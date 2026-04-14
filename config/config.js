require('dotenv').config();

module.exports = {
    // Bot Configuration
    botName: process.env.BOT_NAME || '📚 Bot Tugas IBIK',
    ownerNumber: process.env.OWNER_NUMBER || '6281291544061', // Super Admin phone number

    // Session Configuration
    sessionId: process.env.SESSION_ID || 'ibik-bot-session',

    // Message Configuration
    messageDelay: parseInt(process.env.MESSAGE_DELAY || '1000'), // Delay between messages in ms

    // Role Configuration
    roles: {
        SUPER_ADMIN: 'super_admin',
        ADMIN: 'admin',
        USER: 'user'
    },

    // Message Templates
    messages: {
        welcome: `
🌸 *Selamat Datang di Bot Tugas IBIK*

📚 Pergi ke sekolah pagi-pagi
*Roti goreng dimakan bersama*
🎓 Bot tugas siap membantu
*Yuk mulai bersama!*

━━━━━━━━━━━━━━━━━━

📌 *Perintah yang tersedia:*

🔧 *Untuk Super Admin & Admin:*
• /adduser - Menambahkan user baru
• /addtask - Membuat tugas baru
• /listtask - Melihat daftar tugas
• /taskdetail - Melihat detail tugas
• /remindtask - Mengingatkan user
• /listuser - Melihat daftar user
• /deletetask - Menghapus tugas

📝 *Untuk User:*
• /mytasks - Melihat tugas saya
• /updatetask - Update status tugas
• /taskinfo - Informasi tugas

ℹ️ *Perintah Umum:*
• /help - Bantuan
• /menu - Menu utama

Silakan pilih menu untuk memulai! 🎉
        `,

        unauthorized: '❌ Maaf, Anda tidak memiliki akses untuk perintah ini.',

        taskCreated: (taskName, deadline, className, detail) => `
✨ *TUGAS BERHASIL DIBUAT!*
━━━━━━━━━━━━━━━━━━

🌿 Burung kenari bernyanyi
Kupu-kupu terbang tinggi
📋 Tugas baru telah dibuat
Yuk segera cek, notifikasi sudah dikirim hari ini!

━━━━━━━━━━━━━━━━━━
📋 *Nama:* ${taskName}
🏫 *Kelas:* ${className}
📄 *Detail:* ${detail || '-'}
⏰ *Deadline:* ${deadline}
━━━━━━━━━━━━━━━━━━

📨 *Notifikasi:* Otomatis dikirim ke semua user.

🎉 Selamat bertugas! Ketik *menu* untuk kembali.
        `,

        newTaskNotification: (taskName, deadline, className) => `
📚 *~ PANTUN TUGAS BARU ~*

🍃 Pergi ke perpustakaan
Belajar buku penuh catatan
📢 Ada tugas baru nih~
Yuk dicek dulu biar cepat dikerjakan!

━━━━━━━━━━━━━━━━━━
📋 *Tugas:* ${taskName}
🏫 *Kelas:* ${className}
⏰ *Deadline:* ${deadline}
━━━━━━━━━━━━━━━━━━

💡 Ketik *tugas saya* untuk lihat detail.
Jangan lupa kerjakan ya! 📝✨`,

        taskReminder: (taskName, deadline) => `
⏰ *~ PENGINGAT TUGAS ~*

🌅 Pagi-pagi minum kopi
*Biar fokus jalani hari~*
⏰ Ini tugas yang belum selesai:
*Yuk kerjakan sekarang, jangan sampai terlambat lagi!*

━━━━━━━━━━━━━━━━━━
📋 *Tugas:* ${taskName}
⏰ *Deadline:* ${deadline}
━━━━━━━━━━━━━━━━━━

⏳ Jangan ditunda-tunda ya!
Kerjakan sekarang biar lega! 💪✨`,

        autoMorningReminder: (tasksByUser, dayName) => `
🌅 *PAGI YANG CERIA!* [${dayName}]

🍵 Minum kopi pagi-pagi
*Biar semangat mulai hari~*
📋 Ada beberapa tugas nih
*Yuk dikerjakan, jangan ditunda lagi!*

━━━━━━━━━━━━━━━━━━
📝 *TUGAS BELUM SELESAI:*
━━━━━━━━━━━━━━━━━━
${tasksByUser}
━━━━━━━━━━━━━━━━━━

💪 Semangat! Jangan ditunda-tunda!
Kerjakan sekarang biar lega dan bebas beban! ✨

📩 Balas */menu* untuk kembali ke menu utama.
`
    },

    // Button Templates
    buttons: {
        mainMenu: [
            { id: 'mytasks', text: '📝 Tugas Saya' },
            { id: 'alltasks', text: '📚 Semua Tugas' },
            { id: 'addtask', text: '➕ Buat Tugas' },
            { id: 'admin', text: '⚙️ Admin Panel' },
            { id: 'help', text: '❓ Bantuan' }
        ],

        statusButtons: [
            { id: 'status_not_started', text: '❌ Belum Mulai' },
            { id: 'status_in_progress', text: '🔄 Sedang Dikerjakan' },
            { id: 'status_completed', text: '✅ Selesai' }
        ],

        adminButtons: [
            { id: 'add_user', text: '👤 Add User' },
            { id: 'add_task', text: '📚 Add Task' },
            { id: 'list_users', text: '👥 List Users' },
            { id: 'remind', text: '🔔 Reminder' },
            { id: 'back', text: '⬅️ Kembali' }
        ]
    }
};
