// ========== AUTH GUARD ==========
(async () => {
    try {
        const r = await fetch('/api/auth/me');
        const d = await r.json();
        if (!d.user) { window.location.href = '/login.html'; return; }
    } catch {
        window.location.href = '/login.html';
        return;
    }
})();

// ========== SIDEBAR TOGGLE (mobile) ==========
function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (!sb) return;
    const isOpen = sb.classList.contains('open');
    sb.classList.toggle('open', !isOpen);
    if (overlay) overlay.classList.toggle('active', !isOpen);
}

// Close sidebar when switching to desktop
window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
        const sb = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (sb) sb.classList.remove('open');
        if (overlay) overlay.classList.remove('active');
    }
});

// ========== STATE ==========
let currentUser = null;
let currentPage = 'dashboard';
let pendingConfirm = null;

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', async () => {
    await loadUserInfo();
    loadDashboard();
});

// ========== AUTH ==========
async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
}

// ========== USER INFO ==========
async function loadUserInfo() {
    try {
        const r = await fetch('/api/auth/me');
        const d = await r.json();
        if (!d.user) return;
        currentUser = d.user;
        document.getElementById('userAvatar').textContent = (d.user.name || 'U').charAt(0).toUpperCase();
        document.getElementById('userName').textContent = d.user.name || '-';
        document.getElementById('userRole').textContent = roleLabel(d.user.role);

        // Role-based nav visibility
        if (d.user.role === 'super_admin' || d.user.role === 'admin') {
            document.getElementById('navUsers').classList.remove('hidden');
            document.getElementById('navMyTasks').classList.remove('hidden');
        }
        if (d.user.role === 'super_admin') {
            document.getElementById('navSettings').classList.remove('hidden');
        }
        // Admin-only: show "Buat Tugas" buttons
        const isAdmin = d.user.role === 'admin' || d.user.role === 'super_admin';
        if (!isAdmin) {
            const btnCreateTask = document.getElementById('btnCreateTask');
            if (btnCreateTask) btnCreateTask.style.display = 'none';
            const btnCreateTaskDashboard = document.getElementById('btnCreateTaskDashboard');
            if (btnCreateTaskDashboard) btnCreateTaskDashboard.style.display = 'none';
        }
    } catch { /* silent */ }
}

function roleLabel(role) {
    const map = { super_admin: 'Super Admin', admin: 'Admin', user: 'User' };
    return map[role] || role;
}

// ========== NAVIGATION ==========
function navigate(page) {
    if (!currentUser) return;
    // Role guard
    if (page === 'users' && currentUser.role !== 'super_admin' && currentUser.role !== 'admin') return;
    if (page === 'settings' && currentUser.role !== 'super_admin') return;
    if (page === 'mytasks' && currentUser.role !== 'super_admin' && currentUser.role !== 'admin') return;

    currentPage = page;
    document.querySelectorAll('.page-section').forEach(el => el.style.display = 'none');
    const target = document.getElementById('page-' + page);
    if (target) target.style.display = 'block';

    document.querySelectorAll('#sidebar a[data-page]').forEach(a => {
        a.classList.toggle('active', a.dataset.page === page);
    });

    // Close sidebar on mobile after nav
    if (window.innerWidth <= 768) toggleSidebar();

    if (page === 'dashboard') loadDashboard();
    else if (page === 'tasks') loadTasks();
    else if (page === 'mytasks') loadMyTasks();
    else if (page === 'users') loadUsers();
    else if (page === 'settings') loadSettings();
}

// ========== DASHBOARD ==========
async function loadDashboard() {
    try {
        const r = await fetch('/api/stats');
        if (!r.ok) return;
        const d = await r.json();
        const s = d.stats || {};

        document.getElementById('statUsers').textContent = s.totalUsers ?? '-';
        document.getElementById('statTasks').textContent = s.totalTasks ?? '-';
        document.getElementById('statPending').textContent = s.pendingTasks ?? '-';
        document.getElementById('statCompleted').textContent = s.completedTasks ?? '-';

        const rate = s.totalTasks > 0 ? Math.round((s.completedTasks / s.totalTasks) * 100) : 0;
        document.getElementById('completionRate').textContent = rate + '%';
        document.getElementById('completionBar').style.width = rate + '%';

        updateBotStatus(d.settings);
    } catch { /* silent */ }
}

