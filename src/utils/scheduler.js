// Auto-reminder scheduler
// Runs daily at configured time to remind users of incomplete tasks
const db = require('../../database/db');
const config = require('../../config/config');
const helpers = require('../../utils/helpers');

const MAX_CONCURRENT_SENDS = 3;
const MESSAGE_SEND_DELAY = 500;
const MESSAGE_SEND_TIMEOUT = 10000;

async function sendMessageWithTimeout(sock, jid, message, timeoutMs = MESSAGE_SEND_TIMEOUT) {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            resolve({ success: false, error: 'Timeout' });
        }, timeoutMs);

        sock.sendMessage(jid, { text: message })
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

function getNextReminderTime(hour, minute) {
    const now = new Date();
    const reminder = new Date(now);
    reminder.setHours(hour, minute, 0, 0);
    if (reminder <= now) {
        reminder.setDate(reminder.getDate() + 1);
    }
    return reminder;
}

function parseTime(timeStr) {
    if (!timeStr) return { hour: 9, minute: 0 };
    const parts = timeStr.split(':');
    return {
        hour: parseInt(parts[0], 10) || 9,
        minute: parseInt(parts[1], 10) || 0
    };
}

function getDayName(date) {
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    return days[date.getDay()];
}

async function sendDailyReminder() {
    const sock = global.botSock;
    if (!sock) {
        console.log('[Scheduler] sock not ready yet, skipping reminder.');
        return;
    }

    try {
        await db.init();
        const settings = await db.getSettings();
        if (!settings.reminderEnabled) {
            console.log('[Scheduler] Reminder disabled in settings, skipping.');
            return;
        }
        console.log(`[Scheduler] Running reminder (${settings.reminderTime || '09:00'})...`);
    } catch (e) {
        console.log('[Scheduler] Could not read settings, continuing anyway.');
    }

    try {
        await db.init();
        const users = await db.getAllUsers();
        const tasks = await db.getAllTasks();

        if (!tasks.length) {
            console.log('[Scheduler] No tasks found, skipping reminder.');
            return;
        }

        const dayName = getDayName(new Date());

        let sentCount = 0;
        let skippedCount = 0;

        for (const user of users) {
            if (user.role === 'super_admin') continue;

            const userAssignments = await db.getUserTasks(user.phone);
            const incompleteAssignments = userAssignments.filter(a => a.status !== 'completed');

            if (incompleteAssignments.length === 0) continue;

            const taskLines = [];
            for (const assignment of incompleteAssignments) {
                const task = await db.getTaskById(assignment.taskId);
                if (!task) continue;

                const statusText = helpers.getStatusText(assignment.status);
                const statusEmoji = helpers.getStatusEmoji(assignment.status);
                const deadline = helpers.formatDaysRemaining(task.deadline);

                taskLines.push(
                    `${statusEmoji} *${task.name}*\n` +
                    `   📖 ${task.class || '-'}\n` +
                    `   📊 ${statusText} | ${deadline}`
                );
            }

            if (!taskLines.length) continue;

            const tasksByUser = taskLines.join('\n\n');
            const message = config.messages.autoMorningReminder(tasksByUser, dayName);

            const result = await sendMessageWithTimeout(
                sock,
                `${user.phone}@s.whatsapp.net`,
                message,
                MESSAGE_SEND_TIMEOUT
            );

            if (result.success) {
                console.log(`[Scheduler] Reminder sent to ${user.name} (${user.phone})`);
                sentCount++;
            } else {
                console.log(`[Scheduler] Failed to send to ${user.phone}: ${result.error}`);
                skippedCount++;
            }

            if ((sentCount + skippedCount) % MAX_CONCURRENT_SENDS === 0) {
                await new Promise(resolve => setTimeout(resolve, MESSAGE_SEND_DELAY));
            }
        }

        console.log(`[Scheduler] Daily reminder done. Sent: ${sentCount}, Skipped: ${skippedCount}`);
    } catch (error) {
        console.error('[Scheduler] Error in daily reminder:', error);
    }
}

let schedulerTimeout = null;
let schedulerInterval = null;

function startScheduler() {
    if (schedulerTimeout || schedulerInterval) {
        console.log('[Scheduler] Already running, skipping.');
        return;
    }
    runScheduler();
}

async function runScheduler() {
    let hour = 9, minute = 0;
    try {
        await db.init();
        const settings = await db.getSettings();
        ({ hour, minute } = parseTime(settings.reminderTime || '09:00'));
        console.log(`[Scheduler] Starting — next reminder at ${hour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')} local time.`);
    } catch {
        console.log('[Scheduler] Starting with default time 09:00.');
    }

    scheduleNext(hour, minute);
}

function scheduleNext(hour, minute) {
    const next = getNextReminderTime(hour, minute);
    const delayMs = next.getTime() - Date.now();

    schedulerTimeout = setTimeout(async () => {
        await sendDailyReminder();
        schedulerTimeout = null;

        // Re-read settings for next run
        try {
            await db.init();
            const settings = await db.getSettings();
            if (!settings.reminderEnabled) {
                console.log('[Scheduler] Reminder disabled. Sleeping 1h then rechecking.');
                schedulerInterval = setTimeout(async () => {
                    schedulerInterval = null;
                    await runScheduler();
                }, 60 * 60 * 1000);
                return;
            }
            const { hour: h, minute: m } = parseTime(settings.reminderTime || '09:00');
            scheduleNext(h, m);
        } catch {
            scheduleNext(9, 0);
        }
    }, delayMs);

    console.log(`[Scheduler] Next reminder in ${Math.round(delayMs / 1000 / 60)} minutes.`);
}

function stopScheduler() {
    if (schedulerTimeout) { clearTimeout(schedulerTimeout); schedulerTimeout = null; }
    if (schedulerInterval) { clearTimeout(schedulerInterval); schedulerInterval = null; }
    console.log('[Scheduler] Stopped.');
}

module.exports = { startScheduler, stopScheduler, sendDailyReminder };
