const db = require('../../database/db');
const helpers = require('../../utils/helpers');
const config = require('../../config/config');
const pino = require('pino');
const logger = pino({ level: 'info' });

// Maximum concurrent message sends to prevent timeout
const MAX_CONCURRENT_SENDS = 3;
const MESSAGE_SEND_DELAY = 500; // ms delay between batches

// Timeout for sending messages (in ms)
const MESSAGE_SEND_TIMEOUT = 10000; // 10 seconds max per message

// Helper function to send message with timeout
async function sendMessageWithTimeout(sock, jid, message, timeoutMs = MESSAGE_SEND_TIMEOUT) {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            resolve({ success: false, error: 'Timeout' });
        }, timeoutMs);

        sock.sendMessage(jid, message)
            .then(() => {
                clearTimeout(timeoutId);
                resolve({ success: true });
            })
            .catch((err) => {
                clearTimeout(timeoutId);
                resolve({ success: false, error: err.message });
            });
    });
}

// Background function to send notifications (fire and forget)
async function sendNotificationsInBackground(sock, users, notification) {
    for (let i = 0; i < users.length; i++) {
        const u = users[i];
        if (u.role === 'super_admin') continue;

        const result = await sendMessageWithTimeout(
            sock,
            `${u.phone}@s.whatsapp.net`,
            { text: notification },
            8000
        );

        if (!result.success) {
            console.log(`Notification skipped for ${u.phone}: ${result.error}`);
        }

        if ((i + 1) % MAX_CONCURRENT_SENDS === 0) {
            await new Promise(resolve => setTimeout(resolve, MESSAGE_SEND_DELAY));
        }
    }
}

// User state for multi-step commands
const userStates = new Map();

async function handleMessage(sock, message) {
    try {
        console.log('🎯 handleMessage called');
        console.log('📦 message.key:', JSON.stringify(message.key));

        const remoteJid = message.key.remoteJid;
        console.log('📱 remoteJid:', remoteJid);

        // Skip group messages and broadcast
        if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) return;

        // Handle LID format (@lid) - use sender phone number instead
        let actualJid = remoteJid;
        if (remoteJid.includes('@lid')) {
            // Use sender's phone number if available
            if (message.key?.senderPn) {
                actualJid = message.key.senderPn;
            } else {
                // Skip LID messages if no sender phone
                console.log('Skipping LID message - no sender phone');
                return;
            }
        }

        // Get message content from various message types
        let messageContent = '';

        if (message.message?.conversation) {
            messageContent = message.message.conversation;
        } else if (message.message?.extendedTextMessage?.text) {
            messageContent = message.message.extendedTextMessage.text;
        } else if (message.message?.imageMessage?.caption) {
            messageContent = message.message.imageMessage.caption;
        } else if (message.message?.buttonsResponseMessage?.selectedButtonId) {
            messageContent = message.message.buttonsResponseMessage.selectedButtonId;
        } else if (message.message?.listResponseMessage?.singleSelectReply?.selectedRowId) {
            messageContent = message.message.listResponseMessage.singleSelectReply.selectedRowId;
        }

        if (!messageContent || !messageContent.trim()) return;

        // Extract phone number for database lookup
        const userPhone = actualJid.replace('@s.whatsapp.net', '').replace('@whatsapp.net', '');
        console.log('📱 User phone for DB lookup:', userPhone);

        // Check if user is owner (even if not in database)
        const isOwner = userPhone === config.ownerNumber;

        // Check if bot is enabled - but allow super_admin and owner to use the bot
        const settings = await db.getSettings();
        const user = await db.getUserByPhone(userPhone);
        console.log('👤 User from DB:', user ? `${user.name} (${user.role})` : 'NOT FOUND');

        const isSuperAdmin = user && user.role === config.roles.SUPER_ADMIN;

        // If bot is disabled, only allow super_admin or owner to proceed
        if (!settings.botEnabled && !isOwner && !isSuperAdmin) {
            console.log('🔧 Bot is disabled - sending maintenance message');
            await sock.sendMessage(remoteJid, { text: settings.maintenanceMessage || '🔧 Bot sedang maintenance.' });
            return;
        }

        let effectiveUser = user;
        if (isOwner && !user) {
            effectiveUser = {
                phone: userPhone,
                name: 'Owner',
                role: config.roles.SUPER_ADMIN,
                class: 'TI'
            };
            console.log('👑 User is Owner - granting super_admin access');
        }

        console.log(`📩 Message from ${userPhone}: ${messageContent}`);

        // Handle button responses
        if (message.message?.buttonsResponseMessage) {
            await handleButtonResponse(sock, actualJid, message.message.buttonsResponseMessage);
            return;
        }

        // Handle list responses
        if (message.message?.listResponseMessage) {
            await handleListResponse(sock, actualJid, message.message.listResponseMessage);
            return;
        }

        // Handle text commands
        // Use remoteJid (original) for sending messages, effectiveUser for role check
        await processCommand(sock, remoteJid, messageContent.trim(), effectiveUser, userPhone);

    } catch (error) {
        console.error('Error handling message:', error);
    }
}

async function processCommand(sock, remoteJid, messageContent, user, userPhone) {
    const message = messageContent.toLowerCase().trim();
    const originalMessage = messageContent.trim();

    // Check if user is owner (even if not in database)
    const isOwner = userPhone === config.ownerNumber;
    const effectiveUser = user || (isOwner ? {
        phone: userPhone,
        name: 'Owner',
        role: config.roles.SUPER_ADMIN,
        class: 'TI'
    } : null);

    const isSuperAdmin = effectiveUser && effectiveUser.role === config.roles.SUPER_ADMIN;
    const isAdmin = effectiveUser && effectiveUser.role === config.roles.ADMIN;
    const isUserOnly = effectiveUser && effectiveUser.role === config.roles.USER;

    // Check user state for multi-step commands
    if (userStates.has(remoteJid)) {
        await handleUserState(sock, remoteJid, originalMessage, effectiveUser);
        return;
    }

    // Handle commands with slash
    if (originalMessage.startsWith('/')) {
        await handleCommand(sock, remoteJid, originalMessage, effectiveUser);
        return;
    }

    // ========== SUPER ADMIN MENU ==========
    if (isSuperAdmin) {
        if (message === '1' || message.includes('tugas saya')) {
            await handleMyTasks(sock, remoteJid, effectiveUser);
        } else if (message === '2' || message.includes('kelola user')) {
            await sendSuperAdminUserMenu(sock, remoteJid, effectiveUser);
        } else if (message === '3' || message.includes('kelola tugas') || message.includes('buat tugas') || message.includes('tambah tugas')) {
            await sendSuperAdminTaskMenu(sock, remoteJid, effectiveUser);
        } else if (message === '4' || message.includes('reminder') || message.includes('peng-ingat') || message.includes('pengingat')) {
            await handleRemindMenu(sock, remoteJid, effectiveUser);
        } else if (message === '5' || message.includes('statistik')) {
            await sendStats(sock, remoteJid, effectiveUser);
        } else if (message === '6' || message.includes('pengaturan') || message.includes('setting') || message.includes('maintenance')) {
            await sendSettings(sock, remoteJid, effectiveUser);
        } else if (message === '7' || message.includes('bantuan') || message.includes('help')) {
            await sendHelp(sock, remoteJid, effectiveUser);
        } else if (message === 'menu') {
            await sendMainMenu(sock, remoteJid, effectiveUser);
        } else {
            await sendMainMenu(sock, remoteJid, effectiveUser);
        }
        return;
    }

    // ========== ADMIN MENU ==========
    if (isAdmin) {
        if (message === '1' || message.includes('tugas saya')) {
            await handleMyTasks(sock, remoteJid, effectiveUser);
        } else if (message === '2' || message.includes('semua tugas') || message.includes('list tugas') || message.includes('kelola')) {
            await handleListTasks(sock, remoteJid, effectiveUser);
        } else if (message === '3' || message.includes('buat tugas') || message.includes('tambah tugas')) {
            await handleAddTask(sock, remoteJid, effectiveUser);
        } else if (message === '4' || message.includes('peng-ingat') || message.includes('reminder') || message.includes('pengingat')) {
            await handleRemindMenu(sock, remoteJid, effectiveUser);
        } else if (message === '5' || message.includes('bantuan') || message.includes('help')) {
            await sendHelp(sock, remoteJid, effectiveUser);
        } else if (message === 'menu') {
            await sendMainMenu(sock, remoteJid, effectiveUser);
        } else {
            await sendMainMenu(sock, remoteJid, effectiveUser);
        }
        return;
    }

    // ========== USER MENU ==========
    if (message === '1' || message.includes('tugas saya')) {
        await handleMyTasks(sock, remoteJid, effectiveUser);
    } else if (message === '2' || message.includes('update status')) {
        await handleQuickUpdateStatus(sock, remoteJid, effectiveUser);
    } else if (message === '3' || message.includes('bantuan') || message.includes('help')) {
        await sendHelp(sock, remoteJid, effectiveUser);
    } else if (message === 'menu') {
        await sendMainMenu(sock, remoteJid, effectiveUser);
    } else {
        await sendMainMenu(sock, remoteJid, effectiveUser);
    }
}

async function handleCommand(sock, remoteJid, message, user) {
    const command = message.split(' ')[0].toLowerCase();
    const args = message.slice(command.length).trim();

    switch (command) {
        case '/start':
        case '/menu':
            await sendMainMenu(sock, remoteJid, user);
            break;

        case '/help':
            await sendHelp(sock, remoteJid, user);
            break;

        case '/adduser':
            await handleAddUser(sock, remoteJid, user);
            break;

        case '/addtask':
            await handleAddTask(sock, remoteJid, user);
            break;

        case '/listtask':
            await handleListTasks(sock, remoteJid, user);
            break;

        case '/taskdetail':
            await handleTaskDetail(sock, remoteJid, user, args);
            break;

        case '/remindtask':
            await handleRemindTask(sock, remoteJid, user, args);
            break;

        case '/listuser':
            await handleListUsers(sock, remoteJid, user);
            break;

        case '/taskinfo':
            await handleTaskInfo(sock, remoteJid, user, args);
            break;

        case '/edittask':
            await handleEditTaskSelect(sock, remoteJid, user);
            break;

        case '/deletetask':
            await handleDeleteTask(sock, remoteJid, user, args);
            break;

        case '/updatetask':
            await handleUpdateTask(sock, remoteJid, user, args);
            break;

        case '/mytasks':
            await handleMyTasks(sock, remoteJid, user);
            break;

        case '/maintenance':
            await handleMaintenanceToggle(sock, remoteJid, user);
            break;

        case '/botstatus':
            await handleBotStatus(sock, remoteJid, user);
            break;
            await sock.sendMessage(remoteJid, { text: '❌ Perintah tidak dikenali. Ketik /help untuk bantuan.' });
    }
}

