const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { handleMessage } = require('../handlers/messageHandler');
const { responses } = require('../commands/textResponses');
const config = require('../../config/config');
const db = require('../../database/db');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const path = require('path');

// Initialize logger
const logger = pino({ level: 'info' });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Add global handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function connectToWhatsApp(retryCount = 0) {
    try {
        // Initialize database first
        await db.init();
        console.log('✅ Database initialized');

        // Use sessionId from config for auth directory
        const authDir = './auth_info_baileys';
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version, isLatest } = await fetchLatestBaileysVersion();

        console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Chrome (Linux)', '', ''],
            markOnlineOnConnect: true,
            getMessage: async (key) => {
                return { conversation: '' };
            }
        });

        // Export sock globally so the scheduler can send messages
        global.botSock = sock;

        // Connection update handler
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n========================================');
                console.log('       📱 SCAN QR CODE INI            ');
                console.log('========================================');
                qrcode.generate(qr, { small: true });
                console.log('========================================');
                console.log('💡 Buka WhatsApp > Menu > Perangkat Tertaut');
                console.log('💡 Ketuk "Tautkan Perangkat" > Scan QR Code');
                console.log('========================================\n');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                // Handle session conflict (440)
                if (statusCode === 440) {
                    console.log('Session conflict detected, enabling maintenance mode...');
                    const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 30000);
                    setTimeout(() => connectToWhatsApp(retryCount + 1), backoffDelay);
                    return;
                }

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log(`Reconnecting in 5 seconds... (attempt ${retryCount + 1})`);
                    setTimeout(() => connectToWhatsApp(retryCount + 1), 5000);
                } else {
                    console.log('❌ Logged out. Please delete auth folder and run again.');
                }
            } else if (connection === 'connecting') {
                console.log('Connecting to WhatsApp...');
            } else if (connection === 'open') {
                console.log('✅✅✅ BOT BERHASIL TERHUBUNG! ✅✅✅');
                console.log('🤖 Bot siap digunakan...\n');
            }
        });

        // Automatically save session credentials
        sock.ev.on('creds.update', async () => {
            await saveCreds();
        });

        // Handle errors globally
        sock.ev.on('error', async (error) => {
            console.error('Connection error:', error);
        });

        // Update message handling
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            console.log('📨 messages.upsert received, type:', type, 'count:', messages?.length);
            if (type !== 'notify') {
                console.log('Skipping - type is not notify');
                return;
            }

            try {
                const message = messages[0];
                if (!message) {
                    console.log('No message in array');
                    return;
                }

                // Skip messages from the bot itself
                if (message.key.fromMe) {
                    console.log('Skipping own message');
                    return;
                }

                console.log('Processing message from:', message.key.remoteJid);
                await handleMessage(sock, message);
                console.log('Message processed successfully');
            } catch (error) {
                console.error('Error in message handling:', error);
                console.error('Stack:', error.stack);
            }
        });

        return sock;
    } catch (error) {
        console.error('Failed to connect:', error);
        const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 30000);
        setTimeout(() => connectToWhatsApp(retryCount + 1), backoffDelay);
    }
}

module.exports = { connectToWhatsApp };
