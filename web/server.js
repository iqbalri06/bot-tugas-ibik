const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('../database/db');

const app = express();
const PORT = process.env.WEB_PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'botwa-ibik-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth middleware
function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function requireSuperAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || (req.session.user.role !== 'super_admin' && req.session.user.role !== 'admin')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

// ========== AUTH ==========

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        await db.init();
        const { phone } = req.body;
        const user = await db.getUserByPhone(phone);

        if (!user) {
            return res.status(401).json({ error: 'User tidak ditemukan. Hubungi admin.' });
        }

        req.session.user = user;
        res.json({ success: true, user });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Get current session
app.get('/api/auth/me', (req, res) => {
    if (!req.session.user) {
        return res.json({ user: null });
    }
    res.json({ user: req.session.user });
});

// ========== DASHBOARD ==========

// Get stats
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        await db.init();
        const stats = await db.getStats();
        const settings = await db.getSettings();
        res.json({ stats, settings });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== TASKS ==========

// Get all tasks (admin: all tasks, user: own tasks)
app.get('/api/tasks', requireAuth, async (req, res) => {
    try {
        await db.init();
        const tasks = await db.getAllTasks();
        const user = req.session.user;

        const assignments = await db.getUserTasks(user.phone);
        const userTaskIds = new Set(assignments.map(a => a.taskId));

        if (user.role === 'super_admin' || user.role === 'admin') {
            // Admin: return all tasks with full details + their own assignment
            const tasksWithStats = await Promise.all(tasks.map(async (task) => {
                const stats = await db.getTaskStats(task.id);
                const assignment = assignments.find(a => a.taskId === task.id);
                return { ...task, taskStats: stats, myAssignment: assignment || null };
            }));
            return res.json({ tasks: tasksWithStats });
        } else {
            // User: return only their own tasks
            const userTasks = [];
            for (const task of tasks) {
                if (userTaskIds.has(task.id)) {
                    const assignment = assignments.find(a => a.taskId === task.id);
                    userTasks.push({ ...task, myAssignment: assignment });
                }
            }
            return res.json({ tasks: userTasks });
        }
    } catch (error) {
        console.error('Tasks error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create task (admin only)
app.post('/api/tasks', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { name, class: className, detail, deadline } = req.body;

        if (!name || !deadline) {
            return res.status(400).json({ error: 'Nama dan deadline wajib diisi.' });
        }

        const deadlineDate = new Date(deadline);
        if (isNaN(deadlineDate.getTime())) {
            return res.status(400).json({ error: 'Format deadline tidak valid.' });
        }

        const task = await db.addTask({
            name,
            class: className || 'Semua Kelas',
            detail: detail || '',
            deadline: deadlineDate.toISOString()
        });

        // Assign to all users
        await db.assignTaskToAllUsers(task.id);

        // Try to notify via WhatsApp
        const sock = global.botSock;
        if (sock) {
            const helpers = require('../utils/helpers');
            const config = require('../config/config');
            const users = await db.getAllUsers();
            const notification = config.messages.newTaskNotification(
                task.name,
                helpers.formatDate(deadlineDate),
                task.class
            );

            for (const u of users) {
                if (u.role === 'super_admin') continue;
                try {
                    await sock.sendMessage(`${u.phone}@s.whatsapp.net`, { text: notification });
                    await new Promise(r => setTimeout(r, 500));
                } catch (e) {
                    console.log(`Failed to notify ${u.phone}: ${e.message}`);
                }
            }
        }

        res.json({ success: true, task });
    } catch (error) {
        console.error('Create task error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update task (admin only)
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
        if (!task) {
            return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        }

        res.json({ success: true, task });
    } catch (error) {
        console.error('Update task error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete task (admin only)
app.delete('/api/tasks/:id', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { id } = req.params;
        const task = await db.getTaskById(id);

        if (!task) {
            return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        }

        await db.deleteTask(id);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete task error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get task detail with assignments (admin only)
app.get('/api/tasks/:id/detail', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { id } = req.params;
        const task = await db.getTaskById(id);

        if (!task) {
            return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        }

        const assignments = await db.getTaskAssignments(id);
        const stats = await db.getTaskStats(id);

        // Enrich assignments with user info
        const users = await db.getAllUsers();
        const enrichedAssignments = assignments.map(a => {
            const user = users.find(u => u.phone === a.userPhone);
            return { ...a, userName: user ? user.name : a.userPhone, userClass: user ? user.class : '' };
        });

        res.json({ task, assignments: enrichedAssignments, stats });
    } catch (error) {
        console.error('Task detail error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update own task status
app.put('/api/tasks/:id/status', requireAuth, async (req, res) => {
    try {
        await db.init();
        const { id } = req.params;
        const { status } = req.body;
        const user = req.session.user;

        if (!['not_started', 'in_progress', 'completed'].includes(status)) {
            return res.status(400).json({ error: 'Status tidak valid.' });
        }

        const updated = await db.updateTaskStatus(id, user.phone, status);
        if (!updated) {
            return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        }

        res.json({ success: true, assignment: updated });
    } catch (error) {
        console.error('Update status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin: update any user's task status
app.put('/api/tasks/:id/assignment/:phone/status', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { id, phone } = req.params;
        const { status } = req.body;

        if (!['not_started', 'in_progress', 'completed'].includes(status)) {
            return res.status(400).json({ error: 'Status tidak valid.' });
        }

        const updated = await db.updateTaskStatus(id, phone, status);
        if (!updated) {
            return res.status(404).json({ error: 'Assignment tidak ditemukan.' });
        }

        res.json({ success: true, assignment: updated });
    } catch (error) {
        console.error('Admin update status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Send reminder for a task (admin only)
app.post('/api/tasks/:id/remind', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { id } = req.params;
        const sock = global.botSock;

        if (!sock) {
            return res.status(503).json({ error: 'Bot WhatsApp belum terhubung.' });
        }

        const task = await db.getTaskById(id);
        if (!task) {
            return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
        }

        const usersNotCompleted = await db.getUsersNotCompletedTask(id);
        if (usersNotCompleted.length === 0) {
            return res.json({ success: true, sent: 0, message: 'Semua user sudah menyelesaikan tugas ini.' });
        }

        const helpers = require('../utils/helpers');
        const config = require('../config/config');
        const reminderMsg = config.messages.taskReminder(task.name, helpers.formatDate(new Date(task.deadline)));

        let sentCount = 0;
        let failCount = 0;

        for (let i = 0; i < usersNotCompleted.length; i++) {
            const a = usersNotCompleted[i];
            try {
                await sock.sendMessage(`${a.userPhone}@s.whatsapp.net`, { text: reminderMsg });
                sentCount++;
            } catch (e) {
                failCount++;
            }
            if ((i + 1) % 3 === 0) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        res.json({ success: true, sent: sentCount, failed: failCount });
    } catch (error) {
        console.error('Remind error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Trigger manual daily reminder
app.post('/api/remind/daily', requireAdmin, async (req, res) => {
    try {
        const scheduler = require('../src/utils/scheduler');
        await scheduler.sendDailyReminder();
        res.json({ success: true });
    } catch (error) {
        console.error('Daily remind error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== USERS ==========

// Get all users (admin only)
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const users = await db.getAllUsers();

        // Enrich with task stats
        const enrichedUsers = await Promise.all(users.map(async (user) => {
            const assignments = await db.getUserTasks(user.phone);
            const completed = assignments.filter(a => a.status === 'completed').length;
            const total = assignments.length;
            return { ...user, completedTasks: completed, totalTasks: total };
        }));

        res.json({ users: enrichedUsers });
    } catch (error) {
        console.error('Users error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user detail (admin only)
app.get('/api/users/:phone/detail', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { phone } = req.params;
        const user = await db.getUserByPhone(phone);

        if (!user) {
            return res.status(404).json({ error: 'User tidak ditemukan.' });
        }

        const assignments = await db.getUserTasks(phone);
        const tasksWithData = [];

        for (const assignment of assignments) {
            const task = await db.getTaskById(assignment.taskId);
            if (task) {
                tasksWithData.push({ ...task, assignment });
            }
        }

        res.json({ user, tasks: tasksWithData });
    } catch (error) {
        console.error('User detail error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Add user (admin only)
app.post('/api/users', requireAdmin, async (req, res) => {
    try {
        await db.init();
        const { phone, name, role, class: className } = req.body;

        if (!phone || !name || !role) {
            return res.status(400).json({ error: 'Phone, nama, dan role wajib diisi.' });
        }

        const helpers = require('../utils/helpers');
        if (!helpers.isValidPhoneNumber(phone)) {
            return res.status(400).json({ error: 'Format nomor telepon tidak valid. Contoh: 6281234567890' });
        }

        const existing = await db.getUserByPhone(phone);
        if (existing) {
            return res.status(409).json({ error: 'User dengan nomor ini sudah terdaftar.' });
        }

        const user = await db.addUser({
            phone,
            name,
            role,
            class: className || 'Tanpa Kelas'
        });

        res.json({ success: true, user });
    } catch (error) {
        console.error('Add user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update user (super_admin only)
app.put('/api/users/:phone', requireSuperAdmin, async (req, res) => {
    try {
        await db.init();
        const { phone } = req.params;
        const { name, role, class: className } = req.body;

        const updates = {};
        if (name) updates.name = name;
        if (role) updates.role = role;
        if (className !== undefined) updates.class = className;

        const user = await db.updateUser(phone, updates);
        if (!user) {
            return res.status(404).json({ error: 'User tidak ditemukan.' });
        }

        res.json({ success: true, user });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete user (super_admin only)
app.delete('/api/users/:phone', requireSuperAdmin, async (req, res) => {
    try {
        await db.init();
        const { phone } = req.params;
        const user = await db.getUserByPhone(phone);

        if (!user) {
            return res.status(404).json({ error: 'User tidak ditemukan.' });
        }

        await db.deleteUserAssignments(phone);
        await db.deleteUser(phone);

        res.json({ success: true });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== SETTINGS ==========

// Get settings (super_admin only)
app.get('/api/settings', requireSuperAdmin, async (req, res) => {
    try {
        await db.init();
        const settings = await db.getSettings();
        const botConnected = !!global.botSock;
        res.json({ settings, botConnected });
    } catch (error) {
        console.error('Settings error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update settings (super_admin only)
app.put('/api/settings', requireSuperAdmin, async (req, res) => {
    try {
        await db.init();
        const { botEnabled, maintenanceMessage, reminderEnabled, reminderTime } = req.body;
        const updates = {};
        if (botEnabled !== undefined) updates.botEnabled = botEnabled;
        if (maintenanceMessage !== undefined) updates.maintenanceMessage = maintenanceMessage;
        if (reminderEnabled !== undefined) updates.reminderEnabled = reminderEnabled;
        if (reminderTime !== undefined) updates.reminderTime = reminderTime;

        const settings = await db.updateSettings(updates);
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== SERVE PAGES ==========

app.get('/', (req, res) => {
    if (!req.session.user) {
        return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server - bind to all network interfaces for cross-device access
const server = app.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    const localIPs = [];

    for (const name of Object.keys(networkInterfaces)) {
        for (const iface of networkInterfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIPs.push(iface.address);
            }
        }
    }

    console.log(`🌐 Web Dashboard running`);
    console.log(`   Local:    http://localhost:${PORT}`);
    console.log(`   Network:  ${localIPs.map(ip => `http://${ip}:${PORT}`).join(', ')}`);
    console.log(`📊 Admin dashboard at /dashboard`);
    console.log(`   Akses dari device lain: http://<IP-komputer>:${PORT}/dashboard`);
});