// Send main menu
async function sendMainMenu(sock, remoteJid, user) {
    if (!user) {
        const text = `
👋 *SELAMAT DATANG*
━━━━━━━━━━━━━━━━━━
📚 Bot Tugas IBIK

Anda belum terdaftar sebagai user.
Silakan hubungi admin untuk pendaftaran.

📞 *Admin:* ${config.ownerNumber || 'Hubungi super admin'}
        `;
        await sock.sendMessage(remoteJid, { text });
        return;
    }

    const isSuperAdmin = user.role === config.roles.SUPER_ADMIN;
    const isAdmin = user.role === config.roles.ADMIN;
    const isUser = user.role === config.roles.USER;

    let text = '';

    // ========== SUPER ADMIN MENU ==========
    if (isSuperAdmin) {
        const settings = await db.getSettings();
        const statusIcon = settings.botEnabled ? '🟢' : '🔴';
        const statusText = settings.botEnabled ? 'Aktif' : 'Nonaktif';

        text = `
👑 *SUPER ADMIN PANEL*
━━━━━━━━━━━━━━━━━━
👤 *Nama:* ${user.name}
🏷️ *Role:* SUPER ADMIN
📚 *Kelas:* ${user.class || '-'}
🤖 *Bot:* ${statusIcon} ${statusText}
━━━━━━━━━━━━━━━━━━

📌 *MENU UTAMA:*

📝 *1. Tugas Saya*
   → Lihat & update status tugas saya

👥 *2. Kelola User*
   → Tambah, edit, hapus user

📚 *3. Kelola Tugas*
   → Lihat, buat, edit, hapus tugas

🔔 *4. Pengingat*
   → Kirim pengingat tugas

📊 *5. Statistik*
   → Lihat statistik bot

⚙️ *6. Pengaturan*
   → Pengaturan & maintenance bot

❓ *7. Bantuan*
   → Panduan penggunaan
━━━━━━━━━━━━━━━━━━

💡 Ketik angka untuk memilih menu
   Contoh: ketik "1" untuk lihat tugas
        `;
    }
    // ========== ADMIN MENU ==========
    else if (isAdmin) {
        text = `
⭐ *ADMIN PANEL*
━━━━━━━━━━━━━━━━━━
👤 *Nama:* ${user.name}
🏷️ *Role:* ADMIN
📚 *Kelas:* ${user.class || '-'}
━━━━━━━━━━━━━━━━━━

📌 *MENU UTAMA:*

📝 *1. Tugas Saya*
   → Lihat & update status tugas saya

📚 *2. Semua Tugas*
   → Lihat daftar semua tugas

➕ *3. Buat Tugas*
   → Membuat tugas baru

🔔 *4. Pengingat*
   → Kirim pengingat ke user

❓ *5. Bantuan*
   → Panduan penggunaan
━━━━━━━━━━━━━━━━━━

💡 Ketik angka untuk memilih menu
   Contoh: ketik "1" untuk lihat tugas
        `;
    }
    // ========== USER MENU ==========
    else {
        text = `
📚 *BOT TUGAS IBIK*
━━━━━━━━━━━━━━━━━━
👤 *Nama:* ${user.name}
🏷️ *Role:* USER
📚 *Kelas:* ${user.class || '-'}
━━━━━━━━━━━━━━━━━━

📌 *MENU UTAMA:*

📝 *1. Tugas Saya*
   → Lihat & update status tugas saya

📋 *2. Update Status*
   → Update status tugas (ketik nomor tugas)

❓ *3. Bantuan*
   → Panduan penggunaan
━━━━━━━━━━━━━━━━━━

💡 Ketik angka untuk memilih menu
   Contoh: ketik "1" untuk lihat tugas
        `;
    }

    await sock.sendMessage(remoteJid, { text });
}

// Send help
async function sendHelp(sock, remoteJid, user) {
    const isAdmin = user && (user.role === config.roles.SUPER_ADMIN || user.role === config.roles.ADMIN);

    if (!isAdmin) {
        await sock.sendMessage(remoteJid, { text: `
📚 *PANDUAN BOT TUGAS IBIK*
━━━━━━━━━━━━━━━━━━

📝 *Perintah untuk User:*

📋 *TUGAS SAYA*
   Ketik: 1 atau "tugas saya"
   → Lihat tugas yang ditugaskan

📝 *UPDATE STATUS TUGAS*
   Ketik: /updatetask [id] [status]
   Status: not_started, in_progress, completed
   Contoh: /updatetask 12345 completed

📖 *INFO TUGAS*
   Ketik: /taskinfo [id]
   Contoh: /taskinfo 12345

━━━━━━━━━━━━━━━━━━

💡 *Tips:*
• Ketik angka untuk memilih menu
• Lihat ID tugas di menu Tugas Saya
• Update status secara berkala
        ` });
    } else {
        await sock.sendMessage(remoteJid, { text: `
📚 *PANDUAN BOT TUGAS IBIK*
━━━━━━━━━━━━━━━━━━

👑 *PERINTAH ADMIN:*

👤 *1. Tambah User*
   → Ketik di Admin Panel

📚 *2. Buat Tugas*
   → Ketik di Admin Panel

📋 *3. Daftar Tugas*
   → Ketik: 2 atau "semua tugas"

👥 *4. Daftar User*
   → Ketik di Admin Panel

🔔 *5. Pengingat*
   → Ketik di Admin Panel

🔧 *6. Maintenance*
   → Aktifkan/Nonaktifkan bot

━━━━━━━━━━━━━━━━━━

📖 *PERINTAH UNIVERSAL:*

📝 */mytasks* - Tugas saya
📝 */menu* - Menu utama

📖 *PERINTAH ADMIN:*
📝 */addtask* - Buat tugas baru
📝 */edittask* - Edit tugas (via nomor)
📝 */deletetask [id]* - Hapus tugas
📝 */taskinfo [id]* - Info tugas
📝 */remindtask [id]* - Kirim pengingat
📝 */maintenance* - Toggle maintenance mode
📝 */botstatus* - Lihat status bot

━━━━━━━━━━━━━━━━━━

💡 *Tips:*
• Ketik angka untuk navigasi cepat
• Lihat ID tugas untuk update status
• Kirim pengingat sebelum deadline
• Ketik *cancel* untuk membatalkan proses input
        ` });
    }
}

// Handle add user (admin only)
async function handleAddUser(sock, remoteJid, user) {
    if (!user || (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN)) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    userStates.set(remoteJid, {
        step: 'add_user_phone',
        data: {}
    });

    await sock.sendMessage(remoteJid, { text: `
👤 *TAMBAH USER BARU*
━━━━━━━━━━━━━━━━━━

Masukkan nomor telepon user baru:
Format: 6281234567890 (tanpa + atau 0 di depan)

Ketik *cancel* untuk batal.
    ` });
}

// Handle add task (admin only)
async function handleAddTask(sock, remoteJid, user) {
    if (!user || (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN)) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    userStates.set(remoteJid, {
        step: 'add_task_name',
        data: {}
    });

    await sock.sendMessage(remoteJid, { text: `
📝 *BUAT TUGAS BARU*
━━━━━━━━━━━━━━━━━━

✅ Langkah 1 dari 4

📋 *Nama Tugas:*
Masukkan nama tugas yang akan diberikan.

💡 Contoh: "Tugas UTS Pemrograman Web"

Ketik *cancel* untuk batal.
    ` });
}

// Handle list tasks
async function handleListTasks(sock, remoteJid, user) {
    if (!user) {
        await sock.sendMessage(remoteJid, { text: '❌ Anda belum terdaftar.' });
        return;
    }

    const tasks = await db.getAllTasks();
    let assignments = null;

    if (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN) {
        assignments = await db.getUserTasks(user.phone);
    }

    const message = helpers.formatTaskList(tasks, assignments);
    await sock.sendMessage(remoteJid, { text: message });
}

// Handle task detail
async function handleTaskDetail(sock, remoteJid, user, args) {
    if (!user || (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN)) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    if (!args) {
        await sock.sendMessage(remoteJid, { text: '❌ Masukkan ID tugas. Contoh: /taskdetail 1234567890' });
        return;
    }

    const task = await db.getTaskById(args);
    if (!task) {
        await sock.sendMessage(remoteJid, { text: '❌ Tugas tidak ditemukan.' });
        return;
    }

    const assignments = await db.getTaskAssignments(args);
    const stats = await db.getTaskStats(args);

    let message = helpers.formatTaskMessage(task);
    message += `\n\n📊 *Statistik:*\n`;
    message += `✅ Selesai: ${stats.completed}\n`;
    message += `⏳ Belum Selesai: ${stats.notCompleted}\n`;
    message += `📊 Total: ${stats.total}\n`;

    await sock.sendMessage(remoteJid, { text: message });
}

// Handle remind task
async function handleRemindTask(sock, remoteJid, user, args) {
    if (!user || (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN)) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    if (!args) {
        await sock.sendMessage(remoteJid, { text: '❌ Masukkan ID tugas. Contoh: /remindtask 1234567890' });
        return;
    }

    const task = await db.getTaskById(args);
    if (!task) {
        await sock.sendMessage(remoteJid, { text: '❌ Tugas tidak ditemukan.' });
        return;
    }

    const usersNotCompleted = await db.getUsersNotCompletedTask(args);

    if (usersNotCompleted.length === 0) {
        await sock.sendMessage(remoteJid, { text: '✅ Semua user sudah menyelesaikan tugas ini!' });
        return;
    }

    const message = helpers.formatUsersNotCompleted(task, usersNotCompleted);
    await sock.sendMessage(remoteJid, { text: message });

    const reminderMsg = config.messages.taskReminder(task.name, helpers.formatDate(task.deadline));
    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < usersNotCompleted.length; i++) {
        const assignment = usersNotCompleted[i];
        const result = await sendMessageWithTimeout(
            sock,
            `${assignment.userPhone}@s.whatsapp.net`,
            { text: reminderMsg },
            8000 // 8 seconds timeout
        );

        if (result.success) {
            sentCount++;
        } else {
            failedCount++;
            console.log(`Reminder skipped for ${assignment.userPhone}: ${result.error}`);
        }

        // Add delay between sends to prevent rate limiting
        if ((i + 1) % MAX_CONCURRENT_SENDS === 0) {
            await new Promise(resolve => setTimeout(resolve, MESSAGE_SEND_DELAY));
        }
    }

    await sock.sendMessage(remoteJid, { text: `✅ Pengingat telah dikirim ke ${sentCount} user.${failedCount > 0 ? ` Gagal: ${failedCount}.` : ''}` });
}

// Handle list users
async function handleListUsers(sock, remoteJid, user) {
    if (!user || (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN)) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    const users = await db.getAllUsers();
    const message = helpers.formatUserList(users);
    await sock.sendMessage(remoteJid, { text: message });
}

// Handle delete task
async function handleDeleteTask(sock, remoteJid, user, args) {
    if (!user || (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN)) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    if (!args) {
        await sock.sendMessage(remoteJid, { text: '❌ Masukkan ID tugas. Contoh: /deletetask 1234567890' });
        return;
    }

    const task = await db.getTaskById(args);
    if (!task) {
        await sock.sendMessage(remoteJid, { text: '❌ Tugas tidak ditemukan.' });
        return;
    }

    await db.deleteTask(args);
    await sock.sendMessage(remoteJid, { text: `✅ Tugas "${task.name}" berhasil dihapus.` });
}

