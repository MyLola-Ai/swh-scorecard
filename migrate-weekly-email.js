// Migration: default weeklyEmailEnabled = true for all users who don't have it explicitly set
// Run once from: node migrate-weekly-email.js
// Uses firebase-admin via the functions node_modules + application default credentials

const admin = require('./functions/node_modules/firebase-admin');

admin.initializeApp({ projectId: 'swh-scoreboard' });
const db = admin.firestore();

async function run() {
  console.log('Fetching all users...');
  const usersSnap = await db.collection('users').get();
  console.log(`Found ${usersSnap.size} user docs`);

  let updated = 0, skipped = 0, errors = 0;
  const BATCH_SIZE = 400;
  let batch = db.batch();
  let batchCount = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    try {
      const settingsRef = db.doc(`users/${uid}/config/settings`);
      const settingsSnap = await settingsRef.get();
      const data = settingsSnap.exists ? settingsSnap.data() : {};

      // Only update if not already explicitly true
      if (data.weeklyEmailEnabled === true) {
        skipped++;
        continue;
      }

      batch.set(settingsRef, { weeklyEmailEnabled: true }, { merge: true });
      batchCount++;
      updated++;

      if (batchCount >= BATCH_SIZE) {
        await batch.commit();
        console.log(`  Committed batch of ${batchCount}...`);
        batch = db.batch();
        batchCount = 0;
      }
    } catch (e) {
      console.error(`  Error for uid ${uid}:`, e.message);
      errors++;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
    console.log(`  Committed final batch of ${batchCount}.`);
  }

  console.log(`\nDone.`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Already on (skipped): ${skipped}`);
  console.log(`  Errors: ${errors}`);
}

run().catch(err => { console.error('Migration failed:', err); process.exit(1); });
