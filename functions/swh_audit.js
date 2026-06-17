const admin = require('firebase-admin');

// Use application default credentials (Firebase CLI auth)
admin.initializeApp({ projectId: 'swh-scoreboard' });
const db = admin.firestore();

async function main() {
  // Get all user subscription docs
  const usersSnap = await db.collection('users').get();
  
  const results = [];
  usersSnap.forEach(doc => {
    const d = doc.data();
    results.push({
      uid: doc.id,
      email: d.email || '',
      plan: d.plan || 'free',
      stripeCustomerId: d.stripeCustomerId || '',
      stripeSubscriptionId: d.stripeSubscriptionId || '',
      stripeStatus: d.stripeStatus || '',
      rcEntitlement: d.rcEntitlement || '',
      teamId: d.teamId || '',
      teamRole: d.teamRole || '',
      createdAt: d.createdAt ? d.createdAt.toDate().toISOString().slice(0,10) : '',
    });
  });
  
  // Sort by createdAt
  results.sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  
  console.log(JSON.stringify(results, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