// Handle my tasks - improved with number selection and detail view
async function handleMyTasks(sock, remoteJid, user) {
    if (!user) {
        await sock.sendMessage(remoteJid, { text: '❌ Anda belum terdaftar.' });
        return;
    }

    const userTasks = await db.getUserTasks(user.phone);

    if (userTasks.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Anda belum memiliki tugas yang ditugaskan.' });
        return;
    }

    // Store tasks for selection
    const tasksWithData = [];
    for (const assignment of userTasks) {
        const task = await db.getTaskById(assignment.taskId);
        if (task) {
            tasksWithData.push({ assignment, task });
        }
    }

    let message = `📋 *TUGAS SAYA*
━━━━━━━━━━━━━━━━━━
📊 Total: ${tasksWithData.length} tugas

Pilih nomor untuk lihat detail:
`;

    tasksWithData.forEach(({ assignment, task }, index) => {
        message += `\n${index + 1}. ${helpers.getStatusEmoji(assignment.status)} *${task.name}*
   📖 ${task.class}
   ⏰ ${helpers.formatDaysRemaining(task.deadline)}
   📊 ${helpers.getStatusText(assignment.status)}`;
    });

    message += `\n━━━━━━━━━━━━━━━━━━
💡 Ketik nomor tugas (1-${tasksWithData.length})
   untuk lihat detail lengkap.`;

    userStates.set(remoteJid, {
        step: 'my_tasks_detail',
        data: { tasks: tasksWithData }
    });

    await sock.sendMessage(remoteJid, { text: message });
}

// Handle my tasks detail - show task detail when user picks a number
async function handleMyTasksDetail(sock, remoteJid, user, state, messageInput) {
    const idx = parseInt(messageInput) - 1;
    const tasks = state.data.tasks;

    if (messageInput.toLowerCase() === 'menu' || messageInput === '/menu') {
        userStates.delete(remoteJid);
        await sendMainMenu(sock, remoteJid, user);
        return;
    }

    if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${tasks.length}.\n\nKetik *menu* untuk kembali.`
        });
        return;
    }

    const { assignment, task } = tasks[idx];

    let messageText = `📚 *DETAIL TUGAS*
━━━━━━━━━━━━━━━━━━
📝 *Nama:* ${task.name}
🏫 *Kelas:* ${task.class}
📄 *Detail:* ${task.detail || '-'}
⏰ *Deadline:* ${helpers.formatDate(task.deadline)}
📅 *Ditugaskan:* ${helpers.formatDate(assignment.assignedAt)}
━━━━━━━━━━━━━━━━━━
📊 *STATUS SAYA:*
${helpers.getStatusEmoji(assignment.status)} ${helpers.getStatusText(assignment.status)}
━━━━━━━━━━━━━━━━━━
🔄 *UPDATE STATUS:*
Ketik angka untuk ubah status:

1️⃣ ❌ Belum Mulai
2️⃣ 🔄 Sedang Dikerjakan
3️⃣ ✅ Selesai

Ketik nomor (1/2/3) atau *menu* untuk kembali.`;

    state.step = 'my_tasks_update_status';
    state.data.selectedTask = task;
    state.data.selectedAssignment = assignment;

    await sock.sendMessage(remoteJid, { text: messageText });
}

// Handle my tasks update status
async function handleMyTasksUpdateStatus(sock, remoteJid, user, state, messageInput) {
    const statusMap = { '1': 'not_started', '2': 'in_progress', '3': 'completed' };
    const statusLabels = { 'not_started': 'Belum Mulai', 'in_progress': 'Sedang Dikerjakan', 'completed': 'Selesai' };

    if (messageInput.toLowerCase() === 'menu' || messageInput === '/menu') {
        userStates.delete(remoteJid);
        await sendMainMenu(sock, remoteJid, user);
        return;
    }

    const status = statusMap[messageInput];

    if (!status) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Pilihan tidak valid.\n\n1️⃣ ❌ Belum Mulai\n2️⃣ 🔄 Sedang Dikerjakan\n3️⃣ ✅ Selesai\n\nKetik nomor atau *menu* untuk kembali.`
        });
        return;
    }

    const task = state.data.selectedTask;
    const updated = await db.updateTaskStatus(task.id, user.phone, status);

    if (updated) {
        await sock.sendMessage(remoteJid, {
            text: `✅ *STATUS BERHASIL DIUPDATE!*

📝 *Tugas:* ${task.name}
📊 *Status Baru:* ${helpers.getStatusEmoji(status)} ${statusLabels[status]}
━━━━━━━━━━━━━━━━━━
Ketik *menu* untuk kembali ke menu utama.`
        });
    } else {
        await sock.sendMessage(remoteJid, { text: '❌ Gagal mengupdate status.' });
    }

    userStates.delete(remoteJid);
}

// Handle update task
async function handleUpdateTask(sock, remoteJid, user, args) {
    if (!user) {
        await sock.sendMessage(remoteJid, { text: '❌ Anda belum terdaftar.' });
        return;
    }

    const parts = args.split(' ');
    if (parts.length < 2) {
        await sock.sendMessage(remoteJid, { text:
            '❌ Format salah. Contoh: /updatetask [id_tugas] [status]\n\n' +
            'Status yang tersedia:\n' +
            '• not_started - Belum mulai\n' +
            '• in_progress - Sedang dikerjakan\n' +
            '• completed - Selesai'
        });
        return;
    }

    const taskId = parts[0];
    const status = parts[1];

    if (!['not_started', 'in_progress', 'completed'].includes(status)) {
        await sock.sendMessage(remoteJid, { text: '❌ Status tidak valid. Gunakan: not_started, in_progress, atau completed' });
        return;
    }

    const updated = await db.updateTaskStatus(taskId, user.phone, status);
    if (updated) {
        const task = await db.getTaskById(taskId);
        await sock.sendMessage(remoteJid, { text:
            `✅ Status tugas "${task.name}" berhasil diupdate!\n\n` +
            `📊 Status Baru: ${helpers.getStatusEmoji(status)} ${helpers.getStatusText(status)}`
        });
    } else {
        await sock.sendMessage(remoteJid, { text: '❌ Tugas tidak ditemukan atau Anda tidak memiliki akses ke tugas ini.' });
    }
}

// Handle task info
async function handleTaskInfo(sock, remoteJid, user, args) {
    if (!user) {
        await sock.sendMessage(remoteJid, { text: '❌ Anda belum terdaftar.' });
        return;
    }

    if (!args) {
        await sock.sendMessage(remoteJid, { text: '❌ Masukkan ID tugas. Contoh: /taskinfo 1234567890' });
        return;
    }

    const task = await db.getTaskById(args);
    if (!task) {
        await sock.sendMessage(remoteJid, { text: '❌ Tugas tidak ditemukan.' });
        return;
    }

    const assignment = await db.getTaskAssignments(args).then(assignments =>
        assignments.find(a => a.userPhone === user.phone)
    );

    const message = helpers.formatTaskMessage(task, assignment);
    await sock.sendMessage(remoteJid, { text: message });
}

