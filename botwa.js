const express = require('express');
const os = require('os');
const session = require('express-session');
const path = require('path');
const { connectToWhatsApp } = require('./src/utils/connect');
const { startScheduler } = require('./src/utils/scheduler');
const db = require('./database/db');

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// ========== WEB SERVER ==========

const app = express();
const WEB_PORT = process.env.WEB_PORT || 3000;
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'web', 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'botwa-ibik-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    next();
}
function requireSuperAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
    next();
}
function requireAdmin(req, res, next) {
    if (!req.session.user || (req.session.user.role !== 'super_admin' && req.session.user.role !== 'admin')) return res.status(403).json({ error: 'Forbidden' });
    next();
}

// Auth
app.post('/api/auth/login', async (req, res) => {
    try {
        await db.init();
        const { phone } = req.body;
        const user = await db.getUserByPhone(phone);
        if (!user) return res.status(401).json({ error: 'User tidak ditemukan. Hubungi admin.' });
        req.session.user = user;
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/auth/me', (req, res) => {
    if (!req.session.user) return res.json({ user: null });
    res.json({ user: req.session.user });
});

// Stats
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        await db.init();
        res.json({ stats: await db.getStats(), settings: await db.getSettings() });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Tasks
app.get('/api/tasks', requireAuth, async (req, res) => {
    try {
        await db.init();
        const tasks = await db.getAllTasks();
        const user = req.session.user;
        const assignments = await db.getUserTasks(user.phone);
        const tasksWithMyAssignment = tasks.map(t => {
            const myAssignment = assignments.find(a => a.taskId === t.id);
            return { ...t, myAssignment };
        });
        if (user.role === 'super_admin' || user.role === 'admin') {
            // Admin also gets taskStats + myAssignment
            const tasksWithStats = await Promise.all(tasksWithMyAssignment.map(async (t) => ({ ...t, taskStats: await db.getTaskStats(t.id) })));
            return res.json({ tasks: tasksWithStats });
        }
        res.json({ tasks: tasksWithMyAssignment });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/tasks', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { name, class: className, detail, deadline } = req.body;
        if (!name || !deadline) return res.status(400).json({ error: 'Nama dan deadline wajib diisi.' });
        const deadlineDate = new Date(deadline);
        if (isNaN(deadlineDate.getTime())) return res.status(400).json({ error: 'Format deadline tidak valid.' });

        const task = await db.addTask({ name, class: className || 'Semua Kelas', detail: detail || '', deadline: deadlineDate.toISOString() });
        await db.assignTaskToAllUsers(task.id);

        const sock = global.botSock;
        if (sock) {
            const helpers = require('./utils/helpers');
            const config = require('./config/config');
            const users = await db.getAllUsers();
            const notification = config.messages.newTaskNotification(task.name, helpers.formatDate(deadlineDate), task.class);
            for (const u of users) {
                if (u.role === 'super_admin') continue;
                try {
                    await sock.sendMessage(`${u.phone}@s.whatsapp.net`, { text: notification });
                    await new Promise(r => setTimeout(r, 500));
                } catch (e) { /* skip */ }
            }
        }
        res.json({ success: true, task });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/tasks/:id', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { id } = req.params;
        const { name, class: className, detail, deadline } = req.body;
        const updates = {};
        if (name) updates.name = name;
        if (className) updates.class = className;
        if (detail !== undefined) updates.detail = detail;
        if (deadline) updates.deadline = new Date(deadline).toISOString();
        const task = await db.updateTask(id, updates);
        if (!task) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        res.json({ success: true, task });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/tasks/:id', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const task = await db.getTaskById(req.params.id);
        if (!task) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        await db.deleteTask(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/tasks/:id/detail', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const task = await db.getTaskById(req.params.id);
        if (!task) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        const assignments = await db.getTaskAssignments(req.params.id);
        const stats = await db.getTaskStats(req.params.id);
        const users = await db.getAllUsers();
        const enriched = assignments.map(a => { const u = users.find(u => u.phone === a.userPhone); return { ...a, userName: u ? u.name : a.userPhone, userClass: u ? u.class : '' }; });
        res.json({ task, assignments: enriched, stats });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/tasks/:id/status', requireAuth, async (req, res) => {
    try {
        await db.init();
        const { status } = req.body;
        if (!['not_started', 'in_progress', 'completed'].includes(status)) return res.status(400).json({ error: 'Status tidak valid.' });
        const updated = await db.updateTaskStatus(req.params.id, req.session.user.phone, status);
        if (!updated) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        res.json({ success: true, assignment: updated });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Update specific user assignment status (admin only)
app.put('/api/tasks/:id/assignment/:phone/status', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { status } = req.body;
        if (!['not_started', 'in_progress', 'completed'].includes(status)) return res.status(400).json({ error: 'Status tidak valid.' });
        const updated = await db.updateTaskStatus(req.params.id, req.params.phone, status);
        if (!updated) return res.status(404).json({ error: 'Assignment tidak ditemukan.' });
        res.json({ success: true, assignment: updated });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/tasks/:id/remind', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const sock = global.botSock;
        if (!sock) return res.status(503).json({ error: 'Bot WhatsApp belum terhubung.' });
        const task = await db.getTaskById(req.params.id);
        if (!task) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        const usersNotCompleted = await db.getUsersNotCompletedTask(req.params.id);
        if (usersNotCompleted.length === 0) return res.json({ success: true, sent: 0, message: 'Semua user sudah menyelesaikan tugas ini.' });
        const helpers = require('./utils/helpers');
        const config = require('./config/config');
        const reminderMsg = config.messages.taskReminder(task.name, helpers.formatDate(new Date(task.deadline)));
        let sent = 0, failed = 0;
        for (let i = 0; i < usersNotCompleted.length; i++) {
            try { await sock.sendMessage(`${usersNotCompleted[i].userPhone}@s.whatsapp.net`, { text: reminderMsg }); sent++; } catch (e) { failed++; }
            if ((i + 1) % 3 === 0) await new Promise(r => setTimeout(r, 500));
        }
        res.json({ success: true, sent, failed });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/remind/daily', requireAdmin, async (req, res) => {
    try {
        const scheduler = require('./src/utils/scheduler');
        await scheduler.sendDailyReminder();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Users
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const users = await db.getAllUsers();
        const enriched = await Promise.all(users.map(async (u) => { const asgn = await db.getUserTasks(u.phone); const done = asgn.filter(a => a.status === 'completed').length; return { ...u, completedTasks: done, totalTasks: asgn.length }; }));
        res.json({ users: enriched });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users/:phone/detail', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const user = await db.getUserByPhone(req.params.phone);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
        const assignments = await db.getUserTasks(req.params.phone);
        const tasks = [];
        for (const a of assignments) { const t = await db.getTaskById(a.taskId); if (t) tasks.push({ ...t, assignment: a }); }
        res.json({ user, tasks });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { phone, name, role, class: className } = req.body;
        if (!phone || !name || !role) return res.status(400).json({ error: 'Phone, nama, dan role wajib diisi.' });
        const helpers = require('./utils/helpers');
        if (!helpers.isValidPhoneNumber(phone)) return res.status(400).json({ error: 'Format nomor telepon tidak valid.' });
        if (await db.getUserByPhone(phone)) return res.status(409).json({ error: 'User dengan nomor ini sudah terdaftar.' });
        const user = await db.addUser({ phone, name, role, class: className || 'Tanpa Kelas' });
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/users/:phone', requireSuperAdmin, async (req, res) => {
    try {
        await db.init();
        const updates = {};
        const { name, role, class: className } = req.body;
        if (name) updates.name = name;
        if (role) updates.role = role;
        if (className !== undefined) updates.class = className;
        const user = await db.updateUser(req.params.phone, updates);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
        res.json({ success: true, user });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/users/:phone', requireSuperAdmin, async (req, res) => {
    try {
        await db.init();
        const user = await db.getUserByPhone(req.params.phone);
        if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
        await db.deleteUserAssignments(req.params.phone);
        await db.deleteUser(req.params.phone);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Settings
app.get('/api/settings', requireSuperAdmin, async (req, res) => {
    try {
        await db.init();
        res.json({ settings: await db.getSettings(), botConnected: !!global.botSock });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/settings', requireSuperAdmin, async (req, res) => {
    try {
        await db.init();
        const updates = {};
        if (req.body.botEnabled !== undefined) updates.botEnabled = req.body.botEnabled;
        if (req.body.maintenanceMessage !== undefined) updates.maintenanceMessage = req.body.maintenanceMessage;
        res.json({ success: true, settings: await db.updateSettings(updates) });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Serve pages
app.get('/', (req, res) => {
    if (!req.session.user) return res.sendFile(path.join(__dirname, 'web', 'public', 'login.html'));
    res.sendFile(path.join(__dirname, 'web', 'public', 'index.html'));
});
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'web', 'public', 'index.html')));

// Start web server
app.listen(WEB_PORT, WEB_HOST, () => {
    const localIP = getLocalIP();
    console.log(`\n========================================`);
    console.log(`🌐 Web Dashboard running at http://localhost:${WEB_PORT}`);
    console.log(`📱 Akses di device lain: http://${localIP}:${WEB_PORT}/dashboard`);
    console.log(`📊 Admin dashboard at http://localhost:${WEB_PORT}/dashboard`);
    console.log(`========================================\n`);
});

// ========== WHATSAPP BOT ==========

async function startBot() {
    console.log('🔄 Starting WhatsApp Bot...');
    await connectToWhatsApp();
    startScheduler();
}

startBot();

// Handle graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
        console.log('\n👋 Shutting down bot...');
        process.exit(0);
    });
});