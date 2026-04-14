/**
 * Inisialisasi database dengan user pertama (Super Admin)
 * Jalankan: node init-db.js
 */

const db = require('./database/db');

async function initSuperAdmin() {
    try {
        // Initialize database
        await db.init();
        console.log('✅ Database initialized');

        // Check if super admin already exists
        const existingUsers = await db.getAllUsers();
        console.log(`📊 Current users: ${existingUsers.length}`);

        // Add super admin (you can modify this)
        const superAdmin = {
            phone: '6281291544061', // Ganti dengan nomor HP super admin
            name: 'Super Admin',
            role: 'super_admin',
            class: 'TI-3A'
        };

        // Check if user already exists
        const existingUser = await db.getUserByPhone(superAdmin.phone);
        if (existingUser) {
            console.log('⚠️ User already exists:', existingUser);
        } else {
            await db.addUser(superAdmin);
            console.log('✅ Super Admin added successfully!');
            console.log('   Phone:', superAdmin.phone);
            console.log('   Name:', superAdmin.name);
            console.log('   Role:', superAdmin.role);
        }

    } catch (error) {
        console.error('❌ Error:', error);
    }
}

initSuperAdmin();