// Handle user state (multi-step commands)
async function handleUserState(sock, remoteJid, message, user) {
    const state = userStates.get(remoteJid);

    // If no user, check if owner by phone
    let effectiveUser = user;
    if (!effectiveUser) {
        const userPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@whatsapp.net', '');
        const isOwner = userPhone === config.ownerNumber;
        if (isOwner) {
            effectiveUser = {
                phone: userPhone,
                name: 'Owner',
                role: config.roles.SUPER_ADMIN,
                class: 'TI'
            };
        }
    }

    switch (state.step) {
        case 'add_user_phone':
            if (message.toLowerCase() === 'cancel' || message.toLowerCase() === 'batal') {
                userStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: '✅ Penambahan user dibatalkan.\n\nKetik *menu* untuk kembali.' });
                return;
            }
            if (!helpers.isValidPhoneNumber(message)) {
                await sock.sendMessage(remoteJid, { text: `
❌ *Format nomor telepon tidak valid*

Format: 6281234567890
(tanpa + atau 0 di depan)

Ketik *cancel* untuk batal.
                ` });
                return;
            }
            state.data.phone = message;
            state.step = 'add_user_name';
            await sock.sendMessage(remoteJid, { text: `
👤 *TAMBAH USER - LANGKAH 2/4*
━━━━━━━━━━━━━━━━━━

Masukkan nama lengkap user:

Ketik *cancel* untuk batal.
            ` });
            break;

        case 'add_user_name':
            if (message.toLowerCase() === 'cancel' || message.toLowerCase() === 'batal') {
                userStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: '✅ Penambahan user dibatalkan.\n\nKetik *menu* untuk kembali.' });
                return;
            }
            state.data.name = message;
            state.step = 'add_user_role';
            await sock.sendMessage(remoteJid, { text: `
👤 *TAMBAH USER - LANGKAH 3/4*
━━━━━━━━━━━━━━━━━━

Pilih role user:

1️⃣ *super_admin* - Super Admin
   → Akses penuh ke semua fitur

2️⃣ *admin* - Admin
   → Kelola tugas dan user

3️⃣ *user* - User Biasa
   → Hanya lihat & update tugas sendiri

Masukkan nomor (1/2/3):
Ketik *cancel* untuk batal.
            ` });
            break;

        case 'add_user_role':
            if (message.toLowerCase() === 'cancel' || message.toLowerCase() === 'batal') {
                userStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: '✅ Penambahan user dibatalkan.\n\nKetik *menu* untuk kembali.' });
                return;
            }
            const roleMap = { '1': 'super_admin', '2': 'admin', '3': 'user' };
            const selectedRole = roleMap[message];

            if (!selectedRole) {
                await sock.sendMessage(remoteJid, { text: '❌ Pilihan tidak valid. Masukkan 1, 2, atau 3.\n\nKetik *cancel* untuk batal.' });
                return;
            }

            state.data.role = selectedRole;
            state.step = 'add_user_kelas';
            await sock.sendMessage(remoteJid, { text: `
👤 *TAMBAH USER - LANGKAH 4/4*
━━━━━━━━━━━━━━━━━━

Masukkan nama kelas:
Contoh: TI-3A, SI-2B, MI-1A

(ketik "-" jika tidak ada kelas)

Ketik *cancel* untuk batal.
            ` });
            break;

        case 'add_user_kelas':
            if (message.toLowerCase() === 'cancel' || message.toLowerCase() === 'batal') {
                userStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: '✅ Penambahan user dibatalkan.\n\nKetik *menu* untuk kembali.' });
                return;
            }
            state.data.class = message === '-' ? 'Tanpa Kelas' : message;

            try {
                await db.addUser(state.data);
                await sock.sendMessage(remoteJid, { text: `
✅ *USER BERHASIL DITAMBAHKAN*
━━━━━━━━━━━━━━━━━━
👤 *Nama:* ${state.data.name}
📱 *No. HP:* ${state.data.phone}
🏷️ *Role:* ${state.data.role.toUpperCase()}
📚 *Kelas:* ${state.data.class}
━━━━━━━━━━━━━━━━━━
                ` });
                userStates.delete(remoteJid);
            } catch (error) {
                await sock.sendMessage(remoteJid, { text: '❌ Gagal menambahkan user. Nomor telepon mungkin sudah terdaftar.' });
                userStates.delete(remoteJid);
            }
            break;

        case 'add_task_name':
            if (message.toLowerCase() === 'cancel' || message.toLowerCase() === 'batal') {
                userStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: '✅ Pembuatan tugas dibatalkan.\n\nKetik *menu* untuk kembali.' });
                return;
            }
            state.data.name = message;
            state.step = 'add_task_class';
            await sock.sendMessage(remoteJid, { text: `
📝 *BUAT TUGAS BARU*
━━━━━━━━━━━━━━━━━━

✅ Langkah 2 dari 4

📋 *Nama Tugas:* ${message}

🏫 *Kelas/Prodi:*
Masukkan nama kelas atau prodi.
Contoh: TI-3A, SI-2B, MI-1A

💡 Ketik "-" jika tidak ada kelas tertentu.

Ketik *cancel* untuk batal.
            ` });
            break;

        case 'add_task_class':
            if (message.toLowerCase() === 'cancel' || message.toLowerCase() === 'batal') {
                userStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: '✅ Pembuatan tugas dibatalkan.\n\nKetik *menu* untuk kembali.' });
                return;
            }
            state.data.class = message === '-' ? 'Semua Kelas' : message;
            state.step = 'add_task_detail';
            await sock.sendMessage(remoteJid, { text: `
📝 *BUAT TUGAS BARU*
━━━━━━━━━━━━━━━━━━

✅ Langkah 3 dari 4

📋 *Nama:* ${state.data.name}
🏫 *Kelas:* ${state.data.class}

📄 *Detail Tugas:*
Jelaskan isi atau instruksi tugas secara singkat.

💡 Contoh: "Buatlah resume artikel tentang React Hooks"

Ketik *cancel* untuk batal.
            ` });
            break;

        case 'add_task_detail':
            if (message.toLowerCase() === 'cancel' || message.toLowerCase() === 'batal') {
                userStates.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: '✅ Pembuatan tugas dibatalkan.\n\nKetik *menu* untuk kembali.' });
                return;
            }
            state.data.detail = message;
            state.step = 'add_task_deadline';
            await sock.sendMessage(remoteJid, { text: `
📝 *BUAT TUGAS BARU*
━━━━━━━━━━━━━━━━━━

✅ Langkah 4 dari 4

📋 *Nama:* ${state.data.name}
🏫 *Kelas:* ${state.data.class}
📄 *Detail:* ${message}

⏰ *Deadline / Batas Waktu:*

Pilih format sesuai keinginan:

📅 *Format Tanggal:*
  • DD/MM/YYYY  →  contoh: 25/12/2026
  • DD/MM       →  contoh: 25/12 (tahun ini)

📆 *Kata Kunci:*
  • besok       →  besok hari
  • lusa         →  2 hari lagi
  • minggu depan →  7 hari lagi

💡 Contoh: ketik "25/12/2026" atau "besok"

Ketik *cancel* untuk batal.
            ` });
            break;

        case 'add_task_deadline':
            const deadline = helpers.parseDeadline(message);
            if (!deadline) {
                await sock.sendMessage(remoteJid, { text: '❌ Format deadline tidak valid. Coba lagi.' });
                return;
            }

            state.data.deadline = deadline;

            try {
                const task = await db.addTask(state.data);

                await db.assignTaskToAllUsers(task.id);

                const users = await db.getAllUsers();
                const notification = config.messages.newTaskNotification(
                    task.name,
                    helpers.formatDate(task.deadline),
                    task.class
                );

                // First: Send success message to admin IMMEDIATELY
                await sock.sendMessage(remoteJid, {
                    text: config.messages.taskCreated(
                        task.name,
                        helpers.formatDate(task.deadline),
                        state.data.class,
                        state.data.detail
                    )
                });
                userStates.delete(remoteJid);

                // Second: Send notifications in BACKGROUND (fire and forget)
                // This won't block the response to admin
                sendNotificationsInBackground(sock, users, notification)
                    .then(() => console.log('All notifications sent'))
                    .catch(err => console.log('Notification batch error:', err.message));

            } catch (error) {
                console.error('Error creating task:', error);
                await sock.sendMessage(remoteJid, { text: `
❌ *GAGAL MEMBUAT TUGAS*

Terjadi kesalahan saat menyimpan tugas.
Silakan coba beberapa saat lagi.

Ketik *menu* untuk kembali ke menu utama.
                ` });
                userStates.delete(remoteJid);
            }
            break;

        case 'update_task_with_status':
            const taskId = message.trim();
            const task = await db.getTaskById(taskId);

            if (!task) {
                await sock.sendMessage(remoteJid, { text: '❌ Tugas tidak ditemukan. Coba lagi.' });
                return;
            }

            const updated = await db.updateTaskStatus(taskId, user.phone, state.data.status);
            if (updated) {
                await sock.sendMessage(remoteJid, { text:
                    `✅ Status tugas "${task.name}" berhasil diupdate!\n\n` +
                    `📊 Status Baru: ${helpers.getStatusEmoji(state.data.status)} ${helpers.getStatusText(state.data.status)}`
                });
            } else {
                await sock.sendMessage(remoteJid, { text: '❌ Gagal mengupdate status. Anda mungkin tidak memiliki akses ke tugas ini.' });
            }
            userStates.delete(remoteJid);
            break;

        case 'super_admin_user_menu':
            await handleSuperAdminUserMenu(sock, remoteJid, message, user);
            break;

        case 'super_admin_task_menu':
            await handleSuperAdminTaskMenu(sock, remoteJid, message, user);
            break;

        // ========== MY TASKS DETAIL (ALL USERS) ==========
        case 'my_tasks_detail':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleMyTasksDetail(sock, remoteJid, user, state, message);
            break;

        case 'my_tasks_update_status':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleMyTasksUpdateStatus(sock, remoteJid, user, state, message);
            break;

        // ========== TASK UPDATE BY NUMBER (USER) ==========
        case 'update_status_pick_task':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleUpdateStatusPickTask(sock, remoteJid, user, state, message);
            break;

        case 'update_status_pick_new_status':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleUpdateStatusPickNewStatus(sock, remoteJid, user, state, message);
            break;

        // ========== TASK CRUD (SUPER ADMIN) ==========
        case 'edit_task_pick':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleEditTaskPick(sock, remoteJid, user, state, message);
            break;

        case 'edit_task_field':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleEditTaskField(sock, remoteJid, user, state, message);
            break;

        case 'edit_task_value':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleEditTaskValue(sock, remoteJid, user, state, message);
            break;

        case 'delete_task_pick':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleDeleteTaskPick(sock, remoteJid, user, state, message);
            break;

        case 'delete_task_confirm':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleDeleteTaskConfirmState(sock, remoteJid, user, state, message);
            break;

        // ========== DETAIL USER (PICK + SHOW) ==========
        case 'detail_user_pick':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleDetailUserPick(sock, remoteJid, user, state, message);
            break;

        case 'detail_user_tasks':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleDetailUserTaskPick(sock, remoteJid, user, state, message);
            break;

        // ========== REMIND TASK (SUPER ADMIN) ==========
        case 'remind_task_pick':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleRemindTaskPick(sock, remoteJid, user, state, message);
            break;

        case 'remind_task_confirm':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleRemindTaskConfirm(sock, remoteJid, user, state, message);
            break;

        // ========== TASK DETAIL (ADMIN) ==========
        case 'task_detail_pick':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendSuperAdminTaskMenu(sock, remoteJid, user);
                return;
            }
            await handleTaskDetailPick(sock, remoteJid, user, state, message);
            break;

        // ========== USER EDIT (SUPER ADMIN) ==========
        case 'edit_user_pick':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleEditUserPick(sock, remoteJid, user, state, message);
            break;

        case 'edit_user_field':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleEditUserField(sock, remoteJid, user, state, message);
            break;

        case 'edit_user_value':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleEditUserValue(sock, remoteJid, user, state, message);
            break;

        // ========== DELETE USER ==========
        case 'delete_user_pick':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleDeleteUserPick(sock, remoteJid, user, state, message);
            break;

        case 'delete_user_confirm':
            if (message === 'menu' || message === '/menu') {
                userStates.delete(remoteJid);
                await sendMainMenu(sock, remoteJid, user);
                return;
            }
            await handleDeleteUserConfirm(sock, remoteJid, user, state, message);
            break;

        default:
            userStates.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: '❌ Terjadi kesalahan. Silakan coba lagi.' });
    }
}

// Handle button responses
async function handleButtonResponse(sock, remoteJid, buttonResponse) {
    const buttonId = buttonResponse.selectedButtonId;
    const userPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@whatsapp.net', '');
    let user = await db.getUserByPhone(userPhone);

    // Check if user is owner
    const isOwner = userPhone === config.ownerNumber;
    if (isOwner && !user) {
        user = {
            phone: userPhone,
            name: 'Owner',
            role: config.roles.SUPER_ADMIN,
            class: 'TI'
        };
    }

    console.log(`🔘 Button clicked: ${buttonId} by ${remoteJid}`);

    switch (buttonId) {
        // Main menu buttons
        case 'btn_mytasks':
            await handleMyTasks(sock, remoteJid, user);
            break;

        case 'btn_alltasks':
            await handleListTasks(sock, remoteJid, user);
            break;

        case 'btn_addtask':
            await handleAddTask(sock, remoteJid, user);
            break;

        case 'btn_help':
            await sendHelp(sock, remoteJid, user);
            break;

        case 'btn_admin_panel':
            if (!user || (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN)) {
                await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
            } else {
                await sendAdminMenu(sock, remoteJid, user);
            }
            break;

        case 'btn_back':
            await sendMainMenu(sock, remoteJid, user);
            break;

        // Admin panel buttons
        case 'btn_add_user':
            await handleAddUser(sock, remoteJid, user);
            break;

        case 'btn_add_task':
            await handleAddTask(sock, remoteJid, user);
            break;

        case 'btn_list_users':
            await handleListUsers(sock, remoteJid, user);
            break;

        case 'btn_list_tasks':
            await handleListTasks(sock, remoteJid, user);
            break;

        case 'btn_remind':
            await handleRemindMenu(sock, remoteJid, user);
            break;

        // Status buttons
        case 'btn_status_not_started':
        case 'btn_status_in_progress':
        case 'btn_status_completed':
            await handleStatusButton(sock, remoteJid, user, buttonId);
            break;

        // Legacy button IDs (backward compatibility)
        case 'mytasks':
            await handleMyTasks(sock, remoteJid, user);
            break;

        case 'alltasks':
            await handleListTasks(sock, remoteJid, user);
            break;

        case 'addtask':
            await handleAddTask(sock, remoteJid, user);
            break;

        case 'admin':
            if (!user || (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN)) {
                await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
            } else {
                await sendAdminMenu(sock, remoteJid, user);
            }
            break;

        case 'help':
            await sendHelp(sock, remoteJid, user);
            break;

        case 'add_user':
            await handleAddUser(sock, remoteJid, user);
            break;

        case 'list_users':
            await handleListUsers(sock, remoteJid, user);
            break;

        case 'remind':
            await handleRemindMenu(sock, remoteJid, user);
            break;

        case 'back':
            await sendMainMenu(sock, remoteJid, user);
            break;

        case 'status_not_started':
        case 'status_in_progress':
        case 'status_completed':
            await handleStatusButton(sock, remoteJid, user, buttonId);
            break;

        default:
            await sock.sendMessage(remoteJid, { text: '❌ Perintah tidak dikenali.' });
    }
}

