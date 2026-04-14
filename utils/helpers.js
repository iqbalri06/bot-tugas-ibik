const config = require('../config/config');

// Format date to readable format
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('id-ID', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Check if deadline is near (within 24 hours)
function isDeadlineNear(deadlineString) {
    const deadline = new Date(deadlineString);
    const now = new Date();
    const diffHours = (deadline - now) / (1000 * 60 * 60);
    return diffHours > 0 && diffHours <= 24;
}

// Check if deadline is overdue
function isDeadlineOverdue(deadlineString) {
    const deadline = new Date(deadlineString);
    const now = new Date();
    return deadline < now;
}

// Get status emoji
function getStatusEmoji(status) {
    const statusEmojis = {
        'not_started': '❌',
        'in_progress': '🔄',
        'completed': '✅'
    };
    return statusEmojis[status] || '❓';
}

// Get status text
function getStatusText(status) {
    const statusTexts = {
        'not_started': 'Belum Mulai',
        'in_progress': 'Sedang Dikerjakan',
        'completed': 'Selesai'
    };
    return statusTexts[status] || 'Tidak Diketahui';
}

// Format phone number (remove +, spaces, etc.)
function formatPhoneNumber(phone) {
    return phone.replace(/[\s\-\+\(\)]/g, '').replace('@s.whatsapp.net', '');
}

// Validate role
function isValidRole(role) {
    return Object.values(config.roles).includes(role);
}

// Format task message - improved design
function formatTaskMessage(task, assignment = null) {
    let message = `📚 *DETAIL TUGAS*
━━━━━━━━━━━━━━━━━━
📝 *Nama:* ${task.name}
🏫 *Kelas:* ${task.class || '-'}
📄 *Detail:* ${task.detail || '-'}
⏰ *Deadline:* ${formatDate(task.deadline)}
`;

    if (task.photo) {
        message += `📷 *Foto:* Ada lampiran\n`;
    }

    if (assignment) {
        message += `━━━━━━━━━━━━━━━━━━\n📊 *STATUS:* ${getStatusEmoji(assignment.status)} ${getStatusText(assignment.status)}\n📅 *Ditugaskan:* ${formatDate(assignment.assignedAt)}\n`;
    }

    message += `━━━━━━━━━━━━━━━━━━`;

    return message;
}

// Format task list - improved design
function formatTaskList(tasks, assignments = null) {
    if (tasks.length === 0) {
        return '📭 *Tidak ada tugas yang tersedia.*';
    }

    let message = `📋 *DAFTAR TUGAS*
━━━━━━━━━━━━━━━━━━
📊 Total: ${tasks.length} tugas
`;

    tasks.forEach((task, index) => {
        message += `\n${index + 1}. *${task.name}*\n`;
        message += `   🏫 ${task.class || '-'}\n`;
        message += `   ⏰ ${formatDate(task.deadline)}\n`;

        if (assignments) {
            const assignment = assignments.find(a => a.taskId === task.id);
            if (assignment) {
                message += `   ${getStatusEmoji(assignment.status)} ${getStatusText(assignment.status)}\n`;
            }
        }
    });

    return message;
}

// Format user list - improved design
function formatUserList(users) {
    if (users.length === 0) {
        return '👥 *Tidak ada user yang terdaftar.*';
    }

    let message = `👥 *DAFTAR USER*
━━━━━━━━━━━━━━━━━━
📊 Total: ${users.length} user\n`;

    users.forEach((user, index) => {
        const roleEmoji = user.role === 'super_admin' ? '👑' : user.role === 'admin' ? '⭐' : '👤';
        const roleLabel = user.role === 'super_admin' ? 'SUPER_ADMIN' : user.role === 'admin' ? 'ADMIN' : 'USER';
        const separator = '━━━━━━━━';

        message += `
${separator}
${index + 1}. ${roleEmoji} *${user.name}*
   📱 ${user.phone}
   🏷️ ${roleLabel}
   🏫 ${user.class || '-'}
`;
    });

    message += `${'━'.repeat(20)}\n`;

    return message;
}

// Format user list for selection - improved design
function formatUserListSelect(users) {
    if (users.length === 0) {
        return '👥 *Tidak ada user yang terdaftar.*';
    }

    let message = `👥 *DAFTAR USER*
━━━━━━━━━━━━━━━━━━
📊 Total: ${users.length} user

Pilih nomor user:
`;

    users.forEach((user, index) => {
        const roleEmoji = user.role === 'super_admin' ? '👑' : user.role === 'admin' ? '⭐' : '👤';
        const roleLabel = user.role === 'super_admin' ? 'SUPER_ADMIN' : user.role === 'admin' ? 'ADMIN' : 'USER';
        message += `${index + 1}. ${roleEmoji} *${user.name}*\n`;
        message += `   📱 ${user.phone}\n`;
        message += `   🏷️ ${roleLabel} | 🏫 ${user.class || '-'}\n`;
    });

    message += `\n━━━━━━━━━━━━━━━━━━\nKetik *menu* untuk batal.`;
    return message;
}

// Format task list with numbers
function formatTaskListNumbered(tasks, assignments = null) {
    if (tasks.length === 0) {
        return '📭 *Tidak ada tugas yang tersedia.*';
    }

    let message = '📋 *DAFTAR TUGAS*\n\n';

    tasks.forEach((task, index) => {
        message += `${index + 1}. *${task.name}*\n`;
        message += `   🏫 ${task.class || '-'}\n`;
        message += `   ⏰ ${formatDate(task.deadline)}\n`;

        if (assignments) {
            const assignment = assignments.find(a => a.taskId === task.id);
            if (assignment) {
                message += `   ${getStatusEmoji(assignment.status)} ${getStatusText(assignment.status)}\n`;
            }
        }

        message += '\n';
    });

    message += 'Ketik *menu* untuk batal.';
    return message;
}

// Format users not completed task
function formatUsersNotCompleted(task, usersNotCompleted) {
    if (usersNotCompleted.length === 0) {
        return '✅ *Semua user sudah menyelesaikan tugas ini!*';
    }

    let message = `⚠️ *USER YANG BELUM MENGERJAKAN TUGAS*\n\n`;
    message += `📚 *Tugas:* ${task.name}\n`;
    message += `⏰ *Deadline:* ${formatDate(task.deadline)}\n\n`;
    message += `📊 *Total Belum Selesai:* ${usersNotCompleted.length} user\n\n`;

    usersNotCompleted.forEach((assignment, index) => {
        message += `${index + 1}. *${assignment.userName || assignment.userPhone}*\n`;
        message += `   ${getStatusEmoji(assignment.status)} ${getStatusText(assignment.status)}\n\n`;
    });

    return message;
}

// Parse task deadline from various formats
function parseDeadline(deadlineInput) {
    const now = new Date();
    const parts = deadlineInput.split('/');

    if (parts.length === 3) {
        // Format: DD/MM/YYYY
        const [day, month, year] = parts.map(p => parseInt(p));
        const date = new Date(year, month - 1, day, 23, 59, 59);
        return date.toISOString();
    } else if (parts.length === 2) {
        // Format: DD/MM (assume current year)
        const [day, month] = parts.map(p => parseInt(p));
        const date = new Date(now.getFullYear(), month - 1, day, 23, 59, 59);
        // If date has passed, assume next year
        if (date < now) {
            date.setFullYear(now.getFullYear() + 1);
        }
        return date.toISOString();
    }

    // Try to parse as natural language (tomorrow, next week, etc.)
    const lowerInput = deadlineInput.toLowerCase();
    if (lowerInput.includes('besok') || lowerInput.includes('tomorrow')) {
        now.setDate(now.getDate() + 1);
        return now.toISOString();
    } else if (lowerInput.includes('lusa')) {
        now.setDate(now.getDate() + 2);
        return now.toISOString();
    } else if (lowerInput.includes('minggu depan') || lowerInput.includes('next week')) {
        now.setDate(now.getDate() + 7);
        return now.toISOString();
    }

    return null;
}

// Validate phone number (basic validation)
function isValidPhoneNumber(phone) {
    const formatted = formatPhoneNumber(phone);
    return /^\d{10,15}$/.test(formatted);
}

// Create button message template
function createButtonMessage(text, buttons) {
    return {
        text: text,
        buttons: buttons.map(btn => ({
            buttonId: btn.id,
            buttonText: { displayText: btn.text },
            type: 1
        }))
    };
}

// Create list message template
function createListMessage(title, description, sections) {
    return {
        title: title,
        description: description,
        buttonText: '📋 Pilih Opsi',
        sections: sections
    };
}

// Calculate days remaining
function getDaysRemaining(deadlineString) {
    const deadline = new Date(deadlineString);
    const now = new Date();
    const diffTime = deadline - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
}

// Format days remaining
function formatDaysRemaining(deadlineString) {
    const days = getDaysRemaining(deadlineString);

    if (days < 0) {
        return `⚠️ *Terlambat ${Math.abs(days)} hari*`;
    } else if (days === 0) {
        return '⏰ *Hari ini*';
    } else if (days === 1) {
        return '⏰ *Besok*';
    } else {
        return `⏰ *${days} hari lagi*`;
    }
}

module.exports = {
    formatDate,
    isDeadlineNear,
    isDeadlineOverdue,
    getStatusEmoji,
    getStatusText,
    formatPhoneNumber,
    isValidRole,
    formatTaskMessage,
    formatTaskList,
    formatTaskListNumbered,
    formatUserList,
    formatUserListSelect,
    formatUsersNotCompleted,
    parseDeadline,
    isValidPhoneNumber,
    createButtonMessage,
    createListMessage,
    getDaysRemaining,
    formatDaysRemaining
};
