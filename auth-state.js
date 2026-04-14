const { initAuthCreds } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const authFile = path.join(__dirname, '../auth_info_baileys', 'auth.json');

/**
 * Simple single-file auth state.
 * Writes ALL credentials (creds + keys) to ONE file atomically.
 * Avoids the multi-file race conditions in useMultiFileAuthState.
 */
function useSingleAuthState() {
    let creds = initAuthCreds();

    // Load existing credentials if file exists
    if (fs.existsSync(authFile)) {
        try {
            const raw = fs.readFileSync(authFile, 'utf-8');
            const parsed = JSON.parse(raw);
            creds = parsed;
            console.log('✅ Loaded existing auth credentials.');
        } catch (e) {
            console.log('⚠️ Gagal load auth file, menggunakan credentials baru.');
        }
    }

    const saveCreds = async () => {
        try {
            const dir = path.dirname(authFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(authFile, JSON.stringify(creds));
        } catch (e) {
            console.log('❌ Gagal menyimpan credentials:', e.message);
        }
    };

    const state = {
        creds,
        keys: {
            get: async () => ({}),
            set: async () => {}
        }
    };

    return { state, saveCreds };
}

module.exports = { useSingleAuthState };