// Handle status button for task update
async function handleStatusButton(sock, remoteJid, user, buttonId) {
    if (!user) {
        await sock.sendMessage(remoteJid, { text: '❌ Anda belum terdaftar.' });
        return;
    }

    // Handle both old and new button ID formats
    let status = buttonId.replace('status_', '').replace('btn_status_', '');

    const statusButtons = [
        { buttonId: 'btn_status_not_started', buttonText: { displayText: '❌ Belum Mulai' }, type: 1 },
        { buttonId: 'btn_status_in_progress', buttonText: { displayText: '🔄 Dikerjakan' }, type: 1 },
        { buttonId: 'btn_status_completed', buttonText: { displayText: '✅ Selesai' }, type: 1 }
    ];

    await sock.sendMessage(remoteJid, {
        text: `📝 *UPDATE STATUS*\n\nPilih status baru:\n• ❌ Belum Mulai\n• 🔄 Sedang Dikerjakan\n• ✅ Selesai\n\nAtau ketik: /updatetask [id_tugas] [status]\nContoh: /updatetask 123456 completed`,
        footer: config.botName,
        buttons: statusButtons
    });

    userStates.set(remoteJid, {
        step: 'update_task_with_status',
        data: { status }
    });
}

// Handle list responses
async function handleListResponse(sock, remoteJid, listResponse) {
    const selectedId = listResponse.singleSelectReply.selectedRowId;
    console.log(`📋 List item selected: ${selectedId} by ${remoteJid}`);

    await sock.sendMessage(remoteJid, { text: `✅ Anda memilih: ${selectedId}` });
}

// Send admin menu
async function sendAdminMenu(sock, remoteJid, user) {
    const text = `
⚙️ *ADMIN PANEL*
━━━━━━━━━━━━━━━━━━

👑 *Admin:* ${user.name}

📌 *MENU ADMIN:*

👤 *1. Tambah User*
   → Menambah user baru

📚 *2. Buat Tugas*
   → Membuat tugas baru

📋 *3. Daftar Tugas*
   → Melihat semua tugas

👥 *4. Daftar User*
   → Melihat semua user

🔔 *5. Pengingat*
   → Mengirim pengingat tugas

🔙 *6. Kembali*
   → Kembali ke menu utama
━━━━━━━━━━━━━━━━━━

💡 Ketik angka untuk memilih menu
   Contoh: ketik "1" untuk tambah user
        `;

    await sock.sendMessage(remoteJid, { text });
}

// Send Super Admin user management menu
async function sendSuperAdminUserMenu(sock, remoteJid, user) {
    userStates.set(remoteJid, {
        step: 'super_admin_user_menu',
        data: {}
    });

    const text = `
👤 *KELOLA USER*
━━━━━━━━━━━━━━━━━━

👑 *Admin:* ${user.name}

📌 *MENU:*

📋 *1. Daftar & Detail User*
   → Lihat semua user & detail tugasnya

✏️ *2. Edit User*
   → Ubah nama, kelas, role

➕ *3. Tambah User*
   → Menambah user baru

🗑️ *4. Hapus User*
   → Hapus user dari sistem

🔙 *5. Kembali*
   → Kembali ke menu utama
━━━━━━━━━━━━━━━━━━

💡 Ketik angka untuk memilih menu
    `;

    await sock.sendMessage(remoteJid, { text });
}

// Handle Super Admin user menu selection
async function handleSuperAdminUserMenu(sock, remoteJid, message, user) {
    const msg = message.toLowerCase().trim();

    if (msg === '1' || msg.includes('daftar') || msg.includes('detail')) {
        userStates.delete(remoteJid);
        await handleDetailUserSelect(sock, remoteJid, user);
    } else if (msg === '2' || msg.includes('edit')) {
        userStates.delete(remoteJid);
        await handleEditUserSelect(sock, remoteJid, user);
    } else if (msg === '3' || msg.includes('tambah')) {
        userStates.delete(remoteJid);
        await handleAddUser(sock, remoteJid, user);
    } else if (msg === '4' || msg.includes('hapus')) {
        userStates.delete(remoteJid);
        await handleDeleteUserSelect(sock, remoteJid, user);
    } else if (msg === '5' || msg.includes('kembali')) {
        userStates.delete(remoteJid);
        await sendMainMenu(sock, remoteJid, user);
    } else if (msg === 'menu' || msg === '/menu' || msg === '/start') {
        userStates.delete(remoteJid);
        await sendMainMenu(sock, remoteJid, user);
    } else {
        await sock.sendMessage(remoteJid, { text: '❌ Pilihan tidak valid. Ketik 1, 2, 3, 4, atau 5.' });
    }
}

// ========== USER CRUD (SUPER ADMIN) ==========

// Detail user - select first
async function handleDetailUserSelect(sock, remoteJid, user) {
    const users = await db.getAllUsers();

    if (users.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Belum ada user terdaftar.' });
        return;
    }

    const messageText = helpers.formatUserListSelect(users);

    userStates.set(remoteJid, {
        step: 'detail_user_pick',
        data: { users }
    });

    await sock.sendMessage(remoteJid, { text: messageText });
}

// Show user detail with their tasks - improved with numbered list
async function handleDetailUserPick(sock, remoteJid, user, state, messageInput) {
    const idx = parseInt(messageInput) - 1;
    const users = state.data.users;

    if (isNaN(idx) || idx < 0 || idx >= users.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${users.length}.\n\nKetik *menu* untuk batal.`
        });
        return;
    }

    const selectedUser = users[idx];
    const roleEmoji = selectedUser.role === 'super_admin' ? '👑' : selectedUser.role === 'admin' ? '⭐' : '👤';
    const roleLabel = selectedUser.role === 'super_admin' ? 'SUPER_ADMIN' : selectedUser.role === 'admin' ? 'ADMIN' : 'USER';

    // Store selected user info
    state.data.selectedUser = selectedUser;
    state.step = 'detail_user_tasks';

    let messageText = `👤 *DETAIL USER*
━━━━━━━━━━━━━━━━━━
${roleEmoji} *${selectedUser.name}*
📱 ${selectedUser.phone}
🏷️ ${roleLabel}
🏫 ${selectedUser.class || '-'}
━━━━━━━━━━━━━━━━━━
📝 *TUGAS USER:*
`;

    const userTasks = await db.getUserTasks(selectedUser.phone);
    state.data.userTasks = [];

    if (userTasks.length === 0) {
        messageText += '   📭 Belum ada tugas.\n';
        messageText += '━━━━━━━━━━━━━━━━━━\nKetik *menu* untuk kembali.';
        userStates.delete(remoteJid);
        await sock.sendMessage(remoteJid, { text: messageText });
    } else {
        let taskNum = 0;
        for (const assignment of userTasks) {
            const task = await db.getTaskById(assignment.taskId);
            if (task) {
                taskNum++;
                state.data.userTasks.push({ assignment, task });
                messageText += `${taskNum}. ${helpers.getStatusEmoji(assignment.status)} *${task.name}*\n`;
                messageText += `   📖 ${task.class}\n`;
                messageText += `   📊 ${helpers.getStatusText(assignment.status)}\n`;
                messageText += `   ⏰ ${helpers.formatDaysRemaining(task.deadline)}\n`;
            }
        }

        messageText += `
━━━━━━━━━━━━━━━━━━
📋 *LIHAT DETAIL TUGAS:*
Ketik nomor tugas (1-${taskNum})
atau ketik *menu* untuk kembali.
`;
        await sock.sendMessage(remoteJid, { text: messageText });
    }
}

// Show task detail when user selects a task number
async function handleDetailUserTaskPick(sock, remoteJid, user, state, messageInput) {
    const idx = parseInt(messageInput) - 1;
    const tasks = state.data.userTasks;

    if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${tasks.length}.\n\nKetik *menu* untuk kembali.`
        });
        return;
    }

    const { assignment, task } = tasks[idx];

    let messageText = `📚 *DETAIL TUGAS*
━━━━━━━━━━━━━━━━━━
📝 *Nama:* ${task.name}
🏫 *Kelas:* ${task.class}
📄 *Detail:* ${task.detail || '-'}
⏰ *Deadline:* ${helpers.formatDate(task.deadline)}
━━━━━━━━━━━━━━━━━━
📊 *STATUS USER:*
${helpers.getStatusEmoji(assignment.status)} ${helpers.getStatusText(assignment.status)}
📅 *Ditugaskan:* ${helpers.formatDate(assignment.assignedAt)}
━━━━━━━━━━━━━━━━━━
Ketik *menu* untuk kembali.`;

    await sock.sendMessage(remoteJid, { text: messageText });
}

// Delete user - select first
async function handleDeleteUserSelect(sock, remoteJid, user) {
    const users = await db.getAllUsers();

    if (users.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Belum ada user terdaftar.' });
        return;
    }

    let messageText = '🗑️ *HAPUS USER*\n\nPilih nomor user yang ingin dihapus:\n\n';

    users.forEach((u, index) => {
        const roleEmoji = u.role === 'super_admin' ? '👑' : u.role === 'admin' ? '⭐' : '👤';
        messageText += `${index + 1}. ${roleEmoji} *${u.name}*\n`;
        messageText += `   📱 ${u.phone}\n`;
        messageText += `   🏫 ${u.class || '-'}\n\n`;
    });

    messageText += '⚠️ Perhatian: Menghapus user juga akan menghapus semua tugasnya.\n\nKetik *menu* untuk batal.';

    userStates.set(remoteJid, {
        step: 'delete_user_pick',
        data: { users }
    });

    await sock.sendMessage(remoteJid, { text: messageText });
}

