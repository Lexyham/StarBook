/**
 * StarBook - Admin Setup Script
 * Run manually: npm run setup-admin
 *
 * Sets admin login to: Lexy / Lexy
 * Clears all stored admin session tokens
 * Initialises required DB collections
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../db/database.json');
const IMG_DIR = path.join(__dirname, '../public/images/celebrities');

async function setup() {
  console.log('\n⚙️  StarBook Setup Script\n');

  // Ensure image directory exists
  if (!fs.existsSync(IMG_DIR)) {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    console.log('✅ Created image cache directory: public/images/celebrities/');
  }

  const db = JSON.parse(fs.readFileSync(DB_PATH));

  // ── Remove ALL admin sessions ──────────────────────────────
  // Since we use stateless JWT there are no server-stored sessions,
  // but we clear any legacy session fields from user objects
  let sessionsCleaned = 0;
  db.users.forEach(u => {
    if (u.session) { delete u.session; sessionsCleaned++; }
    if (u.sessionToken) { delete u.sessionToken; sessionsCleaned++; }
    if (u.refreshToken) { delete u.refreshToken; sessionsCleaned++; }
    if (u.tokens) { delete u.tokens; sessionsCleaned++; }
  });
  if (sessionsCleaned > 0) console.log(`✅ Cleared ${sessionsCleaned} legacy session field(s)`);

  // ── Set admin account: Lexy / Lexy ───────────────────────
  const pwHash = await bcrypt.hash('Lexy', 10);
  const adminIdx = db.users.findIndex(u => u.userType === 'admin' || u.email === 'admin@starbook.com');

  const adminData = {
    id: 'admin-001',
    fullName: 'Lexy Admin',
    username: 'Lexy',
    email: 'lexy@starbook.internal',   // internal - not shown on login page
    password: pwHash,
    userType: 'admin',
    publicDashboardUserId: adminIdx >= 0 ? db.users[adminIdx].publicDashboardUserId || null : null,
    createdAt: adminIdx >= 0 ? db.users[adminIdx].createdAt : new Date().toISOString(),
    lastLogin: null,
    notifications: []
  };

  if (adminIdx >= 0) {
    db.users[adminIdx] = adminData;
  } else {
    db.users.push(adminData);
  }
  console.log('✅ Admin account set - Username: Lexy  |  Password: Lexy');

  // ── Initialise collections ────────────────────────────────
  if (!db.payments) db.payments = [];
  if (!db.pendingTestimonials) db.pendingTestimonials = [];
  if (!db.fanCards) db.fanCards = [];
  if (!db.pendingFanCards) db.pendingFanCards = [];
  if (!db.bookings) db.bookings = [];
  if (!db.licenseKeys) db.licenseKeys = [];
  console.log('✅ Database collections initialised');

  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

  console.log('\n🎉 Setup complete!');
  console.log('──────────────────────────────────────────');
  console.log('  Admin username : Lexy');
  console.log('  Admin password : Lexy');
  console.log('  Admin panel    : /backdoor');
  console.log('──────────────────────────────────────────');
  console.log('  Run: npm start');
  console.log('  Fetch images: node server/image-fetcher.js\n');
}

setup().catch(e => { console.error('Setup error:', e); process.exit(1); });
