require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { connectMongo, isConnected, User, Celebrity, Booking, FanCard, Testimonial, LicenseKey } = require('../services/mongoService');

const DB_PATH = path.join(__dirname, '../db/database.json');

async function migrate() {
  console.log('StarBook - JSON → MongoDB migration');
  console.log('=====================================');

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set in .env');
    process.exit(1);
  }

  await connectMongo();
  if (!isConnected()) {
    console.error('Could not connect to MongoDB. Check MONGODB_URI.');
    process.exit(1);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error('db/database.json not found');
    process.exit(1);
  }

  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

  async function upsertMany(Model, items, keyField, label) {
    let inserted = 0, updated = 0, failed = 0;
    for (const item of items) {
      try {
        const filter = { [keyField]: item[keyField] };
        const result = await Model.updateOne(filter, { $set: item }, { upsert: true });
        if (result.upsertedCount) inserted++;
        else updated++;
      } catch (e) {
        failed++;
        console.warn(`  [${label}] skip: ${e.message.slice(0, 80)}`);
      }
    }
    console.log(`  ${label}: ${inserted} inserted, ${updated} updated, ${failed} failed`);
  }

  console.log('\nMigrating users...');
  await upsertMany(User, db.users || [], 'id', 'Users');

  console.log('Migrating celebrities...');
  await upsertMany(Celebrity, db.celebrities || [], 'id', 'Celebrities');

  console.log('Migrating bookings...');
  const allBookings = [...(db.bookings || [])];
  await upsertMany(Booking, allBookings, 'id', 'Bookings');

  console.log('Migrating fan cards...');
  const allCards = [...(db.fanCards || []), ...(db.pendingFanCards || [])];
  await upsertMany(FanCard, allCards, 'id', 'FanCards');

  console.log('Migrating testimonials...');
  const allTestimonials = [...(db.testimonials || []), ...(db.pendingTestimonials || [])];
  await upsertMany(Testimonial, allTestimonials, 'id', 'Testimonials');

  console.log('Migrating license keys...');
  await upsertMany(LicenseKey, db.licenseKeys || [], 'key', 'LicenseKeys');

  console.log('\nMigration complete.');
  process.exit(0);
}

migrate().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