// Delete user - confirm
async function handleDeleteUserPick(sock, remoteJid, user, state, messageInput) {
    const idx = parseInt(messageInput) - 1;
    const users = state.data.users;

    if (isNaN(idx) || idx < 0 || idx >= users.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${users.length}.\n\nKetik *menu* untuk batal.`
        });
        return;
    }

    const selectedUser = users[idx];

    await sock.sendMessage(remoteJid, {
        text: `⚠️ *KONFIRMASI HAPUS USER*
━━━━━━━━━━━━━━━━━━

👤 *${selectedUser.name}*
📱 ${selectedUser.phone}
🏫 ${selectedUser.class || '-'}

━━━━━━━━━━━━━━━━━━

Apakah Anda yakin ingin menghapus user ini?

1️⃣ *Ya, Hapus*
2️⃣ *Batal*`
    });

    userStates.set(remoteJid, {
        step: 'delete_user_confirm',
        data: { phone: selectedUser.phone, name: selectedUser.name }
    });
}

// Delete user - execute
async function handleDeleteUserConfirm(sock, remoteJid, user, state, messageInput) {
    const msg = messageInput.trim();

    if (msg === '1') {
        try {
            // First delete all task assignments for this user
            await db.deleteUserAssignments(state.data.phone);
            // Then delete the user
            await db.deleteUser(state.data.phone);
            await sock.sendMessage(remoteJid, {
                text: `✅ *USER BERHASIL DIHAPUS!*

🗑️ "${state.data.name}" telah dihapus dari sistem.`
            });
        } catch (error) {
            console.error('Error deleting user:', error);
            await sock.sendMessage(remoteJid, { text: '❌ Gagal menghapus user.' });
        }
    } else if (msg === '2') {
        await sock.sendMessage(remoteJid, { text: '✅ Penghapusan dibatalkan.\n\nKetik *menu* untuk kembali.' });
    } else {
        await sock.sendMessage(remoteJid, { text: '❌ Pilihan tidak valid.\n1️⃣ Ya, Hapus\n2️⃣ Batal\n\nKetik *menu* untuk batal.' });
        return;
    }

    userStates.delete(remoteJid);
}

// ========== USER EDIT (SUPER ADMIN) ==========

async function handleEditUserSelect(sock, remoteJid, user) {
    const users = await db.getAllUsers();

    if (users.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Belum ada user terdaftar.' });
        return;
    }

    let messageText = '✏️ *EDIT USER*\n\nPilih nomor user yang ingin diedit:\n\n';

    users.forEach((u, index) => {
        const roleEmoji = u.role === 'super_admin' ? '👑' : u.role === 'admin' ? '⭐' : '👤';
        messageText += `${index + 1}. ${roleEmoji} *${u.name}*\n`;
        messageText += `   📱 ${u.phone}\n`;
        messageText += `   🏫 ${u.class || '-'}\n`;
        messageText += `   🏷️ ${u.role.toUpperCase()}\n\n`;
    });

    messageText += 'Ketik *menu* untuk batal.';

    userStates.set(remoteJid, {
        step: 'edit_user_pick',
        data: { users }
    });

    await sock.sendMessage(remoteJid, { text: messageText });
}

async function handleEditUserPick(sock, remoteJid, user, state, messageInput) {
    const idx = parseInt(messageInput) - 1;
    const users = state.data.users;

    if (isNaN(idx) || idx < 0 || idx >= users.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${users.length}.\n\nKetik *menu* untuk batal.`
        });
        return;
    }

    const selectedUser = users[idx];
    state.step = 'edit_user_field';
    state.data.selectedPhone = selectedUser.phone;
    state.data.name = selectedUser.name;
    state.data.class = selectedUser.class || '';
    state.data.role = selectedUser.role;

    await sock.sendMessage(remoteJid, {
        text: `✏️ *EDIT USER: ${selectedUser.name}*
━━━━━━━━━━━━━━━━━━

Pilih field yang ingin diubah:

1️⃣ *Nama*
   → Saat ini: ${selectedUser.name}

2️⃣ *Kelas*
   → Saat ini: ${selectedUser.class || '-'}

3️⃣ *Role*
   → Saat ini: ${selectedUser.role.toUpperCase()}

4️⃣ *Simpan & Selesai*

5️⃣ *Batal*

Ketik nomor (1-5). Ketik *menu* untuk batal.`
    });
}

async function handleEditUserField(sock, remoteJid, user, state, messageInput) {
    const choice = messageInput.trim();

    if (choice.toLowerCase() === 'cancel' || choice.toLowerCase() === 'batal') {
        userStates.delete(remoteJid);
        await sock.sendMessage(remoteJid, { text: '✅ Edit user dibatalkan.\n\nKetik *menu* untuk kembali.' });
        return;
    }

    if (choice === '5') {
        userStates.delete(remoteJid);
        await sock.sendMessage(remoteJid, { text: '✅ Edit dibatalkan.' });
        return;
    }

    if (choice === '4') {
        const updated = await db.updateUser(state.data.selectedPhone, {
            name: state.data.name,
            class: state.data.class,
            role: state.data.role
        });
        userStates.delete(remoteJid);
        if (updated) {
            await sock.sendMessage(remoteJid, {
                text: `✅ *USER BERHASIL DIEDIT!*

👤 Nama: ${state.data.name}
🏫 Kelas: ${state.data.class}
🏷️ Role: ${state.data.role.toUpperCase()}`
            });
        } else {
            await sock.sendMessage(remoteJid, { text: '❌ Gagal menyimpan perubahan.' });
        }
        return;
    }

    if (!['1', '2', '3'].includes(choice)) {
        await sock.sendMessage(remoteJid, {
            text: '❌ Pilihan tidak valid. Ketik 1, 2, 3, 4, atau 5.'
        });
        return;
    }

    const fieldMap = {
        '1': { name: 'nama', step: 'edit_user_value', field: 'name' },
        '2': { name: 'kelas', step: 'edit_user_value', field: 'class' },
        '3': { name: 'role (1=super_admin, 2=admin, 3=user)', step: 'edit_user_value', field: 'role' }
    };

    const field = fieldMap[choice];
    state.step = 'edit_user_value';
    state.data.editingField = field.field;
    state.data.editingFieldName = field.name;

    await sock.sendMessage(remoteJid, {
        text: `✏️ *EDIT: ${field.name.toUpperCase()}*

Masukkan ${field.name} baru:

Ketik *menu* untuk batal, ketik *skip* untuk lewati.`
    });
}

async function handleEditUserValue(sock, remoteJid, user, state, messageInput) {
    const value = messageInput.trim();

    if (value.toLowerCase() === 'cancel' || value.toLowerCase() === 'batal') {
        userStates.delete(remoteJid);
        await sock.sendMessage(remoteJid, { text: '✅ Edit user dibatalkan.\n\nKetik *menu* untuk kembali.' });
        return;
    }

    if (value.toLowerCase() === 'skip') {
        await sock.sendMessage(remoteJid, {
            text: `⏭️ Dilewati. ${state.data.editingFieldName} tetap: *${state.data[state.data.editingField]}*`
        });
    } else {
        if (state.data.editingField === 'role') {
            const roleMap = { '1': 'super_admin', '2': 'admin', '3': 'user' };
            const newRole = roleMap[value];
            if (!newRole) {
                await sock.sendMessage(remoteJid, {
                    text: '❌ Role tidak valid. Ketik 1 (super_admin), 2 (admin), atau 3 (user).'
                });
                return;
            }
            state.data.role = newRole;
        } else {
            state.data[state.data.editingField] = value;
        }
    }

    state.step = 'edit_user_field';

    await sock.sendMessage(remoteJid, {
        text: `✏️ *EDIT USER*
━━━━━━━━━━━━━━━━━━

Pilih field lain yang ingin diubah:

1️⃣ *Nama*
   → Saat ini: ${state.data.name}

2️⃣ *Kelas*
   → Saat ini: ${state.data.class || '-'}

3️⃣ *Role*
   → Saat ini: ${state.data.role.toUpperCase()}

4️⃣ *Simpan & Selesai*

5️⃣ *Batal*

Ketik nomor (1-5). Ketik *menu* untuk batal.`
    });
}

// Send Super Admin Task CRUD menu
async function sendSuperAdminTaskMenu(sock, remoteJid, user) {
    userStates.set(remoteJid, {
        step: 'super_admin_task_menu',
        data: {}
    });

    const text = `📚 *KELOLA TUGAS*
━━━━━━━━━━━━━━━━━━
👑 *Admin:* ${user.name}
━━━━━━━━━━━━━━━━━━

📝 *1. Buat Tugas Baru*
   → Membuat tugas baru

📋 *2. Daftar Tugas*
   → Lihat semua tugas

👁️ *3. Detail Tugas*
   → Lihat detail & statistik tugas

✏️ *4. Edit Tugas*
   → Ubah nama, kelas, deadline

🗑️ *5. Hapus Tugas*
   → Hapus tugas

🔙 *6. Kembali*
   → Kembali ke menu utama
━━━━━━━━━━━━━━━━━━

💡 Ketik angka untuk memilih menu`;

    await sock.sendMessage(remoteJid, { text });
}

// Handle Super Admin task menu selection
async function handleSuperAdminTaskMenu(sock, remoteJid, message, user) {
    const msg = message.toLowerCase().trim();

    if (msg === '1' || msg.includes('buat')) {
        userStates.delete(remoteJid);
        await handleAddTask(sock, remoteJid, user);
    } else if (msg === '2' || msg.includes('daftar')) {
        userStates.delete(remoteJid);
        await handleListTasks(sock, remoteJid, user);
    } else if (msg === '3' || msg.includes('detail')) {
        userStates.delete(remoteJid);
        await handleTaskDetailSelect(sock, remoteJid, user);
    } else if (msg === '4' || msg.includes('edit')) {
        userStates.delete(remoteJid);
        await handleEditTaskSelect(sock, remoteJid, user);
    } else if (msg === '5' || msg.includes('hapus')) {
        userStates.delete(remoteJid);
        await handleDeleteTaskSelect(sock, remoteJid, user);
    } else if (msg === '6' || msg.includes('kembali')) {
        userStates.delete(remoteJid);
        await sendMainMenu(sock, remoteJid, user);
    } else if (msg === 'menu' || msg === '/menu' || msg === '/start') {
        userStates.delete(remoteJid);
        await sendMainMenu(sock, remoteJid, user);
    } else {
        await sock.sendMessage(remoteJid, { text: '❌ Pilihan tidak valid. Ketik 1, 2, 3, 4, 5, atau 6.' });
    }
}

// Handle task detail select - admin can view task details with stats
async function handleTaskDetailSelect(sock, remoteJid, user) {
    const tasks = await db.getAllTasks();

    if (tasks.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Belum ada tugas.' });
        return;
    }

    let message = `👁️ *DETAIL TUGAS*
━━━━━━━━━━━━━━━━━━
📊 Total: ${tasks.length} tugas

Pilih nomor tugas untuk lihat detail:
`;

    tasks.forEach((task, index) => {
        message += `${index + 1}. 📝 *${task.name}*\n`;
        message += `   📖 ${task.class}\n`;
        message += `   ⏰ ${helpers.formatDaysRemaining(task.deadline)}\n\n`;
    });

    message += '━━━━━━━━━━━━━━━━━━\nKetik *menu* untuk batal.';

    userStates.set(remoteJid, {
        step: 'task_detail_pick',
        data: { tasks }
    });

    await sock.sendMessage(remoteJid, { text: message });
}