function updateBotStatus(settings) {
    const connected = !!settings && settings.botConnected;
    const dot = document.getElementById('botDot');
    const text = document.getElementById('botText');
    if (dot) { dot.className = 'bs-dot ' + (connected ? 'online' : 'offline'); }
    if (text) { text.textContent = connected ? 'Bot: Online' : 'Bot: Offline'; }
}

async function sendDailyReminder() {
    try {
        const r = await fetch('/api/remind/daily', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
            showAlert(document.getElementById('statsGrid'), 'Reminder berhasil dikirim.', 'success');
        } else {
            showAlert(document.getElementById('statsGrid'), d.error || 'Gagal mengirim reminder.', 'error');
        }
    } catch {
        showAlert(document.getElementById('statsGrid'), 'Terjadi kesalahan.', 'error');
    }
}

// ========== TASKS ==========
let tasksData = [];

async function loadTasks() {
    try {
        const r = await fetch('/api/tasks');
        if (!r.ok) return;
        const d = await r.json();
        tasksData = d.tasks || [];
        renderTasks(tasksData);
    } catch { /* silent */ }
}

// ========== MY TASKS (Admin - Tugas Saya) ==========
let myTasksData = [];

async function loadMyTasks() {
    // Reload from API to ensure fresh data for current user's assignments
    try {
        const r = await fetch('/api/tasks');
        if (!r.ok) return;
        const d = await r.json();
        const allTasks = d.tasks || [];
        // Filter: only show tasks where current user has myAssignment
        const myTasks = allTasks.filter(t => t.myAssignment);
        myTasksData = myTasks;
        renderMyTasks(myTasksData);
    } catch { /* silent */ }
}

function renderMyTasks(tasks) {
    const empty = document.getElementById('mytasksEmpty');
    const board = document.getElementById('kanbanMyBoard');

    if (!tasks || tasks.length === 0) {
        if (board) board.style.display = 'none';
        if (empty) empty.style.display = 'flex';
        ['ready','progress','done'].forEach(col => {
            const el = document.getElementById('mycards-' + col);
            const cnt = document.getElementById('mycount-' + col);
            if (el) el.innerHTML = '<div class="kanban-empty">Belum ada tugas</div>';
            if (cnt) cnt.textContent = '0';
        });
        return;
    }

    if (board) board.style.display = 'grid';
    if (empty) empty.style.display = 'none';

    // Bucket based on MY assignment status (not aggregate stats)
    const buckets = { ready: [], progress: [], done: [] };
    tasks.forEach(t => {
        const my = t.myAssignment ? t.myAssignment.status : 'not_started';
        if (my === 'completed') buckets['done'].push(t);
        else if (my === 'in_progress') buckets['progress'].push(t);
        else buckets['ready'].push(t);
    });

    const colOrder = ['ready', 'progress', 'done'];

    colOrder.forEach(col => {
        const container = document.getElementById('mycards-' + col);
        const colEl = document.getElementById('mytask-col-' + col);
        const counter = document.getElementById('mycount-' + col);
        const items = buckets[col] || [];
        if (counter) counter.textContent = items.length;

        // Setup drag-over & drop for columns
        if (colEl) {
            colEl.ondragover = e => { e.preventDefault(); colEl.classList.add('drag-over'); };
            colEl.ondragleave = () => colEl.classList.remove('drag-over');
            colEl.ondrop = async e => {
                e.preventDefault();
                colEl.classList.remove('drag-over');
                const taskId = e.dataTransfer.getData('taskId');
                const newStatus = col === 'ready' ? 'not_started' : col === 'progress' ? 'in_progress' : 'completed';
                if (taskId) {
                    await fetch('/api/tasks/' + taskId + '/status', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: newStatus })
                    });
                    loadMyTasks();
                }
            };
        }

        if (items.length === 0) {
            container.innerHTML = '<div class="kanban-empty">Belum ada tugas</div>';
            return;
        }

        container.innerHTML = items.map(t => {
            const deadline = t.deadline ? new Date(t.deadline) : null;
            const isOverdue = deadline && deadline < new Date();
            const deadlineStr = deadline ? deadline.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) : null;
            const myStatus = t.myAssignment ? t.myAssignment.status : 'not_started';

            return `<div class="kanban-card" draggable="true" ondragstart="onCardDragStart(event,'${t.id}')" onclick="openMyTaskDetail('${t.id}')">
                <div class="kanban-card-name">${escHtml(t.name)}</div>
                <div class="kanban-card-meta">
                    ${t.class ? `<span class="kanban-card-class">${escHtml(t.class)}</span>` : ''}
                    ${deadlineStr ? `<span class="kanban-card-deadline${isOverdue && col !== 'done' ? ' overdue' : ''}">
                        <i class="fa-regular fa-calendar"></i>${deadlineStr}
                        ${isOverdue && col !== 'done' ? '<i class="fa-solid fa-circle-exclamation"></i>' : ''}
                    </span>` : ''}
                </div>
                <div style="margin-bottom:10px">
                    <span class="badge badge-${myStatus === 'completed' ? 's' : myStatus === 'in_progress' ? 'i' : 'g'}">${myStatus === 'completed' ? 'Selesai' : myStatus === 'in_progress' ? 'Dikerjakan' : 'Belum'}</span>
                </div>
                <div class="kanban-card-actions">
                    <button class="btn-xs" onclick="event.stopPropagation();openMyTaskDetail('${t.id}')" title="Detail"><i class="fa-regular fa-eye"></i></button>
                </div>
            </div>`;
        }).join('');
    });
}

