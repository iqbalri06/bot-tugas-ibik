// Text responses for the bot
// These are used throughout the bot for consistent messaging

const responses = {
    // Greetings and welcome messages
    welcome: `
👋 *Selamat Datang di Bot Tugas IBIK*

Saya akan membantu Anda mengelola tugas kuliah!

📌 *Perintah yang tersedia:*

🔧 *Untuk Super Admin & Admin:*
• /adduser - Menambahkan user baru
• /addtask - Membuat tugas baru
• /listtask - Melihat daftar tugas
• /taskdetail - Melihat detail tugas
• /remindtask - Mengingatkan user yang belum mengerjakan
• /listuser - Melihat daftar user
• /deletetask - Menghapus tugas

📝 *Untuk User:*
• /mytasks - Melihat tugas saya
• /updatetask - Update status tugas
• /taskinfo - Informasi tugas

ℹ️ *Perintah Umum:*
• /help - Bantuan
• /menu - Menu utama

Pilih menu di bawah untuk memulai!
    `,

    notRegistered: `
👋 *Selamat Datang di Bot Tugas IBIK*

Anda belum terdaftar sebagai user.
Silakan hubungi admin untuk pendaftaran.
    `,

    unauthorized: '❌ Maaf, Anda tidak memiliki akses untuk perintah ini.',

    invalidCommand: '❌ Perintah tidak dikenali. Ketik /help untuk bantuan.',

    // Task related messages
    taskCreated: (taskName, deadline) => `
✅ *Tugas Berhasil Dibuat!*

📚 Tugas: ${taskName}
⏰ Deadline: ${deadline}

Notifikasi akan dikirim ke semua user.
    `,

    newTaskNotification: (taskName, deadline, className) => `
🆕 *TUGAS BARU DITAMBAHKAN*

📚 *Tugas:* ${taskName}
🏫 *Kelas:* ${className}
⏰ *Deadline:* ${deadline}

Silakan cek dan selesaikan tugas sebelum deadline!
    `,

    taskReminder: (taskName, deadline) => `
⚠️ *PENGINGAT TUGAS*

📚 *Tugas:* ${taskName}
⏰ *Deadline:* ${deadline}

Mohon segera menyelesaikan tugas Anda!
    `,

    taskDeleted: (taskName) => `✅ Tugas "${taskName}" berhasil dihapus.`,

    taskNotFound: '❌ Tugas tidak ditemukan.',

    taskStatusUpdated: (taskName, status) => `
✅ Status tugas "${taskName}" berhasil diupdate!

📊 Status Baru: ${status}
    `,

    allTasksCompleted: '✅ Semua user sudah menyelesaikan tugas ini!',

    noUpcomingTasks: '📭 Tidak ada tugas dengan deadline dekat (7 hari ke depan).',

    // User related messages
    userAdded: (name) => `✅ User "${name}" berhasil ditambahkan!`,

    userAddFailed: '❌ Gagal menambahkan user. Nomor telepon mungkin sudah terdaftar.',

    invalidPhone: '❌ Format nomor telepon tidak valid. Gunakan format: 6281234567890',

    // Status related messages
    statusNotStarted: '❌ Belum mulai',
    statusInProgress: '🔄 Sedang dikerjakan',
    statusCompleted: '✅ Selesai',

    invalidStatus: '❌ Status tidak valid. Gunakan: not_started, in_progress, atau completed',

    // General messages
    processingError: '❌ Terjadi kesalahan. Silakan coba lagi.',

    // Help text
    helpUser: `
📚 *PANDUAN PENGGUNAAN BOT TUGAS IBIK*

📝 *Perintah untuk User:*
• /mytasks - Melihat semua tugas Anda
• /updatetask [id_tugas] [status] - Update status tugas
• /taskinfo [id_tugas] - Melihat detail tugas

📋 *Perintah Umum:*
• /menu - Tampilkan menu utama
• /help - Tampilkan bantuan

💡 *Tips:*
• Gunakan tombol untuk navigasi yang lebih mudah
• Cek tugas secara berkala untuk tidak ketinggalan deadline
    `,

    helpAdmin: `
📚 *PANDUAN PENGGUNAAN BOT TUGAS IBIK*

🔧 *Perintah untuk Admin & Super Admin:*
• /adduser - Menambahkan user baru
• /addtask - Membuat tugas baru
• /listtask - Melihat daftar semua tugas
• /taskdetail [id_tugas] - Melihat detail tugas
• /remindtask [id_tugas] - Mengingatkan user
• /listuser - Melihat daftar semua user
• /deletetask [id_tugas] - Menghapus tugas

📝 *Perintah untuk User:*
• /mytasks - Melihat semua tugas Anda
• /updatetask [id_tugas] [status] - Update status tugas
• /taskinfo [id_tugas] - Melihat detail tugas

📋 *Perintah Umum:*
• /menu - Tampilkan menu utama
• /help - Tampilkan bantuan
    `,

    // Admin panel
    adminPanel: (userName) => `
⚙️ *ADMIN PANEL*

Selamat datang, ${userName}! 👑

Pilih menu di bawah ini:
    `,

    // Multi-step prompts
    promptUserPhone: `
📝 *Tambah User Baru*

Masukkan nomor telepon user baru:
Format: 6281234567890 (tanpa + atau 0 di depan)
    `,

    promptUserName: 'Masukkan nama user:',

    promptUserRole: `
Pilih role user:
1. super_admin - Super Admin
2. admin - Admin
3. user - User biasa

Masukkan nomor (1/2/3):
    `,

    promptUserMaple: 'Masukkan kelas (opsional, ketik "-" untuk kosong):',

    promptTaskName: `
📝 *Buat Tugas Baru*

Masukkan nama tugas:
    `,

    promptTaskMaple: 'Masukkan kelas tugas:',

    promptTaskDetail: 'Masukkan detail tugas:',

    promptTaskDeadline: `
Masukkan deadline tugas:
Format: DD/MM/YYYY (contoh: 31/12/2026)
Atau: DD/MM (contoh: 31/12 untuk tahun ini)
Atau kata: besok, lusa, minggu depan
    `,

    // Maintenance mode
    maintenance: '⚠️ Bot sedang dalam mode pemeliharaan. Silakan coba lagi nanti.',

    // Connection messages
    connecting: '🔄 Menyambung ke WhatsApp...',
    connected: '✅✅✅ BOT BERHASIH TERHUBUNG! ✅✅✅',
    reconnecting: '🔄 Mencoba reconnect...',
    connectionFailed: '❌ Gagal terhubung ke WhatsApp.',
    sessionConflict: '⚠️ Session conflict detected. Enabling maintenance mode...'
};

module.exports = { responses };