// Handle task detail pick - show full task info with stats
async function handleTaskDetailPick(sock, remoteJid, user, state, messageInput) {
    const idx = parseInt(messageInput) - 1;
    const tasks = state.data.tasks;

    if (messageInput.toLowerCase() === 'menu' || messageInput === '/menu') {
        userStates.delete(remoteJid);
        await sendSuperAdminTaskMenu(sock, remoteJid, user);
        return;
    }

    if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${tasks.length}.\n\nKetik *menu* untuk batal.`
        });
        return;
    }

    const task = tasks[idx];
    const assignments = await db.getTaskAssignments(task.id);
    const stats = await db.getTaskStats(task.id);

    // Count status
    const notStarted = assignments.filter(a => a.status === 'not_started').length;
    const inProgress = assignments.filter(a => a.status === 'in_progress').length;
    const completed = assignments.filter(a => a.status === 'completed').length;

    let message = `📚 *DETAIL TUGAS*
━━━━━━━━━━━━━━━━━━
📝 *Nama:* ${task.name}
🏫 *Kelas:* ${task.class}
📄 *Detail:* ${task.detail || '-'}
⏰ *Deadline:* ${helpers.formatDate(task.deadline)}
📅 *Dibuat:* ${helpers.formatDate(task.createdAt)}
━━━━━━━━━━━━━━━━━━
📊 *STATISTIK:*
✅ Selesai: ${completed}
🔄 Dikerjakan: ${inProgress}
❌ Belum: ${notStarted}
━━━━━━━━━━━━━━━━━━
📋 *STATUS PER USER:*
`;

    if (assignments.length === 0) {
        message += '   📭 Belum ada user yang ditugaskan.\n';
    } else {
        assignments.forEach((a, i) => {
            const assignUser = assignments.find(u => u.userPhone === a.userPhone);
            message += `${i + 1}. ${helpers.getStatusEmoji(a.status)} 📱 ${a.userPhone}\n`;
        });
    }

    message += `━━━━━━━━━━━━━━━━━━
💡 Ketik *menu* untuk kembali ke menu tugas.`;

    await sock.sendMessage(remoteJid, { text: message });
}

// ========== TASK CRUD FUNCTIONS ==========

// Edit task - select task first
async function handleEditTaskSelect(sock, remoteJid, user) {
    const tasks = await db.getAllTasks();

    if (tasks.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Belum ada tugas. Buat tugas baru dulu.' });
        return;
    }

    let message = '✏️ *EDIT TUGAS*\n\nPilih nomor tugas yang ingin diedit:\n\n';

    tasks.forEach((task, index) => {
        message += `${index + 1}. *${task.name}*\n`;
        message += `   📖 ${task.class || '-'}\n`;
        message += `   ⏰ ${helpers.formatDaysRemaining(task.deadline)}\n\n`;
    });

    message += '\nKetik *menu* untuk batal.';

    userStates.set(remoteJid, {
        step: 'edit_task_pick',
        data: { tasks }
    });

    await sock.sendMessage(remoteJid, { text: message });
}

// Delete task - select task first
async function handleDeleteTaskSelect(sock, remoteJid, user) {
    const tasks = await db.getAllTasks();

    if (tasks.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Belum ada tugas untuk dihapus.' });
        return;
    }

    let message = '🗑️ *HAPUS TUGAS*\n\nPilih nomor tugas yang ingin dihapus:\n\n';

    tasks.forEach((task, index) => {
        message += `${index + 1}. *${task.name}*\n`;
        message += `   📖 ${task.class || '-'}\n`;
        message += `   ⏰ ${helpers.formatDaysRemaining(task.deadline)}\n\n`;
    });

    message += '\nKetik *menu* untuk batal.';

    userStates.set(remoteJid, {
        step: 'delete_task_pick',
        data: { tasks }
    });

    await sock.sendMessage(remoteJid, { text: message });
}

// Delete task - confirmation
async function handleDeleteTaskConfirm(sock, remoteJid, user, task) {
    await sock.sendMessage(remoteJid, {
        text: `⚠️ *KONFIRMASI HAPUS TUGAS*
━━━━━━━━━━━━━━━━━━

🗑️ *${task.name}*
📖 Maple: ${task.class || '-'}
⏰ Deadline: ${helpers.formatDate(task.deadline)}

━━━━━━━━━━━━━━━━━━

Apakah Anda yakin ingin menghapus tugas ini?

1️⃣ *Ya, Hapus* → Ketik: 1
2️⃣ *Batal* → Ketik: 2`
    });

    userStates.set(remoteJid, {
        step: 'delete_task_confirm',
        data: { taskId: task.id, taskName: task.name }
    });
}

// Show status selection after picking task
async function handleUpdateStatusPickTask(sock, remoteJid, user, state, message) {
    const idx = parseInt(message) - 1;
    const tasks = state.data.tasks;

    if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${tasks.length}.\n\nKetik *menu* untuk batal.`
        });
        return;
    }

    const { task, assignment } = tasks[idx];

    state.step = 'update_status_pick_new_status';
    state.data.selectedTask = task;
    state.data.selectedAssignment = assignment;

    await sock.sendMessage(remoteJid, {
        text: `📝 *UPDATE STATUS*
━━━━━━━━━━━━━━━━━━

✅ Task: *${task.name}*
📊 Status saat ini: ${helpers.getStatusEmoji(assignment.status)} ${helpers.getStatusText(assignment.status)}

Pilih status baru:

1️⃣ ❌ Belum Mulai
2️⃣ 🔄 Sedang Dikerjakan
3️⃣ ✅ Selesai
━━━━━━━━━━━━━━━━━━

Ketik 1, 2, atau 3. Ketik *menu* untuk batal.`
    });
}

// Process status selection
async function handleUpdateStatusPickNewStatus(sock, remoteJid, user, state, message) {
    const statusMap = { '1': 'not_started', '2': 'in_progress', '3': 'completed' };
    const statusLabels = { 'not_started': 'Belum Mulai', 'in_progress': 'Sedang Dikerjakan', 'completed': 'Selesai' };
    const status = statusMap[message];

    if (!status) {
        await sock.sendMessage(remoteJid, {
            text: '❌ Pilihan tidak valid. Ketik 1, 2, atau 3.'
        });
        return;
    }

    const task = state.data.selectedTask;
    const updated = await db.updateTaskStatus(task.id, user.phone, status);

    if (updated) {
        await sock.sendMessage(remoteJid, {
            text: `✅ *STATUS BERHASIL DIUPDATE!*

📝 Task: *${task.name}*
📊 Status Baru: ${helpers.getStatusEmoji(status)} ${statusLabels[status]}

Ketik *menu* untuk kembali ke menu utama.`
        });
    } else {
        await sock.sendMessage(remoteJid, { text: '❌ Gagal mengupdate status.' });
    }

    userStates.delete(remoteJid);
}

// ========== STATE HANDLERS FOR TASK CRUD ==========

// Handle edit task pick
async function handleEditTaskPick(sock, remoteJid, user, state, message) {
    const idx = parseInt(message) - 1;
    const tasks = state.data.tasks;

    if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${tasks.length}.\n\nKetik *menu* untuk batal.`
        });
        return;
    }

    const task = tasks[idx];

    state.step = 'edit_task_field';
    state.data.taskId = task.id;
    state.data.taskName = task.name;
    state.data.class = task.class;
    state.data.detail = task.detail;
    state.data.deadline = task.deadline;

    await sock.sendMessage(remoteJid, {
        text: `✏️ *EDIT TUGAS: ${task.name}*
━━━━━━━━━━━━━━━━━━

Pilih field yang ingin diubah:

1️⃣ *Nama Tugas*
   → Saat ini: ${task.name}

2️⃣ *Maple/Prodi*
   → Saat ini: ${task.class || '-'}

3️⃣ *Detail*
   → Saat ini: ${task.detail || '-'}

4️⃣ *Deadline*
   → Saat ini: ${helpers.formatDate(task.deadline)}

5️⃣ *Simpan & Selesai*

6️⃣ *Batal*

Ketik nomor (1-6). Ketik *menu* untuk batal.`
    });
}

// Handle edit task field selection
async function handleEditTaskField(sock, remoteJid, user, state, message) {
    const choice = message.trim();

    if (choice.toLowerCase() === 'cancel' || choice.toLowerCase() === 'batal') {
        userStates.delete(remoteJid);
        await sock.sendMessage(remoteJid, { text: '✅ Edit tugas dibatalkan.\n\nKetik *menu* untuk kembali.' });
        return;
    }

    if (choice === '6') {
        userStates.delete(remoteJid);
        await sock.sendMessage(remoteJid, { text: '✅ Edit dibatalkan.' });
        return;
    }

    if (choice === '5') {
        // Save
        const updated = await db.updateTask(state.data.taskId, {
            name: state.data.name,
            class: state.data.class,
            detail: state.data.detail,
            deadline: state.data.deadline
        });
        userStates.delete(remoteJid);
        if (updated) {
            await sock.sendMessage(remoteJid, {
                text: `✅ *TUGAS BERHASIL DIEDIT!*

📝 Nama: ${state.data.name}
📖 Maple: ${state.data.class}
📄 Detail: ${state.data.detail}
⏰ Deadline: ${helpers.formatDate(state.data.deadline)}`
            });
        } else {
            await sock.sendMessage(remoteJid, { text: '❌ Gagal menyimpan perubahan.' });
        }
        return;
    }

    if (!['1', '2', '3', '4'].includes(choice)) {
        await sock.sendMessage(remoteJid, {
            text: '❌ Pilihan tidak valid. Ketik 1, 2, 3, 4, 5, atau 6.'
        });
        return;
    }

    const fieldMap = {
        '1': { name: 'nama tugas', step: 'edit_task_value', field: 'name' },
        '2': { name: 'kelas', step: 'edit_task_value', field: 'class' },
        '3': { name: 'detail', step: 'edit_task_value', field: 'detail' },
        '4': { name: 'deadline (DD/MM/YYYY)', step: 'edit_task_value', field: 'deadline' }
    };

    const field = fieldMap[choice];

    state.step = 'edit_task_value';
    state.data.editingField = field.field;
    state.data.editingFieldName = field.name;

    await sock.sendMessage(remoteJid, {
        text: `✏️ *EDIT: ${field.name.toUpperCase()}*

Masukkan ${field.name} baru:

Ketik *menu* untuk batal, ketik *skip* untuk lewati.`
    });
}

// Handle edit task value input
async function handleEditTaskValue(sock, remoteJid, user, state, message) {
    const value = message.trim();

    if (value.toLowerCase() === 'cancel' || value.toLowerCase() === 'batal') {
        userStates.delete(remoteJid);
        await sock.sendMessage(remoteJid, { text: '✅ Edit tugas dibatalkan.\n\nKetik *menu* untuk kembali.' });
        return;
    }

    if (value.toLowerCase() === 'skip') {
        await sock.sendMessage(remoteJid, { text: `⏭️ Dilewati. ${state.data.editingFieldName} tetap: *${state.data[state.data.editingField]}*` });
    } else {
        if (state.data.editingField === 'deadline') {
            const deadline = helpers.parseDeadline(value);
            if (!deadline) {
                await sock.sendMessage(remoteJid, {
                    text: `❌ Format deadline tidak valid.\nFormat: DD/MM/YYYY, DD/MM, atau besok/lusa/minggu depan\n\nKetik deadline baru atau *menu* untuk batal.`
                });
                return;
            }
            state.data.deadline = deadline;
        } else {
            state.data[state.data.editingField] = value;
        }
    }

    state.step = 'edit_task_field';

    await sock.sendMessage(remoteJid, {
        text: `✏️ *EDIT TUGAS: ${state.data.taskName}*
━━━━━━━━━━━━━━━━━━

Pilih field lain yang ingin diubah:

1️⃣ *Nama Tugas*
   → Saat ini: ${state.data.name}

2️⃣ *Maple/Prodi*
   → Saat ini: ${state.data.class || '-'}

3️⃣ *Detail*
   → Saat ini: ${state.data.detail || '-'}

4️⃣ *Deadline*
   → Saat ini: ${helpers.formatDate(state.data.deadline)}

5️⃣ *Simpan & Selesai*

6️⃣ *Batal*

Ketik nomor (1-6). Ketik *menu* untuk batal.`
    });
}

// Handle delete task pick
async function handleDeleteTaskPick(sock, remoteJid, user, state, message) {
    const idx = parseInt(message) - 1;
    const tasks = state.data.tasks;

    if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${tasks.length}.\n\nKetik *menu* untuk batal.`
        });
        return;
    }

    const task = tasks[idx];
    await handleDeleteTaskConfirm(sock, remoteJid, user, task);
}