// Open detail for "Tugas Saya" page (simplified - just status update)
async function openMyTaskDetail(taskId) {
    const task = myTasksData.find(t => t.id === taskId) || tasksData.find(t => t.id === taskId);
    if (!task) return;
    const deadline = task.deadline ? new Date(task.deadline) : null;
    const myStatus = task.myAssignment ? task.myAssignment.status : 'not_started';
    const statusMap = { not_started: 'Belum Dikerjakan', in_progress: 'Dikerjakan', completed: 'Selesai' };
    const statusBadgeMap = { not_started: 'pending', in_progress: 'progress', completed: 'done' };

    document.getElementById('taskDetailBody').innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
            <div><strong>Nama:</strong> ${escHtml(task.name)}</div>
            <div><strong>Kelas:</strong> ${escHtml(task.class || '-')}</div>
            <div><strong>Deadline:</strong> ${deadline ? formatDate(deadline) : '-'}</div>
            <div><strong>Status Saya:</strong> <span class="badge badge-${statusBadgeMap[myStatus]}">${statusMap[myStatus]}</span></div>
        </div>
        ${task.detail ? `<div style="margin-bottom:16px"><strong>Detail:</strong><p style="margin:4px 0 0;white-space:pre-wrap">${escHtml(task.detail)}</p></div>` : '<p style="color:#999;margin-bottom:16px">Tidak ada detail tugas.</p>'}
        <div style="margin-top:16px">
            <label style="font-weight:600;display:block;margin-bottom:8px">Update Status:</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn ${myStatus === 'not_started' ? 'btn-primary' : 'btn-outline'}" onclick="updateMyTaskStatus('${taskId}','not_started');closeTaskDetailModal();"><i class="fa-regular fa-circle"></i> Belum</button>
                <button class="btn ${myStatus === 'in_progress' ? 'btn-primary' : 'btn-outline'}" onclick="updateMyTaskStatus('${taskId}','in_progress');closeTaskDetailModal();"><i class="fa-solid fa-spinner"></i> Dikerjakan</button>
                <button class="btn ${myStatus === 'completed' ? 'btn-primary' : 'btn-outline'}" onclick="updateMyTaskStatus('${taskId}','completed');closeTaskDetailModal();"><i class="fa-solid fa-check"></i> Selesai</button>
            </div>
        </div>
    `;
    document.getElementById('taskDetailModal').style.display = 'flex';
}

function renderTasks(tasks) {
    const empty = document.getElementById('tasksEmpty');
    const board = document.getElementById('kanbanBoard');
    if (!tasks || tasks.length === 0) {
        if (board) board.style.display = 'none';
        if (empty) empty.style.display = 'flex';
        ['ready','progress','done'].forEach(col => {
            const el = document.getElementById('cards-' + col);
            const cnt = document.getElementById('count-' + col);
            if (el) el.innerHTML = '<div class="kanban-empty">Belum ada tugas</div>';
            if (cnt) cnt.textContent = '0';
        });
        return;
    }
    if (board) board.style.display = 'grid';
    if (empty) empty.style.display = 'none';

    const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');

    // Determine bucket for each task
    const buckets = { ready: [], progress: [], done: [] };
    tasks.forEach(t => {
        let status;
        if (isAdmin && t.taskStats) {
            const pct = t.taskStats.total > 0 ? t.taskStats.completed / t.taskStats.total : 0;
            if (pct === 1) status = 'done';
            else if (pct > 0) status = 'progress';
            else status = 'ready';
        } else {
            const my = t.myAssignment ? t.myAssignment.status : 'not_started';
            if (my === 'completed') status = 'done';
            else if (my === 'in_progress') status = 'progress';
            else status = 'ready';
        }
        buckets[status].push(t);
    });

    const statusColMap = { ready: 'ready', progress: 'progress', done: 'done' };
    const colOrder = ['ready', 'progress', 'done'];

    colOrder.forEach(col => {
        const container = document.getElementById('cards-' + col);
        const colEl = document.getElementById('col-' + col);
        const counter = document.getElementById('count-' + col);
        const items = buckets[col] || [];
        if (counter) counter.textContent = items.length;

        // Setup drag-over & drop untuk kolom
        if (colEl) {
            colEl.ondragover = e => { e.preventDefault(); colEl.classList.add('drag-over'); };
            colEl.ondragleave = () => colEl.classList.remove('drag-over');
            colEl.ondrop = async e => {
                e.preventDefault();
                colEl.classList.remove('drag-over');
                const taskId = e.dataTransfer.getData('taskId');
                const newStatus = col === 'ready' ? 'not_started' : col === 'progress' ? 'in_progress' : 'completed';
                if (taskId) {
                    const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
                    if (isAdmin) {
                        // Admin: bulk update status for ALL users on this task
                        const r = await fetch('/api/tasks/' + taskId + '/detail');
                        if (r.ok) {
                            const d = await r.json();
                            for (const a of d.assignments) {
                                await fetch('/api/tasks/' + taskId + '/assignment/' + a.userPhone + '/status', {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ status: newStatus })
                                });
                            }
                        }
                    } else {
                        // Non-admin: update own status only
                        await fetch('/api/tasks/' + taskId + '/status', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ status: newStatus })
                        });
                    }
                    loadTasks();
                }
            };
        }

        if (items.length === 0) {
            container.innerHTML = '<div class="kanban-empty">Belum ada tugas</div>';
            return;
        }

        container.innerHTML = items.map(t => {
            const deadline = t.deadline ? new Date(t.deadline) : null;
            const isOverdue = deadline && deadline < new Date();
            const deadlineStr = deadline ? deadline.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) : null;
            const myStatus = t.myAssignment ? t.myAssignment.status : 'not_started';

            return `<div class="kanban-card" draggable="true" ondragstart="onCardDragStart(event,'${t.id}')" onclick="openTaskDetail('${t.id}')">
                <div class="kanban-card-name">${escHtml(t.name)}</div>
                <div class="kanban-card-meta">
                    ${t.class ? `<span class="kanban-card-class">${escHtml(t.class)}</span>` : ''}
                    ${deadlineStr ? `<span class="kanban-card-deadline${isOverdue && col !== 'done' ? ' overdue' : ''}">
                        <i class="fa-regular fa-calendar"></i>${deadlineStr}
                        ${isOverdue && col !== 'done' ? '<i class="fa-solid fa-circle-exclamation"></i>' : ''}
                    </span>` : ''}
                </div>
                ${isAdmin && t.taskStats ? `<div style="margin-bottom:10px">
                    <div style="display:flex;align-items:center;gap:6px;font-size:10px;color:#607D8B;margin-bottom:4px">
                        <span>${t.taskStats.completed}/${t.taskStats.total} selesai</span>
                    </div>
                    <div style="height:4px;background:#E8F0EC;border-radius:2px;overflow:hidden">
                        <div style="height:4px;background:linear-gradient(90deg,#128C7E,#25D366);border-radius:2px;width:${t.taskStats.total > 0 ? Math.round((t.taskStats.completed/t.taskStats.total)*100) : 0}%"></div>
                    </div>
                </div>` : ''}
                ${!isAdmin ? `<div style="margin-bottom:10px">
                    <span class="badge badge-${myStatus === 'completed' ? 's' : myStatus === 'in_progress' ? 'i' : 'g'}">${myStatus === 'completed' ? 'Selesai' : myStatus === 'in_progress' ? 'Dikerjakan' : 'Belum'}</span>
                </div>` : ''}
                <div class="kanban-card-actions">
                    ${isAdmin ? `<button class="btn-xs" onclick="event.stopPropagation();editTask('${t.id}')" title="Edit"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn-xs btn-danger-xs" onclick="event.stopPropagation();deleteTask('${t.id}')" title="Hapus"><i class="fa-solid fa-trash"></i></button>` : ''}
                    <button class="btn-xs" onclick="event.stopPropagation();openTaskDetail('${t.id}')" title="Detail"><i class="fa-regular fa-eye"></i></button>
                </div>
            </div>`;
        }).join('');
    });
}

async function openTaskDetail(taskId) {
    const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');

    // Non-admin: gunakan data lokal dari tasksData
    if (!isAdmin) {
        const task = tasksData.find(t => t.id === taskId);
        if (!task) return;
        const deadline = task.deadline ? new Date(task.deadline) : null;
        const myAssignment = task.myAssignment || { status: 'not_started' };
        const statusMap = { not_started: 'Belum Dikerjakan', in_progress: 'Dikerjakan', completed: 'Selesai' };
        const statusBadgeMap = { not_started: 'pending', in_progress: 'progress', completed: 'done' };

        document.getElementById('taskDetailBody').innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
                <div><strong>Nama:</strong> ${escHtml(task.name)}</div>
                <div><strong>Kelas:</strong> ${escHtml(task.class || '-')}</div>
                <div><strong>Deadline:</strong> ${deadline ? formatDate(deadline) : '-'}</div>
                <div><strong>Status Saya:</strong> <span class="badge badge-${statusBadgeMap[myAssignment.status]}">${statusMap[myAssignment.status]}</span></div>
            </div>
            ${task.detail ? `<div style="margin-bottom:16px"><strong>Detail:</strong><p style="margin:4px 0 0;white-space:pre-wrap">${escHtml(task.detail)}</p></div>` : '<p style="color:#999;margin-bottom:16px">Tidak ada detail tugas.</p>'}
            <div style="margin-top:16px">
                <label style="font-weight:600;display:block;margin-bottom:8px">Update Status:</label>
                <div style="display:flex;gap:8px">
                    <button class="btn ${myAssignment.status === 'not_started' ? 'btn-primary' : 'btn-outline'}" onclick="updateMyTaskStatus('${taskId}','not_started')"><i class="fa-regular fa-circle"></i> Belum</button>
                    <button class="btn ${myAssignment.status === 'in_progress' ? 'btn-primary' : 'btn-outline'}" onclick="updateMyTaskStatus('${taskId}','in_progress')"><i class="fa-solid fa-spinner"></i> Dikerjakan</button>
                    <button class="btn ${myAssignment.status === 'completed' ? 'btn-primary' : 'btn-outline'}" onclick="updateMyTaskStatus('${taskId}','completed')"><i class="fa-solid fa-check"></i> Selesai</button>
                </div>
            </div>
        `;
        document.getElementById('taskDetailModal').style.display = 'flex';
        return;
    }

    // Admin: fetch dari API untuk dapat daftar semua assignment
    try {
        const r = await fetch('/api/tasks/' + taskId + '/detail');
        if (!r.ok) return;
        const d = await r.json();
        const { task, assignments, stats } = d;
        const deadline = task.deadline ? new Date(task.deadline) : null;

        const isOverdue = deadline && deadline < new Date();
        document.getElementById('taskDetailBody').innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
                <div><strong>Nama:</strong> ${escHtml(task.name)}</div>
                <div><strong>Kelas:</strong> ${escHtml(task.class || '-')}</div>
                <div><strong>Deadline:</strong> ${deadline ? formatDate(deadline) : '-'}${isOverdue ? ' <span style="color:#e74c3c;font-size:11px">(Terlambat)</span>' : ''}</div>
                <div><strong>Status:</strong> ${stats ? stats.completed + '/' + stats.total + ' selesai' : '-'}</div>
            </div>
            ${task.detail ? `<div style="margin-bottom:16px"><strong>Detail:</strong><p style="margin:4px 0 0;white-space:pre-wrap">${escHtml(task.detail)}</p></div>` : ''}
            ${assignments && assignments.length > 0 ? `<div style="max-height:280px;overflow-y:auto">
                <table class="table"><thead><tr><th>#</th><th>Nama</th><th>Kelas</th><th>Status</th><th>Aksi</th></tr></thead><tbody>
                ${assignments.map((a, i) => {
                    const badgeMap = { not_started: 'pending', in_progress: 'progress', completed: 'done' };
                    const statusTextMap = { not_started: 'Belum', in_progress: 'Dikerjakan', completed: 'Selesai' };
                    return `<tr>
                        <td>${i + 1}</td>
                        <td>${escHtml(a.userName)}</td>
                        <td>${escHtml(a.userClass || '-')}</td>
                        <td><span class="badge badge-${badgeMap[a.status]}">${statusTextMap[a.status]}</span></td>
                        <td>
                            <select onchange="adminUpdateStatus('${taskId}','${a.userPhone}',this.value)" style="border:1px solid #ddd;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer">
                                <option value="not_started" ${a.status==='not_started'?'selected':''}>Belum</option>
                                <option value="in_progress" ${a.status==='in_progress'?'selected':''}>Dikerjakan</option>
                                <option value="completed" ${a.status==='completed'?'selected':''}>Selesai</option>
                            </select>
                        </td>
                    </tr>`;
                }).join('')}
            </tbody></table></div>` : '<p>Belum ada data.</p>'}
        `;
        document.getElementById('taskDetailModal').style.display = 'flex';
    } catch { /* silent */ }
}

function closeTaskDetailModal() {
    document.getElementById('taskDetailModal').style.display = 'none';
}

// ========== TASK STATUS UPDATE ==========
// Non-admin: update status tugas sendiri dari detail modal
async function updateMyTaskStatus(taskId, status) {
    try {
        const r = await fetch('/api/tasks/' + taskId + '/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        if (r.ok) {
            // Update local data in both arrays
            const updateLocal = (arr) => {
                const t = arr.find(x => x.id === taskId);
                if (t && t.myAssignment) t.myAssignment.status = status;
            };
            updateLocal(tasksData);
            updateLocal(myTasksData);
            // Re-render tasks board depending on current page
            if (currentPage === 'mytasks') {
                loadMyTasks();
            } else {
                renderTasks(tasksData);
            }
        }
    } catch { /* silent */ }
}

// Admin: update status user lain dari dropdown di detail modal
async function adminUpdateStatus(taskId, userPhone, status) {
    try {
        await fetch('/api/tasks/' + taskId + '/assignment/' + userPhone + '/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
    } catch { /* silent */ }
}

// Kirim reminder ke user yang belum selesai dari modal detail
async function remindFromDetail(taskId) {
    try {
        const r = await fetch('/api/tasks/' + taskId + '/remind', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
            showAlert(document.getElementById('taskDetailBody'), `Reminder dikirim ke ${d.sent} user.`, 'success');
        } else {
            showAlert(document.getElementById('taskDetailBody'), d.error || 'Gagal mengirim reminder.', 'error');
        }
    } catch {
        showAlert(document.getElementById('taskDetailBody'), 'Terjadi kesalahan.', 'error');
    }
}

// ========== TASK MODAL ==========
function openTaskModal(editId) {
    document.getElementById('taskEditId').value = editId || '';
    document.getElementById('taskModalTitle').textContent = editId ? 'Edit Tugas' : 'Buat Tugas Baru';
    document.getElementById('taskForm').reset();
    document.getElementById('taskModalAlert').style.display = 'none';
    document.getElementById('taskModal').style.display = 'flex';
    if (editId) {
        const t = tasksData.find(x => x.id === editId);
        if (t) {
            document.getElementById('taskName').value = t.name || '';
            document.getElementById('taskClass').value = t.class || '';
            document.getElementById('taskDetail').value = t.detail || '';
            if (t.deadline) {
                const d = new Date(t.deadline);
                document.getElementById('taskDeadline').value = d.toISOString().slice(0, 16);
            }
        }
    }
}

function closeTaskModal() {
    document.getElementById('taskModal').style.display = 'none';
}

function editTask(taskId) { openTaskModal(taskId); }

async function submitTask() {
    const editId = document.getElementById('taskEditId').value;
    const alert = document.getElementById('taskModalAlert');
    const name = document.getElementById('taskName').value.trim();
    const cls = document.getElementById('taskClass').value.trim();
    const detail = document.getElementById('taskDetail').value.trim();
    const deadline = document.getElementById('taskDeadline').value;

    if (!name || !deadline) { alert.textContent = 'Nama dan deadline wajib diisi.'; alert.style.display = 'block'; return; }

    const body = { name, class: cls, detail, deadline };
    const method = editId ? 'PUT' : 'POST';
    const url = editId ? '/api/tasks/' + editId : '/api/tasks';

    try {
        const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json();
        if (!r.ok) { alert.textContent = d.error || 'Gagal menyimpan.'; alert.style.display = 'block'; return; }
        closeTaskModal();
        loadTasks();
        if (currentPage === 'dashboard') loadDashboard();
    } catch {
        alert.textContent = 'Terjadi kesalahan.'; alert.style.display = 'block';
    }
}

async function deleteTask(taskId) {
    showConfirm('Hapus tugas ini?', async () => {
        try {
            await fetch('/api/tasks/' + taskId, { method: 'DELETE' });
            loadTasks();
            if (currentPage === 'dashboard') loadDashboard();
        } catch { /* silent */ }
    });
}

// ========== USERS ==========
let usersData = [];

async function loadUsers() {
    try {
        const r = await fetch('/api/users');
        if (!r.ok) return;
        const d = await r.json();
        usersData = d.users || [];
        renderUsers(usersData);
    } catch { /* silent */ }
}

function renderUsers(users) {
    const tbody = document.getElementById('usersBody');
    const empty = document.getElementById('usersEmpty');
    if (!users || users.length === 0) {
        tbody.innerHTML = '';
        if (empty) empty.style.display = 'flex';
        return;
    }
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = users.map((u, i) => {
        const progress = u.totalTasks > 0 ? Math.round((u.completedTasks / u.totalTasks) * 100) : 0;
        return `<tr>
            <td>${i + 1}</td>
            <td>${escHtml(u.name)}</td>
            <td>${escHtml(u.phone)}</td>
            <td>${escHtml(u.class || '-')}</td>
            <td><span class="badge badge-${u.role === 'super_admin' ? 'admin' : u.role === 'admin' ? 'accent' : 'default'}">${roleLabel(u.role)}</span></td>
            <td>
                <div style="display:flex;align-items:center;gap:8px">
                    <div style="flex:1;height:6px;background:#e2e8f0;border-radius:3px"><div style="width:${progress}%;height:100%;background:#4f46e5;border-radius:3px"></div></div>
                    <small>${progress}%</small>
                </div>
            </td>
            <td>
                ${currentUser && currentUser.role === 'super_admin' && u.role !== 'super_admin' ? `<button class="btn-xs" onclick="editUser('${u.phone}')"><i class="fa-solid fa-pen"></i></button>
                <button class="btn-xs btn-danger-xs" onclick="deleteUser('${u.phone}')"><i class="fa-solid fa-trash"></i></button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

// ========== USER MODAL ==========
function openUserModal(editPhone) {
    document.getElementById('userEditPhone').value = editPhone || '';
    document.getElementById('userModalTitle').textContent = editPhone ? 'Edit User' : 'Tambah User';
    document.getElementById('userForm').reset();
    document.getElementById('userModalAlert').style.display = 'none';
    document.getElementById('userModal').style.display = 'flex';
    if (editPhone) {
        const u = usersData.find(x => x.phone === editPhone);
        if (u) {
            document.getElementById('userPhone').value = u.phone || '';
            document.getElementById('userPhone').disabled = true;
            document.getElementById('userName').value = u.name || '';
            document.getElementById('userClass').value = u.class || '';
            document.getElementById('userRole').value = u.role || 'user';
        }
    } else {
        document.getElementById('userPhone').disabled = false;
    }
}

function closeUserModal() {
    document.getElementById('userModal').style.display = 'none';
    document.getElementById('userPhone').disabled = false;
}

function editUser(phone) { openUserModal(phone); }

async function submitUser() {
    const editPhone = document.getElementById('userEditPhone').value;
    const alert = document.getElementById('userModalAlert');
    const phone = document.getElementById('userPhone').value.trim();
    const name = document.getElementById('userName').value.trim();
    const cls = document.getElementById('userClass').value.trim();
    const role = document.getElementById('userRole').value;

    if (!phone || !name || !role) { alert.textContent = 'No. HP, nama, dan role wajib diisi.'; alert.style.display = 'block'; return; }

    const body = { phone, name, class: cls, role };
    let method, url;
    if (editPhone) {
        method = 'PUT'; url = '/api/users/' + editPhone;
    } else {
        method = 'POST'; url = '/api/users';
    }

    try {
        const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json();
        if (!r.ok) { alert.textContent = d.error || 'Gagal menyimpan.'; alert.style.display = 'block'; return; }
        closeUserModal();
        loadUsers();
    } catch {
        alert.textContent = 'Terjadi kesalahan.'; alert.style.display = 'block';
    }
}

async function deleteUser(phone) {
    showConfirm('Hapus user ini?', async () => {
        try {
            await fetch('/api/users/' + phone, { method: 'DELETE' });
            loadUsers();
        } catch { /* silent */ }
    });
}

// ========== SETTINGS ==========
async function loadSettings() {
    try {
        const r = await fetch('/api/settings');
        if (!r.ok) return;
        const d = await r.json();
        const s = d.settings || {};

        // Bot connection status
        const dotLarge = document.getElementById('settingsBotDotLarge');
        if (dotLarge) { dotLarge.className = 'bs-dot-large ' + (d.botConnected ? 'online' : ''); }
        const txt = document.getElementById('settingsBotText');
        if (txt) { txt.textContent = d.botConnected ? 'Bot Terhubung' : 'Bot Offline'; }

        // Bot toggle switch
        const toggleBot = document.getElementById('toggleBot');
        if (toggleBot) { toggleBot.checked = s.botEnabled !== false; }

        // Reminder toggle
        const toggleReminder = document.getElementById('toggleReminder');
        if (toggleReminder) { toggleReminder.checked = s.reminderEnabled !== false; }

        // Reminder time
        const reminderTime = document.getElementById('reminderTime');
        if (reminderTime) { reminderTime.value = s.reminderTime || '09:00'; }

        // Maintenance message
        if (document.getElementById('maintenanceMsg')) {
            document.getElementById('maintenanceMsg').value = s.maintenanceMessage || '';
        }
    } catch { /* silent */ }
}

async function saveSettings() {
    const alert = document.getElementById('settingsAlert');
    const botEnabled = document.getElementById('toggleBot') ? document.getElementById('toggleBot').checked : true;
    const reminderEnabled = document.getElementById('toggleReminder') ? document.getElementById('toggleReminder').checked : true;
    const reminderTime = document.getElementById('reminderTime') ? document.getElementById('reminderTime').value : '09:00';
    const maintenanceMsg = document.getElementById('maintenanceMsg') ? document.getElementById('maintenanceMsg').value : '';

    try {
        const r = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                botEnabled,
                reminderEnabled,
                reminderTime,
                maintenanceMessage: maintenanceMsg
            })
        });
        const d = await r.json();
        if (!r.ok) { alert.textContent = d.error || 'Gagal menyimpan.'; alert.className = 'alert alert-err'; alert.style.display = 'block'; return; }
        alert.textContent = 'Pengaturan berhasil disimpan.';
        alert.className = 'alert alert-suc';
        alert.style.display = 'block';
        setTimeout(() => { alert.style.display = 'none'; }, 3000);
    } catch {
        alert.textContent = 'Terjadi kesalahan.'; alert.className = 'alert alert-err'; alert.style.display = 'block';
    }
}

// ========== CONFIRM MODAL ==========
function showConfirm(message, onConfirm) {
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmModal').style.display = 'flex';
    pendingConfirm = onConfirm;
}

function closeConfirmModal() {
    document.getElementById('confirmModal').style.display = 'none';
    pendingConfirm = null;
}

function confirmAction() {
    if (pendingConfirm) pendingConfirm();
    closeConfirmModal();
}

// ========== TASK STATUS UPDATE (from detail view — inline) ==========
async function updateTaskStatus(taskId, status) {
    try {
        await fetch('/api/tasks/' + taskId + '/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        loadTasks();
    } catch { /* silent */ }
}

// ========== HELPERS ==========
function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(date) {
    if (!date) return '-';
    const d = new Date(date);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function showAlert(container, message, type) {
    if (!container) return;
    const existing = container.querySelector('.inline-alert');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'inline-alert alert ' + (type === 'success' ? 'alert-suc' : 'alert-err');
    el.textContent = message;
    el.style.cssText = 'margin-bottom:12px';
    container.insertBefore(el, container.firstChild);
    setTimeout(() => el.remove(), 4000);
}

// ========== DRAG & DROP ==========
function onCardDragStart(event, taskId) {
    event.dataTransfer.setData('taskId', taskId);
    event.dataTransfer.effectAllowed = 'move';
    // Visual feedback
    const card = event.target;
    if (card) card.classList.add('dragging');
    event.target.addEventListener('dragend', () => card.classList.remove('dragging'), { once: true });
}