// Handle delete task confirmation state
async function handleDeleteTaskConfirmState(sock, remoteJid, user, state, message) {
    const msg = message.trim();

    if (msg === '1') {
        try {
            await db.deleteTask(state.data.taskId);
            await sock.sendMessage(remoteJid, {
                text: `✅ *TUGAS BERHASIL DIHAPUS!*

🗑️ "${state.data.taskName}" telah dihapus beserta semua assignments-nya.`
            });
        } catch (error) {
            await sock.sendMessage(remoteJid, { text: '❌ Gagal menghapus tugas.' });
        }
    } else if (msg === '2') {
        await sock.sendMessage(remoteJid, { text: '✅ Penghapusan dibatalkan.\n\nKetik *menu* untuk kembali.' });
    } else {
        await sock.sendMessage(remoteJid, {
            text: '❌ Pilihan tidak valid.\n1️⃣ Ya, Hapus\n2️⃣ Batal\n\nKetik *menu* untuk batal.'
        });
        return;
    }

    userStates.delete(remoteJid);
}

// Send stats
async function sendStats(sock, remoteJid, user) {
    if (!user || user.role !== config.roles.SUPER_ADMIN) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    const stats = await db.getStats();
    const text = `
📊 *STATISTIK BOT TUGAS*
━━━━━━━━━━━━━━━━━━

👥 *Total User:* ${stats.totalUsers}
👤 *Admin:* ${stats.totalAdmins}
👑 *Super Admin:* ${stats.totalSuperAdmins}

📝 *Total Tugas:* ${stats.totalTasks}
✅ *Tugas Selesai:* ${stats.completedTasks}
⏳ *Tugas Belum Selesai:* ${stats.pendingTasks}

📈 *Completion Rate:* ${stats.completionRate}%
━━━━━━━━━━━━━━━━━━
    `;

    await sock.sendMessage(remoteJid, { text });
}

// Send settings
async function sendSettings(sock, remoteJid, user) {
    if (!user || user.role !== config.roles.SUPER_ADMIN) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    const settings = await db.getSettings();
    const statusIcon = settings.botEnabled ? '🟢' : '🔴';
    const statusText = settings.botEnabled ? 'AKTIF' : 'NONAKTIF';

    const text = `
⚙️ *PENGATURAN BOT*
━━━━━━━━━━━━━━━━━━

🤖 *Status Bot:* ${statusIcon} ${statusText}

📌 *Pengaturan:*
• Auto-reminder: Enabled
• Deadline alert: 7 days before

🔧 *Perintah Maintenance:*
• /maintenance on  → Aktifkan maintenance
• /maintenance off → Nonaktifkan maintenance
• /botstatus       → Lihat status bot

🔙 Kembali ke menu utama
   Ketik: menu
━━━━━━━━━━━━━━━━━━
    `;

    await sock.sendMessage(remoteJid, { text });
}

// Handle maintenance toggle (super admin only)
async function handleMaintenanceToggle(sock, remoteJid, user) {
    if (!user || user.role !== config.roles.SUPER_ADMIN) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    const settings = await db.getSettings();
    const newStatus = !settings.botEnabled;
    const statusIcon = newStatus ? '🟢' : '🔴';
    const statusText = newStatus ? 'AKTIF' : 'NONAKTIF';

    await db.updateSettings({ botEnabled: newStatus, lastToggle: new Date().toISOString() });

    const message = newStatus
        ? `✅ *BOT BERHASIL DIAKTIFKAN!* ${statusIcon} ${statusText}\n\nBot sekarang dapat menerima pesan dan merespons perintah.`
        : `🔧 *BOT MASUK MODE MAINTENANCE!* ${statusIcon} ${statusText}\n\nBot tidak akan merespons pesan apapun dari user.\n\nGunakan /maintenance off untuk mengaktifkan kembali.`;

    await sock.sendMessage(remoteJid, { text: message });
}

// Handle bot status check (super admin only)
async function handleBotStatus(sock, remoteJid, user) {
    if (!user || user.role !== config.roles.SUPER_ADMIN) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    const settings = await db.getSettings();
    const statusIcon = settings.botEnabled ? '🟢' : '🔴';
    const statusText = settings.botEnabled ? 'AKTIF' : 'NONAKTIF';
    const uptimeInfo = settings.lastToggle
        ? `⏱️ Terakhir diubah: ${helpers.formatDate(settings.lastToggle)}`
        : '';

    const text = `
📊 *STATUS BOT*
━━━━━━━━━━━━━━━━━━

🤖 *Bot Status:* ${statusIcon} ${statusText}
${uptimeInfo}

${settings.botEnabled ? '✅ Bot berjalan normal dan merespons pesan.' : '🔧 Bot dalam mode maintenance - tidak menerima pesan.'}
━━━━━━━━━━━━━━━━━━
    `;

    await sock.sendMessage(remoteJid, { text });
}

// Handle quick update status (delegates to numbered version)
async function handleQuickUpdateStatus(sock, remoteJid, user) {
    if (!user) {
        await sock.sendMessage(remoteJid, { text: '❌ Anda belum terdaftar.' });
        return;
    }

    const userTasks = await db.getUserTasks(user.phone);

    if (userTasks.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Anda belum memiliki tugas.' });
        return;
    }

    // Fetch full task data for each assignment
    const tasksWithData = [];
    for (const assignment of userTasks) {
        const task = await db.getTaskById(assignment.taskId);
        if (task) {
            tasksWithData.push({ assignment, task });
        }
    }

    if (tasksWithData.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Anda belum memiliki tugas.' });
        return;
    }

    let message = '📝 *UPDATE STATUS TUGAS*\n\nPilih nomor tugas yang ingin diupdate:\n\n';

    tasksWithData.forEach(({ assignment, task }, index) => {
        message += `${index + 1}. ${helpers.getStatusEmoji(assignment.status)} *${task.name}*\n`;
        message += `   📖 ${task.class || '-'}\n`;
        message += `   📊 Status: ${helpers.getStatusText(assignment.status)}\n`;
        message += `   ⏰ ${helpers.formatDaysRemaining(task.deadline)}\n\n`;
    });

    message += 'Ketik *menu* untuk batal.';

    userStates.set(remoteJid, {
        step: 'update_status_pick_task',
        data: { tasks: tasksWithData }
    });

    await sock.sendMessage(remoteJid, { text: message });
}

// Handle remind menu - improved with number selection
async function handleRemindMenu(sock, remoteJid, user) {
    if (!user || (user.role !== config.roles.SUPER_ADMIN && user.role !== config.roles.ADMIN)) {
        await sock.sendMessage(remoteJid, { text: config.messages.unauthorized });
        return;
    }

    const tasks = await db.getAllTasks();
    const upcomingTasks = tasks.filter(task => {
        const deadline = new Date(task.deadline);
        const now = new Date();
        const diffDays = (deadline - now) / (1000 * 60 * 60 * 24);
        return diffDays > 0 && diffDays <= 7;
    });

    if (upcomingTasks.length === 0) {
        await sock.sendMessage(remoteJid, { text: '📭 Tidak ada tugas dengan deadline dekat (7 hari ke depan).' });
        return;
    }

    let message = `🔔 *PENGINGAT TUGAS*
━━━━━━━━━━━━━━━━━━
📋 Pilih tugas untuk dikirimkan pengingat:

`;

    upcomingTasks.forEach((task, index) => {
        message += `${index + 1}. *${task.name}*\n`;
        message += `   📖 ${task.class}\n`;
        message += `   ⏰ ${helpers.formatDaysRemaining(task.deadline)}\n`;
    });

    message += `
━━━━━━━━━━━━━━━━━━
💡 Ketik nomor tugas (1-${upcomingTasks.length})
atau ketik *menu* untuk batal.`;

    userStates.set(remoteJid, {
        step: 'remind_task_pick',
        data: { tasks: upcomingTasks }
    });

    await sock.sendMessage(remoteJid, { text: message });
}

// Handle remind task pick - send reminder
async function handleRemindTaskPick(sock, remoteJid, user, state, messageInput) {
    const idx = parseInt(messageInput) - 1;
    const tasks = state.data.tasks;

    if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
        await sock.sendMessage(remoteJid, {
            text: `❌ Nomor tidak valid. Pilih 1 sampai ${tasks.length}.\n\nKetik *menu* untuk batal.`
        });
        return;
    }

    const selectedTask = tasks[idx];

    // Get users who haven't completed this task
    const usersNotCompleted = await db.getUsersNotCompletedTask(selectedTask.id);

    if (usersNotCompleted.length === 0) {
        userStates.delete(remoteJid);
        await sock.sendMessage(remoteJid, {
            text: `✅ *SEMUA USER SUDAH MENYELESAIKAN TUGAS INI!*

📝 ${selectedTask.name}
📖 ${selectedTask.class}
━━━━━━━━━━━━━━━━━━
Ketik *menu* untuk kembali.`
        });
        return;
    }

    // Build user list for display
    let userList = usersNotCompleted.map((u, i) => `${i + 1}. 📱 ${u.userPhone}`).join('\n');

    // Send confirmation
    await sock.sendMessage(remoteJid, {
        text: `🔔 *KONFIRMASI PENGINGAT*
━━━━━━━━━━━━━━━━━━
📝 *Tugas:* ${selectedTask.name}
📖 *Kelas:* ${selectedTask.class}
⏰ *Deadline:* ${helpers.formatDaysRemaining(selectedTask.deadline)}
━━━━━━━━━━━━━━━━━━
👥 *User belum selesai (${usersNotCompleted.length}):*
${userList}
━━━━━━━━━━━━━━━━━━
⚠️ Pengingat akan dikirim ke semua user di atas.

1️⃣ *Kirim Pengingat* → Ketik: 1
2️⃣ *Batal* → Ketik: 2

Ketik *menu* untuk batal.`
    });

    userStates.set(remoteJid, {
        step: 'remind_task_confirm',
        data: { task: selectedTask, users: usersNotCompleted }
    });
}

// Handle remind task confirmation
async function handleRemindTaskConfirm(sock, remoteJid, user, state, messageInput) {
    const msg = messageInput.trim();

    if (msg === '1') {
        // Send reminders with error handling and batching
        const task = state.data.task;
        const reminderMsg = config.messages.taskReminder(task.name, helpers.formatDate(task.deadline));
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < state.data.users.length; i++) {
            const assignment = state.data.users[i];
            const result = await sendMessageWithTimeout(
                sock,
                `${assignment.userPhone}@s.whatsapp.net`,
                { text: reminderMsg },
                8000 // 8 seconds timeout
            );

            if (result.success) {
                successCount++;
            } else {
                failCount++;
                console.log(`Reminder skipped for ${assignment.userPhone}: ${result.error}`);
            }

            // Add delay between sends to prevent rate limiting
            if ((i + 1) % MAX_CONCURRENT_SENDS === 0) {
                await new Promise(resolve => setTimeout(resolve, MESSAGE_SEND_DELAY));
            }
        }

        let resultText = `✅ *PENGINGAT BERHASIL DIKIRIM!*
━━━━━━━━━━━━━━━━━━
📝 *Tugas:* ${task.name}
📊 *Berhasil:* ${successCount} user
${failCount > 0 ? `❌ *Gagal:* ${failCount} user` : ''}
━━━━━━━━━━━━━━━━━━
Ketik *menu* untuk kembali.`;

        await sock.sendMessage(remoteJid, { text: resultText });
    } else if (msg === '2') {
        await sock.sendMessage(remoteJid, { text: '✅ Pengiriman pengingat dibatalkan.' });
    } else {
        await sock.sendMessage(remoteJid, {
            text: '❌ Pilihan tidak valid.\n1️⃣ Kirim Pengingat\n2️⃣ Batal'
        });
        return;
    }

    userStates.delete(remoteJid);
}

module.exports = { handleMessage };