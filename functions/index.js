const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const { RELATIONSHIP_GRADES, DEMOTION_RULES } = require('./relationship-config');
const {defineSecret} = require('firebase-functions/params');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const REVENUECAT_WEBHOOK_AUTH = defineSecret('REVENUECAT_WEBHOOK_AUTH');

// ===== MyAppointment.AI cross-project integration =====
// SA key for myappointment-ai-8756e — lets us provision users + mint custom tokens.
// Shared bearer secret used by this codebase to call the upgradePlan endpoint
// that lives in functions/mylola (loaniq-75a20).
const MYAPPOINTMENT_SA_KEY        = defineSecret('MYAPPOINTMENT_SERVICE_ACCOUNT_KEY');
const MYAPPOINTMENT_UPGRADE_SECRET = defineSecret('MYAPPOINTMENT_UPGRADE_SECRET');
// SA key for loaniq-75a20 — the ACTUAL project where mylola.ai user data lives
// (schedulingProfile, bookingPages, meetings). Distinct from myappointment-ai-8756e.
const LOANIQ_SA_KEY               = defineSecret('LOANIQ_SERVICE_ACCOUNT_KEY');

// ===== Email integration: Gmail (Google OAuth) =====
// Set via: firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID
//          firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET
// Authorized redirect URI (configure in Google Cloud Console):
//   https://us-central1-swh-scoreboard.cloudfunctions.net/gmailOauthCallback
// Scopes used: gmail.readonly + openid + email + profile
const GOOGLE_OAUTH_CLIENT_ID = defineSecret('GOOGLE_OAUTH_CLIENT_ID');
const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret('GOOGLE_OAUTH_CLIENT_SECRET');
// HMAC secret for signing the OAuth `state` parameter (prevents CSRF and
// proves the uid in the redirect came from us). Any random 32+ char string.
const OAUTH_STATE_SECRET = defineSecret('OAUTH_STATE_SECRET');
// Microsoft / Outlook (planned — secrets reserved, integration ships next drop)
const MICROSOFT_OAUTH_CLIENT_ID = defineSecret('MICROSOFT_OAUTH_CLIENT_ID');
const MICROSOFT_OAUTH_CLIENT_SECRET = defineSecret('MICROSOFT_OAUTH_CLIENT_SECRET');

// ===== RevenueCat config =====
// IAP product identifiers — these MUST match what's created in App Store Connect.
// Convention: com.<appbundle>.<plan>.<period>
// (Pick these IDs once and never rename — Apple bakes them into the user's purchase history.)
const REVENUECAT_PRODUCTS = {
  // Apple IAP product IDs (configured in App Store Connect, then imported into RevenueCat)
  'com.impactleadershipgroup.swh.scorecard.monthly': 'scorecard', // Scorecard $10/mo
  'com.impactleadershipgroup.swh.crm.monthly':       'pro',       // Scorecard CRM $25/mo
};
// RevenueCat entitlement identifiers → internal plan value.
// An entitlement is RC's abstraction for "what does an active sub unlock?"
// We use one entitlement per tier so users can be on EITHER scorecard or pro at any time.
const REVENUECAT_ENTITLEMENTS = {
  'scorecard': 'scorecard',
  'crm':       'pro',
  'pro':       'pro', // alias if RC dashboard names it "pro" instead of "crm"
};

// ===== Stripe config — LIVE mode price IDs =====
// Sandbox IDs preserved here for reference if we ever need to flip back:
//   scorecard (sandbox $10):     price_1TWRRd9BR5tIfukkmQQH2Nmj
//   scorecard_crm (sandbox $25): price_1TWRS49BR5tIfukks1vt6Hnd
const STRIPE_PRICES = {
  // Monthly personal plans
  scorecard:        'price_1TV0G35dEXTl1F5TvTpDo7kq', // Live Scorecard $10/mo
  scorecard_crm:    'price_1TWSjh5dEXTl1F5TonpKPaOb', // Live Scorecard CRM $25/mo
  // Team plans — volume-tiered prices in Stripe.
  team:             'price_1TZHb75dEXTl1F5Tu7dWgMIk',  // Team Scorecard, 3-9 @ $8, 10+ @ $7
  team_crm:         'price_1TZfBe5dEXTl1F5T5vGF3vum',  // Team CRM, Volume: 1-2 @ $25, 3-9 @ $20, 10+ @ $15
};
const TEAM_MIN_SEATS = 3;
const STRIPE_TRIAL_DAYS = 60;
const STRIPE_RETURN_BASE = 'https://swh-scoreboard.web.app'; // post-checkout return + portal return
const LANDING_BASE = 'https://stopwastinghandshakes.com';
// PLAN_LOOKUP — map a Stripe price ID back to our internal `plan` value on the user doc.
const STRIPE_PRICE_TO_PLAN = {
  [STRIPE_PRICES.scorecard]:     'scorecard',
  [STRIPE_PRICES.scorecard_crm]: 'pro',
  [STRIPE_PRICES.team]:          'team',
  [STRIPE_PRICES.team_crm]:      'team',
};

function getStripe() {
  const Stripe = require('stripe');
  return Stripe(STRIPE_SECRET_KEY.value(), { apiVersion: '2024-06-20' });
}

// ===== EXISTING: Business Card Scanner =====
exports.scanBusinessCard = onCall({
  cors: true,
  enforceAppCheck: false,
  secrets: [ANTHROPIC_API_KEY],
}, async (request) => {
  // Auth-first — callable harness will return 401 for HttpsError('unauthenticated')
  // instead of 500 INTERNAL (which is what a plain `throw new Error()` gives).
  // Caller is always a SWH-signed-in user (browser SDK attaches the bearer); we
  // never expect anonymous traffic here, but the gate keeps the function out of
  // the noisy-log 500 bucket if a scraper finds the URL.
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required to scan business cards.');
  }
  const { imageBase64, mediaType } = request.data || {};
  if (!imageBase64) throw new HttpsError('invalid-argument', 'imageBase64 required');
  console.log(`[scanBusinessCard] uid=${request.auth.uid} img=${Math.round(imageBase64.length / 1024)}KB type=${mediaType || 'image/jpeg'}`);
  const t0 = Date.now();

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // secrets set via pipe carry a trailing newline; undici rejects it as a header value
      'x-api-key': ANTHROPIC_API_KEY.value().trim(),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Extract the contact information from this business card. Return ONLY a JSON object with these fields (use empty string if not found): firstName, lastName, phone, email, company, title, website. No other text, no markdown.' }
        ]
      }]
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('scanBusinessCard: Anthropic API error', response.status, JSON.stringify(result.error || result).slice(0, 500));
    throw new HttpsError('internal', result.error?.message || `Card scan failed (API ${response.status}).`);
  }
  const text = result.content?.find(b => b.type === 'text')?.text || '{}';
  let parsed = null;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) { /* fall through */ } }
  }
  if (!parsed) {
    console.error('scanBusinessCard: unparseable model output', text.slice(0, 300));
    throw new HttpsError('internal', 'Could not parse card data.');
  }
  console.log(`[scanBusinessCard] ok in ${Date.now() - t0}ms fields=${['firstName', 'lastName', 'phone', 'email'].filter(k => parsed[k]).join(',') || 'none'}`);
  return parsed;
});

// ===== Auth helper — verify the Firebase ID token from the Authorization header =====
async function requireAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    const err = new Error('Missing Authorization header');
    err.statusCode = 401;
    throw err;
  }
  const token = header.slice(7);
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (e) {
    const err = new Error('Invalid or expired token');
    err.statusCode = 401;
    throw err;
  }
}

function sendErr(res, e) {
  const code = e.statusCode || 500;
  res.status(code).json({ error: e.message || 'Server error' });
}

// ===== Helpers for week math (mirror of client logic) =====
const DAY_INDEX = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getWeekStart(dateKey, weekStartDay) {
  const startIdx = DAY_INDEX[(weekStartDay||'monday').toLowerCase()] ?? 1;
  const d = new Date(dateKey + 'T12:00:00');
  let diff = d.getDay() - startIdx;
  if (diff < 0) diff += 7;
  d.setDate(d.getDate() - diff);
  return fmtDate(d);
}
function addDays(dateKey, days) {
  const d = new Date(dateKey + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
// KEEP IN SYNC with the tier msgs in public-scorecard/index.html (tiers array
// + tiers modal) and public-crm/index.html.
function getTier(pts) {
  if (pts >= 200) return { name:'Master Networker', emoji:'🥇', color:'#D4A847', msg:"Gold earned. Every handshake honored. You are the network." };
  if (pts >= 150) return { name:'Professional Networker', emoji:'🥈', color:'#9CA3AF', msg:"Silver earned. You follow through when others fade away." };
  if (pts >= 100) return { name:'Consistent Connector', emoji:'🥉', color:'#CD7F32', msg:"Bronze earned. Relationships are built, not harvested. Keep building." };
  if (pts >= 50)  return { name:'Active Networker', emoji:'🔵', color:'#2563EB', msg:"You're showing up. Now notice, remember, and respond." };
  return { name:'Getting Started', emoji:'🟢', color:'#16A34A', msg:"The first step is taken. Trust is built in small kept commitments." };
}

// Canonical category/lead per default activity name. Saved day breakdowns
// carry whatever category the user's (possibly stale/legacy) activity list
// had at log time — e.g. "Perform Other 8 Step Activities" labeled
// "Follow Through" in old lists. Emails normalize known names through this
// map and only trust stored values for unknown/custom activities.
const CANONICAL_ACTIVITIES = {
  'Attend Networking Meeting':        { category: 'Networking',          lead: true },
  'Add New Contact':                  { category: 'Networking',          lead: true },
  'Have a FORMing Conversation':      { category: 'Conversations',       lead: true },
  'Good to Meet You Follow Through':  { category: 'Follow Through',      lead: true },
  'Call Someone from CRM':            { category: 'Follow Through',      lead: true },
  'Attend 1:1, Coffee, Lunch, etc.':  { category: 'High-Value Meetings', lead: true },
  'Attend 1:1, Coffee, Lunch':        { category: 'High-Value Meetings', lead: true },
  'Mail Note or Card':                { category: 'High-Value Meetings', lead: true },
  'Give a Referral':                  { category: 'Referrals & Results', lead: true },
  'Make Introduction':                { category: 'Referrals & Results', lead: true },
  'Receive a Referral':               { category: 'Referrals & Results', lead: false },
  'Opportunity Won':                  { category: 'Referrals & Results', lead: false },
  'Perform Other 8 Step Activities':  { category: 'System',              lead: true },
  'Host Event':                       { category: 'Events',              lead: true },
};

// ===== getMe — returns the current user's plan, settings, today, history, lag, activities =====
exports.getMe = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST' && req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const userRef = db.collection('users').doc(uid);

    const [userSnap, settingsSnap, activitiesSnap, daysSnap, lagSnap] = await Promise.all([
      userRef.get(),
      userRef.collection('config').doc('settings').get(),
      userRef.collection('config').doc('activities').get(),
      userRef.collection('days').orderBy('dateKey', 'desc').limit(180).get(),
      userRef.collection('lag').orderBy('dateKey', 'desc').limit(180).get()
    ]);

    const userData = userSnap.exists ? userSnap.data() : {};
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const activitiesData = activitiesSnap.exists ? activitiesSnap.data() : null;
    const history = daysSnap.docs.map(d => d.data()).filter(d => (d.totalPts || 0) > 0);
    const lagHistory = lagSnap.docs.map(d => d.data());

    // Today's counts
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const todayDoc = await userRef.collection('days').doc(todayKey).get();
    const todayCounts = todayDoc.exists ? (todayDoc.data().counts || {}) : {};

    // ===== Effective plan resolution — team membership grants product access =====
    // A user on a team with an active subscription is entitled to the team's product set
    // even if their personal `plan` is `free`. Team plan field controls what they get:
    //   - team_scorecard: Scorecard only (effective = 'scorecard')
    //   - team_crm:       Scorecard + CRM (effective = 'pro')
    // Existing teams created before this change default to team_scorecard.
    let effectivePlan = userData.plan || 'free';
    let teamInfo = null;
    if (userData.teamId) {
      const teamSnap = await db.collection('teams').doc(userData.teamId).get();
      if (teamSnap.exists) {
        const team = teamSnap.data();
        const teamActive = team.active === true ||
          team.subscriptionStatus === 'active' ||
          team.subscriptionStatus === 'trialing' ||
          team.subscriptionStatus === 'comp'; // admin-comp'd teams are always active
        const teamPlan = team.plan || 'team_scorecard'; // backfill default
        if (teamActive) {
          // Upgrade the effective plan if the team's plan is richer than the personal one.
          // Order: free < scorecard < pro
          const rank = { free: 0, scorecard: 1, pro: 2 };
          const teamProduct = teamPlan === 'team_crm' ? 'pro' : 'scorecard';
          if ((rank[teamProduct] || 0) > (rank[effectivePlan] || 0)) {
            effectivePlan = teamProduct;
          }
        }
        teamInfo = {
          id: userData.teamId,
          name: team.name,
          plan: teamPlan,
          role: userData.teamRole || (team.ownerUid === uid ? 'owner' : 'member'),
          active: teamActive,
          seats: team.seats || 0,
          subscriptionStatus: team.subscriptionStatus || null,
        };
      }
    }

    res.json({
      uid,
      email: decoded.email || userData.email || '',
      plan: effectivePlan,
      personalPlan: userData.plan || 'free', // raw personal plan for billing UI
      team: teamInfo,
      dismissedAnnouncements: userData.dismissedAnnouncements || {},
      settings: {
        phone: settings.phone || '',
        smsOptIn: settings.smsOptIn || false,
        weeklyGoal: settings.weeklyGoal || 150,
        displayName: settings.displayName || '',
        weekStartDay: settings.weekStartDay || 'monday',
        weeklyEmailEnabled: settings.weeklyEmailEnabled || false,
        weeklyEmailDay: settings.weeklyEmailDay || 'monday',
        weeklyEmailHour: typeof settings.weeklyEmailHour === 'number' ? settings.weeklyEmailHour : 9,
        weeklyEmailTimezone: settings.weeklyEmailTimezone || 'America/Chicago'
      },
      activities: activitiesData ? activitiesData.list : null,
      todayCounts,
      history,
      lagHistory
    });
  } catch (e) { sendErr(res, e); }
});

// ===== saveDay — write today's (or a backdated) day doc with merged counts/breakdown =====
exports.saveDay = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const { dateKey, counts, breakdown, totalPts, leadPts, lagPts, categoryPts, weekKey, monthKey, dateLabel } = req.body || {};
    if (!dateKey || typeof dateKey !== 'string') { res.status(400).json({ error: 'Missing dateKey' }); return; }

    const dayRef = db.collection('users').doc(uid).collection('days').doc(dateKey);
    const existing = await dayRef.get();
    const existingData = existing.exists ? existing.data() : {};
    const existingBreakdown = existingData.breakdown || {};

    // Merge breakdown so we don't clobber CRM-logged items the scorecard doesn't know about
    const mergedBreakdown = { ...existingBreakdown, ...(breakdown || {}) };
    let mergedTotal = totalPts || 0, mergedLead = leadPts || 0, mergedLag = lagPts || 0;
    const mergedCatPts = { ...(categoryPts || {}) };
    Object.entries(existingBreakdown).forEach(([name, bd]) => {
      if (!(breakdown || {})[name] && bd && bd.count > 0) {
        mergedTotal += bd.pts || 0;
        if (bd.lead === false) mergedLag += bd.pts || 0; else mergedLead += bd.pts || 0;
        const cat = bd.category || 'Activities';
        mergedCatPts[cat] = (mergedCatPts[cat] || 0) + (bd.pts || 0);
      }
    });

    await dayRef.set({
      ...existingData,
      dateKey, dateLabel: dateLabel || dateKey, weekKey: weekKey || dateKey, monthKey: monthKey || dateKey.slice(0,7),
      counts: { ...(existingData.counts || {}), ...(counts || {}) },
      breakdown: mergedBreakdown,
      totalPts: mergedTotal,
      leadPts: mergedLead,
      lagPts: mergedLag,
      categoryPts: mergedCatPts,
      submitted: true,
      submittedAt: new Date().toISOString()
    });

    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

// ===== saveLag — write a lag entry (opportunities/referrals/deals) =====
exports.saveLag = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const { dateKey, weekKey, monthKey, opportunities, referrals, dealsStarted, dealsCompleted } = req.body || {};
    if (!dateKey) { res.status(400).json({ error: 'Missing dateKey' }); return; }
    await db.collection('users').doc(uid).collection('lag').doc(dateKey).set({
      dateKey,
      weekKey: weekKey || dateKey,
      monthKey: monthKey || dateKey.slice(0,7),
      opportunities: parseInt(opportunities) || 0,
      referrals: parseInt(referrals) || 0,
      dealsStarted: parseInt(dealsStarted) || 0,
      dealsCompleted: parseInt(dealsCompleted) || 0,
      updatedAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

// ===== saveSettings — update phone, smsOptIn, weeklyGoal, displayName =====
exports.saveSettings = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const { phone, smsOptIn, weeklyGoal, displayName,
            weekStartDay, weeklyEmailEnabled, weeklyEmailDay, weeklyEmailHour, weeklyEmailTimezone,
            accountabilityPartners, calendarAutoLog } = req.body || {};
    const update = {};
    if (typeof phone === 'string') update.phone = phone;
    if (typeof smsOptIn === 'boolean') update.smsOptIn = smsOptIn;
    if (typeof weeklyGoal === 'number' && weeklyGoal > 0 && weeklyGoal < 10000) update.weeklyGoal = weeklyGoal;
    if (typeof displayName === 'string') update.displayName = displayName.slice(0, 100);
    if (typeof weekStartDay === 'string' && DAY_INDEX[weekStartDay.toLowerCase()] !== undefined) {
      update.weekStartDay = weekStartDay.toLowerCase();
    }
    if (typeof weeklyEmailEnabled === 'boolean') update.weeklyEmailEnabled = weeklyEmailEnabled;
    if (typeof weeklyEmailDay === 'string' && DAY_INDEX[weeklyEmailDay.toLowerCase()] !== undefined) {
      update.weeklyEmailDay = weeklyEmailDay.toLowerCase();
    }
    if (typeof weeklyEmailHour === 'number' && weeklyEmailHour >= 0 && weeklyEmailHour <= 23) {
      update.weeklyEmailHour = Math.floor(weeklyEmailHour);
    }
    if (typeof weeklyEmailTimezone === 'string' && weeklyEmailTimezone.length < 50) {
      update.weeklyEmailTimezone = weeklyEmailTimezone;
    }
    if (Array.isArray(accountabilityPartners)) {
      update.accountabilityPartners = accountabilityPartners
        .filter(e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))
        .slice(0, 5)
        .map(e => e.toLowerCase().trim());
    }
    if (typeof calendarAutoLog === 'boolean') update.calendarAutoLog = calendarAutoLog;
    await db.collection('users').doc(uid).collection('config').doc('settings').set(update, { merge: true });
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

// ===== Waitlist signup — plain HTTP endpoint that bypasses Firebase SDK on the client =====
// The iOS app's WKWebView can't initialize Firebase Auth (Google APIs iframe blocked
// by capacitor:// CORS), which means Firestore writes hang waiting for auth state.
// This endpoint accepts unauthenticated POSTs and writes via Admin SDK.
exports.submitWaitlist = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { email, reason, platform } = req.body || {};
  if (typeof email !== 'string' || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email' });
    return;
  }
  try {
    await db.collection('waitlist').add({
      email: email.toLowerCase(),
      reason: typeof reason === 'string' ? reason.slice(0, 50) : 'paywall',
      platform: typeof platform === 'string' ? platform.slice(0, 30) : 'unknown',
      createdAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch(e) {
    console.error('[submitWaitlist] write failed:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Waitlist approval — admin promotes a /waitlist entry to a real account =====
const ADMIN_EMAILS = ['austen@austensmith.com'];

// Sender address for all outbound mail written to the `mail` collection.
// Must match a verified sender in the SMTP credentials configured for the
// firestore-send-email extension.  Update this if your SMTP uses a different
// verified domain.
const MAIL_FROM = 'SWH Reports <noreply@stopwastinghandshakes.com>';

exports.approveWaitlistUser = onCall({ cors: true }, async (request) => {
  const callerEmail = (request.auth?.token?.email || '').toLowerCase();
  if (!callerEmail || !ADMIN_EMAILS.includes(callerEmail)) {
    throw new Error('Permission denied: admin only');
  }
  const { waitlistDocId, plan } = request.data || {};
  if (!waitlistDocId) throw new Error('Missing waitlistDocId');
  const targetPlan = plan === 'pro' ? 'pro' : 'scorecard';

  const waitlistRef = db.collection('waitlist').doc(waitlistDocId);
  const waitlistSnap = await waitlistRef.get();
  if (!waitlistSnap.exists) throw new Error('Waitlist entry not found');
  const { email } = waitlistSnap.data();
  if (!email) throw new Error('Waitlist entry missing email');

  // Find or create the Firebase Auth user
  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      userRecord = await admin.auth().createUser({ email, emailVerified: false });
    } else {
      throw e;
    }
  }
  const uid = userRecord.uid;

  // Upsert /users/{uid} with the plan
  const userDocRef = db.collection('users').doc(uid);
  const userDocSnap = await userDocRef.get();
  await userDocRef.set({
    email,
    plan: targetPlan,
    approvedAt: new Date().toISOString(),
    approvedBy: callerEmail,
    ...(userDocSnap.exists ? {} : { createdAt: new Date().toISOString() })
  }, { merge: true });

  // Password reset link doubles as a "set your password and sign in" link.
  const link = await admin.auth().generatePasswordResetLink(email);

  // Welcome email via Trigger Email Extension
  await db.collection('mail').add({
    to: [email],
    message: {
      subject: 'You\'re in — set up your SWH Scorecard account',
      html: `<p>Welcome to Stop Wasting Handshakes.</p>
        <p>You've been approved as a beta tester on the <strong>${targetPlan === 'pro' ? 'Pro' : 'Scorecard'}</strong> plan. Click below to set your password — that's your sign-in for the iOS app and web.</p>
        <p><a href="${link}" style="display:inline-block;padding:14px 28px;background:#E63946;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-family:Arial,sans-serif;">Set password & sign in</a></p>
        <p>After setting your password, sign in at <a href="https://app.stopwastinghandshakes.com">app.stopwastinghandshakes.com</a> or open the SWH Scorecard iOS app and tap "Already a member? Sign in" from the paywall.</p>
        <p>If you're getting access to the iOS app via TestFlight, you'll receive a separate invite from Apple shortly.</p>
        <p>— Austen</p>`
    }
  });

  // Mark the waitlist entry as approved
  await waitlistRef.update({
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy: callerEmail,
    uid,
    plan: targetPlan
  });

  return { ok: true, uid, plan: targetPlan };
});

// ===== Create user manually — admin creates a Firebase user with a known password =====
// Useful for App Store reviewer accounts and internal testing. Skips the
// "set password via email link" flow so the admin can capture credentials directly.
exports.createTestUser = onCall({ cors: true }, async (request) => {
  const callerEmail = (request.auth?.token?.email || '').toLowerCase();
  if (!callerEmail || !ADMIN_EMAILS.includes(callerEmail)) {
    throw new Error('Permission denied: admin only');
  }
  const { email, password, plan, displayName } = request.data || {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Invalid email');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const targetPlan = plan === 'pro' ? 'pro' : 'scorecard';

  let userRecord;
  let created = false;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
    // User exists — just update password and confirm email
    await admin.auth().updateUser(userRecord.uid, { password, emailVerified: true });
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      userRecord = await admin.auth().createUser({
        email, password, emailVerified: true,
        ...(displayName ? { displayName } : {})
      });
      created = true;
    } else throw e;
  }

  await db.collection('users').doc(userRecord.uid).set({
    email,
    plan: targetPlan,
    ...(created ? { createdAt: new Date().toISOString() } : {}),
    createdBy: callerEmail,
    isTestUser: true
  }, { merge: true });

  if (displayName) {
    await db.collection('users').doc(userRecord.uid)
      .collection('config').doc('settings').set({ displayName }, { merge: true });
  }

  return { ok: true, uid: userRecord.uid, email, plan: targetPlan, created };
});

// ===== Self-service account deletion — user deletes their own account (Apple Guideline 4) =====
exports.deleteAccountSelf = onRequest({ cors: true }, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;

    // Best-effort cleanup of user subcollections
    const subcollections = ['days', 'lag', 'config', 'contacts', 'opportunities', 'integrations'];
    for (const sub of subcollections) {
      try {
        const snap = await db.collection(`users/${uid}/${sub}`).get();
        if (!snap.empty) {
          const chunks = [];
          for (let i = 0; i < snap.docs.length; i += 400) chunks.push(snap.docs.slice(i, i + 400));
          for (const chunk of chunks) {
            const batch = db.batch();
            chunk.forEach(d => batch.delete(d.ref));
            await batch.commit();
          }
        }
      } catch (e) { console.warn(`[deleteAccountSelf] subcol ${sub} cleanup failed:`, e.message); }
    }

    // Delete /users/{uid} doc
    await db.collection('users').doc(uid).delete().catch(() => {});

    // Delete the Firebase Auth account
    try {
      await admin.auth().deleteUser(uid);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }

    res.json({ ok: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ===== Delete user — admin removes a user's auth account, /users doc, and subcollections =====
exports.deleteUser = onCall({ cors: true }, async (request) => {
  const callerEmail = (request.auth?.token?.email || '').toLowerCase();
  if (!callerEmail || !ADMIN_EMAILS.includes(callerEmail)) {
    throw new Error('Permission denied: admin only');
  }
  const { uid } = request.data || {};
  if (!uid) throw new Error('Missing uid');
  // Don't allow self-delete
  if (request.auth?.uid === uid) throw new Error('Cannot delete your own admin account');

  // Best-effort cleanup of user subcollections
  const subcollections = ['days', 'lag', 'config', 'contacts', 'opportunities'];
  for (const sub of subcollections) {
    const snap = await db.collection(`users/${uid}/${sub}`).get();
    if (snap.empty) continue;
    // Firestore batches max 500 ops
    const chunks = [];
    for (let i = 0; i < snap.docs.length; i += 400) chunks.push(snap.docs.slice(i, i + 400));
    for (const chunk of chunks) {
      const batch = db.batch();
      chunk.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }

  // Delete /users/{uid} doc
  await db.collection('users').doc(uid).delete().catch(() => {});

  // Delete the Firebase Auth user
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  return { ok: true, uid };
});

// ===== Weekly Recap Email — shared helpers (template + stat computation) =====

const DAY_SHORT = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
const DAY_LONG  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const TIER_BADGE_BG = {
  'Master Networker':       { fill:'rgba(212,168,71,0.16)',  border:'rgba(212,168,71,0.45)',  text:'#FFE38B' },
  'Professional Networker': { fill:'rgba(192,192,192,0.16)', border:'rgba(192,192,192,0.4)',  text:'#E5E5E5' },
  'Consistent Connector':   { fill:'rgba(205,127,50,0.16)',  border:'rgba(205,127,50,0.4)',   text:'#F0B68A' },
  'Active Networker':       { fill:'rgba(37,99,235,0.16)',   border:'rgba(37,99,235,0.4)',    text:'#93C5FD' },
  'Getting Started':        { fill:'rgba(22,163,74,0.16)',   border:'rgba(22,163,74,0.4)',    text:'#86EFAC' },
};

// Compute weekly stats for a user. Returns null if there's no logged activity.
async function computeUserWeeklyStats(uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) return null;
  const userData = userDoc.data() || {};
  const settingsSnap = await db.doc(`users/${uid}/config/settings`).get();
  const settings = settingsSnap.exists ? (settingsSnap.data() || {}) : {};

  const tz = settings.weeklyEmailTimezone || 'America/Chicago';
  const todayKey = new Date().toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10);
  const weekStart = settings.weekStartDay || 'monday';
  const thisWeekStart = getWeekStart(todayKey, weekStart);
  const lastWeekEnd = addDays(thisWeekStart, -1);
  const lastWeekStart = addDays(thisWeekStart, -7);

  const daysSnap = await db.collection(`users/${uid}/days`)
    .where('dateKey', '>=', lastWeekStart)
    .where('dateKey', '<=', lastWeekEnd)
    .get();

  // Initialize 7 daily buckets
  const dailyMap = {};
  for (let i = 0; i < 7; i++) {
    const k = addDays(lastWeekStart, i);
    const d = new Date(k + 'T12:00:00');
    dailyMap[k] = { dateKey: k, dayShort: DAY_SHORT[d.getDay()], dayLong: DAY_LONG[d.getDay()], pts: 0 };
  }

  let totalPts = 0, leadPts = 0, lagPts = 0, daysLogged = 0;
  const breakdown = {}, catTotals = {};
  daysSnap.forEach(d => {
    const data = d.data() || {};
    if ((data.totalPts || 0) <= 0) return;
    daysLogged++;
    totalPts += data.totalPts || 0;
    leadPts += data.leadPts || 0;
    lagPts += data.lagPts || 0;
    if (dailyMap[data.dateKey]) dailyMap[data.dateKey].pts = data.totalPts;
    Object.entries(data.breakdown || {}).forEach(([name, bd]) => {
      if (!breakdown[name]) breakdown[name] = { count: 0, pts: 0, icon: bd.icon, category: bd.category, lead: bd.lead };
      breakdown[name].count += bd.count || 0;
      breakdown[name].pts += bd.pts || 0;
    });
    Object.entries(data.categoryPts || {}).forEach(([cat, pts]) => {
      catTotals[cat] = (catTotals[cat] || 0) + (pts || 0);
    });
  });

  if (daysLogged === 0) return null;

  // Streak: consecutive days with > 0 pts ending at the latest logged day in the week
  const dailyArr = Object.values(dailyMap).sort((a,b) => a.dateKey.localeCompare(b.dateKey));
  let streak = 0, runningStreak = 0;
  dailyArr.forEach(d => {
    if (d.pts > 0) { runningStreak++; streak = Math.max(streak, runningStreak); }
    else { runningStreak = 0; }
  });

  // Best day
  const bestDay = dailyArr.reduce((best, d) => (d.pts > best.pts ? d : best), dailyArr[0]);

  // Mark best day in dailyArr
  const maxPts = Math.max(...dailyArr.map(d => d.pts));
  dailyArr.forEach(d => { d.isBest = (d.pts > 0 && d.pts === maxPts); });

  // Compare to prior week
  const priorWeekStart = addDays(lastWeekStart, -7);
  const priorWeekEnd = addDays(lastWeekStart, -1);
  const priorSnap = await db.collection(`users/${uid}/days`)
    .where('dateKey', '>=', priorWeekStart)
    .where('dateKey', '<=', priorWeekEnd)
    .get();
  let priorTotal = 0;
  priorSnap.forEach(d => { priorTotal += (d.data() || {}).totalPts || 0; });
  const trendPct = priorTotal > 0 ? Math.round(((totalPts - priorTotal) / priorTotal) * 100) : null;

  const tier = getTier(totalPts);
  const goal = settings.weeklyGoal || 150;
  const goalPct = Math.round((totalPts / goal) * 100);
  const goalHit = totalPts >= goal;
  const firstName = (settings.displayName || userData.email || 'there').split(/[\s@]/)[0];

  // Top 3 activities by count (normalize category/lead for known names —
  // stored breakdowns can carry stale categories from legacy activity lists)
  const topActs = Object.entries(breakdown)
    .map(([name, b]) => {
      const canon = CANONICAL_ACTIVITIES[name];
      return { name, ...b, category: canon ? canon.category : b.category, lead: canon ? canon.lead : b.lead };
    })
    .sort((a,b) => b.count - a.count)
    .slice(0, 3);

  // Top category
  const topCatEntry = Object.entries(catTotals).sort((a,b) => b[1] - a[1])[0];
  const topCategory = topCatEntry ? topCatEntry[0] : null;
  const topCategoryPts = topCatEntry ? topCatEntry[1] : 0;

  // Three-block coaching
  const coaching = buildCoachingBlocks({ totalPts, leadPts, lagPts, daysLogged, goal, goalHit, streak, dailyArr, topActs, topCategory, tier });

  return {
    email: userData.email, firstName,
    weekStart: lastWeekStart, weekEnd: lastWeekEnd,
    totalPts, leadPts, lagPts, daysLogged,
    avgPerDay: daysLogged > 0 ? Math.round(totalPts / daysLogged) : 0,
    streak, bestDay,
    goal, goalPct, goalHit,
    tier, trendPct, priorWeekPts: priorTotal,
    dailyArr,
    topActs, topCategory, topCategoryPts,
    coaching
  };
}

// Coaching voice: SWH Manifesto (built not harvested, small kept commitments,
// follow through when others fade) + Marketing by Referral (givers gain,
// referrals come from cultivated relationships, results follow activity).
function buildCoachingBlocks({ totalPts, leadPts, lagPts, daysLogged, goal, goalHit, streak, dailyArr, topActs, topCategory, tier }) {
  const zeroDays = dailyArr.filter(d => d.pts === 0).length;
  const lagShare = totalPts > 0 ? lagPts / totalPts : 0;
  // Lag-heavy week: results dominated the scoreboard. Celebrate the harvest,
  // then coach hard on planting (lead activity) so next month doesn't go quiet.
  const lagHeavy = totalPts > 0 && lagShare >= 0.4;

  // Strength
  let strength;
  if (lagHeavy && lagPts > 0) strength = `Results landed: ${lagPts} pts in referrals and wins. That is the harvest of relationships you planted weeks ago. The system is paying you back.`;
  else if (streak >= 5) strength = `${streak}-day streak. That's the consistency engine working. Keep the chain alive and the tier follows.`;
  else if (topActs[0] && topActs[0].count >= 10) strength = `${topActs[0].name} rhythm was elite: ${topActs[0].count} sessions. Repetition at this volume is what compounds.`;
  else if (goalHit) strength = `Crossed your weekly goal of ${goal} with ${totalPts} pts. The bar moved.`;
  else if (totalPts > 0) strength = `You showed up ${daysLogged} ${daysLogged === 1 ? 'day' : 'days'} this week. Every entry counts toward the habit.`;
  else strength = 'You opened the app. That already puts you ahead of most.';

  // Watch / Risk
  let watch;
  if (lagHeavy) watch = `${Math.round(lagShare * 100)}% of this week's points were results, only ${leadPts} pts were lead activity. Results are the harvest, not the planting. Today's referrals came from seeds you planted weeks ago; if the planting stays quiet now, the pipeline goes quiet next month.`;
  else if (zeroDays >= 4) watch = `${zeroDays} days at zero this week. Even one small touch, a follow through note, keeps the momentum from going cold.`;
  else if (lagPts === 0 && totalPts > 0) watch = 'Lots of activity, zero results logged. Make sure you\'re tracking referrals received and deals won so the lag side reflects the lead.';
  else if (zeroDays >= 1) watch = `${zeroDays} quiet ${zeroDays === 1 ? 'day' : 'days'}. Stacking two or three breaks the streak engine. Plan a small move on those days.`;
  else watch = 'No obvious gaps this week. Keep the variety up so no single category carries the whole load.';

  // Recommendation
  let recommendation;
  const tierTargets = { 'Getting Started': 50, 'Active Networker': 100, 'Consistent Connector': 150, 'Professional Networker': 200, 'Master Networker': null };
  const nextTierAt = tierTargets[tier.name];
  if (lagHeavy) recommendation = 'Givers gain: the surest way to keep referrals coming is to give first. This week, give one referral, book two one-on-ones, and send five Good to Meet You notes. Relationships are built, not harvested. Small kept commitments now become next month\'s wins.';
  else if (tier.name === 'Master Networker') recommendation = 'You\'re at the top tier. Hold the line. Two more weeks at this rhythm becomes a habit, not a streak.';
  else if (nextTierAt) {
    const gap = nextTierAt - totalPts;
    recommendation = `To reach the next tier, layer on ${gap} more pts next week. Try ${Math.ceil(gap / 10)} extra introductions or a host event.`;
  } else if (!goalHit) {
    const gap = goal - totalPts;
    recommendation = `You're ${gap} pts shy of goal. Add ${Math.ceil(gap / 7)} pts per day next week to close it. That's one quick conversation.`;
  } else {
    recommendation = 'Goal hit and tier earned. Hold the same rhythm next week and the gap to the next tier closes itself.';
  }

  return { strength, watch, recommendation };
}

// Demo stats (the version Austen wants to forward as marketing)
function getDemoStats() {
  const dailyArr = [
    { dateKey:'2026-04-27', dayShort:'MON', dayLong:'Monday',    pts:20, isBest:false },
    { dateKey:'2026-04-28', dayShort:'TUE', dayLong:'Tuesday',   pts:30, isBest:false },
    { dateKey:'2026-04-29', dayShort:'WED', dayLong:'Wednesday', pts:20, isBest:false },
    { dateKey:'2026-04-30', dayShort:'THU', dayLong:'Thursday',  pts:30, isBest:false },
    { dateKey:'2026-05-01', dayShort:'FRI', dayLong:'Friday',    pts:35, isBest:false },
    { dateKey:'2026-05-02', dayShort:'SAT', dayLong:'Saturday',  pts:40, isBest:true  },
    { dateKey:'2026-05-03', dayShort:'SUN', dayLong:'Sunday',    pts:0,  isBest:false },
  ];
  return {
    email: null, firstName: 'Austen',
    weekStart: '2026-04-27', weekEnd: '2026-05-03',
    totalPts: 175, leadPts: 145, lagPts: 30, daysLogged: 6,
    avgPerDay: 29, streak: 5,
    bestDay: dailyArr[5],
    goal: 150, goalPct: 117, goalHit: true,
    tier: getTier(175), // Professional Networker
    trendPct: 23, priorWeekPts: 142,
    dailyArr,
    topActs: [
      { name:'Have a FORMing Conversation',    count:14, pts:70, icon:'💬', category:'Conversations',  lead:true },
      { name:'Good to Meet You Follow Through', count:11, pts:55, icon:'✉️', category:'Follow Through', lead:true },
      { name:'Attend Networking Meeting',       count:4,  pts:20, icon:'🏢', category:'Networking',     lead:true },
    ],
    topCategory: 'Conversations', topCategoryPts: 70,
    coaching: {
      strength: 'FORMing conversation rhythm was elite this week: 14 sessions averages 2 per day. Consistency at this pace is what separates Master Networkers from everyone else.',
      watch: 'Sunday was a zero. One quiet day is fine, but stacking two or three breaks the streak engine. Plan a small Sunday move (one follow-through note) to keep the chain alive.',
      recommendation: 'You crossed the goal but haven\'t broken into Master Networker yet. To hit 200, layer in 2 introductions and 1 host event next week. That\'s 35 pts on top of your current rhythm.'
    }
  };
}

function renderRecapSubject(s) {
  return `Your week: ${s.totalPts} pts ${s.goalHit ? '✓' : ''} (${s.tier.name})`.trim();
}

function escHtml(str) { return String(str||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderRecapHTML(s) {
  const tierBadge = TIER_BADGE_BG[s.tier.name] || TIER_BADGE_BG['Getting Started'];
  const goalPctClamped = Math.min(100, s.goalPct);
  const overGoal = Math.max(0, s.totalPts - s.goal);
  const trendUp = s.trendPct !== null && s.trendPct >= 0;
  const maxBarPts = Math.max(...s.dailyArr.map(d => d.pts), 1);

  // Daily bar chart cells. Bars are table cells with bgcolor (email-safe:
  // Outlook and others strip gradient/div backgrounds; bgcolor always renders).
  const barCells = s.dailyArr.map(d => {
    const heightPx = d.pts > 0 ? Math.max(8, Math.round((d.pts / maxBarPts) * 100)) : 6;
    const solid = d.isBest ? '#E63946' : (d.pts > 0 ? '#1a1a1a' : '#E4E4E7');
    const grad = d.isBest
      ? 'linear-gradient(180deg,#E63946,#b8252f)'
      : (d.pts > 0 ? 'linear-gradient(180deg,#1a1a1a,#3a3a3a)' : '#E4E4E7');
    const labelColor = d.isBest ? 'color:#E63946;' : (d.pts > 0 ? 'color:#0a0a0a;' : 'color:#9CA3AF;font-weight:600;');
    const labelText = d.pts > 0 ? `${d.pts}${d.isBest ? ' 🏆' : ''}` : '–';
    const fontWeight = d.isBest ? '800' : '700';
    return `<td style="width:14.28%;text-align:center;padding:0 3px;vertical-align:bottom;">
      <div style="font-size:10px;font-weight:${fontWeight};${labelColor}margin-bottom:4px;">${labelText}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td width="32" height="${heightPx}" bgcolor="${solid}" style="width:32px;height:${heightPx}px;background:${grad};border-radius:6px 6px 0 0;font-size:1px;line-height:1px;">&nbsp;</td></tr></table>
    </td>`;
  }).join('');
  const dayLabels = s.dailyArr.map(d => {
    const isBest = d.isBest;
    return `<td style="text-align:center;padding-top:8px;font-size:10px;font-weight:${isBest?'800':'700'};color:${isBest?'#E63946':'#9CA3AF'};letter-spacing:0.08em;">${d.dayShort}</td>`;
  }).join('');

  // Top activities (numbered podium)
  const podiumColors = [
    { bg:'#FFEDD5', text:'#9A3412' },
    { bg:'#F3F4F6', text:'#374151' },
    { bg:'#FED7AA', text:'#9A3412' },
  ];
  const topActsRows = s.topActs.map((a, i) => `
    <tr><td style="padding:12px 0;${i < s.topActs.length-1 ? 'border-bottom:1px solid #E4E4E7;':''}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="width:36px;vertical-align:middle;">
            <div style="background:${podiumColors[i].bg};color:${podiumColors[i].text};font-family:Georgia,serif;font-weight:900;font-size:14px;width:28px;height:28px;border-radius:50%;text-align:center;line-height:28px;">${i+1}</div>
          </td>
          <td style="vertical-align:middle;">
            <div style="font-size:14px;font-weight:700;color:#0a0a0a;">${a.icon||''} ${escHtml(a.name)}</div>
            <div style="font-size:11px;color:#9CA3AF;margin-top:2px;">${escHtml(a.category||'')} · ${a.lead === false ? 'Lag' : 'Lead'}</div>
          </td>
          <td align="right" style="vertical-align:middle;">
            <div style="font-family:Georgia,serif;font-size:18px;font-weight:900;color:#0a0a0a;">${a.count}×</div>
            <div style="font-size:11px;color:#9CA3AF;">${a.pts} pts</div>
          </td>
        </tr>
      </table>
    </td></tr>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your Week Recap</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#0a0a0a;opacity:0;">Final score: ${s.totalPts} pts · ${s.tier.name}${s.goalHit ? ' · Goal hit' : ''}${s.trendPct !== null ? ` · ${trendUp?'+':''}${s.trendPct}% vs last week` : ''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:20px;overflow:hidden;max-width:600px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,0.5);">

<tr><td style="background:#0a0a0a;padding:20px 32px;border-bottom:1px solid rgba(255,255,255,0.06);">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="vertical-align:middle;"><span style="font-family:Georgia,serif;font-size:14px;font-weight:900;color:#fff;letter-spacing:0.04em;">SWH</span><span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);letter-spacing:0.16em;text-transform:uppercase;margin-left:10px;">Stop Wasting Handshakes</span></td>
      <td align="right" style="vertical-align:middle;"><span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);letter-spacing:0.14em;text-transform:uppercase;">Week Recap</span></td>
    </tr>
  </table>
</td></tr>

<tr><td style="background:linear-gradient(160deg,#0a0a0a 0%,#1a1a1a 60%,#2a1416 100%);padding:42px 32px 36px;text-align:center;">
  <div style="font-size:11px;font-weight:800;color:rgba(255,255,255,0.45);letter-spacing:0.22em;text-transform:uppercase;">${s.weekStart} → ${s.weekEnd}</div>
  <div style="font-family:Georgia,serif;font-size:18px;font-weight:400;color:rgba(255,255,255,0.7);margin-top:14px;font-style:italic;">Hey ${escHtml(s.firstName)}, here's how the week shook out.</div>
  <div style="margin-top:32px;">
    <div style="font-size:11px;font-weight:800;color:#E63946;letter-spacing:0.24em;text-transform:uppercase;">Final Score</div>
    <div style="font-family:Georgia,serif;font-size:96px;font-weight:900;line-height:1;color:#fff;margin-top:8px;letter-spacing:-0.04em;">${s.totalPts}</div>
    <div style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.55);margin-top:6px;letter-spacing:0.04em;">Total points · ${s.daysLogged} of 7 days logged</div>
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:28px auto 0;">
    <tr><td style="background:linear-gradient(135deg,${tierBadge.fill},rgba(0,0,0,0));border:1px solid ${tierBadge.border};border-radius:999px;padding:10px 22px;">
      <span style="font-size:18px;vertical-align:middle;">${s.tier.emoji}</span>
      <span style="font-family:Georgia,serif;font-size:15px;font-weight:900;color:${tierBadge.text};letter-spacing:0.06em;text-transform:uppercase;margin-left:8px;vertical-align:middle;">${escHtml(s.tier.name)}</span>
    </td></tr>
  </table>
  <div style="font-size:13px;color:rgba(255,255,255,0.55);font-style:italic;margin-top:12px;line-height:1.55;">"${escHtml(s.tier.msg)}"</div>
  ${s.trendPct !== null ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto 0;"><tr><td style="background:rgba(${trendUp?'90,138,106':'230,57,70'},0.18);border:1px solid rgba(${trendUp?'90,138,106':'230,57,70'},0.4);border-radius:8px;padding:8px 14px;"><span style="font-size:12px;font-weight:800;color:${trendUp?'#7BC288':'#FF8B95'};letter-spacing:0.04em;">${trendUp?'▲ +':'▼ '}${s.trendPct}%</span><span style="font-size:12px;color:rgba(255,255,255,0.6);margin-left:8px;">vs last week (${s.priorWeekPts} pts)</span></td></tr></table>` : ''}
</td></tr>

<tr><td style="padding:32px 32px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td><div style="font-size:10px;font-weight:800;color:#9CA3AF;letter-spacing:0.18em;text-transform:uppercase;">Weekly Goal</div><div style="font-family:Georgia,serif;font-size:24px;font-weight:900;color:#0a0a0a;margin-top:4px;line-height:1;">${s.totalPts} <span style="color:#9CA3AF;font-weight:400;">/ ${s.goal}</span></div></td>
      <td align="right" style="vertical-align:bottom;"><span style="display:inline-block;background:${s.goalHit?'#E8F5EC':'#FEE2E2'};color:${s.goalHit?'#2F6B3F':'#991B1B'};font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:6px 12px;border-radius:6px;">${s.goalHit ? `✓ Goal hit · ${s.goalPct}%` : `${s.goalPct}% to goal`}</span></td>
    </tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;border-collapse:separate;border-radius:10px;overflow:hidden;"><tr style="height:14px;">${goalPctClamped > 0 ? `<td width="${goalPctClamped}%" height="14" bgcolor="${s.goalHit ? '#5A8A6A' : '#E63946'}" style="height:14px;background:${s.goalHit?'linear-gradient(90deg,#5A8A6A 0%,#7BC288 70%,#5A8A6A 100%)':'linear-gradient(90deg,#E63946,#b8252f)'};font-size:1px;line-height:1px;">&nbsp;</td>` : ''}${goalPctClamped < 100 ? `<td height="14" bgcolor="#F4F4F5" style="height:14px;background:#F4F4F5;font-size:1px;line-height:1px;">&nbsp;</td>` : ''}</tr></table>
  <div style="font-size:11px;color:#9CA3AF;margin-top:8px;text-align:right;">${s.goalHit ? `+${overGoal} pts beyond goal` : `${s.goal - s.totalPts} pts to go`}</div>
</td></tr>

<tr><td style="padding:24px 32px 8px;">
  <div style="font-size:10px;font-weight:800;color:#9CA3AF;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:14px;">Box Score</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="width:25%;padding:0 4px;"><div style="background:#FAFAFA;border:1px solid #E4E4E7;border-radius:14px;padding:14px 10px;text-align:center;"><div style="font-family:Georgia,serif;font-size:30px;font-weight:900;color:#0a0a0a;line-height:1;">${s.leadPts}</div><div style="font-size:10px;color:#5A8A6A;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;margin-top:6px;">Lead</div><div style="font-size:10px;color:#9CA3AF;margin-top:2px;">${s.totalPts > 0 ? Math.round((s.leadPts/s.totalPts)*100) : 0}% of total</div></div></td>
      <td style="width:25%;padding:0 4px;"><div style="background:#FAFAFA;border:1px solid #E4E4E7;border-radius:14px;padding:14px 10px;text-align:center;"><div style="font-family:Georgia,serif;font-size:30px;font-weight:900;color:#0a0a0a;line-height:1;">${s.lagPts}</div><div style="font-size:10px;color:#1E40AF;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;margin-top:6px;">Lag</div><div style="font-size:10px;color:#9CA3AF;margin-top:2px;">${s.totalPts > 0 ? Math.round((s.lagPts/s.totalPts)*100) : 0}% of total</div></div></td>
      <td style="width:25%;padding:0 4px;"><div style="background:#FAFAFA;border:1px solid #E4E4E7;border-radius:14px;padding:14px 10px;text-align:center;"><div style="font-family:Georgia,serif;font-size:30px;font-weight:900;color:#0a0a0a;line-height:1;">${s.avgPerDay}</div><div style="font-size:10px;color:#9CA3AF;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;margin-top:6px;">Avg/day</div><div style="font-size:10px;color:#9CA3AF;margin-top:2px;">across ${s.daysLogged} ${s.daysLogged === 1 ? 'day' : 'days'}</div></div></td>
      <td style="width:25%;padding:0 4px;"><div style="background:#FAFAFA;border:1px solid #E4E4E7;border-radius:14px;padding:14px 10px;text-align:center;"><div style="font-family:Georgia,serif;font-size:30px;font-weight:900;color:#0a0a0a;line-height:1;">${s.streak}</div><div style="font-size:10px;color:#E63946;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;margin-top:6px;">Streak</div><div style="font-size:10px;color:#9CA3AF;margin-top:2px;">${s.streak === 1 ? 'day' : 'days'} in a row</div></div></td>
    </tr>
  </table>
</td></tr>

<tr><td style="padding:32px 32px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td><div style="font-size:10px;font-weight:800;color:#9CA3AF;letter-spacing:0.18em;text-transform:uppercase;">Day-by-Day</div></td>
        <td align="right">${s.bestDay && s.bestDay.pts > 0 ? `<div style="font-size:11px;color:#9CA3AF;">🏆 Best day: <strong style="color:#0a0a0a;">${s.bestDay.dayLong} · ${s.bestDay.pts} pts</strong></div>` : ''}</td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;">
    <tr style="vertical-align:bottom;height:120px;">${barCells}</tr>
    <tr><td colspan="7" style="height:1px;background:#E4E4E7;font-size:1px;line-height:1px;">&nbsp;</td></tr>
    <tr>${dayLabels}</tr>
  </table>
</td></tr>

${topActsRows ? `<tr><td style="padding:32px 32px 8px;">
  <div style="font-size:10px;font-weight:800;color:#9CA3AF;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:14px;">Top Performers</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${topActsRows}</table>
  ${s.topCategory ? `<div style="background:#FAFAFA;border-radius:10px;padding:14px 16px;margin-top:14px;font-size:13px;color:#374151;line-height:1.5;"><strong style="color:#0a0a0a;">MVP category:</strong> ${escHtml(s.topCategory)} led the week with <strong>${s.topCategoryPts} pts</strong>.</div>` : ''}
</td></tr>` : ''}

<tr><td style="padding:36px 32px 8px;">
  <div style="font-size:10px;font-weight:800;color:#9CA3AF;letter-spacing:0.18em;text-transform:uppercase;margin-bottom:14px;">Post-Game Analysis</div>
  <div style="background:#F0FDF4;border-left:4px solid #5A8A6A;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
    <div style="font-size:10px;font-weight:800;color:#2F6B3F;letter-spacing:0.14em;text-transform:uppercase;">💪 Strength</div>
    <div style="font-size:14px;color:#0a0a0a;line-height:1.55;margin-top:6px;">${escHtml(s.coaching.strength)}</div>
  </div>
  <div style="background:#FFFBEB;border-left:4px solid #D4A847;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
    <div style="font-size:10px;font-weight:800;color:#92400E;letter-spacing:0.14em;text-transform:uppercase;">⚠️ Watch</div>
    <div style="font-size:14px;color:#0a0a0a;line-height:1.55;margin-top:6px;">${escHtml(s.coaching.watch)}</div>
  </div>
  <div style="background:#EFF6FF;border-left:4px solid #2563EB;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
    <div style="font-size:10px;font-weight:800;color:#1E40AF;letter-spacing:0.14em;text-transform:uppercase;">🎯 Next Week</div>
    <div style="font-size:14px;color:#0a0a0a;line-height:1.55;margin-top:6px;">${escHtml(s.coaching.recommendation)}</div>
  </div>
  <div style="background:linear-gradient(135deg,#0a0a0a,#1a1a1a);border-radius:10px;padding:18px 20px;margin-top:14px;text-align:center;">
    <div style="font-size:10px;font-weight:800;color:rgba(255,255,255,0.5);letter-spacing:0.18em;text-transform:uppercase;">This Week's Identity</div>
    <div style="font-family:Georgia,serif;font-size:16px;font-style:italic;color:#fff;line-height:1.5;margin-top:8px;">"${escHtml(s.tier.msg)}"</div>
  </div>
</td></tr>

<tr><td style="padding:36px 32px 8px;text-align:center;">
  <a href="https://app.stopwastinghandshakes.com" style="display:inline-block;background:linear-gradient(135deg,#E63946,#b8252f);color:#fff;text-decoration:none;font-weight:800;font-size:15px;letter-spacing:0.02em;padding:16px 36px;border-radius:12px;box-shadow:0 8px 24px rgba(230,57,70,0.35);">Start the Next Week →</a>
  <div style="font-size:11px;color:#9CA3AF;margin-top:14px;line-height:1.6;">Open the app to log your first activity.</div>
</td></tr>

<tr><td style="padding:24px 32px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAFAFA;border:1px solid #E4E4E7;border-radius:14px;">
    <tr>
      <td style="padding:18px 20px;vertical-align:middle;">
        <div style="font-size:10px;font-weight:800;color:#9CA3AF;letter-spacing:0.18em;text-transform:uppercase;">Looking for something to do?</div>
        <div style="font-size:14px;color:#0a0a0a;line-height:1.55;margin-top:6px;">Every handshake starts somewhere. Find this week's networking events on The Networking Wire.</div>
      </td>
      <td align="right" style="vertical-align:middle;padding:18px 20px 18px 0;white-space:nowrap;">
        <a href="https://thenetworkingwire.com" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-weight:800;font-size:13px;padding:12px 20px;border-radius:10px;">Browse events →</a>
      </td>
    </tr>
  </table>
</td></tr>

<tr><td style="background:#FAFAFA;border-top:1px solid #E4E4E7;padding:22px 32px;text-align:center;">
  <div style="font-size:11px;color:#9CA3AF;line-height:1.7;">Weekly summary email · <a href="https://app.stopwastinghandshakes.com" style="color:#9CA3AF;text-decoration:underline;">Manage in Settings</a></div>
  <div style="font-size:10px;color:#D1D5DB;margin-top:8px;">© 2026 Impact Leadership Group · Stop Wasting Handshakes</div>
</td></tr>

</table></td></tr></table></body></html>`;
}

function renderRecapText(s) {
  return `Hey ${s.firstName},

Final Score: ${s.totalPts} pts (${s.leadPts} lead, ${s.lagPts} lag) · ${s.tier.name}
${s.goalHit ? `Goal hit (${s.totalPts}/${s.goal}, ${s.goalPct}%)` : `${s.goal - s.totalPts} pts short of goal (${s.goalPct}%)`}
${s.trendPct !== null ? `${s.trendPct >= 0 ? '+' : ''}${s.trendPct}% vs last week (${s.priorWeekPts} pts)` : ''}
Days logged: ${s.daysLogged} of 7 · Streak: ${s.streak} · Best day: ${s.bestDay && s.bestDay.pts > 0 ? `${s.bestDay.dayLong} (${s.bestDay.pts} pts)` : 'n/a'}

Top activities:
${s.topActs.map(a => `  ${a.name}: ${a.count}× (${a.pts} pts)`).join('\n')}

STRENGTH: ${s.coaching.strength}
WATCH: ${s.coaching.watch}
NEXT WEEK: ${s.coaching.recommendation}

"${s.tier.msg}"

Looking for something to do? This week's networking events: https://thenetworkingwire.com

Open the app: https://app.stopwastinghandshakes.com`;
}

// ===== Team weekly report helpers =====
async function computeTeamWeeklyStats(teamId) {
  const teamSnap = await db.doc(`teams/${teamId}`).get();
  if (!teamSnap.exists) return null;
  const team = teamSnap.data() || {};

  const tz = team.weeklyReportTimezone || 'America/Chicago';
  const todayKey = new Date().toLocaleString('sv-SE', { timeZone: tz }).slice(0, 10);
  const lastWeekEnd = addDays(getWeekStart(todayKey, 'monday'), -1);
  const lastWeekStart = addDays(lastWeekEnd, -6);

  const membersSnap = await db.collection('teams').doc(teamId).collection('members').get();
  const memberRows = [];
  let teamTotal = 0;

  for (const mDoc of membersSnap.docs) {
    const m = mDoc.data();
    const daysSnap = await db.collection(`users/${m.uid}/days`)
      .where('dateKey', '>=', lastWeekStart)
      .where('dateKey', '<=', lastWeekEnd)
      .get();
    const pts = daysSnap.docs.reduce((s, d) => s + ((d.data() || {}).totalPts || 0), 0);
    const daysLogged = daysSnap.docs.filter(d => ((d.data() || {}).totalPts || 0) > 0).length;
    memberRows.push({ name: m.displayName || m.email || 'Member', email: m.email, role: m.role, pts, daysLogged });
    teamTotal += pts;
  }

  memberRows.sort((a, b) => b.pts - a.pts);
  return { teamName: team.name || 'Your Team', weekStart: lastWeekStart, weekEnd: lastWeekEnd, members: memberRows, teamTotal };
}

function renderTeamRecapSubject(s) {
  return `Team recap: ${s.teamTotal} pts this week (${s.teamName})`;
}

function renderTeamRecapHTML(s) {
  const rows = s.members.map((m, i) => `
    <tr style="border-bottom:1px solid #E4E4E7;">
      <td style="padding:10px 12px;font-size:13px;font-weight:700;color:#0a0a0a;">${i === 0 ? '🏆 ' : ''}${escHtml(m.name)}</td>
      <td style="padding:10px 12px;font-size:13px;color:#6B7280;text-align:center;">${m.daysLogged}d</td>
      <td style="padding:10px 12px;font-family:'Georgia',serif;font-size:16px;font-weight:700;color:${m.pts > 0 ? '#E63946' : '#9CA3AF'};text-align:right;">${m.pts}</td>
    </tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#F9F9F9;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
      <div style="background:#0a0a0a;padding:24px 28px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;color:rgba(255,255,255,0.45);text-transform:uppercase;margin-bottom:6px;">WEEKLY TEAM REPORT</div>
        <div style="font-size:22px;font-weight:800;color:#fff;">${escHtml(s.teamName)}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:4px;">${s.weekStart} – ${s.weekEnd}</div>
      </div>
      <div style="padding:20px 24px 8px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#9CA3AF;margin-bottom:8px;">MEMBER BREAKDOWN</div>
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="border-bottom:2px solid #E4E4E7;">
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:#9CA3AF;text-align:left;letter-spacing:0.06em;">MEMBER</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:#9CA3AF;text-align:center;letter-spacing:0.06em;">DAYS</th>
            <th style="padding:8px 12px;font-size:11px;font-weight:700;color:#9CA3AF;text-align:right;letter-spacing:0.06em;">PTS</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr style="border-top:2px solid #0a0a0a;">
            <td colspan="2" style="padding:12px 12px;font-size:13px;font-weight:800;color:#0a0a0a;">TEAM TOTAL</td>
            <td style="padding:12px 12px;font-family:'Georgia',serif;font-size:20px;font-weight:900;color:#E63946;text-align:right;">${s.teamTotal}</td>
          </tr></tfoot>
        </table>
      </div>
      <div style="padding:16px 24px 24px;font-size:11px;color:#9CA3AF;text-align:center;">
        Stop Wasting Handshakes · <a href="https://app.stopwastinghandshakes.com" style="color:#E63946;text-decoration:none;">Open App</a>
      </div>
    </div>
  </div></body></html>`;
}

function renderTeamRecapText(s) {
  const rows = s.members.map(m => `  ${m.name}: ${m.pts} pts (${m.daysLogged} days)`).join('\n');
  return `WEEKLY TEAM REPORT — ${s.teamName}\n${s.weekStart} – ${s.weekEnd}\n\n${rows}\n\nTEAM TOTAL: ${s.teamTotal} pts\n\nOpen the app: https://app.stopwastinghandshakes.com`;
}

// ===== Weekly Activity Email — runs every hour, sends to users whose preference matches now =====
exports.weeklyActivityEmail = onSchedule({
  schedule: '0 * * * *', // every hour at :00
  timeZone: 'UTC',
}, async () => {
  const now = new Date();

  // Helper: parse current hour in a given timezone, normalizing midnight correctly.
  // toLocaleString with hour12:false returns "24" for midnight in some Node versions;
  // modulo 24 converts that to 0 so the match against targetHour (0–23) works.
  function localHour(tz) {
    return parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz })) % 24;
  }
  function localDayName(tz) {
    return now.toLocaleString('en-US', { weekday: 'long', timeZone: tz }).toLowerCase();
  }

  const usersSnap = await db.collection('users').get();
  let personalSent = 0;

  // Process all users in parallel to avoid sequential-await timeouts on large user bases.
  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    const uid = userDoc.id;
    const userData = userDoc.data() || {};
    const settingsSnap = await db.doc(`users/${uid}/config/settings`).get();
    const settings = settingsSnap.data() || {};
    if (!settings.weeklyEmailEnabled) return;
    if (!userData.email) return;

    const tz = settings.weeklyEmailTimezone || 'America/Chicago';
    const targetDay = (settings.weeklyEmailDay || 'monday').toLowerCase();
    const targetHour = typeof settings.weeklyEmailHour === 'number' ? settings.weeklyEmailHour : 9;

    let userDayName, userHour;
    try {
      userDayName = localDayName(tz);
      userHour = localHour(tz);
    } catch(e) { console.warn('[weeklyEmail] bad timezone for', uid, tz); return; }

    if (userDayName !== targetDay || userHour !== targetHour) return;

    // Idempotency: skip if we already sent a report within the past 23 hours
    // to guard against duplicate Cloud Scheduler firings on the same hour.
    const lastSent = settings.lastWeeklyEmailDate;
    if (lastSent) {
      const hoursSinceSent = (now.getTime() - new Date(lastSent).getTime()) / (1000 * 60 * 60);
      if (hoursSinceSent < 23) {
        console.log('[weeklyEmail] skipping', uid, '— already sent', Math.round(hoursSinceSent), 'h ago');
        return;
      }
    }

    const stats = await computeUserWeeklyStats(uid);
    if (!stats) return;

    try {
      const ccPartners = Array.isArray(settings.accountabilityPartners) ? settings.accountabilityPartners : [];
      await db.collection('mail').add({
        from: MAIL_FROM,
        to: [userData.email],
        ...(ccPartners.length ? { cc: ccPartners } : {}),
        message: { subject: renderRecapSubject(stats), html: renderRecapHTML(stats), text: renderRecapText(stats) },
      });
      // Mark sent so a retry of this scheduler invocation doesn't double-send.
      await db.doc(`users/${uid}/config/settings`).set({ lastWeeklyEmailDate: now.toISOString() }, { merge: true });
      personalSent++;
    } catch(mailErr) {
      console.error('[weeklyEmail] failed to queue mail for', uid, mailErr.message);
    }
  }));

  console.log(`[weeklyEmail] queued ${personalSent} personal email(s)`);

  // Team weekly reports
  let teamSent = 0;
  try {
    const teamsSnap = await db.collection('teams').where('weeklyReportEnabled', '==', true).get();

    await Promise.all(teamsSnap.docs.map(async (teamDoc) => {
      const team = teamDoc.data() || {};
      const tz = team.weeklyReportTimezone || 'America/Chicago';
      const targetDay = (team.weeklyReportDay || 'monday').toLowerCase();
      const targetHour = typeof team.weeklyReportHour === 'number' ? team.weeklyReportHour : 9;

      let teamDayName, teamHour;
      try {
        teamDayName = localDayName(tz);
        teamHour = localHour(tz);
      } catch(e) { return; }
      if (teamDayName !== targetDay || teamHour !== targetHour) return;

      // Idempotency: skip if already sent a team report within 23 hours
      const lastTeamSent = team.lastWeeklyReportDate;
      if (lastTeamSent) {
        const hoursSince = (now.getTime() - new Date(lastTeamSent).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 23) return;
      }

      const teamStats = await computeTeamWeeklyStats(teamDoc.id);
      if (!teamStats) return;

      // Collect recipients: owner + all co_leads
      const membersSnap = await db.collection('teams').doc(teamDoc.id).collection('members').get();
      const recipientEmails = new Set();

      if (team.ownerUid) {
        const ownerDoc = await db.doc(`users/${team.ownerUid}`).get();
        if (ownerDoc.exists && ownerDoc.data().email) recipientEmails.add(ownerDoc.data().email);
      }
      membersSnap.docs.forEach(d => {
        const m = d.data();
        if ((m.role === 'co_lead' || m.role === 'owner') && m.email) recipientEmails.add(m.email);
      });

      if (!recipientEmails.size) return;

      try {
        await db.collection('mail').add({
          from: MAIL_FROM,
          to: Array.from(recipientEmails),
          message: { subject: renderTeamRecapSubject(teamStats), html: renderTeamRecapHTML(teamStats), text: renderTeamRecapText(teamStats) },
        });
        await db.doc(`teams/${teamDoc.id}`).set({ lastWeeklyReportDate: now.toISOString() }, { merge: true });
        teamSent++;
      } catch(mailErr) {
        console.error('[weeklyEmail] failed to queue team mail for', teamDoc.id, mailErr.message);
      }
    }));

    console.log(`[weeklyEmail] queued ${teamSent} team report(s)`);
  } catch(e) { console.error('[weeklyEmail] team reports error:', e); }
});

// ===== sendMyRecap — user-triggered "send my weekly recap NOW" (HTTP, Bearer auth) =====
exports.sendMyRecap = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const email = userData.email || decoded.email;
    if (!email) { res.status(400).json({ error: 'No email on file for this account' }); return; }

    const stats = await computeUserWeeklyStats(uid);
    if (!stats) { res.status(400).json({ error: 'No activity logged in the past week — log a few entries first.' }); return; }

    const settingsSnap = await db.doc(`users/${uid}/config/settings`).get();
    const settings = settingsSnap.data() || {};
    const ccPartners = Array.isArray(settings.accountabilityPartners) ? settings.accountabilityPartners : [];
    await db.collection('mail').add({
      from: MAIL_FROM,
      to: [email],
      ...(ccPartners.length ? { cc: ccPartners } : {}),
      message: { subject: renderRecapSubject(stats), html: renderRecapHTML(stats), text: renderRecapText(stats) },
    });
    res.json({ ok: true, email, totalPts: stats.totalPts });
  } catch (e) { sendErr(res, e); }
});

// ===== sendSampleRecap — admin sends a demo recap to any address (for marketing/preview) =====
exports.sendSampleRecap = onCall({ cors: true }, async (request) => {
  const callerEmail = (request.auth?.token?.email || '').toLowerCase();
  if (!callerEmail || !ADMIN_EMAILS.includes(callerEmail)) throw new Error('Permission denied: admin only');
  const { email } = request.data || {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');

  const stats = getDemoStats();
  await db.collection('mail').add({
    from: MAIL_FROM,
    to: [email],
    message: { subject: '[Sample] ' + renderRecapSubject(stats), html: renderRecapHTML(stats), text: renderRecapText(stats) },
  });
  return { ok: true, email };
});

// ===== NEW: Daily SMS Reminder Mon-Fri 5pm CST =====
exports.dailySMSReminder = onSchedule({
  schedule: '0 23 * * 1-5',
  timeZone: 'America/Chicago',
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
}, async () => {
  const today = new Date();
  const dateKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  const twilioSid = TWILIO_ACCOUNT_SID.value();
  const twilioToken = TWILIO_AUTH_TOKEN.value();
  const twilioFrom = TWILIO_PHONE_NUMBER.value();

  // Get all users with SMS opted in and a phone number
  const usersSnap = await db.collection('users').get();

  const promises = [];
  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const settingsDoc = await db.doc(`users/${uid}/config/settings`).get();
    const settings = settingsDoc.data() || {};

    if (!settings.smsOptIn || !settings.phone) continue;

    // Check if they logged today
    const dayDoc = await db.doc(`users/${uid}/days/${dateKey}`).get();
    const dayData = dayDoc.data() || {};
    const totalPts = dayData.totalPts || 0;

    if (totalPts > 0) continue; // Already logged, skip

    const firstName = (settings.displayName || 'there').split(' ')[0];
    const body = `Hey ${firstName} 👋 You haven't logged your points today. Every rep counts — don't let the day slip. Log now: swh-scoreboard.web.app`;

    const params = new URLSearchParams();
    params.append('To', settings.phone);
    params.append('From', twilioFrom);
    params.append('Body', body);

    promises.push(
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params
      })
    );
  }

  await Promise.all(promises);
  console.log(`SMS reminders sent for ${dateKey}`);
});

// ===== Daily push + email reminder (opt-in, runs every hour, timezone-aware) =====
exports.dailyActivityReminder = onSchedule({
  schedule: '0 * * * *',
  timeZone: 'UTC',
}, async () => {
  const now = new Date();
  const usersSnap = await db.collection('users').get();
  const tasks = [];

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const userData = userDoc.data() || {};
    const settingsSnap = await db.doc(`users/${uid}/config/settings`).get();
    const settings = settingsSnap.data() || {};

    const pushOptIn = settings.pushReminderOptIn === true;
    const emailOptIn = settings.emailReminderOptIn === true;
    if (!pushOptIn && !emailOptIn) continue;

    // Check if it's 5PM in the user's timezone
    const tz = settings.weeklyEmailTimezone || 'America/Chicago';
    let userHour;
    try { userHour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz })); }
    catch(e) { continue; }
    if (userHour !== 17) continue; // 5PM

    // Check if they've already logged today
    const dateKey = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const daySnap = await db.doc(`users/${uid}/days/${dateKey}`).get();
    if ((daySnap.data()?.totalPts || 0) > 0) continue; // already logged

    const firstName = (userData.displayName || settings.displayName || 'there').split(' ')[0];

    // Push notification
    if (pushOptIn && settings.fcmToken) {
      tasks.push(
        admin.messaging().send({
          token: settings.fcmToken,
          notification: {
            title: "⚡ Log your points",
            body: `Hey ${firstName}! Don't let today's handshakes go to waste. Tap to log now.`,
          },
          apns: { payload: { aps: { badge: 1, sound: 'default' } } },
        }).catch(e => console.warn('[dailyReminder] push failed for', uid, e.message))
      );
    }

    // Email notification
    if (emailOptIn && userData.email) {
      tasks.push(
        db.collection('mail').add({
          to: [userData.email],
          message: {
            subject: `⚡ ${firstName}, don't let today's handshakes go to waste`,
            html: `<p>Hey ${firstName},</p><p>You haven't logged your points today. Every rep counts — don't let the day slip.</p><p><a href="https://app.stopwastinghandshakes.com" style="background:#E63946;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin-top:8px;">Log Now →</a></p><p style="font-size:12px;color:#999;margin-top:24px;">You're receiving this because you opted in to daily reminders. <a href="https://app.stopwastinghandshakes.com">Manage settings</a>.</p>`,
            text: `Hey ${firstName},\n\nYou haven't logged your points today. Log now: https://app.stopwastinghandshakes.com\n\nTo turn off these reminders, visit your settings.`,
          },
        }).catch(e => console.warn('[dailyReminder] email failed for', uid, e.message))
      );
    }
  }

  await Promise.all(tasks);
  console.log(`[dailyActivityReminder] processed ${tasks.length} notification(s)`);
});

// ===== saveFcmToken — saves push notification token for a user =====
exports.saveFcmToken = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const { token } = req.body || {};
    if (!token) { res.status(400).json({ error: 'token required' }); return; }
    await db.doc(`users/${decoded.uid}/config/settings`).set(
      { fcmToken: token, fcmTokenUpdatedAt: new Date().toISOString() }, { merge: true }
    );
    res.json({ ok: true });
  } catch(e) { sendErr(res, e); }
});

// ===== getTeamMemberActivity — team lead fetches a member's full history =====
exports.getTeamMemberActivity = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const callerUid = decoded.uid;
    const { memberUid } = req.body || {};
    if (!memberUid) { res.status(400).json({ error: 'memberUid required' }); return; }

    // Verify caller is on the same team AND is owner/co_lead/admin
    const callerSnap = await db.doc(`users/${callerUid}`).get();
    const callerData = callerSnap.data() || {};
    let teamId = callerData.teamId;

    // Fallback: find team by ownership (mirrors getTeamSummary behaviour)
    if (!teamId) {
      const q = await db.collection('teams').where('ownerUid', '==', callerUid).limit(1).get();
      if (!q.empty) teamId = q.docs[0].id;
    }
    if (!teamId) { res.status(403).json({ error: 'Not on a team' }); return; }

    const callerRole = callerData.teamRole || 'member';
    if (!['owner','co_lead','admin'].includes(callerRole)) {
      // Fallback: check if caller is the team owner via the team doc
      const teamSnap = await db.doc(`teams/${teamId}`).get();
      if (teamSnap.data()?.ownerUid !== callerUid) {
        res.status(403).json({ error: 'Team lead access required' }); return;
      }
    }

    // Verify memberUid is on the same team
    const memberSnap = await db.doc(`teams/${teamId}/members/${memberUid}`).get();
    if (!memberSnap.exists) { res.status(403).json({ error: 'Member not on your team' }); return; }

    // Load member's activity config — needed to resolve old numeric-index keys
    const actSnap = await db.doc(`users/${memberUid}/config/activities`).get();
    const acts = actSnap.data()?.list || [];

    // Resolve a counts key that may be a numeric index (old format) or already a name (new format)
    const resolveKey = (k) => {
      const n = parseInt(k);
      if (!isNaN(n) && acts[n] && acts[n].name) return acts[n].name;
      return k;
    };

    // Fetch member's day history (last 60 days)
    const daysSnap = await db.collection(`users/${memberUid}/days`)
      .orderBy('dateKey', 'desc').limit(60).get();
    const history = daysSnap.docs.map(d => {
      const day = d.data();
      // Normalize: convert any numeric keys to activity names
      const normalizedCounts = {};
      Object.entries(day.counts || {}).forEach(([k, v]) => {
        if (v > 0) {
          const name = resolveKey(k);
          normalizedCounts[name] = (normalizedCounts[name] || 0) + v;
        }
      });
      const actSummary = Object.entries(normalizedCounts)
        .map(([k,v]) => `${k}: ${v}`).join(', ');
      return { dateKey: day.dateKey || d.id, totalPts: day.totalPts || 0, activities: actSummary, counts: normalizedCounts };
    });

    // Compute week pts (Mon–today)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - daysFromMon); weekStart.setHours(0,0,0,0);
    const weekStartKey = weekStart.toISOString().slice(0,10);
    const todayKey = now.toISOString().slice(0,10);
    const weekPts = history.filter(d => d.dateKey >= weekStartKey).reduce((s,d) => s + d.totalPts, 0);
    const todayPts = (history.find(d => d.dateKey === todayKey) || {}).totalPts || 0;

    // Compute streak
    let streak = 0;
    const sortedDays = history.map(d => d.dateKey).sort().reverse();
    for (let i = 0; i < sortedDays.length; i++) {
      const expected = new Date(now); expected.setDate(now.getDate() - i);
      const expectedKey = expected.toISOString().slice(0,10);
      if (sortedDays[i] === expectedKey) streak++;
      else break;
    }

    // Member email settings (so team lead can view/edit the schedule)
    const settingsSnap = await db.doc(`users/${memberUid}/config/settings`).get();
    const es = settingsSnap.exists ? (settingsSnap.data() || {}) : {};
    const emailSettings = {
      enabled:  es.weeklyEmailEnabled  || false,
      day:      es.weeklyEmailDay      || 'monday',
      hour:     typeof es.weeklyEmailHour === 'number' ? es.weeklyEmailHour : 9,
      timezone: es.weeklyEmailTimezone || 'America/Chicago',
    };

    res.json({ history, weekPts, todayPts, streak, memberActivities: acts, emailSettings });
  } catch(e) { console.error('[getTeamMemberActivity]', e); sendErr(res, e); }
});

// ===== updateMemberActivity — team lead logs/edits an activity for a member =====
exports.updateMemberActivity = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const callerUid = decoded.uid;
    const { memberUid, dateKey, activityName, count } = req.body || {};
    if (!memberUid || !dateKey || !activityName) {
      res.status(400).json({ error: 'memberUid, dateKey, activityName required' }); return;
    }

    // Verify caller is team lead
    const callerSnap = await db.doc(`users/${callerUid}`).get();
    const callerData = callerSnap.data() || {};
    let teamId = callerData.teamId;

    // Fallback: find team by ownership
    if (!teamId) {
      const q = await db.collection('teams').where('ownerUid', '==', callerUid).limit(1).get();
      if (!q.empty) teamId = q.docs[0].id;
    }
    if (!teamId) { res.status(403).json({ error: 'Not on a team' }); return; }

    const callerRole = callerData.teamRole || 'member';
    if (!['owner','co_lead','admin'].includes(callerRole)) {
      // Fallback: check if caller owns the team via the team doc
      const teamSnap = await db.doc(`teams/${teamId}`).get();
      if (teamSnap.data()?.ownerUid !== callerUid) {
        res.status(403).json({ error: 'Team lead access required' }); return;
      }
    }

    // Verify member is on the same team
    const memberTeamSnap = await db.doc(`teams/${teamId}/members/${memberUid}`).get();
    if (!memberTeamSnap.exists) { res.status(403).json({ error: 'Member not on your team' }); return; }

    // Load member's activities config
    const actSnap = await db.doc(`users/${memberUid}/config/activities`).get();
    const acts = actSnap.data()?.list || [];
    const act = acts.find(a => a.name === activityName) || { pts: 5 };
    const addCount = Math.max(1, parseInt(count) || 1);
    const addPts = (act.pts || 5) * addCount;

    // Read/update the day doc
    const dayRef = db.doc(`users/${memberUid}/days/${dateKey}`);
    const daySnap = await dayRef.get();
    const dayData = daySnap.data() || { dateKey, counts: {}, totalPts: 0 };
    const counts = dayData.counts || {};
    counts[activityName] = (counts[activityName] || 0) + addCount;
    const totalPts = Object.entries(counts).reduce((s, [k, v]) => {
      const a = acts.find(x => x.name === k) || { pts: 5 };
      return s + (a.pts || 5) * v;
    }, 0);
    await dayRef.set({ dateKey, counts, totalPts, updatedAt: new Date().toISOString(), updatedBy: callerUid }, { merge: true });

    res.json({ ok: true, dateKey, totalPts });
  } catch(e) { console.error('[updateMemberActivity]', e); sendErr(res, e); }
});

// ===== setMemberActivityDay — team lead replaces an entire day's activity counts for a member =====
exports.setMemberActivityDay = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const callerUid = decoded.uid;
    const { memberUid, dateKey, counts } = req.body || {};
    if (!memberUid || !dateKey || !counts || typeof counts !== 'object') {
      res.status(400).json({ error: 'memberUid, dateKey, counts required' }); return;
    }

    const callerSnap = await db.doc(`users/${callerUid}`).get();
    const callerData = callerSnap.data() || {};
    let teamId = callerData.teamId;
    if (!teamId) {
      const q = await db.collection('teams').where('ownerUid', '==', callerUid).limit(1).get();
      if (!q.empty) teamId = q.docs[0].id;
    }
    if (!teamId) { res.status(403).json({ error: 'Not on a team' }); return; }

    const callerRole = callerData.teamRole || 'member';
    if (!['owner','co_lead','admin'].includes(callerRole)) {
      const teamSnap = await db.doc(`teams/${teamId}`).get();
      if (teamSnap.data()?.ownerUid !== callerUid) {
        res.status(403).json({ error: 'Team lead access required' }); return;
      }
    }

    const memberTeamSnap = await db.doc(`teams/${teamId}/members/${memberUid}`).get();
    if (!memberTeamSnap.exists) { res.status(403).json({ error: 'Member not on your team' }); return; }

    const actSnap = await db.doc(`users/${memberUid}/config/activities`).get();
    const acts = actSnap.data()?.list || [];

    // Sanitize: only non-negative integers; drop zeros
    const safeCounts = {};
    for (const [k, v] of Object.entries(counts)) {
      const n = Math.max(0, parseInt(v) || 0);
      if (n > 0) safeCounts[k] = n;
    }

    const totalPts = Object.entries(safeCounts).reduce((s, [k, v]) => {
      const a = acts.find(x => x.name === k) || { pts: 5 };
      return s + (a.pts || 5) * v;
    }, 0);

    const dayRef = db.doc(`users/${memberUid}/days/${dateKey}`);
    await dayRef.set({ dateKey, counts: safeCounts, totalPts, updatedAt: new Date().toISOString(), updatedBy: callerUid });

    res.json({ ok: true, dateKey, totalPts });
  } catch(e) { console.error('[setMemberActivityDay]', e); sendErr(res, e); }
});

// ===== saveTeamReportSettings — owner/co_lead sets the team's weekly report schedule =====
exports.saveTeamReportSettings = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const callerUid = decoded.uid;
    const { enabled, day, hour, timezone } = req.body || {};

    const callerSnap = await db.doc(`users/${callerUid}`).get();
    const callerData = callerSnap.data() || {};
    let teamId = callerData.teamId;
    if (!teamId) {
      const q = await db.collection('teams').where('ownerUid', '==', callerUid).limit(1).get();
      if (!q.empty) teamId = q.docs[0].id;
    }
    if (!teamId) { res.status(403).json({ error: 'Not on a team' }); return; }

    const teamSnap = await db.doc(`teams/${teamId}`).get();
    const callerRole = callerData.teamRole || 'member';
    if (!['owner','co_lead'].includes(callerRole) && teamSnap.data()?.ownerUid !== callerUid) {
      res.status(403).json({ error: 'Owner or co-lead access required' }); return;
    }

    const update = {};
    if (typeof enabled === 'boolean') update.weeklyReportEnabled = enabled;
    if (typeof day === 'string' && DAY_INDEX[day.toLowerCase()] !== undefined) update.weeklyReportDay = day.toLowerCase();
    if (typeof hour === 'number' && hour >= 0 && hour <= 23) update.weeklyReportHour = Math.floor(hour);
    if (typeof timezone === 'string' && timezone.length < 50) update.weeklyReportTimezone = timezone;

    await db.doc(`teams/${teamId}`).set(update, { merge: true });
    res.json({ ok: true });
  } catch(e) { console.error('[saveTeamReportSettings]', e); sendErr(res, e); }
});

// ===== Team Contact Awareness — shared duplicate-awareness index =====
// teams/{teamId}/contactIndex/{uid_contactId} = { phoneNorm, ownerUid, ownerName, addedAt, contactId }
// Contacts stay private per rep; the index only tells teammates "this number is
// already being worked by [name]" at add time. Day-to-day upkeep is client-side
// in the CRM; the rebuild below runs with the admin SDK when the toggle flips on.
function phoneKeyLast10(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : '';
}

async function wipeTeamContactIndex(teamId) {
  const snap = await db.collection(`teams/${teamId}/contactIndex`).get();
  let batch = db.batch(), n = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref); n++;
    if (n >= 450) { await batch.commit(); batch = db.batch(); n = 0; }
  }
  if (n > 0) await batch.commit();
  return snap.size;
}

async function rebuildTeamContactIndex(teamId) {
  // Member set = members subcollection ∪ users bound via users/{uid}.teamId ∪ owner.
  // (Owners don't always carry teamId on their user doc — see loadTeamForOwnerOrColead.)
  const teamSnap = await db.doc(`teams/${teamId}`).get();
  const uids = new Set();
  const nameByUid = {};
  if (teamSnap.data()?.ownerUid) uids.add(teamSnap.data().ownerUid);
  const membersSnap = await db.collection(`teams/${teamId}/members`).get();
  membersSnap.docs.forEach(d => {
    uids.add(d.id);
    const m = d.data() || {};
    if (m.displayName || m.name) nameByUid[d.id] = m.displayName || m.name;
  });
  const boundSnap = await db.collection('users').where('teamId', '==', teamId).get();
  boundSnap.docs.forEach(d => uids.add(d.id));

  let written = 0;
  let batch = db.batch(), n = 0;
  for (const uid of uids) {
    let ownerName = nameByUid[uid];
    if (!ownerName) {
      const u = await db.doc(`users/${uid}`).get();
      const ud = u.data() || {};
      ownerName = ud.displayName || ud.name || (ud.email ? ud.email.split('@')[0] : 'A teammate');
    }
    const contactsSnap = await db.collection(`users/${uid}/contacts`).get();
    for (const c of contactsSnap.docs) {
      const phoneNorm = phoneKeyLast10((c.data() || {}).phone);
      if (!phoneNorm) continue;
      batch.set(db.doc(`teams/${teamId}/contactIndex/${uid}_${c.id}`), {
        phoneNorm,
        ownerUid: uid,
        ownerName,
        addedAt: (c.data() || {}).addedAt || null,
        contactId: c.id,
      });
      n++; written++;
      if (n >= 450) { await batch.commit(); batch = db.batch(); n = 0; }
    }
  }
  if (n > 0) await batch.commit();
  return written;
}

// ===== setTeamContactAwareness — owner/co_lead toggles the awareness index =====
// Body: { enabled:boolean }
// Enable: sets teams/{id}.settings.contactAwareness, then rebuilds the index fresh.
// Disable: clears the flag AND wipes the index so nothing stale stays readable.
exports.setTeamContactAwareness = onRequest({ cors: true, timeoutSeconds: 540 }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be a boolean' }); return; }

    const team = await loadTeamForOwnerOrColead(decoded.uid);
    const teamId = team.id;

    await db.doc(`teams/${teamId}`).set({ settings: { contactAwareness: enabled } }, { merge: true });

    // Always wipe first so every enable starts from a clean, accurate index
    // (heals drift from contacts deleted or members removed while off).
    await wipeTeamContactIndex(teamId);
    const indexed = enabled ? await rebuildTeamContactIndex(teamId) : 0;

    console.log(`[setTeamContactAwareness] team=${teamId} enabled=${enabled} indexed=${indexed} by=${decoded.uid}`);
    res.json({ ok: true, enabled, indexed });
  } catch (e) { console.error('[setTeamContactAwareness]', e); sendErr(res, e); }
});

// ===== sendTeamReportNow — owner/co_lead triggers an immediate team report (HTTP, Bearer auth) =====
exports.sendTeamReportNow = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const team = await loadTeamForOwnerOrColead(decoded.uid);

    const stats = await computeTeamWeeklyStats(team.id);
    if (!stats) { res.status(400).json({ error: 'No activity data found for this team.' }); return; }

    // Collect recipients: owner + all co_leads (same as scheduled report)
    const membersSnap = await db.collection('teams').doc(team.id).collection('members').get();
    const recipientEmails = new Set();
    if (team.ownerUid) {
      const ownerDoc = await db.doc(`users/${team.ownerUid}`).get();
      if (ownerDoc.exists && ownerDoc.data().email) recipientEmails.add(ownerDoc.data().email);
    }
    membersSnap.docs.forEach(d => {
      const m = d.data();
      if ((m.role === 'co_lead' || m.role === 'owner') && m.email) recipientEmails.add(m.email);
    });
    if (!recipientEmails.size) { res.status(400).json({ error: 'No recipients found.' }); return; }

    await db.collection('mail').add({
      from: MAIL_FROM,
      to: Array.from(recipientEmails),
      message: {
        subject: renderTeamRecapSubject(stats),
        html: renderTeamRecapHTML(stats),
        text: renderTeamRecapText(stats),
      },
    });

    res.json({ ok: true, recipients: Array.from(recipientEmails), weekStart: stats.weekStart, weekEnd: stats.weekEnd });
  } catch (e) { console.error('[sendTeamReportNow]', e); sendErr(res, e); }
});

// ===== checkMailQueue — admin diagnostic: returns delivery status of recent mail docs =====
// GET/POST, Bearer auth required (admin only).
// Returns the last 20 mail docs with their delivery.state + delivery.error fields.
// Use this to diagnose firestore-send-email extension issues — if delivery.state is
// 'ERROR', delivery.error will tell you exactly why (bad SMTP, missing FROM, etc.)
exports.checkMailQueue = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(callerEmail)) { res.status(403).json({ error: 'admin only' }); return; }

    const snap = await db.collection('mail').orderBy('delivery.startTime', 'desc').limit(20).get()
      .catch(() => db.collection('mail').limit(20).get()); // fallback if no index yet

    const docs = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        to: data.to,
        from: data.from || '(none — using DEFAULT_FROM)',
        subject: data.message?.subject,
        delivery: data.delivery || null,
      };
    });

    const summary = {
      total: docs.length,
      byState: docs.reduce((acc, d) => {
        const s = d.delivery?.state || 'PENDING/NO_STATE';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {}),
      configuredFrom: MAIL_FROM,
      docs,
    };

    res.json(summary);
  } catch (e) { console.error('[checkMailQueue]', e); sendErr(res, e); }
});

// ===== saveTeamDomainSettings — owner/co_lead sets the team's SSO domain config =====
// Body: { domain: string, autoJoin: boolean }
// Saves teamDomain + teamDomainAutoJoin on the team doc. When autoJoin is true,
// any user who authenticates via Microsoft with a matching email domain is
// automatically added to the team (via claimMicrosoftTeam below).
exports.saveTeamDomainSettings = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const team = await loadTeamForOwnerOrColead(decoded.uid);
    let { domain, autoJoin } = req.body || {};
    domain = (domain || '').trim().toLowerCase().replace(/^@/, '').replace(/\s/g, '');
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      res.status(400).json({ error: 'Invalid domain format. Use example.com (no @ symbol).' });
      return;
    }
    const update = {
      teamDomain: domain || null,
      teamDomainAutoJoin: domain ? !!autoJoin : false,
      updatedAt: new Date().toISOString(),
    };
    await db.doc(`teams/${team.id}`).set(update, { merge: true });
    res.json({ ok: true, domain: domain || null, autoJoin: update.teamDomainAutoJoin });
  } catch (e) { console.error('[saveTeamDomainSettings]', e); sendErr(res, e); }
});

// ===== claimMicrosoftTeam — auto-join a team after Microsoft SSO sign-in =====
// Called by client after a successful microsoft.com sign-in. Looks up the caller's
// email domain against teams with teamDomainAutoJoin enabled. If matched, adds the
// user to that team automatically (no invite required).
exports.claimMicrosoftTeam = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const email = (decoded.email || '').toLowerCase();
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'No email address on this account' }); return;
    }
    const domain = email.split('@')[1];
    if (!domain) { res.status(400).json({ error: 'Cannot determine email domain' }); return; }

    // Is the user already on a team?
    const userSnap = await db.doc(`users/${uid}`).get();
    const userData = userSnap.data() || {};
    if (userData.teamId) {
      res.json({ joined: false, reason: 'already_on_team', teamId: userData.teamId });
      return;
    }

    // Find a team with this domain and autoJoin enabled
    const teamsQ = await db.collection('teams')
      .where('teamDomain', '==', domain)
      .where('teamDomainAutoJoin', '==', true)
      .limit(1)
      .get();
    if (teamsQ.empty) {
      res.json({ joined: false, reason: 'no_domain_match' }); return;
    }

    const teamDoc = teamsQ.docs[0];
    const teamId = teamDoc.id;
    const team = teamDoc.data();

    // Already a member?
    const memberSnap = await db.doc(`teams/${teamId}/members/${uid}`).get();
    if (memberSnap.exists) {
      res.json({ joined: false, reason: 'already_member', teamId, teamName: team.name });
      return;
    }

    // Add member
    const displayName = decoded.name || decoded.displayName || email.split('@')[0];
    await db.doc(`teams/${teamId}/members/${uid}`).set({
      uid, email, role: 'member',
      displayName,
      addedAt: new Date().toISOString(),
      autoJoinedViaDomain: domain,
    });
    await db.doc(`users/${uid}`).set({
      teamId, teamRole: 'member', updatedAt: new Date().toISOString(),
    }, { merge: true });

    // Bump seat count if needed
    const currentSeats = team.seats || TEAM_MIN_SEATS;
    const membersSnap = await db.collection(`teams/${teamId}/members`).get();
    if (membersSnap.size > currentSeats) {
      const newSeats = membersSnap.size;
      await db.doc(`teams/${teamId}`).set({ seats: newSeats, updatedAt: new Date().toISOString() }, { merge: true });
      await updateStripeTeamQuantity({ ...team, id: teamId }, newSeats).catch(e => console.warn('[claimMicrosoftTeam] stripe update failed:', e));
    }

    console.log(`[claimMicrosoftTeam] auto-joined ${email} → team ${teamId} (${team.name})`);
    res.json({ joined: true, teamId, teamName: team.name || 'Your Team' });
  } catch (e) { console.error('[claimMicrosoftTeam]', e); sendErr(res, e); }
});

// ===== setMemberActivities — team lead updates a member's activity point values =====
exports.setMemberActivities = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const callerUid = decoded.uid;
    const { memberUid, activities: newActs } = req.body || {};
    if (!memberUid || !Array.isArray(newActs)) {
      res.status(400).json({ error: 'memberUid and activities[] required' }); return;
    }
    const callerSnap = await db.doc(`users/${callerUid}`).get();
    const callerData = callerSnap.data() || {};
    let teamId = callerData.teamId;
    if (!teamId) {
      const q = await db.collection('teams').where('ownerUid', '==', callerUid).limit(1).get();
      if (!q.empty) teamId = q.docs[0].id;
    }
    if (!teamId) { res.status(403).json({ error: 'Not on a team' }); return; }
    const callerRole = callerData.teamRole || 'member';
    if (!['owner','co_lead','admin'].includes(callerRole)) {
      const teamSnap = await db.doc(`teams/${teamId}`).get();
      if (teamSnap.data()?.ownerUid !== callerUid) {
        res.status(403).json({ error: 'Team lead access required' }); return;
      }
    }
    const memberTeamSnap = await db.doc(`teams/${teamId}/members/${memberUid}`).get();
    if (!memberTeamSnap.exists) { res.status(403).json({ error: 'Member not on your team' }); return; }

    // Sanitize: only keep valid activity objects
    const safeActs = newActs
      .filter(a => typeof a.name === 'string' && a.name.trim())
      .map(a => ({
        name: a.name.trim().slice(0, 100),
        pts:  Math.max(0, parseInt(a.pts) || 0),
        icon: typeof a.icon === 'string' ? a.icon.slice(0, 10) : '⭐',
        category: typeof a.category === 'string' ? a.category.slice(0, 50) : 'Activities',
        lead: a.lead !== false,
      }));

    await db.doc(`users/${memberUid}/config/activities`).set({ list: safeActs }, { merge: true });
    res.json({ ok: true });
  } catch(e) { console.error('[setMemberActivities]', e); sendErr(res, e); }
});

// ===== setMemberEmailSettings — team lead sets a member's weekly recap schedule =====
exports.setMemberEmailSettings = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const callerUid = decoded.uid;
    const { memberUid, enabled, day, hour } = req.body || {};
    if (!memberUid) { res.status(400).json({ error: 'memberUid required' }); return; }

    const callerSnap = await db.doc(`users/${callerUid}`).get();
    const callerData = callerSnap.data() || {};
    let teamId = callerData.teamId;
    if (!teamId) {
      const q = await db.collection('teams').where('ownerUid', '==', callerUid).limit(1).get();
      if (!q.empty) teamId = q.docs[0].id;
    }
    if (!teamId) { res.status(403).json({ error: 'Not on a team' }); return; }
    const callerRole = callerData.teamRole || 'member';
    if (!['owner','co_lead','admin'].includes(callerRole)) {
      const teamSnap = await db.doc(`teams/${teamId}`).get();
      if (teamSnap.data()?.ownerUid !== callerUid) {
        res.status(403).json({ error: 'Team lead access required' }); return;
      }
    }
    const memberTeamSnap = await db.doc(`teams/${teamId}/members/${memberUid}`).get();
    if (!memberTeamSnap.exists) { res.status(403).json({ error: 'Member not on your team' }); return; }

    const update = {};
    if (typeof enabled === 'boolean') update.weeklyEmailEnabled = enabled;
    if (typeof day === 'string' && DAY_INDEX[day.toLowerCase()] !== undefined) update.weeklyEmailDay = day.toLowerCase();
    if (typeof hour === 'number' && hour >= 0 && hour <= 23) update.weeklyEmailHour = Math.floor(hour);

    await db.doc(`users/${memberUid}/config/settings`).set(update, { merge: true });
    res.json({ ok: true });
  } catch(e) { console.error('[setMemberEmailSettings]', e); sendErr(res, e); }
});

// ===== pushActivityToTeam — team lead adds an activity to every member's list =====
exports.pushActivityToTeam = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const decoded = await requireAuth(req);
    const callerUid = decoded.uid;
    const { activity } = req.body || {};
    if (!activity || typeof activity.name !== 'string' || !activity.name.trim()) {
      res.status(400).json({ error: 'activity.name required' }); return;
    }
    const callerSnap = await db.doc(`users/${callerUid}`).get();
    const callerData = callerSnap.data() || {};
    let teamId = callerData.teamId;
    if (!teamId) {
      const q = await db.collection('teams').where('ownerUid', '==', callerUid).limit(1).get();
      if (!q.empty) teamId = q.docs[0].id;
    }
    if (!teamId) { res.status(403).json({ error: 'Not on a team' }); return; }
    const teamSnap = await db.doc(`teams/${teamId}`).get();
    const callerRole = callerData.teamRole || 'member';
    if (!['owner','co_lead'].includes(callerRole) && teamSnap.data()?.ownerUid !== callerUid) {
      res.status(403).json({ error: 'Owner or co-lead access required' }); return;
    }

    const safeAct = {
      name:     activity.name.trim().slice(0, 100),
      pts:      Math.max(0, parseInt(activity.pts) || 5),
      icon:     typeof activity.icon === 'string' ? activity.icon.slice(0, 10) : '⭐',
      category: typeof activity.category === 'string' ? activity.category.slice(0, 50) : 'Activities',
      lead:     activity.lead !== false,
    };

    const membersSnap = await db.collection('teams').doc(teamId).collection('members').get();
    const updates = membersSnap.docs.map(async mDoc => {
      const uid = mDoc.id;
      const actRef = db.doc(`users/${uid}/config/activities`);
      const actSnap = await actRef.get();
      const list = actSnap.data()?.list || [];
      if (list.find(a => a.name === safeAct.name)) return; // already exists
      list.push(safeAct);
      await actRef.set({ list }, { merge: true });
    });
    await Promise.all(updates);
    res.json({ ok: true, pushedTo: membersSnap.size });
  } catch(e) { console.error('[pushActivityToTeam]', e); sendErr(res, e); }
});

// ============================================================
// REFERRALS
// ============================================================

// ----- logReferral — create a referral detail record -----
exports.logReferral = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const { direction, contactName, counterparty, category, notes, dateKey } = req.body || {};
    if (!direction || !['given','received'].includes(direction)) {
      res.status(400).json({ error: 'direction must be "given" or "received"' }); return;
    }
    if (!contactName || !contactName.trim()) {
      res.status(400).json({ error: 'contactName required' }); return;
    }
    const ref = db.collection('users').doc(uid).collection('referrals').doc();
    const now = new Date().toISOString();
    const rec = {
      id: ref.id,
      direction,
      contactName: contactName.trim().slice(0, 100),
      counterparty: (counterparty || '').trim().slice(0, 100),
      category: (category || '').trim().slice(0, 100),
      notes: (notes || '').trim().slice(0, 500),
      dateKey: dateKey || now.slice(0, 10),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(rec);
    res.json({ ok: true, id: ref.id, referral: rec });
  } catch(e) { console.error('[logReferral]', e); sendErr(res, e); }
});

// ----- updateReferralStatus — advance or set a referral's status -----
exports.updateReferralStatus = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const { referralId, status } = req.body || {};
    const VALID = ['pending','connected','converted'];
    if (!referralId) { res.status(400).json({ error: 'referralId required' }); return; }
    if (!VALID.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` }); return;
    }
    const ref = db.doc(`users/${uid}/referrals/${referralId}`);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Referral not found' }); return; }
    await ref.update({ status, updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch(e) { console.error('[updateReferralStatus]', e); sendErr(res, e); }
});

// ----- getMyReferrals — fetch all referrals for the authenticated user -----
exports.getMyReferrals = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const snap = await db.collection('users').doc(uid).collection('referrals')
      .orderBy('createdAt', 'desc').limit(200).get();
    const referrals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, referrals });
  } catch(e) { console.error('[getMyReferrals]', e); sendErr(res, e); }
});

// ============================================================
// STRIPE BILLING
// ============================================================
// Three endpoints power the web subscription flow:
//   1. createCheckoutSession — opens Stripe Checkout for a plan with 60-day trial
//   2. createPortalSession   — opens Stripe Customer Portal for subscription management
//   3. stripeWebhook         — mirrors subscription state onto users/{uid} doc
//
// User doc shape after a successful subscription:
//   { plan: 'scorecard' | 'pro' | 'free',
//     billingSource: 'stripe',
//     stripeCustomerId, stripeSubscriptionId, stripePriceId,
//     subscriptionStatus: 'trialing' | 'active' | 'past_due' | 'canceled' | ...,
//     currentPeriodEnd: ISO string, trialEnd: ISO string | null,
//     cancelAtPeriodEnd: boolean }

// ----- createCheckoutSession (HTTP, Bearer auth) -----
// Body: { plan: 'scorecard' | 'pro' }
// Returns: { url } — redirect the user to this URL to start checkout
exports.createCheckoutSession = onRequest({
  cors: true,
  secrets: [STRIPE_SECRET_KEY],
}, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const email = decoded.email || null;
    const { plan } = req.body || {};

    // Monthly-only personal plans. Team plans go through createTeamCheckoutSession.
    const priceId = plan === 'pro' ? STRIPE_PRICES.scorecard_crm
                  : plan === 'scorecard' ? STRIPE_PRICES.scorecard
                  : null;
    if (!priceId) { res.status(400).json({ error: 'Unknown plan' }); return; }

    const stripe = getStripe();
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    // Reuse the customer if we already created one; otherwise let Checkout create it
    // and we'll capture customerId in the webhook.
    let customerId = userData.stripeCustomerId || null;
    if (!customerId && email) {
      // Look for an existing Stripe customer with this email (covers prior aborted runs).
      const existing = await stripe.customers.list({ email, limit: 1 });
      if (existing.data.length) {
        customerId = existing.data[0].id;
        await userRef.set({ stripeCustomerId: customerId }, { merge: true });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      // Trial config — 60 days, no card required to start trial.
      subscription_data: {
        trial_period_days: STRIPE_TRIAL_DAYS,
        trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
        metadata: { firebaseUid: uid, plan: plan === 'pro' ? 'pro' : 'scorecard' },
      },
      // Apple Pay / Google Pay enabled by default with 'card'; Stripe Tax will calc tax.
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: customerId ? { address: 'auto', name: 'auto' } : undefined,
      customer: customerId || undefined,
      customer_email: customerId ? undefined : (email || undefined),
      client_reference_id: uid,
      allow_promotion_codes: true,
      success_url: `${STRIPE_RETURN_BASE}/?subscribed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${STRIPE_RETURN_BASE}/?canceled=1`,
      metadata: { firebaseUid: uid, plan: plan === 'pro' ? 'pro' : 'scorecard' },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (e) {
    console.error('[createCheckoutSession]', e);
    sendErr(res, e);
  }
});

// ----- createPortalSession (HTTP, Bearer auth) -----
// Returns: { url } — opens the Customer Portal so the user can manage their sub.
exports.createPortalSession = onRequest({
  cors: true,
  secrets: [STRIPE_SECRET_KEY],
}, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const customerId = userData.stripeCustomerId;
    if (!customerId) {
      res.status(400).json({ error: 'No Stripe customer on file — subscribe first.' });
      return;
    }
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${STRIPE_RETURN_BASE}/`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[createPortalSession]', e);
    sendErr(res, e);
  }
});

// ----- stripeWebhook (HTTP, signature-verified) -----
// Stripe sends subscription lifecycle events here. We mirror them onto the user doc.
// IMPORTANT: signature verification requires the raw request body. Firebase's default
// JSON parser must be bypassed — we use req.rawBody (always populated by gen2).
exports.stripeWebhook = onRequest({
  cors: false,
  secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, MYAPPOINTMENT_UPGRADE_SECRET],
}, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('POST only'); return; }
  const stripe = getStripe();
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody, // gen2 onRequest provides Buffer rawBody
      sig,
      STRIPE_WEBHOOK_SECRET.value()
    );
  } catch (e) {
    console.error('[stripeWebhook] signature verify failed:', e.message);
    res.status(400).send(`Webhook signature error: ${e.message}`);
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session.client_reference_id || session.metadata?.firebaseUid;
        if (!uid) { console.warn('[stripeWebhook] no uid on session', session.id); break; }
        const updates = {
          stripeCustomerId: session.customer,
          billingSource: 'stripe',
          updatedAt: new Date().toISOString(),
        };
        await db.collection('users').doc(uid).set(updates, { merge: true });
        console.log(`[stripeWebhook] checkout.session.completed uid=${uid} customer=${session.customer}`);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await mirrorSubscriptionToUser(sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const teamId = sub.metadata?.teamId || null;
        if (teamId) {
          // Team sub canceled — flip team to inactive; members lose entitlement next read.
          await db.collection('teams').doc(teamId).set({
            subscriptionStatus: 'canceled',
            active: false,
            cancelAtPeriodEnd: false,
            updatedAt: new Date().toISOString(),
          }, { merge: true });
          console.log(`[stripeWebhook] team sub canceled teamId=${teamId}`);
          break;
        }
        const uid = await resolveUidFromSubscription(sub);
        if (uid) {
          await db.collection('users').doc(uid).set({
            plan: 'free',
            subscriptionStatus: 'canceled',
            stripeSubscriptionId: null,
            cancelAtPeriodEnd: false,
            updatedAt: new Date().toISOString(),
          }, { merge: true });
          console.log(`[stripeWebhook] subscription canceled uid=${uid}`);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const customerId = inv.customer;
        const uid = await resolveUidFromCustomer(customerId);
        if (uid) {
          await db.collection('users').doc(uid).set({
            subscriptionStatus: 'past_due',
            updatedAt: new Date().toISOString(),
          }, { merge: true });
          console.log(`[stripeWebhook] payment_failed uid=${uid}`);
        }
        break;
      }
      default:
        // Acknowledge unhandled events so Stripe doesn't retry forever
        console.log(`[stripeWebhook] unhandled event ${event.type}`);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[stripeWebhook] handler error:', e);
    res.status(500).send(e.message);
  }
});

// Helper: given a Stripe subscription object, mirror its state onto the user doc OR team doc.
// If sub.metadata.teamId is set, this is a team subscription — mirror onto teams/{teamId}.
// Otherwise mirror onto the owning user doc (personal subscription).
async function mirrorSubscriptionToUser(sub) {
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  const teamId = sub.metadata?.teamId || null;

  if (teamId) {
    // Team subscription — mirror onto the team doc, NOT a user doc.
    const quantity = sub.items?.data?.[0]?.quantity || 0;
    const periodEndSec = sub.current_period_end || sub.trial_end || null;
    const status = sub.status;
    await db.collection('teams').doc(teamId).set({
      stripeCustomerId: sub.customer,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      subscriptionStatus: status,
      seats: quantity,
      currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      active: status === 'active' || status === 'trialing',
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    console.log(`[mirrorSubscriptionToUser:team] teamId=${teamId} seats=${quantity} status=${status}`);
    return;
  }

  // Personal subscription
  const uid = await resolveUidFromSubscription(sub);
  if (!uid) { console.warn('[mirrorSubscriptionToUser] no uid', sub.id); return; }
  let plan = (sub.status === 'canceled' || sub.status === 'incomplete_expired')
    ? 'free'
    : (STRIPE_PRICE_TO_PLAN[priceId] || 'free');
  // planOverride (manual comp/owner grants) always wins over billing-derived plan.
  try {
    const existing = await db.collection('users').doc(uid).get();
    const override = existing.exists ? existing.data().planOverride : null;
    if (override) plan = override;
  } catch (_) { /* fall through with billing-derived plan */ }
  const periodEndSec = sub.current_period_end || sub.trial_end || null;
  const trialEndSec = sub.trial_end || null;
  await db.collection('users').doc(uid).set({
    plan,
    billingSource: 'stripe',
    stripeCustomerId: sub.customer,
    stripeSubscriptionId: sub.id,
    stripePriceId: priceId,
    subscriptionStatus: sub.status,
    currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null,
    trialEnd: trialEndSec ? new Date(trialEndSec * 1000).toISOString() : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  console.log(`[mirrorSubscriptionToUser] uid=${uid} plan=${plan} status=${sub.status}`);

  // Mirror active/trialing pro subscriptions to myappointment-ai so the booking
  // surface unlocks immediately. Fire-and-forget — Stripe webhook must not fail
  // because of a cross-project side effect.
  if (plan === 'pro' && (sub.status === 'active' || sub.status === 'trialing')) {
    syncApptPlan(uid, sub.id).catch(err =>
      console.warn('[mirrorSubscriptionToUser] appt sync failed (non-fatal):', err?.message ?? err)
    );
    // Enroll in onboarding drip — idempotent, so safe to call on every renewal.
    // Resolves email from the user doc rather than Stripe to avoid coupling.
    db.collection('users').doc(uid).get().then(uSnap => {
      const ud = uSnap.data() || {};
      enrollOnboardingDripForUid(uid, ud.email || '', ud.displayName || '').catch(e =>
        console.warn('[mirrorSubscriptionToUser] drip enroll failed (non-fatal):', e?.message)
      );
    }).catch(() => {});
  }
}

async function resolveUidFromSubscription(sub) {
  if (sub.metadata?.firebaseUid) return sub.metadata.firebaseUid;
  return resolveUidFromCustomer(sub.customer);
}

async function resolveUidFromCustomer(customerId) {
  if (!customerId) return null;
  const q = await db.collection('users').where('stripeCustomerId', '==', customerId).limit(1).get();
  if (!q.empty) return q.docs[0].id;
  // Fallback: query Stripe customer for the email and find a user with that email
  try {
    const stripe = getStripe();
    const cust = await stripe.customers.retrieve(customerId);
    if (cust && cust.email) {
      const userByEmail = await admin.auth().getUserByEmail(cust.email).catch(() => null);
      if (userByEmail) return userByEmail.uid;
    }
  } catch (_) { /* swallow */ }
  return null;
}

// ============================================================
// REVENUECAT WEBHOOK (Apple IAP via RevenueCat)
// ============================================================
// RevenueCat sits between Apple's IAP infrastructure and our app. When a user buys,
// renews, cancels, or refunds an IAP subscription, RC fires this webhook with a clean
// normalized payload. We mirror the subscription state onto users/{uid} in Firestore
// using the SAME schema as the Stripe webhook — so the rest of the app (Scorecard iOS,
// web Scorecard, web CRM) just reads users/{uid}.plan and doesn't care which billing
// source provided the entitlement.
//
// Auth model: RevenueCat lets us configure a shared Authorization header value in their
// dashboard. We store that in REVENUECAT_WEBHOOK_AUTH and verify it on every request.
// (Their docs also support Signing keys but the header approach is the standard pattern.)
//
// Events we handle:
//   - INITIAL_PURCHASE        first-time purchase
//   - RENEWAL                 paid renewal at end of period
//   - PRODUCT_CHANGE          user upgraded/downgraded (e.g. Scorecard → CRM)
//   - CANCELLATION            user canceled (still active until period ends)
//   - EXPIRATION              subscription actually ended (no renewal)
//   - BILLING_ISSUE           Apple couldn't charge — entering grace period
//   - SUBSCRIBER_ALIAS        RC merged two RC users into one (re-resolve uid)
//   - NON_RENEWING_PURCHASE   one-time IAP (we don't sell these; ignore)
//   - TRANSFER                subscription moved to another account
exports.revenueCatWebhook = onRequest({
  cors: false,
  secrets: [REVENUECAT_WEBHOOK_AUTH],
}, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('POST only'); return; }

  // Auth check — RC sends our shared secret in the Authorization header.
  const auth = req.headers['authorization'] || '';
  const expected = REVENUECAT_WEBHOOK_AUTH.value();
  if (!expected || auth !== expected) {
    console.warn('[revenueCatWebhook] auth mismatch');
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    const event = (req.body && req.body.event) || {};
    const type = event.type || 'UNKNOWN';
    // RC's app_user_id is set by us in the iOS app via Purchases.configure({ appUserID })
    // We pass the Firebase uid there, so app_user_id == Firebase uid for all our users.
    const uid = event.app_user_id || event.original_app_user_id || null;

    if (!uid) {
      console.warn('[revenueCatWebhook] no app_user_id on event', type);
      res.status(200).json({ ok: false, reason: 'no uid' });
      return;
    }

    console.log(`[revenueCatWebhook] ${type} uid=${uid} product=${event.product_id || '?'}`);

    switch (type) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'PRODUCT_CHANGE':
      case 'UNCANCELLATION':
      case 'TRANSFER': {
        // Active or re-activated subscription — set plan based on entitlement / product.
        // planOverride (set manually for owners/comps) always wins: a $10 Scorecard
        // renewal must never downgrade an account that's been comp'd to pro.
        let plan = resolvePlanFromRcEvent(event);
        try {
          const existing = await db.collection('users').doc(uid).get();
          const override = existing.exists ? existing.data().planOverride : null;
          if (override) plan = override;
        } catch (_) { /* fall through with resolved plan */ }
        const periodEndSec = event.expiration_at_ms ? Math.floor(event.expiration_at_ms / 1000) : null;
        await db.collection('users').doc(uid).set({
          plan,
          billingSource: 'apple',
          appleProductId: event.product_id || null,
          appleOriginalTransactionId: event.original_transaction_id || null,
          revenueCatAppUserId: uid,
          subscriptionStatus: 'active',
          currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null,
          cancelAtPeriodEnd: false,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        break;
      }
      case 'CANCELLATION': {
        // User canceled — they keep access until expiration. Mark flag, don't downgrade plan yet.
        await db.collection('users').doc(uid).set({
          subscriptionStatus: 'canceled',
          cancelAtPeriodEnd: true,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        break;
      }
      case 'EXPIRATION': {
        // Subscription actually ended — downgrade to free.
        await db.collection('users').doc(uid).set({
          plan: 'free',
          subscriptionStatus: 'expired',
          cancelAtPeriodEnd: false,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        break;
      }
      case 'BILLING_ISSUE': {
        // Apple couldn't charge — grace period. Keep access for now, flag status.
        await db.collection('users').doc(uid).set({
          subscriptionStatus: 'past_due',
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        break;
      }
      case 'NON_RENEWING_PURCHASE':
      case 'SUBSCRIBER_ALIAS':
      default:
        // Acknowledge so RC doesn't retry; we don't act on these.
        console.log(`[revenueCatWebhook] no-op for event type ${type}`);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[revenueCatWebhook] error:', e);
    res.status(500).send(e.message);
  }
});

// Map an RC event to our internal `plan` value. RC sends entitlement_ids[] and product_id;
// we prefer entitlement_ids (more stable) but fall back to product_id if needed.
function resolvePlanFromRcEvent(event) {
  // Entitlement-based resolution
  const entitlements = event.entitlement_ids || (event.entitlement_id ? [event.entitlement_id] : []);
  for (const ent of entitlements) {
    if (REVENUECAT_ENTITLEMENTS[ent]) return REVENUECAT_ENTITLEMENTS[ent];
  }
  // Fallback: product-id-based
  if (event.product_id && REVENUECAT_PRODUCTS[event.product_id]) {
    return REVENUECAT_PRODUCTS[event.product_id];
  }
  // Default: if we can't tell, give them the lower tier rather than the higher one
  return 'scorecard';
}

// ============================================================
// TEAM PLAN — Cloud Functions
// ============================================================
// Data model:
//   teams/{teamId}                    { ownerUid, name, plan:'team', seats, stripeCustomerId,
//                                       stripeSubscriptionId, subscriptionStatus, active, createdAt }
//   teams/{teamId}/members/{uid}      { uid, email, role:'owner'|'admin'|'member', addedAt,
//                                       displayName }
//   teams/{teamId}/invites/{inviteId} { email, token, role, status, invitedBy, createdAt,
//                                       acceptedAt, acceptedByUid }
//   teamInvites/{token}               { teamId, email, status } — token-indexed for accept flow
//   users/{uid}                       adds: teamId, teamRole
//
// All writes happen via these Cloud Functions (admin SDK). Direct client writes are blocked
// by Firestore rules so the seat counter can't be manipulated client-side.

function genInviteToken() {
  return require('crypto').randomBytes(24).toString('base64url');
}

// Resolve the email address of a team's owner. Returns null if not findable.
// Used to CC the team lead on outgoing member-notification emails so they
// stay in the loop on who got pinged.
async function resolveTeamOwnerEmail(team) {
  if (!team || !team.ownerUid) return null;
  try {
    const u = await admin.auth().getUser(team.ownerUid);
    return (u && u.email) ? u.email.toLowerCase() : null;
  } catch (_) { return null; }
}

async function loadTeamForOwner(uid, teamIdHint) {
  // Resolve team owned by this uid. If teamIdHint given, verify ownership; else find via query.
  if (teamIdHint) {
    const snap = await db.collection('teams').doc(teamIdHint).get();
    if (!snap.exists) { const e = new Error('Team not found'); e.statusCode = 404; throw e; }
    if (snap.data().ownerUid !== uid) { const e = new Error('Not the team owner'); e.statusCode = 403; throw e; }
    return { id: snap.id, ...snap.data() };
  }
  const q = await db.collection('teams').where('ownerUid', '==', uid).limit(1).get();
  if (q.empty) { const e = new Error('You do not own a team'); e.statusCode = 404; throw e; }
  return { id: q.docs[0].id, ...q.docs[0].data() };
}

// Like loadTeamForOwner but also accepts co_lead and admin roles.
// Used by invite/remove so co-leads can manage their team.
// Returns { id, callerRole, ...teamData }
async function loadTeamForOwnerOrColead(uid) {
  // 1. Check if this uid owns a team directly.
  const ownerQ = await db.collection('teams').where('ownerUid', '==', uid).limit(1).get();
  if (!ownerQ.empty) {
    return { id: ownerQ.docs[0].id, callerRole: 'owner', ...ownerQ.docs[0].data() };
  }
  // 2. Look up their teamId from the user doc (set when they were added as a member).
  const userSnap = await db.doc(`users/${uid}`).get();
  const userData = userSnap.data() || {};
  const teamId = userData.teamId;
  const teamRole = userData.teamRole;
  if (!teamId || !['co_lead', 'admin'].includes(teamRole)) {
    const e = new Error('Owner or co-lead access required');
    e.statusCode = 403;
    throw e;
  }
  const teamSnap = await db.doc(`teams/${teamId}`).get();
  if (!teamSnap.exists) { const e = new Error('Team not found'); e.statusCode = 404; throw e; }
  return { id: teamSnap.id, callerRole: teamRole, ...teamSnap.data() };
}

async function updateStripeTeamQuantity(team, newQuantity) {
  // Push the new seat count to Stripe and let proration handle the bill delta.
  if (!team.stripeSubscriptionId) {
    console.warn('[updateStripeTeamQuantity] team has no Stripe sub yet, skipping');
    return;
  }
  if (newQuantity < TEAM_MIN_SEATS) newQuantity = TEAM_MIN_SEATS;
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId);
  const itemId = sub.items.data[0].id;
  await stripe.subscriptionItems.update(itemId, {
    quantity: newQuantity,
    proration_behavior: 'create_prorations',
  });
  console.log(`[updateStripeTeamQuantity] team=${team.id} qty=${newQuantity}`);
}

// ----- createTeamCheckoutSession (HTTP, Bearer auth) -----
// Body: { seats:number, teamName?:string }
// Returns: { url, sessionId, teamId } — creates a draft team doc then opens Stripe Checkout
// for the team price with the requested quantity. Webhook activates the team on payment.
exports.createTeamCheckoutSession = onRequest({
  cors: true,
  secrets: [STRIPE_SECRET_KEY],
}, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const email = decoded.email || null;
    let { seats, teamName, plan } = req.body || {};
    // plan is 'team_scorecard' (default, Scorecard only) or 'team_crm' (Scorecard + CRM)
    plan = (plan === 'team_crm') ? 'team_crm' : 'team_scorecard';
    seats = Math.max(TEAM_MIN_SEATS, parseInt(seats) || TEAM_MIN_SEATS);
    teamName = (teamName || (email ? email.split('@')[0] + "'s Team" : 'My Team')).slice(0, 80);

    // Pick the right Stripe price for this team plan.
    const priceId = plan === 'team_crm' ? STRIPE_PRICES.team_crm : STRIPE_PRICES.team;
    if (!priceId || priceId.includes('REPLACE_ME')) {
      res.status(400).json({ error: `${plan} price not yet configured in Stripe.` });
      return;
    }

    const stripe = getStripe();
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    // Reject if this user already owns a team
    const existing = await db.collection('teams').where('ownerUid', '==', uid).limit(1).get();
    if (!existing.empty) {
      res.status(409).json({ error: 'You already own a team', teamId: existing.docs[0].id });
      return;
    }

    // Reuse the customer if we already created one
    let customerId = userData.stripeCustomerId || null;
    if (!customerId && email) {
      const existingCust = await stripe.customers.list({ email, limit: 1 });
      if (existingCust.data.length) {
        customerId = existingCust.data[0].id;
        await userRef.set({ stripeCustomerId: customerId }, { merge: true });
      }
    }

    // Create draft team doc BEFORE checkout so the webhook has a teamId to mirror onto.
    const teamRef = db.collection('teams').doc();
    const teamId = teamRef.id;
    await teamRef.set({
      ownerUid: uid,
      name: teamName,
      plan,                         // 'team_scorecard' or 'team_crm'
      seats,
      active: false,
      subscriptionStatus: 'incomplete',
      createdAt: new Date().toISOString(),
    });
    // Owner is the first member automatically
    await teamRef.collection('members').doc(uid).set({
      uid,
      email: email || null,
      role: 'owner',
      displayName: userData.displayName || (email ? email.split('@')[0] : 'Owner'),
      addedAt: new Date().toISOString(),
    });
    await userRef.set({ teamId, teamRole: 'owner' }, { merge: true });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: seats }],
      subscription_data: {
        trial_period_days: STRIPE_TRIAL_DAYS,
        trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
        metadata: { firebaseUid: uid, plan, teamId },
      },
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: customerId ? { address: 'auto', name: 'auto' } : undefined,
      customer: customerId || undefined,
      customer_email: customerId ? undefined : (email || undefined),
      client_reference_id: uid,
      allow_promotion_codes: true,
      success_url: `${STRIPE_RETURN_BASE}/?team_subscribed=1&team=${teamId}&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${STRIPE_RETURN_BASE}/?team_canceled=1`,
      metadata: { firebaseUid: uid, plan, teamId },
    });

    res.json({ url: session.url, sessionId: session.id, teamId, plan });
  } catch (e) {
    console.error('[createTeamCheckoutSession]', e);
    sendErr(res, e);
  }
});

// ----- inviteTeamMember (HTTP, Bearer auth, owner-only) -----
// Body: { email, role?:'member'|'admin' }
// Returns: { ok, status:'added'|'invited', memberUid?, inviteUrl? }
// If the email already has a Firebase Auth account, they're added directly. Otherwise
// we create a token-based invite and send them an email with a join link.
exports.inviteTeamMember = onRequest({
  cors: true,
  secrets: [STRIPE_SECRET_KEY],
}, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const team = await loadTeamForOwnerOrColead(uid);
    let { email, role } = req.body || {};
    email = (email || '').trim().toLowerCase();
    // Co-leads can only invite as member; only owner can set admin/co_lead roles.
    role = (role === 'admin' && team.callerRole === 'owner') ? 'admin' : 'member';
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Valid email required' });
      return;
    }

    // Already a member?
    const existingMember = await db.collection('teams').doc(team.id).collection('members')
      .where('email', '==', email).limit(1).get();
    if (!existingMember.empty) {
      res.status(409).json({ error: 'Already on the team', memberUid: existingMember.docs[0].id });
      return;
    }

    // Bump the seat count by 1
    const newSeats = (team.seats || TEAM_MIN_SEATS) + 1;
    await db.collection('teams').doc(team.id).set({ seats: newSeats, updatedAt: new Date().toISOString() }, { merge: true });
    await updateStripeTeamQuantity(team, newSeats).catch(err => console.error('[inviteTeamMember] stripe qty update failed', err));

    // Does the email already have a Firebase account?
    const existingUser = await admin.auth().getUserByEmail(email).catch(() => null);
    if (existingUser) {
      // Add them directly as a member
      const memberRef = db.collection('teams').doc(team.id).collection('members').doc(existingUser.uid);
      await memberRef.set({
        uid: existingUser.uid,
        email,
        role,
        displayName: existingUser.displayName || email.split('@')[0],
        addedAt: new Date().toISOString(),
        invitedBy: uid,
      });
      // Mirror onto user doc so client-side entitlement check sees the team binding
      await db.collection('users').doc(existingUser.uid).set({
        teamId: team.id, teamRole: role, updatedAt: new Date().toISOString(),
      }, { merge: true });

      // Email them a notice — copy varies by team plan so CRM teams get the full story.
      const isCrmTeam = team.plan === 'team_crm';
      const productLabel = isCrmTeam ? 'Scorecard + CRM' : 'Scorecard';
      const productPitch = isCrmTeam
        ? 'You get the full Scorecard (daily activity tracking, weekly tier system, coaching) plus a private CRM (contacts, opportunities, 8-Step Follow-Through System).'
        : "Your team's score updates the moment you log a handshake.";
      const ownerEmail = (decoded.email || '').toLowerCase();
      const mailDoc = {
        to: [email],
        message: {
          subject: `You've been added to ${team.name} on SWH ${productLabel}`,
          html: `<p>${team.name} just added you to their <strong>SWH ${productLabel}</strong> team.</p>
            <p>${productPitch}</p>
            <p><a href="${STRIPE_RETURN_BASE}/" style="display:inline-block;padding:14px 28px;background:#EC1825;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-family:Arial,sans-serif;">Open SWH Scorecard</a></p>
            ${isCrmTeam ? `<p style="color:#555;font-size:13px;">Your CRM lives at <a href="https://swh-crm.web.app" style="color:#EC1825;">swh-crm.web.app</a>. Same sign-in.</p>` : ''}
            <p>— Stop Wasting Handshakes</p>`
        },
      };
      if (ownerEmail && ownerEmail !== email) mailDoc.cc = [ownerEmail];
      await db.collection('mail').add(mailDoc);

      res.json({ ok: true, status: 'added', memberUid: existingUser.uid, seats: newSeats });
      return;
    }

    // New user — create a token-based invite
    const token = genInviteToken();
    const inviteRef = db.collection('teams').doc(team.id).collection('invites').doc();
    await inviteRef.set({
      email, role, token,
      status: 'pending',
      invitedBy: uid,
      createdAt: new Date().toISOString(),
    });
    // Token-indexed mirror for accept flow
    await db.collection('teamInvites').doc(token).set({
      teamId: team.id, teamName: team.name, email, role, inviteRefId: inviteRef.id,
      invitedByEmail: decoded.email || null,
      status: 'pending', createdAt: new Date().toISOString(),
    });

    const inviteUrl = `${STRIPE_RETURN_BASE}/?team_invite=${token}`;
    // CC the team lead so they see what the prospective member received
    const ownerEmailForInvite = (decoded.email || '').toLowerCase();
    const isCrmInvite = team.plan === 'team_crm';
    const inviteProductLabel = isCrmInvite ? 'Scorecard + CRM' : 'Scorecard';
    const invitePitch = isCrmInvite
      ? 'SWH Scorecard + CRM combines a daily activity tracker with a private referral-focused CRM. Track contacts, opportunities, follow-ups, and watch your tier climb week by week.'
      : 'SWH Scorecard tracks the networking activities that grow your business: referrals, conversations, intros, follow-ups.';
    const inviteMail = {
      to: [email],
      message: {
        subject: `You're invited to join ${team.name} on SWH ${inviteProductLabel}`,
        html: `<p>${decoded.email || 'Your colleague'} invited you to join <strong>${team.name}</strong> on <strong>SWH ${inviteProductLabel}</strong>.</p>
          <p>${invitePitch} Joining the team takes 30 seconds.</p>
          <p><a href="${inviteUrl}" style="display:inline-block;padding:14px 28px;background:#EC1825;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-family:Arial,sans-serif;">Accept invite & join team</a></p>
          <p>This link expires in 14 days.</p>
          <p>— Stop Wasting Handshakes</p>`
      },
    };
    if (ownerEmailForInvite && ownerEmailForInvite !== email) inviteMail.cc = [ownerEmailForInvite];
    await db.collection('mail').add(inviteMail);

    res.json({ ok: true, status: 'invited', inviteUrl, seats: newSeats });
  } catch (e) {
    console.error('[inviteTeamMember]', e);
    sendErr(res, e);
  }
});

// ----- acceptTeamInvite (HTTP, Bearer auth) -----
// Body: { token }
// The signed-in user trades the invite token for membership. Their account must already
// exist (they signed up via the normal flow with the invite token in the URL).
exports.acceptTeamInvite = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const email = (decoded.email || '').toLowerCase();
    const { token } = req.body || {};
    if (!token) { res.status(400).json({ error: 'Missing token' }); return; }

    const tokenSnap = await db.collection('teamInvites').doc(token).get();
    if (!tokenSnap.exists) { res.status(404).json({ error: 'Invite not found' }); return; }
    const invite = tokenSnap.data();
    if (invite.status !== 'pending') { res.status(410).json({ error: 'Invite already used' }); return; }
    if (invite.email && invite.email !== email) {
      res.status(403).json({ error: `This invite was sent to ${invite.email}. Sign in with that email.` });
      return;
    }

    const teamRef = db.collection('teams').doc(invite.teamId);
    const teamSnap = await teamRef.get();
    if (!teamSnap.exists) { res.status(404).json({ error: 'Team no longer exists' }); return; }

    // Add to members
    await teamRef.collection('members').doc(uid).set({
      uid, email, role: invite.role || 'member',
      displayName: decoded.name || email.split('@')[0],
      addedAt: new Date().toISOString(),
      invitedBy: invite.invitedByEmail || null,
    });
    // Mark invite consumed
    await tokenSnap.ref.set({ status: 'accepted', acceptedAt: new Date().toISOString(), acceptedByUid: uid }, { merge: true });
    if (invite.inviteRefId) {
      await teamRef.collection('invites').doc(invite.inviteRefId).set({
        status: 'accepted', acceptedAt: new Date().toISOString(), acceptedByUid: uid,
      }, { merge: true });
    }
    // Mirror onto user doc
    await db.collection('users').doc(uid).set({
      teamId: invite.teamId, teamRole: invite.role || 'member', updatedAt: new Date().toISOString(),
    }, { merge: true });

    // ===== Notify the team lead that someone accepted =====
    // The owner gets an email confirming the new member joined, with current seat count
    // and a quick link to the Team Dashboard.
    const team = teamSnap.data();
    const ownerEmail = await resolveTeamOwnerEmail(team);
    if (ownerEmail && ownerEmail !== email) {
      try {
        // Refresh member count after the add
        const memSnap = await teamRef.collection('members').get();
        const memberCount = memSnap.size;
        const memberName = decoded.name || email.split('@')[0];
        const teamName = team.name || 'your team';
        const teamProductLabel = team.plan === 'team_crm' ? 'Scorecard + CRM' : 'Scorecard';
        const dashboardUrl = `${STRIPE_RETURN_BASE}/?screen=team`;
        await db.collection('mail').add({
          to: [ownerEmail],
          message: {
            subject: `${memberName} joined ${teamName}`,
            html: `<p><strong>${memberName}</strong> (${email}) just accepted your invite and joined <strong>${teamName}</strong> (${teamProductLabel}).</p>
              <p>Your team is now <strong>${memberCount} member${memberCount === 1 ? '' : 's'}</strong>.</p>
              <p><a href="${dashboardUrl}" style="display:inline-block;padding:14px 28px;background:#EC1825;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-family:Arial,sans-serif;">Open Team Dashboard</a></p>
              <p style="color:#555;font-size:13px;">They'll start showing up in your team's activity feed as soon as they log their first handshake.</p>
              <p>— Stop Wasting Handshakes</p>`
          },
        });
      } catch (e) {
        console.warn('[acceptTeamInvite] owner notification failed (non-fatal):', e?.message);
      }
    }

    res.json({ ok: true, teamId: invite.teamId, teamName: team.name });
  } catch (e) {
    console.error('[acceptTeamInvite]', e);
    sendErr(res, e);
  }
});

// ----- removeTeamMember (HTTP, Bearer auth, owner-only) -----
// Body: { memberUid }
// Removes a member from the team. Decrements Stripe quantity (but not below TEAM_MIN_SEATS).
// Owner can't remove themselves with this endpoint — use cancelTeam for that.
exports.removeTeamMember = onRequest({
  cors: true,
  secrets: [STRIPE_SECRET_KEY],
}, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const { memberUid } = req.body || {};
    if (!memberUid) { res.status(400).json({ error: 'Missing memberUid' }); return; }
    if (memberUid === uid) { res.status(400).json({ error: 'Cannot remove yourself — contact the team owner' }); return; }
    const team = await loadTeamForOwnerOrColead(uid);

    const memberRef = db.collection('teams').doc(team.id).collection('members').doc(memberUid);
    const memberSnap = await memberRef.get();
    if (!memberSnap.exists) { res.status(404).json({ error: 'Member not found' }); return; }
    // Co-leads cannot remove other co-leads or the owner — only the owner can.
    const targetRole = (memberSnap.data() || {}).role || 'member';
    if (team.callerRole !== 'owner' && ['owner','co_lead'].includes(targetRole)) {
      res.status(403).json({ error: 'Only the team owner can remove a co-lead' }); return;
    }

    await memberRef.delete();
    // Clear team binding on the user doc
    await db.collection('users').doc(memberUid).set({
      teamId: null, teamRole: null, updatedAt: new Date().toISOString(),
    }, { merge: true });

    // Decrement seat count
    const newSeats = Math.max(TEAM_MIN_SEATS, (team.seats || TEAM_MIN_SEATS) - 1);
    await db.collection('teams').doc(team.id).set({ seats: newSeats, updatedAt: new Date().toISOString() }, { merge: true });
    await updateStripeTeamQuantity(team, newSeats).catch(err => console.error('[removeTeamMember] stripe qty update failed', err));

    res.json({ ok: true, seats: newSeats });
  } catch (e) {
    console.error('[removeTeamMember]', e);
    sendErr(res, e);
  }
});

// ----- getTeamSummary (HTTP, Bearer auth) -----
// Returns the team doc + members list for either:
//   - the team this user OWNS (if they own one), OR
//   - the team this user is a MEMBER of.
// Used by the Team Dashboard + Settings Team section.
exports.getTeamSummary = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;

    // Find team via user doc binding (fast path)
    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    let teamId = userData.teamId;

    // Fallback: query for ownership
    if (!teamId) {
      const q = await db.collection('teams').where('ownerUid', '==', uid).limit(1).get();
      if (!q.empty) teamId = q.docs[0].id;
    }

    if (!teamId) { res.json({ team: null, members: [], role: null }); return; }

    const teamSnap = await db.collection('teams').doc(teamId).get();
    if (!teamSnap.exists) { res.json({ team: null, members: [], role: null }); return; }
    const team = { id: teamSnap.id, ...teamSnap.data() };
    const role = team.ownerUid === uid ? 'owner' : (userData.teamRole || 'member');

    const membersSnap = await db.collection('teams').doc(teamId).collection('members').get();

    // Fetch lastSeenAt (CRM last-opened timestamp) from each member's user doc in parallel.
    const members = await Promise.all(membersSnap.docs.map(async (d) => {
      const memberData = d.data();
      // uid might be stored as 'uid' or inferred from the doc id
      const memberUid = memberData.uid || d.id;
      let lastSeenAt = memberData.lastSeenAt || null;
      if (memberUid && !lastSeenAt) {
        try {
          const userSnap = await db.collection('users').doc(memberUid).get();
          if (userSnap.exists) lastSeenAt = userSnap.data().lastSeenAt || null;
        } catch (_) {}
      }
      return { ...memberData, lastSeenAt };
    }));

    // Owner / co_lead / admin: include pending invites
    let pendingInvites = [];
    if (role === 'owner' || role === 'co_lead' || role === 'admin') {
      const invSnap = await db.collection('teams').doc(teamId).collection('invites')
        .where('status', '==', 'pending').get();
      pendingInvites = invSnap.docs.map(d => d.data());
    }

    res.json({ team, members, pendingInvites, role });
  } catch (e) {
    console.error('[getTeamSummary]', e);
    sendErr(res, e);
  }
});

// ----- getTeamActivityFeed (HTTP, Bearer auth) -----
// Returns: { events: [{ memberUid, memberName, date, totalPts, leadPts, lagPts, updatedAt }], totals }
// Members can see their own team's feed. Owner sees all. For each member, we pull today's
// day doc — a denormalized view of what each person has logged today.
exports.getTeamActivityFeed = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;

    // Resolve team via user binding
    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    let teamId = userData.teamId;
    if (!teamId) {
      const q = await db.collection('teams').where('ownerUid', '==', uid).limit(1).get();
      if (!q.empty) teamId = q.docs[0].id;
    }
    if (!teamId) { res.json({ events: [], totals: { team: 0, members: 0 } }); return; }

    // Membership check
    const memberSnap = await db.collection('teams').doc(teamId).collection('members').doc(uid).get();
    const teamDoc = await db.collection('teams').doc(teamId).get();
    if (!memberSnap.exists && (!teamDoc.exists || teamDoc.data().ownerUid !== uid)) {
      res.status(403).json({ error: 'Not a team member' });
      return;
    }

    const membersSnap = await db.collection('teams').doc(teamId).collection('members').get();
    const members = membersSnap.docs.map(d => d.data());

    // Today's key in UTC — clients may be in different TZs but for V1 we use a single TZ.
    const today = fmtDate(new Date());
    const yesterday = addDays(today, -1);

    const events = [];
    let teamTotal = 0;
    for (const m of members) {
      // Pull today + yesterday day docs for each member
      const [todaySnap, ySnap, activitiesSnap] = await Promise.all([
        db.collection('users').doc(m.uid).collection('days').doc(today).get(),
        db.collection('users').doc(m.uid).collection('days').doc(yesterday).get(),
        db.collection('users').doc(m.uid).collection('config').doc('activities').get(),
      ]);

      const activitiesList = activitiesSnap.exists ? (activitiesSnap.data().list || []) : [];
      const ptsByName = {};
      const leadByName = {};
      activitiesList.forEach(a => {
        ptsByName[a.name] = a.pts || 0;
        leadByName[a.name] = a.lead !== false; // default true
      });

      for (const [dateKey, snap] of [[today, todaySnap], [yesterday, ySnap]]) {
        if (!snap.exists) continue;
        const data = snap.data();
        const counts = data.counts || {};
        let total = 0, leadPts = 0, lagPts = 0;
        for (const [name, count] of Object.entries(counts)) {
          const pts = (ptsByName[name] || 0) * (parseInt(count) || 0);
          total += pts;
          if (leadByName[name]) leadPts += pts; else lagPts += pts;
        }
        if (total > 0) {
          events.push({
            memberUid: m.uid,
            memberName: m.displayName || m.email || 'Member',
            memberEmail: m.email,
            date: dateKey,
            isToday: dateKey === today,
            totalPts: total,
            leadPts, lagPts,
            counts,
            updatedAt: data.updatedAt || null,
          });
          if (dateKey === today) teamTotal += total;
        }
      }
    }

    // Sort by updatedAt desc, then by date desc
    events.sort((a, b) => {
      const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (bt !== at) return bt - at;
      return b.date.localeCompare(a.date);
    });

    res.json({
      events,
      totals: { team: teamTotal, members: members.length, today, yesterday },
    });
  } catch (e) {
    console.error('[getTeamActivityFeed]', e);
    sendErr(res, e);
  }
});

// ============================================================
// ADMIN — TEAM MANAGEMENT (used by swh-admin.web.app Teams tab)
// ============================================================
// All endpoints below are gated to ADMIN_EMAILS (currently just Austen).
// They let an admin manage ANY team across the platform without going through
// Stripe Checkout. Supports both team_scorecard and team_crm plans.

async function requireAdmin(req) {
  const decoded = await requireAuth(req);
  const email = (decoded.email || '').toLowerCase();
  if (!email || !ADMIN_EMAILS.includes(email)) {
    const err = new Error('Permission denied: admin only');
    err.statusCode = 403;
    throw err;
  }
  return decoded;
}

// ----- adminListTeams (HTTP, admin-only) -----
// Returns every team in the platform with members + owner info baked in.
// Filter via query string: ?plan=team_scorecard | team_crm
exports.adminListTeams = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    const filterPlan = (req.query.plan || '').toString();
    const teamsSnap = await db.collection('teams').get();

    const teams = [];
    for (const doc of teamsSnap.docs) {
      const t = { id: doc.id, ...doc.data() };
      const plan = t.plan || 'team_scorecard';
      if (filterPlan && plan !== filterPlan) continue;

      // Pull member count
      const membersSnap = await db.collection('teams').doc(doc.id).collection('members').get();
      const members = membersSnap.docs.map(m => m.data());

      // Pull owner email
      let ownerEmail = null;
      try {
        const ownerRec = await admin.auth().getUser(t.ownerUid).catch(() => null);
        ownerEmail = ownerRec ? ownerRec.email : null;
      } catch (_) { /* ignore */ }

      teams.push({
        ...t,
        plan,
        memberCount: members.length,
        ownerEmail,
      });
    }
    // Sort newest first
    teams.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ teams });
  } catch (e) {
    console.error('[adminListTeams]', e);
    sendErr(res, e);
  }
});

// ----- adminGetTeam (HTTP, admin-only) -----
// Full team detail: doc + members + pending invites + Stripe sub status if any.
exports.adminGetTeam = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    const { teamId } = req.body || {};
    if (!teamId) { res.status(400).json({ error: 'Missing teamId' }); return; }
    const teamSnap = await db.collection('teams').doc(teamId).get();
    if (!teamSnap.exists) { res.status(404).json({ error: 'Not found' }); return; }
    const team = { id: teamSnap.id, ...teamSnap.data() };

    const membersSnap = await db.collection('teams').doc(teamId).collection('members').get();
    const members = await Promise.all(membersSnap.docs.map(async m => {
      const d = m.data();
      const u = await admin.auth().getUser(d.uid).catch(() => null);
      return {
        ...d,
        email: d.email || (u ? u.email : null),
        lastSignIn: u ? u.metadata?.lastSignInTime : null,
      };
    }));

    const invitesSnap = await db.collection('teams').doc(teamId).collection('invites').get();
    const invites = invitesSnap.docs.map(i => ({ id: i.id, ...i.data() }));

    res.json({ team, members, invites });
  } catch (e) {
    console.error('[adminGetTeam]', e);
    sendErr(res, e);
  }
});

// ----- adminCreateTeam (HTTP, admin-only) -----
// Body: { ownerEmail, teamName, plan: 'team_scorecard'|'team_crm', seats?, comp?:true }
// Creates a team for the given owner. If `comp:true`, marks it active without any
// Stripe subscription — owner gets free access until you cancel it. Otherwise
// the team is created in 'incomplete' state and you wire Stripe later.
exports.adminCreateTeam = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    let { ownerEmail, teamName, plan, seats, comp } = req.body || {};
    ownerEmail = (ownerEmail || '').trim().toLowerCase();
    teamName = (teamName || '').trim();
    plan = (plan === 'team_crm') ? 'team_crm' : 'team_scorecard';
    seats = Math.max(TEAM_MIN_SEATS, parseInt(seats) || TEAM_MIN_SEATS);

    if (!ownerEmail) { res.status(400).json({ error: 'ownerEmail required' }); return; }
    if (!teamName) { res.status(400).json({ error: 'teamName required' }); return; }

    // Resolve / create the owner's Firebase Auth account
    let ownerRec = await admin.auth().getUserByEmail(ownerEmail).catch(() => null);
    if (!ownerRec) {
      ownerRec = await admin.auth().createUser({ email: ownerEmail });
      // Initialize a minimal user doc
      await db.collection('users').doc(ownerRec.uid).set({
        email: ownerEmail,
        plan: 'free',
        createdAt: new Date().toISOString(),
      });
    }
    const ownerUid = ownerRec.uid;

    // Reject if this owner already owns a team
    const existing = await db.collection('teams').where('ownerUid', '==', ownerUid).limit(1).get();
    if (!existing.empty) {
      res.status(409).json({ error: 'Owner already has a team', teamId: existing.docs[0].id });
      return;
    }

    const teamRef = db.collection('teams').doc();
    const teamId = teamRef.id;
    await teamRef.set({
      ownerUid,
      name: teamName,
      plan,
      seats,
      active: !!comp,
      subscriptionStatus: comp ? 'comp' : 'incomplete',
      createdAt: new Date().toISOString(),
      createdBy: 'admin',
    });
    await teamRef.collection('members').doc(ownerUid).set({
      uid: ownerUid,
      email: ownerEmail,
      role: 'owner',
      displayName: ownerRec.displayName || ownerEmail.split('@')[0],
      addedAt: new Date().toISOString(),
    });
    await db.collection('users').doc(ownerUid).set({
      teamId, teamRole: 'owner', updatedAt: new Date().toISOString(),
    }, { merge: true });

    res.json({ ok: true, teamId, ownerUid });
  } catch (e) {
    console.error('[adminCreateTeam]', e);
    sendErr(res, e);
  }
});

// ----- adminUpdateTeam (HTTP, admin-only) -----
// Body: { teamId, patch: { name?, plan?, seats?, active?, subscriptionStatus? } }
// Generic field updater for the team doc.
exports.adminUpdateTeam = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    const { teamId, patch } = req.body || {};
    if (!teamId || !patch) { res.status(400).json({ error: 'teamId and patch required' }); return; }
    const allowed = ['name', 'plan', 'seats', 'active', 'subscriptionStatus'];
    const updates = { updatedAt: new Date().toISOString() };
    for (const k of allowed) {
      if (k in patch) updates[k] = patch[k];
    }
    if (updates.plan && updates.plan !== 'team_scorecard' && updates.plan !== 'team_crm') {
      res.status(400).json({ error: 'plan must be team_scorecard or team_crm' });
      return;
    }
    if ('seats' in updates) updates.seats = Math.max(TEAM_MIN_SEATS, parseInt(updates.seats) || TEAM_MIN_SEATS);
    await db.collection('teams').doc(teamId).set(updates, { merge: true });
    res.json({ ok: true, updates });
  } catch (e) {
    console.error('[adminUpdateTeam]', e);
    sendErr(res, e);
  }
});

// ----- adminCompTeam (HTTP, admin-only) -----
// Flips a team to free/comp status (no Stripe). Members keep access indefinitely
// until you toggle it off. Use for pilot accounts, internal teams, partner pilots.
exports.adminCompTeam = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    const { teamId, comp } = req.body || {};
    if (!teamId) { res.status(400).json({ error: 'teamId required' }); return; }
    await db.collection('teams').doc(teamId).set({
      active: !!comp,
      subscriptionStatus: comp ? 'comp' : 'canceled',
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    console.error('[adminCompTeam]', e);
    sendErr(res, e);
  }
});

// ----- adminAddTeamMember (HTTP, admin-only) -----
// Body: { teamId, email, role?:'member'|'admin'|'co_lead' }
// Adds an existing user to a team OR creates the auth account if needed and adds them.
// Skips Stripe quantity update by default (admin choice — they can hit the per-seat
// endpoint separately if they want to bill).
exports.adminAddTeamMember = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    let { teamId, email, role } = req.body || {};
    email = (email || '').trim().toLowerCase();
    role = ['admin', 'co_lead'].includes(role) ? role : 'member';
    if (!teamId || !email) { res.status(400).json({ error: 'teamId and email required' }); return; }

    const teamSnap = await db.collection('teams').doc(teamId).get();
    if (!teamSnap.exists) { res.status(404).json({ error: 'Team not found' }); return; }
    const team = teamSnap.data();

    // Find or create the user
    let userRec = await admin.auth().getUserByEmail(email).catch(() => null);
    if (!userRec) {
      userRec = await admin.auth().createUser({ email });
      await db.collection('users').doc(userRec.uid).set({
        email, plan: 'free', createdAt: new Date().toISOString(),
      });
    }

    const memberRef = db.collection('teams').doc(teamId).collection('members').doc(userRec.uid);
    const memberSnap = await memberRef.get();
    if (memberSnap.exists) {
      res.status(409).json({ error: 'Already on the team' });
      return;
    }
    await memberRef.set({
      uid: userRec.uid,
      email,
      role,
      displayName: userRec.displayName || email.split('@')[0],
      addedAt: new Date().toISOString(),
      addedBy: 'admin',
    });
    await db.collection('users').doc(userRec.uid).set({
      teamId, teamRole: role, updatedAt: new Date().toISOString(),
    }, { merge: true });

    // Bump seat count on the team doc (admin can decide whether to push to Stripe)
    const newSeats = (team.seats || TEAM_MIN_SEATS) + 1;
    await db.collection('teams').doc(teamId).set({
      seats: newSeats, updatedAt: new Date().toISOString(),
    }, { merge: true });

    res.json({ ok: true, memberUid: userRec.uid, seats: newSeats });
  } catch (e) {
    console.error('[adminAddTeamMember]', e);
    sendErr(res, e);
  }
});

// ----- adminChangeMemberRole (HTTP, admin-only) -----
// Body: { teamId, memberUid, role: 'member'|'co_lead'|'admin' }
exports.adminChangeMemberRole = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    let { teamId, memberUid, role } = req.body || {};
    if (!teamId || !memberUid) { res.status(400).json({ error: 'teamId and memberUid required' }); return; }
    role = ['admin', 'co_lead', 'member'].includes(role) ? role : 'member';
    // Update members subcollection
    await db.collection('teams').doc(teamId).collection('members').doc(memberUid)
      .set({ role, updatedAt: new Date().toISOString() }, { merge: true });
    // Mirror onto user doc for client-side entitlement detection
    await db.collection('users').doc(memberUid)
      .set({ teamRole: role, updatedAt: new Date().toISOString() }, { merge: true });
    res.json({ ok: true, role });
  } catch (e) {
    console.error('[adminChangeMemberRole]', e);
    sendErr(res, e);
  }
});

// ----- adminRemoveTeamMember (HTTP, admin-only) -----
exports.adminRemoveTeamMember = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    const { teamId, memberUid } = req.body || {};
    if (!teamId || !memberUid) { res.status(400).json({ error: 'teamId and memberUid required' }); return; }
    const teamSnap = await db.collection('teams').doc(teamId).get();
    if (!teamSnap.exists) { res.status(404).json({ error: 'Team not found' }); return; }
    const team = teamSnap.data();
    if (team.ownerUid === memberUid) {
      res.status(400).json({ error: 'Cannot remove the owner — use adminDeleteTeam' });
      return;
    }
    await db.collection('teams').doc(teamId).collection('members').doc(memberUid).delete();
    await db.collection('users').doc(memberUid).set({
      teamId: null, teamRole: null, updatedAt: new Date().toISOString(),
    }, { merge: true });
    const newSeats = Math.max(TEAM_MIN_SEATS, (team.seats || TEAM_MIN_SEATS) - 1);
    await db.collection('teams').doc(teamId).set({
      seats: newSeats, updatedAt: new Date().toISOString(),
    }, { merge: true });
    res.json({ ok: true, seats: newSeats });
  } catch (e) {
    console.error('[adminRemoveTeamMember]', e);
    sendErr(res, e);
  }
});

// ----- adminSendTeamWelcomeEmail (HTTP, admin-only) -----
// Body: { teamId, memberUid }
// Queues a "You've been added to {team.name}" email to the member via the
// firestore-send-email extension. Used when an admin added someone via the
// silent admin flow (which doesn't auto-notify) and now wants to nudge them.
exports.adminSendTeamWelcomeEmail = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    const { teamId, memberUid } = req.body || {};
    if (!teamId || !memberUid) { res.status(400).json({ error: 'teamId and memberUid required' }); return; }

    const teamSnap = await db.collection('teams').doc(teamId).get();
    if (!teamSnap.exists) { res.status(404).json({ error: 'Team not found' }); return; }
    const team = teamSnap.data();

    const memberSnap = await db.collection('teams').doc(teamId).collection('members').doc(memberUid).get();
    if (!memberSnap.exists) { res.status(404).json({ error: 'Member not on this team' }); return; }
    const member = memberSnap.data();

    // Also pull auth record for the freshest email
    const authRec = await admin.auth().getUser(memberUid).catch(() => null);
    const email = (member.email || authRec?.email || '').trim().toLowerCase();
    if (!email) { res.status(400).json({ error: 'No email on file for this member' }); return; }

    const teamName = team.name || 'your team';
    const planLabel = team.plan === 'team_crm' ? 'Scorecard + CRM' : 'Scorecard';

    // CC the team lead (owner) so they see what the member received.
    const ownerEmail = await resolveTeamOwnerEmail(team);
    const mailDoc = {
      to: [email],
      message: {
        subject: `You've been added to ${teamName} on SWH Scorecard`,
        html: `<p>${teamName} just added you to their SWH ${planLabel} team.</p>
          <p>Sign in to start logging activities. Your team's score updates the moment you do.</p>
          <p><a href="${STRIPE_RETURN_BASE}/" style="display:inline-block;padding:14px 28px;background:#EC1825;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-family:Arial,sans-serif;">Open SWH Scorecard</a></p>
          <p style="color:#555;font-size:13px;">Already have an account? Use the same email above to sign in. New here? Click "Create one →" on the sign-in screen — it takes 30 seconds.</p>
          <p>— Stop Wasting Handshakes</p>`
      },
    };
    if (ownerEmail && ownerEmail !== email) mailDoc.cc = [ownerEmail];
    await db.collection('mail').add(mailDoc);

    res.json({ ok: true, sentTo: email, ccd: ownerEmail || null });
  } catch (e) {
    console.error('[adminSendTeamWelcomeEmail]', e);
    sendErr(res, e);
  }
});

// ----- adminInspectUser (HTTP, admin-only) -----
// Body: { email } or { uid }
// Returns the complete state of a user: auth record, user doc fields,
// team binding (if any), subcollection counts (contacts, days, opportunities,
// activities, lag, etc.), and Stripe customer info. Use to verify that an
// existing user was correctly added to a team WITHOUT losing or corrupting
// their personal data.
exports.adminInspectUser = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    let { email, uid } = req.body || {};
    email = (email || '').trim().toLowerCase();
    if (!email && !uid) { res.status(400).json({ error: 'email or uid required' }); return; }

    // Resolve to a Firebase Auth record
    let authRec = null;
    try {
      authRec = uid ? await admin.auth().getUser(uid) : await admin.auth().getUserByEmail(email);
    } catch (e) {
      res.status(404).json({ error: 'Auth user not found' });
      return;
    }
    const resolvedUid = authRec.uid;
    const userRef = db.collection('users').doc(resolvedUid);

    // User doc + all subcollection sizes in parallel
    const subcolls = ['contacts','days','opportunities','activities','lag','tasks','config','events','follow-throughs'];
    const [userSnap, ...subSnaps] = await Promise.all([
      userRef.get(),
      ...subcolls.map(c => userRef.collection(c).count().get().catch(() => null)),
    ]);
    const userData = userSnap.exists ? userSnap.data() : null;
    const subcollectionCounts = {};
    subcolls.forEach((c, i) => {
      const s = subSnaps[i];
      subcollectionCounts[c] = s ? (s.data().count || 0) : 'n/a';
    });

    // Team binding — if user has a teamId, hydrate the team doc + their member record
    let team = null;
    let memberDoc = null;
    if (userData && userData.teamId) {
      const teamSnap = await db.collection('teams').doc(userData.teamId).get();
      if (teamSnap.exists) team = { id: teamSnap.id, ...teamSnap.data() };
      const memberSnap = await db.collection('teams').doc(userData.teamId).collection('members').doc(resolvedUid).get();
      if (memberSnap.exists) memberDoc = memberSnap.data();
    }

    // Also check if user is the OWNER of any team (in case userData.teamId is stale)
    const ownedTeamsSnap = await db.collection('teams').where('ownerUid', '==', resolvedUid).get();
    const ownedTeams = ownedTeamsSnap.docs.map(d => ({ id: d.id, name: d.data().name, plan: d.data().plan }));

    res.json({
      auth: {
        uid: authRec.uid,
        email: authRec.email,
        emailVerified: authRec.emailVerified,
        displayName: authRec.displayName,
        disabled: authRec.disabled,
        created: authRec.metadata?.creationTime,
        lastSignIn: authRec.metadata?.lastSignInTime,
        providers: (authRec.providerData || []).map(p => p.providerId),
      },
      userDoc: userData ? {
        exists: true,
        plan: userData.plan || null,
        teamId: userData.teamId || null,
        teamRole: userData.teamRole || null,
        stripeCustomerId: userData.stripeCustomerId || null,
        stripeSubscriptionId: userData.stripeSubscriptionId || null,
        subscriptionStatus: userData.subscriptionStatus || null,
        billingSource: userData.billingSource || null,
        createdAt: userData.createdAt || null,
        updatedAt: userData.updatedAt || null,
      } : { exists: false },
      team,
      memberDoc,
      ownedTeams,
      subcollectionCounts,
      // Final entitlement check — what `getMe` would return for this user
      effectivePlan: (() => {
        const personalPlan = (userData && userData.plan) || 'free';
        if (!team) return personalPlan;
        const teamActive = team.active === true ||
          team.subscriptionStatus === 'active' ||
          team.subscriptionStatus === 'trialing' ||
          team.subscriptionStatus === 'comp';
        if (!teamActive) return personalPlan;
        const teamProduct = team.plan === 'team_crm' ? 'pro' : 'scorecard';
        const rank = { free: 0, scorecard: 1, pro: 2 };
        return (rank[teamProduct] || 0) > (rank[personalPlan] || 0) ? teamProduct : personalPlan;
      })(),
    });
  } catch (e) {
    console.error('[adminInspectUser]', e);
    sendErr(res, e);
  }
});

// ----- adminDeleteTeam (HTTP, admin-only) -----
// Nukes a team entirely: unbinds all members from users/{uid}.teamId, deletes
// subcollections (members, invites, feed), deletes the team doc. Stripe sub
// (if any) must be canceled separately in the Stripe dashboard.
exports.adminDeleteTeam = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAdmin(req);
    const { teamId } = req.body || {};
    if (!teamId) { res.status(400).json({ error: 'teamId required' }); return; }
    const teamRef = db.collection('teams').doc(teamId);

    // Unbind each member's user doc
    const membersSnap = await teamRef.collection('members').get();
    await Promise.all(membersSnap.docs.map(async m => {
      const uid = m.id;
      await db.collection('users').doc(uid).set({
        teamId: null, teamRole: null, updatedAt: new Date().toISOString(),
      }, { merge: true });
      await m.ref.delete();
    }));

    // Delete invites + feed subcollections
    const invitesSnap = await teamRef.collection('invites').get();
    await Promise.all(invitesSnap.docs.map(d => d.ref.delete()));
    const feedSnap = await teamRef.collection('feed').get();
    await Promise.all(feedSnap.docs.map(d => d.ref.delete()));

    await teamRef.delete();
    res.json({ ok: true });
  } catch (e) {
    console.error('[adminDeleteTeam]', e);
    sendErr(res, e);
  }
});

// ============================================================
// LOLA — SWH CRM AI assistant (May 2026)
// ============================================================
// Three modes routed by request.body.mode:
//   - 'build_playbook' → prompt describing a relationship type, returns
//     a structured 8-step playbook proposal (JSON) + a short intro line.
//   - 'write_step' → contact + step context, returns drafted outreach
//     message text the user can copy into iMessage / email.
//   - 'daily_brief' → list of overdue contacts, returns a prioritized
//     top-3 with one-line "what to do" suggestions.
//   - 'freeform' (default) → conversational coaching about networking,
//     FORM conversations, lead vs lag, etc.
//
// All modes share a single system prompt that encodes Lola's SWH voice
// (warm, decisive, no em-dashes, no "AI assistant" buzzword filler) plus
// the SWH philosophy (FORM conversations, lead-vs-lag indicators, the
// 8-step structure).
// ============================================================
const LOLA_SYSTEM_PROMPT = `You are Lola, the AI co-pilot inside SWH (Stop Wasting Handshakes), Austen Smith's networking productivity platform.

Your job: help users build follow-through playbooks, write outreach messages, and prioritize who to reach out to today. You operate inside the SWH CRM for Pro users.

Style rules — these are absolute:
- Never use em-dashes (—). Use periods, commas, or parentheses instead.
- Warm but decisive. No hedging filler like "I think maybe perhaps."
- No "As an AI" / "I'm just an AI" / "I cannot" disclaimers.
- No bulleted answers when prose works. No markdown headers in chat replies.
- Use the user's first name when greeting, once, then drop it.
- Talk like a sharp networking coach who has read every Dale Carnegie book and also runs a real book of business. Not like a chatbot.

SWH philosophy you must internalize:
- Networking is not collecting handshakes, it is following through on them.
- Every contact starts an 8-step "clock" on Day 1 with cadence touches (e.g. day 1, 3, 6, 10, 14, 21, 30, 45).
- "Lead indicators" are actions the user takes (conversations, follow-throughs). "Lag indicators" are results (referrals received, deals won). Coach toward more lead, but celebrate lag.
- FORM = Family, Occupation, Recreation, Motivation. It is the structure for any real 1-on-1 conversation. Never pitch in a FORM.
- A "wasted handshake" is a contact who got no follow-through within 48 hours of meeting them. The whole product exists to prevent this.
- The SWH "Default 8-Step" is: 1) Good to Meet You Message, 2) Social Connection, 3) Value Touch No Ask, 4) Invite to 1:1, 5) FORM Conversation, 6) Strategic Follow Through, 7) Stay Top of Mind, 8) Long-Term Positioning.

CRITICAL language rule — "follow through" vs "follow up":
- The SWH philosophy is FOLLOW THROUGH, not FOLLOW UP. This is THE core distinction the platform is built on.
- "Follow up" is transactional, reactive, one-and-done. Sales reps "follow up."
- "Follow through" is intentional, strategic, sustained. Real networkers "follow through."
- Always say "follow through" / "following through" in your own replies. Never "follow up" / "following up."
- When the user says "follow up" or "following up," gently course-correct them ONCE per conversation. Light touch, not preachy. Something like: "Quick reframe — we're not following up here, we're following through. Follow-up is a sales move. Follow-through is a relationship move. Same calendar entry, very different mindset." Then answer their actual question. Don't repeat the correction every message — once is enough; just keep using the right phrase yourself after that and it'll stick.

CRITICAL formatting rule — sendable message markers:
- When you draft a message the user will SEND VERBATIM to a contact (an email, a text, a LinkedIn DM, a handwritten note, etc.), wrap the sendable content in <<<COPY>>> and <<<ENDCOPY>>> markers.
- The user has a one-tap Copy button below your reply. The button pulls only what's between the markers — NOT your preamble or trailing commentary.
- Example of correct format:

  Here's a quick one for Sarah:

  <<<COPY>>>
  Hi Sarah,

  Great running into you at the BNI mixer this morning. I'd love to grab coffee next week and hear more about how your move into commercial real estate is going. Are you free Wednesday or Thursday morning?

  Austen
  <<<ENDCOPY>>>

  Want me to adjust the tone or shorten it?

- Use markers EVERY TIME you draft something sendable. Not for general chat, coaching answers, brief summaries, or playbook proposals (those have their own JSON path).
- DO NOT include subject lines unless explicitly asked for an email subject.
- DO NOT include the user's signature block (name, title, contact info) — they'll add their own. Just sign off with their first name if it feels natural.
- Inside the markers, write the message as-if you ARE the user. First-person. Their voice.

When building a playbook:
- Always return exactly 8 steps.
- Day offsets should be reasonable for the relationship type. Faster cadence for hot opportunities (e.g. 1, 2, 4, 7, 10, 14, 21, 30). Slower for VIP / past-client / long-game (e.g. 1, 14, 30, 60, 90, 120, 180, 365).
- Each step has a name (4-7 words), a description (1-2 sentences, action-oriented, no fluff), an icon (single emoji), and points. Assign points by matching the step to the closest Log Activity:
  - Initial message / "Good to meet you" outreach: 5 pts
  - FORM conversation (the actual 1-on-1 where you do FORM): 5 pts
  - Phone call or text-based check-in: 5 pts
  - Attending a physical or virtual 1:1, coffee, or lunch: 10 pts
  - Making an introduction: 10 pts
  - Giving a referral: 10 pts
  - Everything else (social media connects, newsletter invites, resource shares, event invitations, check-in messages, follow-through messages that don't fit above): 1 pt ("Perform Other 8 Step Activities")
- Step descriptions should be specific, not generic. "Send a quick text" is bad. "Text them a one-liner referencing where you met, no pitch" is good.

When writing a step message:
- Match the user's voice (informal, professional, etc.) inferable from any sample notes given.
- Keep it under 4 sentences for texts, under 1 short paragraph for email.
- Always reference something specific from the context (their company, what they mentioned, where you met).
- Include an ask or business content only when the step explicitly calls for one; otherwise keep it purely relational. Never write disclaimers like "no pitch" or "no agenda" into the message itself.`;

const LOLA_BUILD_PLAYBOOK_INSTRUCTIONS = `Build an 8-step follow-through playbook for the relationship type the user describes.

You may ask ONE clarifying question if you have zero context about the relationship type. The moment the user provides any description (even brief, like "networking event" or "past client"), build the playbook immediately. Do NOT ask follow-up questions about specific people, their names, or their company. Those details belong in the contact record, not the playbook.

Return your answer in this JSON shape (and ONLY this JSON, no surrounding prose, no markdown fences):

{
  "name": "<6 words or fewer, title case>",
  "description": "<1 sentence explaining when to use this playbook>",
  "icon": "<single emoji>",
  "steps": [
    { "name": "<4-7 words>", "description": "<1-2 sentences, specific and actionable>", "offsetDays": <int>, "points": <1|5|10 — see points mapping>, "icon": "<single emoji>" },
    ... 8 total
  ],
  "intro": "<1-2 sentences to the user explaining the cadence you chose and why. No 'Here is your playbook' filler. Talk like a coach.>"
}

Constraints:
- Exactly 8 steps.
- offsetDays must be strictly increasing (each step happens later than the previous).
- offsetDays[0] should be 1 unless the relationship type strongly suggests otherwise (e.g., VIP long-game might start at day 3 or 7).
- Use emoji icons that match the step's action.
- Points: use the activity mapping (defined in the system prompt). Initial outreach / "good to meet you" message = 5. FORM conversation = 5. Phone/text check-in = 5. In-person or virtual 1:1 / coffee / lunch = 10. Making an introduction = 10. Giving a referral = 10. Everything else = 1.`;

const LOLA_DAILY_BRIEF_INSTRUCTIONS = `Look at the user's overdue follow-throughs (provided in context.overdue). Return a JSON object:

{
  "text": "<conversational morning brief, 3-5 sentences. Lead with the most important thing. Mention specific contacts by name. End with the single most important action they should take next.>"
}

Do NOT return a numbered list. Talk like a sharp executive assistant briefing them over coffee. Reference at most 3 contacts by name. If they have zero overdue, give them a positive nudge to add 1 new touch today.`;

const LOLA_WRITE_STEP_INSTRUCTIONS = `Draft an outreach message for the user to send. Return ONLY valid JSON, no prose, no markdown fences:

{
  "subject": "<email subject line, 5-10 words, warm and specific, no em-dashes>",
  "body": "<the full message body, ready to send. First-person as the user. Reference the contact by first name. Specific and warm, no pitch. No subject line at the top. No em-dashes. No placeholder text in brackets.>",
  "text": "<same as body, included for backward compatibility>"
}

Match the user's voice. Reference specific context from the step and contact notes. Keep it concise. No em-dashes anywhere.`;

// ============================================================
// loadLolaCrmContext — gives Lola visibility into the user's CRM
// ============================================================
// Reads contacts, opportunities, and recent days for the user via the
// Admin SDK (Firestore rules don't apply on the server side). Computes
// analytics fields so Lola can answer questions like:
//   - "What relationships have stalled?"
//   - "Which A+ partners haven't I touched in a month?"
//   - "What's in my pipeline?"
//   - "Show me my wasted handshakes."
//
// Returns a structured JSON object that gets injected into the user
// message. We trim PII (phone/email) and notes (truncate) to keep prompt
// size manageable and to avoid leaking sensitive contact data through
// Anthropic's logs.
// ============================================================
async function loadLolaCrmContext(uid) {
  const dayMs = 86400000;
  const now = Date.now();
  const todayKey = new Date().toISOString().slice(0, 10);

  // Load all of the user's contacts + opps + recent days in parallel
  const [contactsSnap, oppsSnap, daysSnap, playbooksSnap, userSnap] = await Promise.all([
    admin.firestore().collection(`users/${uid}/contacts`).get(),
    admin.firestore().collection(`users/${uid}/opportunities`).get(),
    admin.firestore().collection(`users/${uid}/days`).orderBy('dateKey', 'desc').limit(30).get(),
    admin.firestore().collection(`users/${uid}/playbooks`).get(),
    admin.firestore().doc(`users/${uid}`).get(),
  ]);

  // Build playbook id → step-name lookup so we can label "currentStep"
  const playbooks = {};
  playbooksSnap.docs.forEach(d => {
    const pb = d.data();
    playbooks[d.id] = {
      name: pb.name || 'Default',
      steps: (pb.steps || []).map(s => s.name || '?'),
    };
  });
  const defaultPbId = playbooksSnap.docs.find(d => d.data().isDefault)?.id || playbooksSnap.docs[0]?.id;

  // Analyze each contact, attaching computed "isStalled" / "isWasted" /
  // "daysSinceTouch" fields so Lola doesn't have to compute these itself.
  const contacts = contactsSnap.docs.map(d => {
    const c = d.data();
    const addedAt = c.addedAt ? new Date(c.addedAt).getTime() : null;
    const lastActivity = c.lastActivityAt ? new Date(c.lastActivityAt).getTime() : addedAt;
    const daysSinceTouch = lastActivity ? Math.floor((now - lastActivity) / dayMs) : null;
    const daysSinceAdded = addedAt ? Math.floor((now - addedAt) / dayMs) : null;
    const clockStarted = !!c.clockStarted;
    const stepsCompleted = c.steps || 0;
    // Stalled = clock started, not finished, and >14 days since last touch
    const isStalled = clockStarted && stepsCompleted < 8 && (daysSinceTouch !== null && daysSinceTouch > 14);
    // Wasted = clock never started AND >2 days since added; OR no touch >21d
    const isWasted = (!clockStarted && (daysSinceAdded || 0) > 2)
      || (daysSinceTouch !== null && daysSinceTouch > 21);
    const pbInfo = playbooks[c.playbookId] || playbooks[defaultPbId] || { name: 'Default', steps: [] };
    return {
      id: d.id,
      name: c.name || '',
      company: c.company || '',
      status: c.status || 'new',
      event: c.event || '',
      playbook: pbInfo.name,
      stepsCompleted,
      currentStepName: stepsCompleted < 8 ? (pbInfo.steps[stepsCompleted] || `Step ${stepsCompleted+1}`) : 'Completed all 8',
      clockStarted,
      daysSinceAdded,
      daysSinceTouch,
      isStalled,
      isWasted,
      notesPreview: (c.notes || '').slice(0, 140),
    };
  });

  // Opportunities (trim to essentials)
  const opps = oppsSnap.docs.map(d => {
    const o = d.data();
    const lastActivity = o.lastActivityAt ? new Date(o.lastActivityAt).getTime() : null;
    return {
      contact: o.contactName || '',
      stage: o.stage || 'New',
      value: parseFloat(o.value) || 0,
      event: o.event || '',
      daysSinceTouch: lastActivity ? Math.floor((now - lastActivity) / dayMs) : null,
    };
  });

  // Recent activity totals — current calendar week (Mon–today, leadPts only, matches dashboard)
  // plus rolling windows for trend context.
  const days = daysSnap.docs.map(d => d.data());
  // Monday of current week
  const todayDate = new Date(todayKey + 'T12:00:00');
  const dayOfWeek = todayDate.getDay(); // 0=Sun
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monDate = new Date(todayDate);
  monDate.setDate(monDate.getDate() + daysToMonday);
  const weekStartKey = monDate.toISOString().slice(0, 10);
  const currentWeek = days.filter(d => d.dateKey && d.dateKey >= weekStartKey && d.dateKey <= todayKey);
  const last7 = days.filter(d => {
    if (!d.dateKey) return false;
    const ageDays = Math.floor((now - new Date(d.dateKey + 'T12:00:00').getTime()) / dayMs);
    return ageDays >= 0 && ageDays < 7;
  });
  const last30 = days.filter(d => {
    if (!d.dateKey) return false;
    const ageDays = Math.floor((now - new Date(d.dateKey + 'T12:00:00').getTime()) / dayMs);
    return ageDays >= 0 && ageDays < 30;
  });
  const sum = (arr, key) => arr.reduce((s, d) => s + (d[key] || 0), 0);

  // Build top-N summaries to keep the prompt bounded even for large CRMs.
  // Sort each by "most relevant for that bucket."
  const STATUS_PRIORITY = { aplus: 0, a: 1, b: 2, c: 3, d: 4, new: 5 };
  const byStatus = (a, b) => (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9);
  const stalled = contacts.filter(c => c.isStalled).sort(byStatus).slice(0, 25);
  const wasted  = contacts.filter(c => c.isWasted).sort(byStatus).slice(0, 25);
  const aplusContacts = contacts.filter(c => c.status === 'aplus').sort((a,b) => (b.daysSinceTouch||0) - (a.daysSinceTouch||0)).slice(0, 25);
  const noClockYet = contacts.filter(c => !c.clockStarted).sort(byStatus).slice(0, 25);
  const recentlyAdded = contacts.filter(c => (c.daysSinceAdded ?? 999) < 14).sort((a,b) => (a.daysSinceAdded||0) - (b.daysSinceAdded||0)).slice(0, 15);

  // Pipeline aggregates
  const pipelineByStage = {};
  opps.forEach(o => {
    if (!pipelineByStage[o.stage]) pipelineByStage[o.stage] = { count: 0, value: 0 };
    pipelineByStage[o.stage].count++;
    pipelineByStage[o.stage].value += o.value;
  });

  const user = userSnap.exists ? userSnap.data() : {};
  return {
    user: {
      firstName: (user.displayName || '').split(' ')[0] || '',
      weeklyGoal: user.weeklyGoal || 150,
    },
    activity: {
      weekPts: sum(currentWeek, 'leadPts'),
      weekGoal: user.weeklyGoal || 200,
      weekActiveDays: currentWeek.length,
      pts7d: sum(last7, 'totalPts'),
      leadPts7d: sum(last7, 'leadPts'),
      lagPts7d: sum(last7, 'lagPts'),
      pts30d: sum(last30, 'totalPts'),
      activeDays7d: last7.length,
      activeDays30d: last30.length,
    },
    totals: {
      contacts: contacts.length,
      aplus: contacts.filter(c => c.status === 'aplus').length,
      a: contacts.filter(c => c.status === 'a').length,
      b: contacts.filter(c => c.status === 'b').length,
      d: contacts.filter(c => c.status === 'd').length,
      new: contacts.filter(c => c.status === 'new').length,
      withClockStarted: contacts.filter(c => c.clockStarted).length,
      completedAll8: contacts.filter(c => c.stepsCompleted >= 8).length,
      stalled: contacts.filter(c => c.isStalled).length,
      wasted: contacts.filter(c => c.isWasted).length,
    },
    stalled,
    wasted,
    aplusContacts,
    noClockYet,
    recentlyAdded,
    pipeline: {
      total: opps.length,
      byStage: pipelineByStage,
      sampleWon: opps.filter(o => o.stage === 'Won').slice(0, 10),
      stalled: opps.filter(o => o.daysSinceTouch !== null && o.daysSinceTouch > 14).slice(0, 15),
    },
    playbooks: Object.entries(playbooks).map(([id, p]) => ({ id, name: p.name, isDefault: id === defaultPbId })),
    notes: {
      todayKey,
      generatedAt: new Date().toISOString(),
    },
  };
}

exports.lolaSwhAssistant = onRequest({
  cors: true,
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 30,
  memory: '512MiB',
}, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const { mode, prompt, context, history } = req.body || {};
    if (!mode) throw Object.assign(new Error('mode is required'), { statusCode: 400 });

    // Plan gate — Lola is included with CRM Pro only
    const userSnap = await admin.firestore().doc(`users/${uid}`).get();
    const userPlan = userSnap.exists ? (userSnap.data().plan || 'demo') : 'demo';
    // Team membership also grants Pro entitlement, mirror getMe logic
    let effectivePlan = userPlan;
    if (effectivePlan !== 'pro') {
      const teamId = userSnap.exists ? userSnap.data().teamId : null;
      if (teamId) {
        const teamSnap = await admin.firestore().doc(`teams/${teamId}`).get();
        if (teamSnap.exists && teamSnap.data().plan === 'team_crm') effectivePlan = 'pro';
      }
    }
    if (effectivePlan !== 'pro') {
      return res.status(402).json({ error: 'Lola requires Scorecard CRM ($25/mo) or Team CRM.' });
    }

    // For modes that need visibility into the user's actual CRM data
    // (freeform chat questions like "what's stalled" and the daily brief),
    // load contacts + opportunities + recent activity from Firestore and
    // attach a structured summary. build_playbook and write_step don't
    // need this (they're either generative or already have step-level
    // context passed from the client), so we skip the read to save latency
    // and tokens.
    let crmContext = null;
    if (mode === 'freeform' || mode === 'daily_brief' || !mode) {
      try {
        crmContext = await loadLolaCrmContext(uid);
      } catch (e) {
        console.warn('[lolaSwhAssistant] CRM context load failed (continuing without):', e.message);
      }
    }

    // Compose user message + extra instructions based on mode
    let userMessage = prompt || '';
    let modeInstructions = '';
    if (mode === 'build_playbook') {
      modeInstructions = LOLA_BUILD_PLAYBOOK_INSTRUCTIONS;
      if (!userMessage) userMessage = 'Build me a default networking playbook.';
    } else if (mode === 'daily_brief') {
      modeInstructions = LOLA_DAILY_BRIEF_INSTRUCTIONS;
      // Prefer the rich server-loaded context over the client-side payload.
      if (crmContext) {
        userMessage = `Here is the user's full CRM snapshot:\n\n${JSON.stringify(crmContext, null, 2)}\n\nGive them their morning brief based on this data. Lead with the most important thing they should know.`;
      } else {
        const overdue = (context?.overdue) || [];
        userMessage = `Here are my overdue follow-throughs:\n\n${JSON.stringify(overdue, null, 2)}\n\nGive me my morning brief.`;
      }
    } else if (mode === 'write_step') {
      modeInstructions = LOLA_WRITE_STEP_INSTRUCTIONS;
      userMessage = `Context: ${JSON.stringify(context || {}, null, 2)}\n\nUser request: ${prompt || 'Write the message for me.'}`;
    } else {
      // freeform — conversational chat with CRM context attached so Lola
      // can answer questions like "what relationships have stalled?"
      modeInstructions = `Respond conversationally as Lola. No JSON, just plain text. Keep responses tight (3-6 sentences unless they ask for more).

You have READ-ONLY access to the user's CRM data via the JSON snapshot below. When they ask about specific contacts, stalled relationships, wasted handshakes, pipeline, or weekly activity, USE THIS DATA. Reference contacts by name. Cite specific days-since-touch numbers. Don't say "I don't have access" because you do.

IMPORTANT — keep these two groups distinct and never mix them up:
- "noClockYet" contacts = people who have NEVER had the 8-step campaign started. These are the candidates when the user asks who to START the 8-step follow-through process with.
- "stalled" contacts = people whose 8-step campaign is already running but they've fallen behind. These are NOT new-campaign candidates.

If they ask who to start the 8-step follow-through with, look at "noClockYet" and "recentlyAdded" contacts — not stalled ones.
If they ask what to do today or who needs attention, prioritize: A+ partners with high days-since-touch, then stalled campaigns, then wasted handshakes.
If they ask for a recommendation, give a specific one with a named contact when possible.

When listing contacts, use this format (no bullet markers, just lines):
  Sarah Johnson (A+ partner, Acme Co) — 23 days since last touch, stalled on Step 3
  Mike Park (A partner) — no campaign started, added 5 days ago`;
      if (crmContext) {
        userMessage = `Here is my current CRM snapshot:\n\n${JSON.stringify(crmContext, null, 2)}\n\nMy question: ${prompt || ''}`;
      }
    }

    const fullSystemPrompt = LOLA_SYSTEM_PROMPT + '\n\n' + modeInstructions;

    const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY.value(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 1500,
        system: fullSystemPrompt,
        messages: [
          ...(Array.isArray(history) ? history : []).slice(-8).map(h => ({
            role: h.role === 'assistant' ? 'assistant' : 'user',
            content: String(h.content || ''),
          })).filter(h => h.content),
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      console.error('[lolaSwhAssistant] Anthropic API error:', apiResp.status, errText);
      return res.status(502).json({ error: 'Lola is having trouble right now. Try again in a moment.' });
    }

    const result = await apiResp.json();
    const rawText = result.content?.[0]?.text || '';

    // Parse the response based on mode
    if (mode === 'build_playbook') {
      // Strip markdown code fences, then extract the JSON object even if
      // Claude added preamble prose like "Got it. Here's the playbook:".
      const stripped = rawText.replace(/```json|```/g, '');
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      let proposal;
      try {
        if (!jsonMatch) throw new Error('No JSON object found');
        proposal = JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.error('[lolaSwhAssistant] Failed to parse playbook JSON:', stripped);
        return res.json({ text: rawText, proposal: null });
      }
      const introText = proposal.intro || `Here's a draft for "${proposal.name}". Edit anything before saving.`;
      const playbookProposal = {
        name: proposal.name,
        description: proposal.description,
        icon: proposal.icon || '📋',
        steps: (proposal.steps || []).slice(0, 8).map(s => ({
          name: s.name || '',
          description: s.description || '',
          offsetDays: parseInt(s.offsetDays, 10) || 1,
          points: parseInt(s.points, 10) || 5,
          icon: s.icon || '⭐',
        })),
      };
      // Track usage in user doc for cost monitoring
      try {
        await admin.firestore().doc(`users/${uid}`).set({
          lolaUsage: admin.firestore.FieldValue.increment(1),
          lolaLastUsedAt: new Date().toISOString(),
        }, { merge: true });
      } catch (_) {}
      return res.json({ text: introText, proposal: playbookProposal });
    }

    if (mode === 'daily_brief' || mode === 'write_step') {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      try {
        const parsed = JSON.parse(cleaned);
        return res.json({ text: parsed.text || rawText });
      } catch (_) {
        // Not JSON, just return raw text
        return res.json({ text: rawText });
      }
    }

    // freeform
    return res.json({ text: rawText });

  } catch (e) {
    console.error('[lolaSwhAssistant]', e);
    sendErr(res, e);
  }
});

// ============================================================
// EMAIL INTEGRATION — Gmail OAuth + sync (May 2026)
// ============================================================
// Layered architecture:
//
//   1. OAuth flow:
//        gmailOauthInitiate → returns Google consent URL with signed state
//        gmailOauthCallback → handles redirect, exchanges code for tokens,
//                             stores in users/{uid}/integrations/gmail
//
//   2. Sync engine:
//        gmailInitialSync → on-demand 90-day backfill (called after connect)
//        gmailScheduledSync → every 15 min, picks up new mail via historyId
//        gmailDisconnect → revoke + delete integration doc (keeps email
//                          records — those are the user's data)
//
//   3. Data model:
//        /users/{uid}/integrations/gmail
//          { connectedEmail, accessToken, refreshToken, accessTokenExpiresAt,
//            scopes, lastSyncAt, lastHistoryId, initialBackfillDoneAt, status }
//        /users/{uid}/contacts/{contactId}/emails/{messageId}
//          { direction: 'sent'|'received', sentAt, subject, snippet, fromEmail,
//            toEmails: [], threadId, source: 'gmail', syncedAt }
//
//   4. Contact matching:
//        Normalize emails (lowercase, strip +tags). For each message, look up
//        the OTHER party's email in the user's contacts. Sent → match To/Cc.
//        Received → match From. Multi-recipient sent emails log under EACH
//        matched contact (one message can update many contacts).
//
//   5. Idempotency:
//        Emails written keyed by Gmail messageId. Re-syncing is a no-op for
//        already-synced messages.
//
// ============================================================
// Bundled email + calendar scope. gmail.metadata = read email headers
// (no body) for auto-logging email touches. calendar.events = write events
// to user's primary calendar for 8-step follow-through sync. One Connect
// flow grants both features — see runContactCalendarSync below.
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.metadata',
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
  'profile',
].join(' ');
const GMAIL_OAUTH_REDIRECT = 'https://us-central1-swh-scoreboard.cloudfunctions.net/gmailOauthCallback';
const GMAIL_BACKFILL_DAYS = 90;

// ── HMAC-signed state token (CSRF + uid binding) ──
const crypto = require('crypto');
function signOauthState(uid, secret) {
  const payload = JSON.stringify({ uid, ts: Date.now(), nonce: crypto.randomBytes(8).toString('hex') });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}
function verifyOauthState(state, secret) {
  if (!state || typeof state !== 'string') throw new Error('Missing state');
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) throw new Error('Malformed state');
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  if (sig !== expected) throw new Error('State signature mismatch');
  const parsed = JSON.parse(payload);
  // 30-minute window — OAuth round-trips are usually <1 min
  if (Date.now() - parsed.ts > 30 * 60 * 1000) throw new Error('State expired');
  return parsed; // { uid, ts, nonce }
}

// ── Email normalization for contact matching ──
function normalizeEmail(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim().toLowerCase();
  // Extract just the address from "Name <addr@x>" forms
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = angle ? angle[1] : trimmed;
  // Strip +tags (gmail: foo+anything@gmail.com → foo@gmail.com)
  const [local, domain] = addr.split('@');
  if (!local || !domain) return addr;
  const cleanLocal = local.split('+')[0];
  return `${cleanLocal}@${domain}`;
}
function extractEmails(headerValue) {
  if (!headerValue) return [];
  // Split by comma, then normalize each
  return String(headerValue).split(',').map(s => normalizeEmail(s)).filter(Boolean);
}

// ── Build a "normalized email → contact docs" map for matching ──
async function buildContactEmailIndex(uid) {
  const snap = await db.collection(`users/${uid}/contacts`).get();
  const idx = {};
  snap.docs.forEach(d => {
    const c = d.data();
    if (!c.email) return;
    const norm = normalizeEmail(c.email);
    if (!norm) return;
    if (!idx[norm]) idx[norm] = [];
    idx[norm].push({ id: d.id, name: c.name || '' });
  });
  return idx;
}

// ── Token refresh helper ──
async function ensureFreshGmailToken(uid, integration, clientId, clientSecret) {
  const now = Date.now();
  const expiresAt = integration.accessTokenExpiresAt || 0;
  // Refresh 60s before expiry to avoid race
  if (integration.accessToken && expiresAt > now + 60_000) {
    return integration.accessToken;
  }
  if (!integration.refreshToken) {
    throw new Error('No refresh token on record — user must reconnect Gmail');
  }
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: integration.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error('[gmail] token refresh failed:', resp.status, errText);
    throw new Error('Gmail token refresh failed');
  }
  const data = await resp.json();
  const newAccessToken = data.access_token;
  const newExpiresAt = now + (data.expires_in || 3600) * 1000;
  await db.doc(`users/${uid}/integrations/gmail`).update({
    accessToken: newAccessToken,
    accessTokenExpiresAt: newExpiresAt,
  });
  return newAccessToken;
}

// ── Decode Gmail's URL-safe base64 (used in body bodies + snippets) ──
function decodeB64Url(s) {
  if (!s) return '';
  try {
    const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

// ── Gmail API helpers ──
async function gmailListMessageIds(accessToken, queryParams) {
  // queryParams: { labelIds: 'INBOX'|'SENT', maxResults, pageToken }
  // IMPORTANT: with gmail.metadata scope, the `q` parameter is NOT permitted.
  // We page by label and filter by internalDate per-message in the caller.
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  Object.entries(queryParams).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, v);
  });
  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Gmail list failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}
async function gmailGetMessage(accessToken, messageId) {
  // format=metadata pulls headers + snippet only (no body bytes — faster + tiny)
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`;
  const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error(`Gmail get failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}
function parseGmailMessage(msg) {
  const headers = msg.payload?.headers || [];
  const headerMap = {};
  headers.forEach(h => { headerMap[h.name.toLowerCase()] = h.value; });
  const labelIds = msg.labelIds || [];
  const direction = labelIds.includes('SENT') ? 'sent' : 'received';
  // sentAt: prefer internalDate (ms epoch from Gmail), fall back to Date header
  let sentAtMs = msg.internalDate ? parseInt(msg.internalDate, 10) : null;
  if (!sentAtMs && headerMap.date) {
    const parsed = Date.parse(headerMap.date);
    if (!isNaN(parsed)) sentAtMs = parsed;
  }
  return {
    messageId: msg.id,
    threadId: msg.threadId,
    direction,
    subject: headerMap.subject || '(no subject)',
    snippet: msg.snippet || '',
    fromEmail: normalizeEmail(headerMap.from || ''),
    toEmails: extractEmails(headerMap.to),
    ccEmails: extractEmails(headerMap.cc),
    sentAt: sentAtMs ? new Date(sentAtMs).toISOString() : new Date().toISOString(),
    labelIds,
  };
}

// ── Write parsed message to matched contacts' email subcollections ──
async function writeMessageToContacts(uid, parsed, contactIndex) {
  // Determine the "other party" emails to match against:
  //   sent → matches toEmails + ccEmails
  //   received → matches fromEmail
  const targets = parsed.direction === 'sent'
    ? [...parsed.toEmails, ...parsed.ccEmails]
    : (parsed.fromEmail ? [parsed.fromEmail] : []);
  const matched = new Set();
  for (const email of targets) {
    const hits = contactIndex[email] || [];
    hits.forEach(c => matched.add(c.id));
  }
  if (matched.size === 0) return { matched: 0 };
  // Write the message under each matched contact's emails subcoll (idempotent key = messageId)
  const batch = db.batch();
  const emailDoc = {
    direction: parsed.direction,
    sentAt: parsed.sentAt,
    subject: parsed.subject,
    snippet: parsed.snippet,
    fromEmail: parsed.fromEmail,
    toEmails: parsed.toEmails,
    ccEmails: parsed.ccEmails,
    threadId: parsed.threadId,
    source: 'gmail',
    syncedAt: new Date().toISOString(),
  };
  matched.forEach(contactId => {
    const ref = db.doc(`users/${uid}/contacts/${contactId}/emails/${parsed.messageId}`);
    batch.set(ref, emailDoc, { merge: true });
    // Bump lastActivityAt on the contact so wasted-handshake detection picks it up
    batch.update(db.doc(`users/${uid}/contacts/${contactId}`), {
      lastActivityAt: parsed.sentAt,
    });
  });
  await batch.commit();
  return { matched: matched.size };
}

// ── Endpoint: kick off Gmail OAuth ──
exports.gmailOauthInitiate = onRequest({
  cors: true,
  secrets: [GOOGLE_OAUTH_CLIENT_ID, OAUTH_STATE_SECRET],
}, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    const state = signOauthState(decoded.uid, OAUTH_STATE_SECRET.value());
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', GOOGLE_OAUTH_CLIENT_ID.value());
    url.searchParams.set('redirect_uri', GMAIL_OAUTH_REDIRECT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_OAUTH_SCOPES);
    url.searchParams.set('access_type', 'offline');     // need refresh token
    url.searchParams.set('prompt', 'consent');          // always re-prompt so we get refresh token
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    res.json({ authUrl: url.toString() });
  } catch (e) {
    console.error('[gmailOauthInitiate]', e);
    sendErr(res, e);
  }
});

// ── Endpoint: Google redirects here with ?code=...&state=... ──
exports.gmailOauthCallback = onRequest({
  secrets: [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, OAUTH_STATE_SECRET],
}, async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) {
      res.status(400).send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center;background:#0f1117;color:#fff;"><h1>Gmail connect failed</h1><p>${escapeHtml(String(error))}</p><a href="https://swh-crm.web.app" style="color:#A78BFA;">← Back to SWH</a></body>`);
      return;
    }
    if (!code) {
      // No code + no error means someone landed here directly without
      // going through Google's consent flow. Most common cause: testing
      // the callback URL in a browser. Render a useful explanation page
      // instead of the unhelpful "Missing code" string.
      res.status(400).send(`<!doctype html>
<meta charset="utf-8">
<title>SWH Gmail callback</title>
<body style="font-family:'DM Sans',-apple-system,sans-serif;background:#0f1117;color:#fff;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:24px;">
  <div style="max-width:520px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:18px;padding:32px;line-height:1.6;">
    <div style="width:48px;height:48px;border-radius:50%;background:radial-gradient(circle at 32% 30%,#A78BFA 0%,#5B5BD6 55%,#1E3A8A 100%);margin-bottom:18px;"></div>
    <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:24px;font-weight:900;margin:0 0 12px;">This page isn't a destination</h1>
    <p style="color:rgba(255,255,255,0.75);font-size:14px;margin:0 0 18px;">
      You landed on the Gmail OAuth callback URL directly. This URL only does something useful when Google redirects you back here after a successful consent, with an authorization <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:5px;font-size:13px;">code</code> attached.
    </p>
    <p style="color:rgba(255,255,255,0.65);font-size:13px;margin:0 0 20px;">
      To actually connect Gmail, go to <strong>SWH Settings → Email Integrations → Gmail</strong> and click "Connect to auto-log emails."
    </p>
    <div style="background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.22);border-radius:12px;padding:14px;font-size:12px;color:rgba(255,255,255,0.65);margin-bottom:20px;line-height:1.55;">
      <strong style="color:#C4B5FD;display:block;margin-bottom:6px;">If you got here from clicking Connect Gmail</strong>
      The OAuth client probably isn't fully configured. Common causes:
      <ul style="margin:8px 0 0 18px;padding:0;">
        <li>Real Google Cloud OAuth client ID + secret not pushed to Firebase secrets yet</li>
        <li>Redirect URI in Google Cloud Console doesn't exactly match this page's URL</li>
        <li>Gmail API not enabled in the swh-scoreboard project</li>
        <li>OAuth consent screen still in "draft" state, or your email isn't on the Test Users list</li>
      </ul>
    </div>
    <a href="https://swh-crm.web.app" style="display:inline-block;background:linear-gradient(135deg,#5B5BD6,#A78BFA);color:#fff;padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:700;font-size:14px;">← Back to SWH</a>
  </div>
</body>`);
      return;
    }
    const parsedState = verifyOauthState(String(state), OAUTH_STATE_SECRET.value());
    const uid = parsedState.uid;
    // Exchange code for tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_OAUTH_CLIENT_ID.value(),
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET.value(),
        redirect_uri: GMAIL_OAUTH_REDIRECT,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error('[gmailOauthCallback] token exchange failed:', tokenResp.status, errText);
      throw new Error('Token exchange failed');
    }
    const tokens = await tokenResp.json();
    // Get the connected email address
    const profileResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    const profile = profileResp.ok ? await profileResp.json() : {};
    const connectedEmail = profile.email || '';
    // Store in /users/{uid}/integrations/gmail
    const now = Date.now();
    await db.doc(`users/${uid}/integrations/gmail`).set({
      provider: 'gmail',
      connectedEmail,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      accessTokenExpiresAt: now + (tokens.expires_in || 3600) * 1000,
      scopes: tokens.scope || GOOGLE_OAUTH_SCOPES,
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
      lastHistoryId: null,
      initialBackfillDoneAt: null,
      status: 'connected',
    }, { merge: true });
    // Trigger initial backfill in the background (fire and forget — UI polls status)
    // The backfill function is invoked via internal call to keep this callback fast.
    runGmailInitialBackfill(uid).catch(e => console.error('[gmail] initial backfill failed:', e));
    // Redirect back to CRM with success flag in the URL hash
    res.redirect(`https://swh-crm.web.app/?gmail=connected`);
  } catch (e) {
    console.error('[gmailOauthCallback]', e);
    res.status(500).send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center;background:#0f1117;color:#fff;"><h1>Gmail connect failed</h1><p>${escapeHtml(e.message)}</p><a href="https://swh-crm.web.app" style="color:#A78BFA;">← Back to SWH</a></body>`);
  }
});

function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ── Initial 90-day backfill (called once after connect) ──
async function runGmailInitialBackfill(uid) {
  const integrationSnap = await db.doc(`users/${uid}/integrations/gmail`).get();
  if (!integrationSnap.exists) throw new Error('No Gmail integration');
  const integration = integrationSnap.data();
  await db.doc(`users/${uid}/integrations/gmail`).update({ status: 'syncing' });
  try {
    const accessToken = await ensureFreshGmailToken(
      uid, integration,
      GOOGLE_OAUTH_CLIENT_ID.value(), GOOGLE_OAUTH_CLIENT_SECRET.value()
    );
    const contactIndex = await buildContactEmailIndex(uid);
    // Don't bother pulling messages if user has no contacts with emails
    const hasEmailContacts = Object.keys(contactIndex).length > 0;
    if (!hasEmailContacts) {
      await db.doc(`users/${uid}/integrations/gmail`).update({
        status: 'connected',
        initialBackfillDoneAt: new Date().toISOString(),
        lastSyncAt: new Date().toISOString(),
        backfillStats: { matched: 0, scanned: 0, note: 'No contacts with email addresses yet' },
      });
      return;
    }
    let totalScanned = 0, totalMatched = 0, totalWritten = 0;
    // gmail.metadata scope forbids the `q=newer_than:Xd` filter. Instead we
    // walk messages newest-first by label and stop once internalDate falls
    // below the cutoff. Gmail returns messages in reverse-chrono order, so
    // this terminates fast even on large mailboxes.
    const cutoffMs = Date.now() - GMAIL_BACKFILL_DAYS * 86400000;
    for (const labelId of ['SENT', 'INBOX']) {
      let pageToken = null;
      let stopThisLabel = false;
      do {
        const listResp = await gmailListMessageIds(accessToken, {
          labelIds: labelId,
          maxResults: 100,
          pageToken,
        });
        const messages = listResp.messages || [];
        for (const m of messages) {
          totalScanned++;
          try {
            const full = await gmailGetMessage(accessToken, m.id);
            const internalDateMs = parseInt(full.internalDate || '0', 10);
            // Hit the age cutoff — newer-first order means everything past
            // this point is older, so bail out of the whole label.
            if (internalDateMs && internalDateMs < cutoffMs) {
              stopThisLabel = true;
              break;
            }
            const parsed = parseGmailMessage(full);
            const { matched } = await writeMessageToContacts(uid, parsed, contactIndex);
            if (matched > 0) { totalMatched++; totalWritten += matched; }
          } catch (e) {
            console.warn('[gmail backfill] message error:', m.id, e.message);
          }
        }
        if (stopThisLabel) break;
        pageToken = listResp.nextPageToken || null;
        // Hard cap on total messages scanned to bound cost on huge mailboxes
        if (totalScanned >= 2000) { pageToken = null; break; }
      } while (pageToken);
    }
    // Also fetch the most recent historyId so the scheduled sync can pick up incrementally
    let lastHistoryId = null;
    try {
      const profileResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (profileResp.ok) {
        const profile = await profileResp.json();
        lastHistoryId = profile.historyId || null;
      }
    } catch (_) {}
    await db.doc(`users/${uid}/integrations/gmail`).update({
      status: 'connected',
      initialBackfillDoneAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      lastHistoryId,
      backfillStats: {
        scanned: totalScanned,
        matchedMessages: totalMatched,
        writtenLogs: totalWritten,
      },
    });
    console.log(`[gmail] backfill complete for ${uid}: scanned=${totalScanned} matched=${totalMatched}`);
  } catch (e) {
    await db.doc(`users/${uid}/integrations/gmail`).update({
      status: 'error',
      lastError: e.message,
      lastErrorAt: new Date().toISOString(),
    });
    throw e;
  }
}

// ── Endpoint: manually re-run backfill ──
exports.gmailRunBackfill = onRequest({
  cors: true,
  secrets: [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET],
  timeoutSeconds: 540,
  memory: '512MiB',
}, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    runGmailInitialBackfill(decoded.uid).catch(e => console.error('[gmail backfill]', e));
    res.json({ ok: true, message: 'Backfill running in background' });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Endpoint: get integration status (for the Settings UI to poll) ──
exports.gmailStatus = onRequest({ cors: true }, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    const snap = await db.doc(`users/${decoded.uid}/integrations/gmail`).get();
    if (!snap.exists) return res.json({ connected: false });
    const d = snap.data();
    res.json({
      connected: true,
      email: d.connectedEmail || '',
      status: d.status || 'connected',
      lastSyncAt: d.lastSyncAt || null,
      initialBackfillDoneAt: d.initialBackfillDoneAt || null,
      backfillStats: d.backfillStats || null,
      lastError: d.lastError || null,
    });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Endpoint: disconnect Gmail (revoke token, drop integration doc) ──
exports.gmailDisconnect = onRequest({ cors: true }, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const snap = await db.doc(`users/${uid}/integrations/gmail`).get();
    if (snap.exists) {
      const tokenToRevoke = snap.data().refreshToken || snap.data().accessToken;
      if (tokenToRevoke) {
        // Best-effort revoke at Google; don't fail the disconnect if it errors
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`, { method: 'POST' });
        } catch (_) {}
      }
      await db.doc(`users/${uid}/integrations/gmail`).delete();
    }
    res.json({ ok: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Scheduled sync: poll every 15 min for users with Gmail connected ──
// Uses Gmail history API: requests changes since lastHistoryId, processes only new messages.
exports.gmailScheduledSync = onSchedule({
  schedule: 'every 15 minutes',
  timeoutSeconds: 540,
  memory: '512MiB',
  secrets: [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET],
}, async () => {
  // Find all users with active Gmail integrations
  const integrationsSnap = await db.collectionGroup('integrations')
    .where('provider', '==', 'gmail')
    .where('status', 'in', ['connected'])
    .get();
  console.log(`[gmail-sync] processing ${integrationsSnap.docs.length} integrations`);
  for (const intDoc of integrationsSnap.docs) {
    // path is users/{uid}/integrations/gmail
    const pathParts = intDoc.ref.path.split('/');
    const uid = pathParts[1];
    try {
      await runGmailIncrementalSync(uid);
    } catch (e) {
      console.error(`[gmail-sync] uid=${uid} failed:`, e.message);
    }
  }
});

// ── Incremental sync via Gmail history API ──
async function runGmailIncrementalSync(uid) {
  const intSnap = await db.doc(`users/${uid}/integrations/gmail`).get();
  if (!intSnap.exists) return;
  const integration = intSnap.data();
  // Migration guard: once a user is on the unified Nylas integration, stop the
  // legacy Gmail sync so inbound email is not double-logged onto contacts.
  // Marking the doc 'migrated' also drops it from the scheduled query above.
  const nylasSnap = await db.doc(`users/${uid}/integrations/nylas`).get();
  if (nylasSnap.exists && nylasSnap.data().status === 'active') {
    if (integration.status !== 'migrated') {
      await intSnap.ref.set({ status: 'migrated', migratedAt: new Date().toISOString() }, { merge: true });
      console.log(`[gmail-sync] uid=${uid} migrated to Nylas — pausing legacy sync`);
    }
    return;
  }
  if (!integration.lastHistoryId) {
    // No baseline yet — full backfill must finish first
    return;
  }
  const accessToken = await ensureFreshGmailToken(
    uid, integration,
    GOOGLE_OAUTH_CLIENT_ID.value(), GOOGLE_OAUTH_CLIENT_SECRET.value()
  );
  const contactIndex = await buildContactEmailIndex(uid);
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
  url.searchParams.set('startHistoryId', String(integration.lastHistoryId));
  url.searchParams.set('historyTypes', 'messageAdded');
  const resp = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!resp.ok) {
    if (resp.status === 404) {
      // historyId too old — Gmail clears history after ~7 days. Fall back to backfill.
      console.warn(`[gmail-sync] uid=${uid} historyId expired, re-running backfill`);
      await runGmailInitialBackfill(uid);
      return;
    }
    throw new Error(`Gmail history failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  const history = data.history || [];
  const newMessageIds = new Set();
  history.forEach(h => {
    (h.messagesAdded || []).forEach(ma => {
      if (ma.message?.id) newMessageIds.add(ma.message.id);
    });
  });
  let scanned = 0, matched = 0;
  for (const mid of newMessageIds) {
    scanned++;
    try {
      const full = await gmailGetMessage(accessToken, mid);
      const parsed = parseGmailMessage(full);
      const r = await writeMessageToContacts(uid, parsed, contactIndex);
      if (r.matched > 0) matched++;
    } catch (e) {
      console.warn(`[gmail-sync] msg=${mid} err=${e.message}`);
    }
  }
  await db.doc(`users/${uid}/integrations/gmail`).update({
    lastSyncAt: new Date().toISOString(),
    lastHistoryId: data.historyId || integration.lastHistoryId,
  });
  if (scanned > 0) console.log(`[gmail-sync] uid=${uid} scanned=${scanned} matched=${matched}`);
}

// ============================================================
// EMAIL INTEGRATION — Outlook OAuth + sync (May 2026)
// ============================================================
// Mirrors the Gmail integration pattern but talks to Microsoft Graph
// instead of the Gmail API. Same data model (/users/{uid}/integrations/
// outlook + /users/{uid}/contacts/{contactId}/emails/{messageId}),
// same helpers (buildContactEmailIndex, writeMessageToContacts,
// normalizeEmail, signOauthState/verifyOauthState).
//
// Microsoft Graph differences worth noting:
//
//   1. Scope: we use `Mail.Read` + `offline_access` + `User.Read`.
//      Microsoft does NOT have a true metadata-only scope like Gmail's
//      `gmail.metadata`. Mail.Read gives access to bodies in theory,
//      but we use Graph's `$select` parameter to ONLY request from /
//      toRecipients / ccRecipients / subject / sentDateTime / bodyPreview.
//      We never request `body` or `uniqueBody`, so we never read content.
//
//   2. Token endpoint: https://login.microsoftonline.com/common/oauth2/v2.0/
//      For multi-tenant apps that should accept BOTH personal Microsoft
//      accounts (outlook.com, hotmail.com, live.com) AND work/school
//      accounts (Office 365 / Entra ID), use the `/common/` tenant.
//
//   3. Refresh tokens: only issued when `offline_access` is in the scope
//      list AND `prompt=consent` is on the initial authorize request.
//
//   4. Incremental sync: Microsoft Graph uses Delta Query (a delta token
//      that fits into the request URL) rather than Gmail's historyId.
//      Same conceptual primitive, different shape.
//
//   5. Pagination: Graph uses `@odata.nextLink` URLs (full URLs including
//      a `$skiptoken`) rather than Gmail's pageToken string. We just
//      follow the link.
//
//   6. No verification gauntlet: unlike Gmail's restricted-scope CASA
//      requirement, Microsoft lets us ship Mail.Read to all users
//      immediately. Publisher verification is optional and just removes
//      the "unverified app" consent screen warning (similar to Google's
//      Testing-mode warning).
// ============================================================
// Bundled email + calendar scope. Mail.Read = read mail headers via $select
// for email auto-log. Calendars.ReadWrite = create / update / delete events
// on user's calendar for 8-step sync. One Connect flow grants both — see
// runContactCalendarSync below.
const MICROSOFT_OAUTH_SCOPES = [
  'offline_access',
  'User.Read',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'Contacts.ReadWrite',
].join(' ');
const OUTLOOK_OAUTH_REDIRECT = 'https://us-central1-swh-scoreboard.cloudfunctions.net/outlookOauthCallback';
const OUTLOOK_BACKFILL_DAYS = 90;

// ── Microsoft Graph token refresh helper ──
async function ensureFreshOutlookToken(uid, integration, clientId, clientSecret) {
  const now = Date.now();
  const expiresAt = integration.accessTokenExpiresAt || 0;
  if (integration.accessToken && expiresAt > now + 60_000) {
    return integration.accessToken;
  }
  if (!integration.refreshToken) {
    throw new Error('No refresh token on record — user must reconnect Outlook');
  }
  const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: integration.refreshToken,
      grant_type: 'refresh_token',
      scope: MICROSOFT_OAUTH_SCOPES,
    }).toString(),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error('[outlook] token refresh failed:', resp.status, errText);
    throw new Error('Outlook token refresh failed');
  }
  const data = await resp.json();
  const newAccessToken = data.access_token;
  const newExpiresAt = now + (data.expires_in || 3600) * 1000;
  // Microsoft refresh tokens can rotate — if a new one is returned, save it.
  const updates = {
    accessToken: newAccessToken,
    accessTokenExpiresAt: newExpiresAt,
  };
  if (data.refresh_token && data.refresh_token !== integration.refreshToken) {
    updates.refreshToken = data.refresh_token;
  }
  await db.doc(`users/${uid}/integrations/outlook`).update(updates);
  return newAccessToken;
}

// ── Microsoft Graph: list messages in a folder (Inbox or SentItems) ──
// Returns the raw response so the caller can grab @odata.nextLink for paging.
// The $select keeps us metadata-only. $top=50 is Graph's max for messages list.
async function graphListMessages(accessToken, folder, params = {}) {
  // folder: 'inbox' | 'sentitems'
  const url = new URL(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages`);
  // Only request the fields we actually use — never request 'body' or 'uniqueBody'
  url.searchParams.set('$select', 'id,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,bodyPreview,conversationId');
  url.searchParams.set('$top', String(params.top || 50));
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  // Filter by date range if provided
  if (params.afterDate) {
    url.searchParams.set('$filter', `receivedDateTime ge ${params.afterDate}`);
  }
  const fetchUrl = params.nextLink || url.toString();
  const resp = await fetch(fetchUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Graph list failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// ── Microsoft Graph: delta query for incremental sync ──
// Returns messages added/changed since the last delta token. First call
// returns a fresh delta link to remember for next time.
async function graphDeltaMessages(accessToken, folder, deltaUrl = null) {
  let url;
  if (deltaUrl) {
    url = deltaUrl;
  } else {
    const u = new URL(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta`);
    u.searchParams.set('$select', 'id,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,bodyPreview,conversationId');
    u.searchParams.set('$top', '50');
    url = u.toString();
  }
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Graph delta failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// ── Parse a Graph message into our common email shape ──
// folder='inbox' → received, folder='sentitems' → sent. We pass this in
// because Graph doesn't have a "labelIds" like Gmail.
function parseGraphMessage(msg, folder) {
  const direction = folder === 'sentitems' ? 'sent' : 'received';
  const fromAddr = normalizeEmail(msg.from?.emailAddress?.address || '');
  const toEmails = (msg.toRecipients || [])
    .map(r => normalizeEmail(r.emailAddress?.address || ''))
    .filter(Boolean);
  const ccEmails = (msg.ccRecipients || [])
    .map(r => normalizeEmail(r.emailAddress?.address || ''))
    .filter(Boolean);
  // Microsoft uses ISO 8601 directly, no internalDate conversion needed
  const sentAt = msg.sentDateTime || msg.receivedDateTime || new Date().toISOString();
  return {
    messageId: msg.id,
    threadId: msg.conversationId || msg.id,
    direction,
    subject: msg.subject || '(no subject)',
    // bodyPreview is Graph's equivalent of Gmail's snippet — short, no body
    snippet: msg.bodyPreview || '',
    fromEmail: fromAddr,
    toEmails,
    ccEmails,
    sentAt,
  };
}

// ── Same writer as Gmail, just stamps source: 'outlook' ──
async function writeOutlookMessageToContacts(uid, parsed, contactIndex) {
  const targets = parsed.direction === 'sent'
    ? [...parsed.toEmails, ...parsed.ccEmails]
    : (parsed.fromEmail ? [parsed.fromEmail] : []);
  const matched = new Set();
  for (const email of targets) {
    const hits = contactIndex[email] || [];
    hits.forEach(c => matched.add(c.id));
  }
  if (matched.size === 0) return { matched: 0 };
  const batch = db.batch();
  const emailDoc = {
    direction: parsed.direction,
    sentAt: parsed.sentAt,
    subject: parsed.subject,
    snippet: parsed.snippet,
    fromEmail: parsed.fromEmail,
    toEmails: parsed.toEmails,
    ccEmails: parsed.ccEmails,
    threadId: parsed.threadId,
    source: 'outlook',
    syncedAt: new Date().toISOString(),
  };
  matched.forEach(contactId => {
    // Prefix the messageId with 'ms_' so Gmail and Outlook can't collide on
    // the same key — Graph IDs and Gmail IDs use different alphabets but
    // the explicit namespace prevents any future "oh god they collided" pain.
    const ref = db.doc(`users/${uid}/contacts/${contactId}/emails/ms_${parsed.messageId}`);
    batch.set(ref, emailDoc, { merge: true });
    batch.update(db.doc(`users/${uid}/contacts/${contactId}`), {
      lastActivityAt: parsed.sentAt,
    });
  });
  await batch.commit();
  return { matched: matched.size };
}

// ── Endpoint: kick off Outlook OAuth ──
exports.outlookOauthInitiate = onRequest({
  cors: true,
  secrets: [MICROSOFT_OAUTH_CLIENT_ID, OAUTH_STATE_SECRET],
}, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    const state = signOauthState(decoded.uid, OAUTH_STATE_SECRET.value());
    // /common/ accepts both personal Microsoft accounts and work/school accounts
    const url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    url.searchParams.set('client_id', MICROSOFT_OAUTH_CLIENT_ID.value());
    url.searchParams.set('redirect_uri', OUTLOOK_OAUTH_REDIRECT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', MICROSOFT_OAUTH_SCOPES);
    url.searchParams.set('prompt', 'consent'); // force refresh-token issuance
    url.searchParams.set('state', state);
    res.json({ authUrl: url.toString() });
  } catch (e) {
    console.error('[outlookOauthInitiate]', e);
    sendErr(res, e);
  }
});

// ── Endpoint: Microsoft redirects here with ?code=...&state=... ──
exports.outlookOauthCallback = onRequest({
  secrets: [MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET, OAUTH_STATE_SECRET],
}, async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      res.status(400).send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center;background:#0f1117;color:#fff;"><h1>Outlook connect failed</h1><p>${escapeHtml(String(error_description || error))}</p><a href="https://swh-crm.web.app" style="color:#A78BFA;">← Back to SWH</a></body>`);
      return;
    }
    if (!code) {
      // Direct-visit landing page — mirror the Gmail callback's friendly explanation.
      res.status(400).send(`<!doctype html>
<meta charset="utf-8">
<title>SWH Outlook callback</title>
<body style="font-family:'DM Sans',-apple-system,sans-serif;background:#0f1117;color:#fff;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:24px;">
  <div style="max-width:520px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:18px;padding:32px;line-height:1.6;">
    <div style="width:48px;height:48px;border-radius:12px;background:#0078D4;display:flex;align-items:center;justify-content:center;font-size:26px;margin-bottom:18px;">✉</div>
    <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:24px;font-weight:900;margin:0 0 12px;">This page isn't a destination</h1>
    <p style="color:rgba(255,255,255,0.75);font-size:14px;margin:0 0 18px;">You landed on the Outlook OAuth callback URL directly. This URL only does something useful when Microsoft redirects you back here after a successful consent, with an authorization code attached.</p>
    <p style="color:rgba(255,255,255,0.65);font-size:13px;margin:0 0 20px;">To actually connect Outlook, go to <strong>SWH Settings → Email Integrations → Outlook</strong> and click "Connect to auto-log emails."</p>
    <a href="https://swh-crm.web.app" style="display:inline-block;background:linear-gradient(135deg,#5B5BD6,#A78BFA);color:#fff;padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:700;font-size:14px;">← Back to SWH</a>
  </div>
</body>`);
      return;
    }
    const parsedState = verifyOauthState(String(state), OAUTH_STATE_SECRET.value());
    const uid = parsedState.uid;
    // Exchange code for tokens
    const tokenResp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: MICROSOFT_OAUTH_CLIENT_ID.value(),
        client_secret: MICROSOFT_OAUTH_CLIENT_SECRET.value(),
        redirect_uri: OUTLOOK_OAUTH_REDIRECT,
        grant_type: 'authorization_code',
        scope: MICROSOFT_OAUTH_SCOPES,
      }).toString(),
    });
    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error('[outlookOauthCallback] token exchange failed:', tokenResp.status, errText);
      throw new Error('Token exchange failed');
    }
    const tokens = await tokenResp.json();
    // Get the connected email address via /me
    const profileResp = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    const profile = profileResp.ok ? await profileResp.json() : {};
    // `mail` is the user's actual mailbox; `userPrincipalName` is the
    // login identifier. Prefer mail (may be null for personal MSAs, in
    // which case fall back to UPN).
    const connectedEmail = profile.mail || profile.userPrincipalName || '';
    // Store in /users/{uid}/integrations/outlook
    const now = Date.now();
    await db.doc(`users/${uid}/integrations/outlook`).set({
      provider: 'outlook',
      connectedEmail,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      accessTokenExpiresAt: now + (tokens.expires_in || 3600) * 1000,
      scopes: tokens.scope || MICROSOFT_OAUTH_SCOPES,
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
      deltaLinks: { inbox: null, sentitems: null },  // populated after first backfill
      initialBackfillDoneAt: null,
      status: 'connected',
    }, { merge: true });
    runOutlookInitialBackfill(uid).catch(e => console.error('[outlook] initial backfill failed:', e));
    res.redirect(`https://swh-crm.web.app/?outlook=connected`);
  } catch (e) {
    console.error('[outlookOauthCallback]', e);
    res.status(500).send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center;background:#0f1117;color:#fff;"><h1>Outlook connect failed</h1><p>${escapeHtml(e.message)}</p><a href="https://swh-crm.web.app" style="color:#A78BFA;">← Back to SWH</a></body>`);
  }
});

// ── Initial 90-day backfill ──
async function runOutlookInitialBackfill(uid) {
  const integrationSnap = await db.doc(`users/${uid}/integrations/outlook`).get();
  if (!integrationSnap.exists) throw new Error('No Outlook integration');
  const integration = integrationSnap.data();
  await db.doc(`users/${uid}/integrations/outlook`).update({ status: 'syncing' });
  try {
    const accessToken = await ensureFreshOutlookToken(
      uid, integration,
      MICROSOFT_OAUTH_CLIENT_ID.value(), MICROSOFT_OAUTH_CLIENT_SECRET.value()
    );
    const contactIndex = await buildContactEmailIndex(uid);
    const hasEmailContacts = Object.keys(contactIndex).length > 0;
    if (!hasEmailContacts) {
      await db.doc(`users/${uid}/integrations/outlook`).update({
        status: 'connected',
        initialBackfillDoneAt: new Date().toISOString(),
        lastSyncAt: new Date().toISOString(),
        backfillStats: { matched: 0, scanned: 0, note: 'No contacts with email addresses yet' },
      });
      return;
    }
    let totalScanned = 0, totalMatched = 0, totalWritten = 0;
    const cutoffISO = new Date(Date.now() - OUTLOOK_BACKFILL_DAYS * 86400000).toISOString();
    const deltaLinks = { inbox: null, sentitems: null };

    for (const folder of ['sentitems', 'inbox']) {
      let nextLink = null;
      let stopThisFolder = false;
      do {
        let resp;
        if (nextLink) {
          resp = await graphListMessages(accessToken, folder, { nextLink });
        } else {
          resp = await graphListMessages(accessToken, folder, { afterDate: cutoffISO, top: 50 });
        }
        const messages = resp.value || [];
        for (const m of messages) {
          totalScanned++;
          try {
            const parsed = parseGraphMessage(m, folder);
            // Defensive: if a message somehow predates the cutoff, skip
            if (parsed.sentAt < cutoffISO) {
              stopThisFolder = true;
              break;
            }
            const { matched } = await writeOutlookMessageToContacts(uid, parsed, contactIndex);
            if (matched > 0) { totalMatched++; totalWritten += matched; }
          } catch (e) {
            console.warn('[outlook backfill] message error:', m.id, e.message);
          }
        }
        if (stopThisFolder) break;
        nextLink = resp['@odata.nextLink'] || null;
        if (totalScanned >= 2000) { nextLink = null; break; }
      } while (nextLink);

      // After listing the folder, kick off a delta query and store the link
      // for incremental sync. The first delta call returns @odata.deltaLink
      // (no messages, since the timeline is now baseline).
      try {
        let deltaResp = await graphDeltaMessages(accessToken, folder);
        // Walk any pages to find the final deltaLink
        let safety = 0;
        while (deltaResp['@odata.nextLink'] && safety < 10) {
          deltaResp = await graphDeltaMessages(accessToken, folder, deltaResp['@odata.nextLink']);
          safety++;
        }
        if (deltaResp['@odata.deltaLink']) {
          deltaLinks[folder] = deltaResp['@odata.deltaLink'];
        }
      } catch (e) {
        console.warn(`[outlook] delta-link init failed for ${folder}:`, e.message);
      }
    }

    await db.doc(`users/${uid}/integrations/outlook`).update({
      status: 'connected',
      initialBackfillDoneAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      deltaLinks,
      backfillStats: {
        scanned: totalScanned,
        matchedMessages: totalMatched,
        writtenLogs: totalWritten,
      },
    });
    console.log(`[outlook] backfill complete for ${uid}: scanned=${totalScanned} matched=${totalMatched}`);
  } catch (e) {
    await db.doc(`users/${uid}/integrations/outlook`).update({
      status: 'error',
      lastError: e.message,
      lastErrorAt: new Date().toISOString(),
    });
    throw e;
  }
}

// ── Endpoint: manually re-run backfill ──
exports.outlookRunBackfill = onRequest({
  cors: true,
  secrets: [MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET],
  timeoutSeconds: 540,
  memory: '512MiB',
}, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    runOutlookInitialBackfill(decoded.uid).catch(e => console.error('[outlook backfill]', e));
    res.json({ ok: true, message: 'Backfill running in background' });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Endpoint: connection status ──
exports.outlookStatus = onRequest({ cors: true }, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    const snap = await db.doc(`users/${decoded.uid}/integrations/outlook`).get();
    if (!snap.exists) return res.json({ connected: false });
    const d = snap.data();
    res.json({
      connected: true,
      email: d.connectedEmail || '',
      status: d.status || 'connected',
      lastSyncAt: d.lastSyncAt || null,
      initialBackfillDoneAt: d.initialBackfillDoneAt || null,
      backfillStats: d.backfillStats || null,
      lastError: d.lastError || null,
    });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Endpoint: disconnect ──
exports.outlookDisconnect = onRequest({ cors: true }, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const snap = await db.doc(`users/${uid}/integrations/outlook`).get();
    if (snap.exists) {
      // Microsoft doesn't have a clean revoke endpoint like Google's
      // /revoke — the standard practice is to drop the tokens server-side
      // and let the refresh token expire naturally (90 days). The user
      // can also revoke from https://account.live.com/consent/Manage if
      // they want to do it explicitly.
      await db.doc(`users/${uid}/integrations/outlook`).delete();
    }
    res.json({ ok: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Endpoint: push a single CRM contact to Outlook Contacts ──
exports.pushContactToOutlook = onRequest({
  cors: true,
  secrets: [MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET],
}, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const { name, phone, email, company, notes } = req.body || {};

    const integSnap = await db.doc(`users/${uid}/integrations/outlook`).get();
    if (!integSnap.exists) {
      return res.status(400).json({ ok: false, code: 'NOT_CONNECTED', message: 'Outlook not connected' });
    }
    const integration = integSnap.data();

    // Check if the stored token has Contacts scope
    const scopes = (integration.scopes || '').split(' ');
    const hasContactsScope = scopes.some(s => s.toLowerCase().includes('contacts'));
    if (!hasContactsScope && integration.scopes) {
      return res.status(403).json({ ok: false, code: 'NO_SCOPE', message: 'Outlook needs to be reconnected to grant contact access' });
    }

    const accessToken = await ensureFreshOutlookToken(
      uid, integration,
      MICROSOFT_OAUTH_CLIENT_ID.value(),
      MICROSOFT_OAUTH_CLIENT_SECRET.value()
    );

    const [givenName, ...rest] = (name || '').trim().split(' ');
    const surname = rest.join(' ');
    const contactBody = {
      givenName: givenName || name,
      surname: surname || '',
    };
    if (phone) contactBody.mobilePhone = phone;
    if (email) contactBody.emailAddresses = [{ address: email, name: email }];
    if (company) contactBody.companyName = company;
    if (notes) contactBody.personalNotes = notes;

    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me/contacts', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(contactBody),
    });

    if (graphRes.ok) {
      return res.json({ ok: true });
    }
    const errBody = await graphRes.text();
    console.error('[pushContactToOutlook] Graph error:', graphRes.status, errBody);
    if (graphRes.status === 403) {
      return res.status(403).json({ ok: false, code: 'NO_SCOPE', message: 'Insufficient Graph permissions — reconnect Outlook' });
    }
    return res.status(500).json({ ok: false, message: 'Graph API error: ' + graphRes.status });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Scheduled sync: poll every 15 min for users with Outlook connected ──
exports.outlookScheduledSync = onSchedule({
  schedule: 'every 15 minutes',
  timeoutSeconds: 540,
  memory: '512MiB',
  secrets: [MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET],
}, async () => {
  const integrationsSnap = await db.collectionGroup('integrations')
    .where('provider', '==', 'outlook')
    .where('status', 'in', ['connected'])
    .get();
  console.log(`[outlook-sync] processing ${integrationsSnap.docs.length} integrations`);
  for (const intDoc of integrationsSnap.docs) {
    const pathParts = intDoc.ref.path.split('/');
    const uid = pathParts[1];
    try {
      await runOutlookIncrementalSync(uid);
    } catch (e) {
      console.error(`[outlook-sync] uid=${uid} failed:`, e.message);
    }
  }
});

// ── Incremental sync via Graph delta query ──
async function runOutlookIncrementalSync(uid) {
  const intSnap = await db.doc(`users/${uid}/integrations/outlook`).get();
  if (!intSnap.exists) return;
  const integration = intSnap.data();
  const deltaLinks = integration.deltaLinks || { inbox: null, sentitems: null };
  if (!deltaLinks.inbox && !deltaLinks.sentitems) {
    // No baseline — backfill must complete first
    return;
  }
  const accessToken = await ensureFreshOutlookToken(
    uid, integration,
    MICROSOFT_OAUTH_CLIENT_ID.value(), MICROSOFT_OAUTH_CLIENT_SECRET.value()
  );
  const contactIndex = await buildContactEmailIndex(uid);
  const newDeltaLinks = { ...deltaLinks };
  let totalScanned = 0, totalMatched = 0;

  for (const folder of ['sentitems', 'inbox']) {
    if (!deltaLinks[folder]) continue;
    try {
      let deltaResp = await graphDeltaMessages(accessToken, folder, deltaLinks[folder]);
      // Walk all pages until we hit a deltaLink
      let safety = 0;
      while (true) {
        const messages = deltaResp.value || [];
        for (const m of messages) {
          // Delta query may include "tombstone" entries for deleted messages
          // (they have @removed). We skip those — we don't need to delete
          // already-logged emails when a message is removed from the
          // mailbox.
          if (m['@removed']) continue;
          totalScanned++;
          try {
            const parsed = parseGraphMessage(m, folder);
            const r = await writeOutlookMessageToContacts(uid, parsed, contactIndex);
            if (r.matched > 0) totalMatched++;
          } catch (e) {
            console.warn(`[outlook-sync] msg=${m.id} err=${e.message}`);
          }
        }
        if (deltaResp['@odata.deltaLink']) {
          newDeltaLinks[folder] = deltaResp['@odata.deltaLink'];
          break;
        }
        if (deltaResp['@odata.nextLink'] && safety < 20) {
          safety++;
          deltaResp = await graphDeltaMessages(accessToken, folder, deltaResp['@odata.nextLink']);
        } else {
          break;
        }
      }
    } catch (e) {
      // 410 Gone means the delta token expired — fall back to full backfill
      if (e.message.includes('410')) {
        console.warn(`[outlook-sync] uid=${uid} delta token expired for ${folder}, re-running backfill`);
        await runOutlookInitialBackfill(uid);
        return;
      }
      throw e;
    }
  }
  await db.doc(`users/${uid}/integrations/outlook`).update({
    lastSyncAt: new Date().toISOString(),
    deltaLinks: newDeltaLinks,
  });
  if (totalScanned > 0) console.log(`[outlook-sync] uid=${uid} scanned=${totalScanned} matched=${totalMatched}`);
}

// ============================================================
// CROSS-PRODUCT SESSION TOKEN (May 2026)
// ============================================================
// Mints a short-lived Firebase Auth custom token so a user signed
// into one SWH surface (Scoreboard or CRM) can jump to the other
// without re-typing credentials.
//
// Flow:
//   1. Web app (say, CRM) wants to send user to swh-scoreboard.web.app
//   2. CRM calls this endpoint with the user's current ID token
//   3. We verify the ID token (Admin SDK), then mint a NEW custom token
//      with the same uid. Custom tokens are valid for ~5 min by default.
//   4. CRM redirects to https://swh-scoreboard.web.app/#signin=<token>
//   5. Scoreboard boot detects the hash, calls signInWithCustomToken,
//      strips the hash. User lands signed-in. Zero friction.
//
// The hash is used (not a query string) so the token never goes through
// server logs or HTTP referers. The receiving app immediately strips it
// from the URL via history.replaceState.
// ============================================================
// Auto-save any day doc that has points but was never formally submitted.
// Runs at 11 PM CST (5 AM UTC) so users who forget to press Save still
// get their data recorded in history.
exports.autoSaveDailyLog = onSchedule({
  schedule: '0 23 * * *',
  timeZone: 'America/Chicago',
}, async () => {
  const today = new Date();
  const dateKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const usersSnap = await db.collection('users').get();
  let saved = 0;
  for (const userDoc of usersSnap.docs) {
    try {
      const dayRef = db.collection('users').doc(userDoc.id).collection('days').doc(dateKey);
      const daySnap = await dayRef.get();
      if (!daySnap.exists) continue;
      const data = daySnap.data();
      // Already submitted or nothing logged.
      if (data.submitted === true) continue;
      if (!data.totalPts || data.totalPts === 0) continue;
      await dayRef.set({ submitted: true, autoSubmittedAt: new Date().toISOString() }, { merge: true });
      saved++;
    } catch (e) {
      console.warn('[autoSaveDailyLog] user', userDoc.id, e.message);
    }
  }
  console.log(`[autoSaveDailyLog] marked ${saved} day(s) as submitted for ${dateKey}`);
});

exports.mintCrossProductToken = onRequest({
  cors: true,
}, async (req, res) => {
  try {
    const decoded = await requireAuth(req);
    // Custom token expires in 1 hour (Firebase default), but we expect
    // it to be consumed within seconds of redirect.
    const token = await admin.auth().createCustomToken(decoded.uid, {
      _xprod: true,
      _mintedAt: Date.now(),
    });
    res.json({ ok: true, token });
  } catch (e) {
    console.error('[mintCrossProductToken]', e);
    sendErr(res, e);
  }
});

// ============================================================
// MYAPPOINTMENT.AI SSO BRIDGE
// ============================================================
//
// mintApptCustomToken — callable, authenticated SWH users only.
// Provisions the caller in myappointment-ai-8756e (idempotent) and
// returns a one-hour custom token. The CRM client calls
// signInWithCustomToken(apptAuth, token) immediately after — the
// user never sees a second login prompt.
//
// Secrets required in this project:
//   MYAPPOINTMENT_SERVICE_ACCOUNT_KEY — SA JSON for myappointment-ai-8756e

// Lazily-initialized secondary Admin app so we only parse the SA key once
// per function container lifetime.
let _apptAdminApp;
function getApptAdminApp() {
  if (_apptAdminApp) return _apptAdminApp;
  const credential = admin.credential.cert(JSON.parse(MYAPPOINTMENT_SA_KEY.value()));
  _apptAdminApp = admin.initializeApp(
    { credential, projectId: 'myappointment-ai-8756e' },
    'myappointment-cross-project-swh',
  );
  return _apptAdminApp;
}

// loaniq-75a20 — where mylola.ai ACTUALLY stores schedulingProfile,
// bookingPages, and meetings. Distinct from myappointment-ai-8756e.
let _loaniqAdminApp;
function getLoaniqAdminApp() {
  if (_loaniqAdminApp) return _loaniqAdminApp;
  const credential = admin.credential.cert(JSON.parse(LOANIQ_SA_KEY.value()));
  _loaniqAdminApp = admin.initializeApp(
    { credential, projectId: 'loaniq-75a20' },
    'loaniq-cross-project-swh',
  );
  return _loaniqAdminApp;
}

exports.mintApptCustomToken = onCall({
  secrets: [MYAPPOINTMENT_SA_KEY, MYAPPOINTMENT_UPGRADE_SECRET],
}, async (request) => {
  // Was `throw new Error('unauthenticated')` which the v2 onCall harness
  // surfaces as a 500 INTERNAL — wrong category, pollutes logs, and lets
  // monitoring miss real bugs in the bucket. HttpsError('unauthenticated')
  // gets translated to the proper 401 (UNAUTHENTICATED) callable error.
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const swhUid = request.auth.uid;
  const email  = request.auth.token?.email || null;
  const name   = request.auth.token?.name  || null;

  const apptAuth = admin.auth(getApptAdminApp());

  // Strategy: if this user already has a myappointment-ai account under their
  // email (created via mylola.ai), mint a token for THAT uid so their existing
  // booking pages and scheduling profile are visible.  If no account exists yet
  // fall back to provisioning with the SWH uid.
  let targetUid = swhUid;

  if (email) {
    try {
      const existing = await apptAuth.getUserByEmail(email);
      // Found an existing myappointment-ai account for this email — use its uid.
      targetUid = existing.uid;
      console.log(`[mintApptCustomToken] email match → using appt uid=${targetUid} (swh uid=${swhUid})`);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        // No existing account — provision fresh with the SWH uid.
        try {
          await apptAuth.getUser(swhUid);
        } catch (e2) {
          if (e2.code === 'auth/user-not-found') {
            const createOpts = { uid: swhUid };
            if (email) createOpts.email = email;
            if (name)  createOpts.displayName = name;
            await apptAuth.createUser(createOpts);
            console.log(`[mintApptCustomToken] provisioned uid=${swhUid} in myappointment-ai`);
          } else {
            throw e2;
          }
        }
        targetUid = swhUid;
      } else {
        throw e;
      }
    }
  } else {
    // No email on the SWH token — fall back to uid-based provision.
    try {
      await apptAuth.getUser(swhUid);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        await apptAuth.createUser({ uid: swhUid });
        console.log(`[mintApptCustomToken] provisioned uid=${swhUid} (no email) in myappointment-ai`);
      } else {
        throw e;
      }
    }
  }

  const token = await apptAuth.createCustomToken(targetUid);
  console.log(`[mintApptCustomToken] issued token for appt uid=${targetUid}`);

  const apptDb = admin.firestore(getApptAdminApp());

  // Fire-and-forget: seed config/profile + slugs entry on first bridge so
  // the dashboard and SWH Appointments screen have something to display
  // the moment the user connects — they don't need to go set anything up.
  apptDb.doc(`users/${targetUid}/config/profile`).get().then(async (profileSnap) => {
    if (profileSnap.exists) return; // Already seeded — nothing to do.

    const rawSlug = ((name || '').split(' ')[0] || (email || '').split('@')[0] || 'user')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (!rawSlug) return;

    // Find a unique slug — append a suffix if taken by a different uid.
    let slug = rawSlug;
    for (let i = 1; i <= 9; i++) {
      const taken = await apptDb.doc(`slugs/${slug}`).get();
      if (!taken.exists || taken.data().uid === targetUid) break;
      slug = rawSlug + i;
    }

    const now = Date.now();
    await Promise.all([
      apptDb.doc(`users/${targetUid}/config/profile`).set({
        uid:       targetUid,
        slug,
        name:      name || (email ? email.split('@')[0] : 'User'),
        ...(email ? { email } : {}),
        updatedAt: now,
      }, { merge: true }),
      apptDb.doc(`slugs/${slug}`).set({ uid: targetUid, updatedAt: now }, { merge: true }),
    ]);
    console.log(`[mintApptCustomToken] seeded profile for uid=${targetUid} slug=${slug}`);
  }).catch(err => console.warn('[mintApptCustomToken] profile seed failed (non-fatal):', err?.message ?? err));

  // Self-heal: if this SWH user is on the pro plan, ensure myappointment-ai
  // reflects that tier. Fire-and-forget — never block the token response.
  try {
    const userDoc = await admin.firestore().collection('users').doc(swhUid).get();
    if (userDoc.exists && userDoc.data().plan === 'pro') {
      const billingRef = userDoc.data().stripeSubscriptionId || null;
      syncApptPlan(swhUid, billingRef).catch(err =>
        console.warn('[mintApptCustomToken] plan sync failed (non-fatal):', err?.message ?? err)
      );
    }
  } catch (e) {
    console.warn('[mintApptCustomToken] plan check failed (non-fatal):', e?.message ?? e);
  }

  return { token };
});

// ============================================================
// MYLOLA INTEGRATION — sendContactToMyLola
// ============================================================
//
// Browser-callable. The SWH CRM (public-crm/index.html) calls this
// with a contactId + sync options. The function:
//   1. Verifies the caller is signed-in to SWH Auth.
//   2. Reads the SWH contact from /users/{uid}/contacts/{contactId}.
//   3. Builds the MyLola payload (mirrors the browser-side
//      mapSwhContactToMyLolaPayload).
//   4. POSTs to the acceptSwhContact endpoint in loaniq-75a20 with a
//      shared bearer secret.
//   5. Returns { ok, myLolaContactId, myLolaOpportunityId, kind } so
//      the browser can stamp the SWH contact doc with the sync result.
//
// This is the SAME pattern as syncApptPlan → upgradePlan (below). The
// secret never reaches the browser — it stays in Cloud Function env.
//
// Secret required: MYLOLA_INTEGRATION_SECRET (must match the
// SWH_INTEGRATION_SECRET set on loaniq-75a20\'s mylola codebase).

const MYLOLA_INTEGRATION_SECRET = defineSecret('MYLOLA_INTEGRATION_SECRET');
const MYLOLA_ACCEPT_SWH_CONTACT_URL =
  'https://us-central1-loaniq-75a20.cloudfunctions.net/acceptSwhContact';
const MYLOLA_FIND_MATCHES_URL =
  'https://us-central1-loaniq-75a20.cloudfunctions.net/findMyLolaMatches';
const MYLOLA_VERIFY_ACCOUNT_URL =
  'https://us-central1-loaniq-75a20.cloudfunctions.net/verifyMyLolaAccount';

/** Mirror of public-crm/index.html\'s mapSwhContactToMyLolaPayload —
 *  kept in lockstep so the payload shape matches what acceptSwhContact
 *  validates. The browser-side mapper exists so a fast "dry-run preview"
 *  is possible without a CF round-trip; this server-side version is
 *  authoritative because the SWH user can\'t tamper with it. */
const SWH_STATUS_LABELS = { new: 'New', aplus: 'A+ — Inner Circle', a: 'A — Active Relationship', b: 'B — Growth Relationship', c: 'C — Community Relationship', d: 'D — Dormant Relationship' };

function mapSwhContactToMyLolaPayloadCF(contactId, swhContact, options) {
  const fullName = (swhContact.name || '').trim();
  let firstName, lastName;
  if (fullName) {
    const parts = fullName.split(/\s+/);
    firstName = parts[0];
    if (parts.length > 1) lastName = parts.slice(1).join(' ');
  }

  // SWH partner grade -> readable relationship label (networking context only).
  const relationshipType = swhContact.relationshipType
    || (swhContact.status ? SWH_STATUS_LABELS[swhContact.status] : undefined);

  // lastActivityAt is a Firestore Timestamp -> ISO date string.
  let lastConversationDate;
  const la = swhContact.lastActivityAt;
  if (la && typeof la.toDate === 'function') {
    lastConversationDate = la.toDate().toISOString().slice(0, 10);
  } else if (typeof la === 'string') {
    lastConversationDate = la;
  }

  // New 8-type taxonomy is preferred; legacy createAs kept for back-compat.
  const opportunityType = options.opportunityType || undefined;

  const tags = ['SWH'];
  if (relationshipType) tags.push(relationshipType);
  if (opportunityType) tags.push(opportunityType);
  else if (options.createAs && options.createAs !== 'contact') tags.push(options.createAs);

  const payload = {
    firstName,
    lastName,
    fullName: fullName || undefined,
    email: swhContact.email || undefined,
    phone: swhContact.phone || undefined,
    company: swhContact.company || undefined,
    // Networking context — MyLola stores these read-only under swhContext.
    occupation: (swhContact.form && swhContact.form.occupation) || undefined,
    introductionSource: swhContact.event || undefined,
    referralSource: swhContact.event || undefined,
    relationshipType: relationshipType || undefined,
    relationshipScore: typeof swhContact.steps === 'number' ? swhContact.steps : undefined,
    lastConversationDate,
    source: 'SWH',
    sourceContactId: contactId,
    tags,
    opportunityType,
    createAs: options.createAs || undefined,
  };

  // Notes + FORM included by default (the import wants the relationship
  // context); the modal checkbox can still opt out by passing false.
  if (options.includeNotes !== false) {
    if (swhContact.notes) payload.notes = swhContact.notes;
    if (swhContact.form) payload.formNotes = swhContact.form;
  }
  if (options.includeRelationshipScore !== false) {
    payload.activitySummary = {
      stepsCompleted: typeof swhContact.steps === 'number' ? swhContact.steps : null,
      stepsTotal: 8,
      metAt: swhContact.event || null,
    };
  }
  return payload;
}

exports.sendContactToMyLola = onCall(
  {
    secrets: [MYLOLA_INTEGRATION_SECRET],
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: true,
  },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

    const { contactId, options } = req.data || {};
    if (!contactId || typeof contactId !== 'string') {
      throw new HttpsError('invalid-argument', 'contactId required');
    }
    if (!options || (!options.opportunityType && !options.createAs)) {
      throw new HttpsError('invalid-argument', 'options.opportunityType (or legacy createAs) required');
    }

    // Read the caller\'s email — used to route the contact to the right
    // MyLola user (resolved via getUserByEmail on the loaniq side).
    const userRecord = await admin.auth().getUser(uid);
    const swhUserEmail = userRecord.email;
    if (!swhUserEmail) {
      throw new HttpsError('failed-precondition', 'SWH user has no email — cannot route to MyLola');
    }

    // Read the SWH contact.
    const contactSnap = await admin.firestore()
      .doc(`users/${uid}/contacts/${contactId}`).get();
    if (!contactSnap.exists) {
      throw new HttpsError('not-found', `Contact ${contactId} not found`);
    }
    const swhContact = contactSnap.data();
    const payload = mapSwhContactToMyLolaPayloadCF(contactId, swhContact, options);

    // POST to loaniq.
    let res;
    try {
      res = await fetch(MYLOLA_ACCEPT_SWH_CONTACT_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MYLOLA_INTEGRATION_SECRET.value().trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ swhUserEmail, payload }),
      });
    } catch (err) {
      console.error('[sendContactToMyLola] network error', err);
      throw new HttpsError('unavailable', 'Could not reach MyLola. Try again in a moment.');
    }

    const bodyText = await res.text();
    if (!res.ok) {
      console.warn(`[sendContactToMyLola] acceptSwhContact ${res.status}: ${bodyText}`);
      // Try to surface a useful error string. acceptSwhContact returns
      // JSON for 4xx with a `message`; fall back to raw text otherwise.
      let userMessage = bodyText;
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed.message === 'string') userMessage = parsed.message;
      } catch (_) { /* not JSON */ }
      // 404 = no MyLola user — bubble up as the failed-precondition
      // category so the UI can prompt the user to create one.
      if (res.status === 404) {
        throw new HttpsError('failed-precondition', userMessage || 'No MyLola account found for your email.');
      }
      throw new HttpsError('internal', userMessage || `MyLola sync failed (${res.status})`);
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      console.warn('[sendContactToMyLola] failed to parse response', err, bodyText);
      throw new HttpsError('internal', 'MyLola returned an unparseable response.');
    }

    return {
      ok: true,
      myLolaUserId: parsed.myLolaUserId,
      myLolaContactId: parsed.myLolaContactId,
      myLolaOpportunityId: parsed.myLolaOpportunityId ?? null,
      kind: parsed.kind,
      upserted: !!parsed.upserted,
    };
  },
);

// ── findMyLolaMatches: pre-flight duplicate check before a push. ──
// Resolves the SWH user's email + the contact's email/phone, asks MyLola for
// any existing household/partner match, so the UI can offer use-existing.
exports.findMyLolaMatches = onCall(
  { secrets: [MYLOLA_INTEGRATION_SECRET], timeoutSeconds: 20, memory: '256MiB', cors: true },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

    const { contactId, email, phone } = req.data || {};
    const userRecord = await admin.auth().getUser(uid);
    const swhUserEmail = userRecord.email;
    if (!swhUserEmail) throw new HttpsError('failed-precondition', 'SWH user has no email');

    let matchEmail = email;
    let matchPhone = phone;
    if (contactId && !matchEmail && !matchPhone) {
      const snap = await admin.firestore().doc(`users/${uid}/contacts/${contactId}`).get();
      if (snap.exists) { const c = snap.data(); matchEmail = c.email; matchPhone = c.phone; }
    }
    if (!matchEmail && !matchPhone) return { ok: true, matches: [] };

    let res;
    try {
      res = await fetch(MYLOLA_FIND_MATCHES_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${MYLOLA_INTEGRATION_SECRET.value().trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ swhUserEmail, email: matchEmail, phone: matchPhone }),
      });
    } catch (err) {
      console.error('[findMyLolaMatches] network error', err);
      throw new HttpsError('unavailable', 'Could not reach MyLola. Try again in a moment.');
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404) return { ok: true, noAccount: true, matches: [] };
      console.warn(`[findMyLolaMatches] ${res.status}: ${text}`);
      throw new HttpsError('internal', `MyLola match check failed (${res.status})`);
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new HttpsError('internal', 'MyLola returned an unparseable response.'); }
    return { ok: true, matches: Array.isArray(parsed.matches) ? parsed.matches : [] };
  },
);

// ── verifyMyLolaConnection: a real connect check (account exists by email), ──
// replacing the SWH-side mock handshake.
exports.verifyMyLolaConnection = onCall(
  { secrets: [MYLOLA_INTEGRATION_SECRET], timeoutSeconds: 15, memory: '256MiB', cors: true },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    const userRecord = await admin.auth().getUser(uid);
    const swhUserEmail = userRecord.email;
    if (!swhUserEmail) throw new HttpsError('failed-precondition', 'SWH user has no email');

    let res;
    try {
      res = await fetch(MYLOLA_VERIFY_ACCOUNT_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${MYLOLA_INTEGRATION_SECRET.value().trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: swhUserEmail }),
      });
    } catch (err) {
      console.error('[verifyMyLolaConnection] network error', err);
      throw new HttpsError('unavailable', 'Could not reach MyLola. Try again in a moment.');
    }
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
    return { ok: true, connected: !!parsed.connected, myLolaUserId: parsed.myLolaUserId || null, email: swhUserEmail };
  },
);

// ============================================================
// MYAPPOINTMENT.AI PLAN SYNC HELPER (called from stripeWebhook)
// ============================================================
//
// syncApptPlan — posts to the upgradePlan endpoint in the mylola
// codebase (loaniq-75a20) whenever a SWH user activates the pro
// plan. Idempotent — safe to call on every subscription.updated.
//
// Secrets required: MYAPPOINTMENT_UPGRADE_SECRET (already on stripeWebhook)

async function syncApptPlan(uid, billingRef) {
  const userRecord = await admin.auth().getUser(uid);
  const email = userRecord.email;
  if (!email) {
    console.warn(`[syncApptPlan] uid=${uid} has no email — skipping`);
    return;
  }

  const res = await fetch('https://us-central1-loaniq-75a20.cloudfunctions.net/upgradePlan', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MYAPPOINTMENT_UPGRADE_SECRET.value().trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, tier: 'swh', billingRef }),
  });

  const body = await res.text();
  if (!res.ok) {
    console.warn(`[syncApptPlan] upgradePlan returned ${res.status}: ${body}`);
    return;
  }
  const data = JSON.parse(body);
  console.log(`[syncApptPlan] uid=${uid} → myappointment uid=${data.uid}`);
}

// ============================================================
// getApptData — returns scheduling profile, booking pages, and
// upcoming meetings for the calling SWH user.  Reads from
// loaniq-75a20 (the actual project where mylola.ai stores data)
// via admin SDK so Firestore rules are bypassed entirely.
// ============================================================
exports.getApptData = onCall({
  secrets: [LOANIQ_SA_KEY],
}, async (request) => {
  // Was `throw new Error('unauthenticated')` → 500 INTERNAL. HttpsError
  // gets the v2 onCall harness to return a proper 401 UNAUTHENTICATED.
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');

  const email  = request.auth.token?.email || null;
  const swhUid = request.auth.uid;
  const lqDb   = admin.firestore(getLoaniqAdminApp());
  const swhDb  = admin.firestore();
  const result = { userSlug: '', bookingPages: [], meetings: [] };

  // ── Phase 0: SWH cache ────────────────────────────────────────────────────
  let resolvedUid = null;
  try {
    const swhDoc = await swhDb.collection('users').doc(swhUid).get();
    if (swhDoc.exists && swhDoc.data().apptUid) {
      resolvedUid = swhDoc.data().apptUid;
      console.log(`[getApptData] cache hit swhUid=${swhUid} → lqUid=${resolvedUid}`);
    }
  } catch (e) {
    console.warn('[getApptData] cache read failed:', e.message);
  }

  // ── Phase 1: Email lookup in loaniq-75a20 Auth ────────────────────────────
  if (!resolvedUid && email) {
    try {
      const lqAuth = admin.auth(getLoaniqAdminApp());
      const user   = await lqAuth.getUserByEmail(email);
      console.log(`[getApptData] lq email lookup found uid=${user.uid} for ${email}`);
      resolvedUid  = user.uid;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') console.warn('[getApptData] lq email lookup:', e.message);
      else console.log(`[getApptData] no loaniq-75a20 account for ${email}`);
    }
  }

  // ── Phase 2: collectionGroup fallback (if email not in loaniq Auth) ───────
  // Handles Google-SSO users whose loaniq email differs from SWH email.
  // Requires collection-group index on schedulingProfile.userSlug in loaniq-75a20.
  if (!resolvedUid && email) {
    const localPart  = (email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const domainPart = (email.split('@')[1] || '').split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const candidates = [...new Set([domainPart, localPart])].filter(s => s.length >= 2);
    console.log(`[getApptData] phase2 slug candidates: ${candidates.join(', ')}`);
    for (const slug of candidates) {
      try {
        const cgSnap = await lqDb.collectionGroup('schedulingProfile')
          .where('userSlug', '==', slug).limit(1).get();
        if (cgSnap.empty) continue;
        const uid = cgSnap.docs[0].ref.path.split('/')[1];
        console.log(`[getApptData] phase2 found via collectionGroup slug=${slug} uid=${uid}`);
        resolvedUid = uid;
        result.userSlug = slug;
        break;
      } catch (e) {
        console.warn(`[getApptData] phase2 collectionGroup:`, e.message);
      }
    }
  }

  if (!resolvedUid) {
    console.log(`[getApptData] no mylola account found for swhUid=${swhUid} email=${email}`);
    return result;
  }

  // ── Cache the resolved uid so future calls skip discovery ─────────────────
  swhDb.collection('users').doc(swhUid).set(
    { apptUid: resolvedUid }, { merge: true }
  ).catch(err => console.warn('[getApptData] cache write failed:', err?.message));

  // ── Scheduling profile → userSlug ─────────────────────────────────────────
  if (!result.userSlug) {
    try {
      const snap = await lqDb.doc(`users/${resolvedUid}/schedulingProfile/main`).get();
      if (snap.exists) result.userSlug = snap.data().userSlug || '';
    } catch (e) {
      console.warn('[getApptData] profile:', e.message);
    }
  }

  // ── Booking pages ──────────────────────────────────────────────────────────
  try {
    const snap = await lqDb.collection(`users/${resolvedUid}/bookingPages`).get();
    result.bookingPages = snap.docs.map(d => {
      const p = d.data();
      return { id: d.id, displayName: p.displayName || '', slug: p.slug || d.id,
               isPublic: !!p.isPublic, isPublishable: !!p.isPublishable };
    });
  } catch (e) {
    console.warn('[getApptData] pages:', e.message);
  }

  // ── Upcoming meetings ──────────────────────────────────────────────────────
  try {
    const now  = admin.firestore.Timestamp.now();
    const snap = await lqDb.collection(`users/${resolvedUid}/meetings`)
      .where('start', '>=', now).orderBy('start', 'asc').limit(20).get();
    const rawMeetings = snap.docs
      .map(d => ({ ...d.data(), _docId: d.id }))
      .filter(m => m.status === 'scheduled');

    // Batch-fetch guest names via subject references (household / referral_partner)
    const subjectMap = {};
    const householdIds = [...new Set(rawMeetings
      .filter(m => m.subject?.type === 'household' && m.subject?.id)
      .map(m => m.subject.id))];
    const partnerIds = [...new Set(rawMeetings
      .filter(m => m.subject?.type === 'referral_partner' && m.subject?.id)
      .map(m => m.subject.id))];

    await Promise.all([
      ...householdIds.map(async id => {
        try {
          const d = await lqDb.doc(`users/${resolvedUid}/households/${id}`).get();
          if (d.exists) subjectMap[`household:${id}`] = d.data().displayName || '';
        } catch (_) { /* non-fatal */ }
      }),
      ...partnerIds.map(async id => {
        try {
          const d = await lqDb.doc(`users/${resolvedUid}/referralPartners/${id}`).get();
          if (d.exists) {
            const p = d.data();
            subjectMap[`referral_partner:${id}`] = p.fullName || `${p.firstName||''} ${p.lastName||''}`.trim() || '';
          }
        } catch (_) { /* non-fatal */ }
      }),
    ]);

    result.meetings = rawMeetings.map(m => {
      const key = m.subject?.type && m.subject?.id ? `${m.subject.type}:${m.subject.id}` : null;
      return {
        id: m.id || m._docId,
        bookingPageId: m.bookingPageId || null,
        start: m.start.toDate().toISOString(),
        status: m.status,
        location: m.location || null,
        guestName: (key && subjectMap[key]) || m.bookerName || '',
      };
    });
  } catch (e) {
    console.warn('[getApptData] meetings:', e.message);
  }

  console.log(`[getApptData] done slug=${result.userSlug} pages=${result.bookingPages.length} meetings=${result.meetings.length} uid=${resolvedUid}`);
  return result;
});

// ============================================================
// apptMeetingSweep — every 15 min. New myappointment.ai bookings
// (loaniq-75a20 users/{apptUid}/meetings) are matched by bookerEmail
// to SWH contacts → timeline history entry + a scheduled_activity
// task. Points are NOT awarded here: the CRM client auto-completes
// the task once the meeting time passes (autoCompleteApptTasks), so
// points flow through the same client path as manual logging — no
// server-side day-doc mutation, no race with an open session.
// Idempotent via deterministic ids: tasks/appt_{meetingId},
// contact activities/appt_sched_{meetingId}.
// ============================================================
const APPT_MEETING_ACTIVITY = 'Attend 1:1, Coffee, Lunch, etc.';

exports.apptMeetingSweep = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'America/Chicago',
  secrets: [LOANIQ_SA_KEY],
}, async () => {
  const lqDb  = admin.firestore(getLoaniqAdminApp());
  const swhDb = admin.firestore();
  // 26h lookback with overlap — deterministic doc ids make re-processing a no-op
  const sinceTs = admin.firestore.Timestamp.fromMillis(Date.now() - 26 * 3600 * 1000);

  const usersSnap = await swhDb.collection('users').where('apptUid', '>', '').limit(300).get();
  console.log(`[apptMeetingSweep] ${usersSnap.size} linked users`);

  for (const u of usersSnap.docs) {
    const swhUid  = u.id;
    const apptUid = u.data().apptUid;

    // Reconcile pass FIRST — it must run even when there are no new
    // bookings (that's exactly when late cancels/reschedules happen).
    // Open myappointment tasks are re-checked against their live
    // meetings so a dead meeting can never auto-log points.
    try {
      const openTasks = await swhDb.collection(`users/${swhUid}/tasks`)
        .where('type', '==', 'scheduled_activity')
        .where('source', '==', 'myappointment')
        .where('status', '==', 'open')
        .limit(100).get();
      for (const tDoc of openTasks.docs) {
        const t = tDoc.data();
        if (!t.apptMeetingId) continue;
        const mSnap2 = await lqDb.doc(`users/${apptUid}/meetings/${t.apptMeetingId}`).get();
        const m2 = mSnap2.exists ? mSnap2.data() : null;
        if (!m2 || m2.status === 'cancelled' || m2.status === 'canceled') {
          await tDoc.ref.set({ status: 'canceled', canceledAt: new Date().toISOString() }, { merge: true });
          console.log(`[apptMeetingSweep] reconcile: canceled task ${tDoc.id} (${swhUid})`);
          continue;
        }
        if (m2.status === 'scheduled' && m2.start) {
          const sd = m2.start.toDate ? m2.start.toDate() : new Date(m2.start);
          const dk = sd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
          const hm = sd.toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' });
          if (t.dueDate !== dk || (t.startTime || '').slice(11, 16) !== hm) {
            await tDoc.ref.set({ dueDate: dk, startTime: `${dk}T${hm}:00` }, { merge: true });
            console.log(`[apptMeetingSweep] reconcile: moved task ${tDoc.id} → ${dk} ${hm} (${swhUid})`);
          }
        }
      }
    } catch (e) {
      console.error(`[apptMeetingSweep] reconcile ${swhUid}:`, e.message);
    }

    try {
      const mSnap = await lqDb.collection(`users/${apptUid}/meetings`)
        .where('bookedAt', '>=', sinceTs).get();
      if (mSnap.empty) continue;

      // Contacts + catalog loaded lazily — only when this user has fresh bookings
      let contacts = null;
      const loadContacts = async () => {
        if (contacts) return contacts;
        const cSnap = await swhDb.collection(`users/${swhUid}/contacts`).get();
        contacts = cSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        return contacts;
      };
      let oneOnOnePts = 10;
      try {
        const actCfg = await swhDb.doc(`users/${swhUid}/config/activities`).get();
        const def = actCfg.exists ? (actCfg.data().list || []).find(a => a.name === APPT_MEETING_ACTIVITY) : null;
        if (def && typeof def.pts === 'number') oneOnOnePts = def.pts;
      } catch (_) { /* default stands */ }

      for (const mDoc of mSnap.docs) {
        const m = mDoc.data();
        const meetingId = mDoc.id;
        const taskRef  = swhDb.doc(`users/${swhUid}/tasks/appt_${meetingId}`);
        const taskSnap = await taskRef.get();

        // Booking canceled after we tasked it → close the pending task.
        // MyAppointment writes 'cancelled' (double-L); tolerate both.
        if (m.status === 'cancelled' || m.status === 'canceled') {
          if (taskSnap.exists && taskSnap.data().status === 'open') {
            await taskRef.set({ status: 'canceled', canceledAt: new Date().toISOString() }, { merge: true });
            console.log(`[apptMeetingSweep] canceled task appt_${meetingId} (${swhUid})`);
          }
          continue;
        }
        if (m.status !== 'scheduled') continue;

        const startDate = m.start && m.start.toDate ? m.start.toDate() : new Date(m.start);
        const endDate   = m.end && m.end.toDate ? m.end.toDate() : null;
        const dateKey   = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        const hhmm      = startDate.toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' });

        // Rescheduled (same meeting doc, new start) → move the open task
        if (taskSnap.exists) {
          const t = taskSnap.data();
          if (t.status === 'open' && t.dueDate !== dateKey) {
            await taskRef.set({ dueDate: dateKey, startTime: `${dateKey}T${hhmm}:00` }, { merge: true });
            console.log(`[apptMeetingSweep] moved task appt_${meetingId} → ${dateKey} (${swhUid})`);
          }
          continue;
        }

        const bookerEmail = String(m.bookerEmail || '').trim().toLowerCase();
        if (!bookerEmail) continue;
        const all = await loadContacts();
        const contact = all.find(c => String(c.email || '').trim().toLowerCase() === bookerEmail);
        if (!contact) { console.log(`[apptMeetingSweep] no contact match for booker (${swhUid})`); continue; }

        const durationMins = endDate ? Math.max(15, Math.round((endDate - startDate) / 60000)) : 30;
        const bookedIso = (m.bookedAt && m.bookedAt.toDate ? m.bookedAt.toDate() : new Date()).toISOString();
        const bookedKey = new Date(bookedIso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        const whenLabel = startDate.toLocaleString('en-US', {
          timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });

        const batch = swhDb.batch();
        batch.set(taskRef, {
          type: 'scheduled_activity',
          contactId: contact.id,
          contactName: contact.name || bookerEmail,
          activityName: APPT_MEETING_ACTIVITY,
          potentialPts: oneOnOnePts,
          dueDate: dateKey,
          startTime: `${dateKey}T${hhmm}:00`,
          durationMins,
          note: 'Booked via myappointment.ai',
          label: `${APPT_MEETING_ACTIVITY} with ${contact.name || bookerEmail}`,
          status: 'open',
          createdAt: bookedIso,
          source: 'myappointment',
          apptMeetingId: meetingId,
          autoLog: true,
        });
        batch.set(swhDb.doc(`users/${swhUid}/contacts/${contact.id}/activities/appt_sched_${meetingId}`), {
          type: '1-on-1 Booked',
          source: 'myappointment',
          note: `Booked via myappointment.ai for ${whenLabel}`,
          points: 0,
          timestamp: bookedIso,
          dateKey: bookedKey,
          contactId: contact.id,
          contactName: contact.name || '',
        });
        await batch.commit();
        console.log(`[apptMeetingSweep] linked meeting ${meetingId} → contact ${contact.id} (${swhUid})`);
      }
    } catch (e) {
      console.error(`[apptMeetingSweep] user ${swhUid}:`, e.message);
    }
  }
});

// ============================================================
// apptCreateMeeting — host-initiated 1-on-1 at an agreed time.
// Writes a real meeting record into loaniq-75a20 so MyAppointment owns
// it (upcoming list, Next Meeting card, sweep semantics), and creates
// the SWH task + timeline entry immediately with the same ids the
// sweep uses, so the next sweep no-ops. confirmationSentAt is stamped
// so MyAppointment sends no emails — the contact is notified by the
// calendar invite the client creates via Nylas.
// ============================================================
exports.apptCreateMeeting = onRequest({ cors: true, secrets: [LOANIQ_SA_KEY] }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const { contactId, startISO, durationMins, nylasEventId, timezone } = req.body || {};
    const locationTxt = String(req.body?.location || '').trim().slice(0, 200);
    if (!contactId || !startISO) { res.status(400).json({ error: 'contactId and startISO required' }); return; }

    const [userSnap, contactSnap, actCfgSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.doc(`users/${uid}/contacts/${contactId}`).get(),
      db.doc(`users/${uid}/config/activities`).get(),
    ]);
    const apptUid = userSnap.exists ? (userSnap.data().apptUid || null) : null;
    if (!apptUid) { res.status(409).json({ error: 'no_myappointment_account' }); return; }
    if (!contactSnap.exists) { res.status(404).json({ error: 'Contact not found.' }); return; }
    const contact = contactSnap.data();
    if (!contact.email) { res.status(400).json({ error: 'Contact has no email address.' }); return; }

    const start = new Date(startISO);
    if (isNaN(start.getTime())) { res.status(400).json({ error: 'Invalid startISO' }); return; }
    const mins = Math.min(480, Math.max(15, Number(durationMins) || 60));
    const end = new Date(start.getTime() + mins * 60000);
    const meetingId = 'mtg_swh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const nowTs = admin.firestore.Timestamp.now();

    const lqDb = admin.firestore(getLoaniqAdminApp());
    await lqDb.doc(`users/${apptUid}/meetings/${meetingId}`).set({
      id: meetingId,
      userId: apptUid,
      product: 'mylola',
      meetingTypeId: null,
      bookingPageId: null,
      start: admin.firestore.Timestamp.fromDate(start),
      end: admin.firestore.Timestamp.fromDate(end),
      timezone: String(timezone || 'America/Chicago').slice(0, 64),
      status: 'scheduled',
      bookedAt: nowTs,
      source: 'swh_host_scheduled',
      calendarProvider: 'google',
      externalCalendarEventId: nylasEventId ? String(nylasEventId) : `swh_${meetingId}`,
      externalCalendarId: nylasEventId ? 'primary' : 'pending',
      intakeAnswers: {},
      location: locationTxt ? { type: 'custom', label: locationTxt } : null,
      remindersSent: [],
      bookerEmail: String(contact.email).trim().toLowerCase(),
      bookerName: contact.name || '',
      hostSlug: null,
      // onPublicBookingCreated no-ops when this is already set — no
      // MyAppointment confirmation/reminder emails for host-scheduled.
      confirmationSentAt: nowTs,
    });

    let oneOnOnePts = 10;
    const def = actCfgSnap.exists ? (actCfgSnap.data().list || []).find(a => a.name === APPT_MEETING_ACTIVITY) : null;
    if (def && typeof def.pts === 'number') oneOnOnePts = def.pts;

    const dateKey = start.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const hhmm = start.toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' });
    const bookedIso = new Date().toISOString();
    const whenLabel = start.toLocaleString('en-US', {
      timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });

    const task = {
      type: 'scheduled_activity',
      contactId,
      contactName: contact.name || contact.email,
      activityName: APPT_MEETING_ACTIVITY,
      potentialPts: oneOnOnePts,
      dueDate: dateKey,
      startTime: `${dateKey}T${hhmm}:00`,
      durationMins: mins,
      note: locationTxt ? `Where: ${locationTxt}` : 'Scheduled by you · myappointment.ai',
      label: `${APPT_MEETING_ACTIVITY} with ${contact.name || contact.email}`,
      status: 'open',
      createdAt: bookedIso,
      source: 'myappointment',
      apptMeetingId: meetingId,
      calendarEventId: nylasEventId ? String(nylasEventId) : null,
      autoLog: true,
    };
    const batch = db.batch();
    batch.set(db.doc(`users/${uid}/tasks/appt_${meetingId}`), task);
    batch.set(db.doc(`users/${uid}/contacts/${contactId}/activities/appt_sched_${meetingId}`), {
      type: '1-on-1 Booked',
      source: 'myappointment',
      note: `Scheduled by you for ${whenLabel}${locationTxt ? ' · ' + locationTxt : ''}`,
      points: 0,
      timestamp: bookedIso,
      dateKey: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }),
      contactId,
      contactName: contact.name || '',
    });
    await batch.commit();

    res.json({ ok: true, meetingId, task: { id: `appt_${meetingId}`, ...task } });
  } catch (e) {
    const code = e.statusCode || 500;
    console.error('[apptCreateMeeting]', e.message);
    res.status(code).json({ error: e.message || 'Failed to create meeting' });
  }
});

// Cancel a myappointment-linked meeting from the CRM. Marks the loaniq
// meeting 'cancelled' (MyAppointment's spelling), cancels its pending
// reminder messages, and closes the SWH task — kept, not deleted, so
// the sweep can't re-create it.
exports.apptCancelMeeting = onRequest({ cors: true, secrets: [LOANIQ_SA_KEY] }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;
    const meetingId = String(req.body?.meetingId || '').trim();
    if (!meetingId) { res.status(400).json({ error: 'meetingId required' }); return; }

    const [userSnap, taskSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.doc(`users/${uid}/tasks/appt_${meetingId}`).get(),
    ]);
    const apptUid = userSnap.exists ? (userSnap.data().apptUid || null) : null;
    if (!apptUid) { res.status(409).json({ error: 'no_myappointment_account' }); return; }
    if (!taskSnap.exists) { res.status(404).json({ error: 'Meeting task not found.' }); return; }

    const lqDb = admin.firestore(getLoaniqAdminApp());
    const mRef = lqDb.doc(`users/${apptUid}/meetings/${meetingId}`);
    const mSnap = await mRef.get();
    if (mSnap.exists && mSnap.data().status === 'scheduled') {
      await mRef.set({
        status: 'cancelled',
        cancelledAt: admin.firestore.Timestamp.now(),
        cancelledBy: 'swh_host',
      }, { merge: true });
      // Public bookings have queued reminder messages — cancel them so the
      // booker doesn't get reminded about a dead meeting.
      try {
        const pending = await lqDb.collection(`users/${apptUid}/scheduledMessages`)
          .where('meetingId', '==', meetingId).where('status', '==', 'pending').get();
        if (!pending.empty) {
          const b = lqDb.batch();
          pending.docs.forEach(d => b.set(d.ref, { status: 'cancelled' }, { merge: true }));
          await b.commit();
        }
      } catch (msgErr) {
        console.warn('[apptCancelMeeting] reminder cancel skipped:', msgErr.message);
      }
    }
    await db.doc(`users/${uid}/tasks/appt_${meetingId}`).set(
      { status: 'canceled', canceledAt: new Date().toISOString() }, { merge: true });

    res.json({ ok: true, calendarEventId: taskSnap.data().calendarEventId || null });
  } catch (e) {
    const code = e.statusCode || 500;
    console.error('[apptCancelMeeting]', e.message);
    res.status(code).json({ error: e.message || 'Failed to cancel' });
  }
});

// migrateProUsersToAppt — completed 2026-05-28, removed.

// ===== Nylas v3 unified integration (calendar / email / contacts) =====
// Serves both SWH surfaces (Scorecard + CRM) from this one backend.
// Functions: getNylasAuthUrl, nylasCallback, getUpcomingEvents,
// getContactThreads, getContacts, nylasWebhook, nylasFollowThroughSweep,
// nylasStatus, nylasDisconnect. See nylas.js + NYLAS_MIGRATION.md.
Object.assign(exports, require('./nylas'));

// ============================================================
// Relationship grading — server-side foundation
// ============================================================

// Trigger: keep lastMeaningfulInteractionAt on the contact in sync whenever
// an activity or email subcollection document is written. Uses MAX so it
// can never regress. Fires on both create and update.
exports.onActivityWrite = onDocumentWritten(
  'users/{uid}/contacts/{contactId}/activities/{actId}',
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return; // deletion — ignore
    const ts = after.timestamp || after.at || after.createdAt;
    if (!ts) return;
    const ref = admin.firestore().doc(`users/${event.params.uid}/contacts/${event.params.contactId}`);
    const snap = await ref.get();
    if (!snap.exists) return;
    const current = snap.data().lastMeaningfulInteractionAt || '';
    if (ts > current) await ref.update({ lastMeaningfulInteractionAt: ts });
  }
);

exports.onEmailWrite = onDocumentWritten(
  'users/{uid}/contacts/{contactId}/emails/{msgId}',
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return;
    const ts = after.receivedAt || after.timestamp || after.at;
    if (!ts) return;
    const ref = admin.firestore().doc(`users/${event.params.uid}/contacts/${event.params.contactId}`);
    const snap = await ref.get();
    if (!snap.exists) return;
    const current = snap.data().lastMeaningfulInteractionAt || '';
    if (ts > current) await ref.update({ lastMeaningfulInteractionAt: ts });
  }
);

// Dry-run backfill: returns proposed status per contact, writes NOTHING.
// Call via Firebase console or: firebase functions:call backfillRelationshipGrades
exports.backfillRelationshipGrades = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = req.auth.uid;
  const now = Date.now();
  const snap = await admin.firestore().collection(`users/${uid}/contacts`).get();
  const proposals = [];
  for (const d of snap.docs) {
    const c = d.data();
    const existing = c.status;
    // If already a graded status, keep it
    if (['aplus','a','b','c','d'].includes(existing)) {
      proposals.push({ id: d.id, name: c.name, current: existing, proposed: existing, reason: 'already graded' });
      continue;
    }
    // Derive from recency of lastMeaningfulInteractionAt or lastActivityAt
    const lastTouch = c.lastMeaningfulInteractionAt || c.lastActivityAt || c.addedAt;
    const daysSince = lastTouch ? Math.floor((now - Date.parse(lastTouch)) / 86400000) : 9999;
    let proposed = 'b'; // default for new contacts with activity
    if (daysSince <= 30) proposed = 'a';
    else if (daysSince <= 90) proposed = 'b';
    else if (daysSince <= 365) proposed = 'c';
    else proposed = 'd';
    // No activity at all → default to new/ungraded, leave as 'new'
    if (!lastTouch) proposed = 'new';
    proposals.push({ id: d.id, name: c.name, current: existing || 'new', proposed, daysSince, reason: `${daysSince}d since last touch` });
  }
  return { dryRun: true, count: proposals.length, proposals };
});

// ============================================================
// FOLLOW-THROUGH QUEUE — morning build job + Lola drafter
// ============================================================

function chicagoTodayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function addDaysServer(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Normalize clockStarted to a 'YYYY-MM-DD' key. Accepts a date-only string,
// a full ISO datetime, a Firestore Timestamp, a Date, or epoch ms. Returns
// null if it cannot be parsed, so the caller can skip that one contact
// instead of crashing the whole run on an Invalid Date.
function toDateKey(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  try {
    const d = typeof v.toDate === 'function' ? v.toDate() : new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  } catch (_) {
    return null;
  }
}

// Build the user's email signature: name, phone, email (or a custom
// emailSignature override). Appended to every drafted follow-through.
// Contact block appended UNDER the model's own sign-off (it signs with the name
// in Austen's voice; we add the real phone + email so they are never guessed).
function buildSignature(ud) {
  ud = ud || {};
  if (ud.emailSignature) return String(ud.emailSignature).trim();
  return [ud.phone || '', ud.email || ''].filter(Boolean).join('\n');
}

// Per-step link that must appear in the draft, exactly. Keyed off the step
// name so it works with custom playbook step names (e.g. "The Networking Wire
// Invitation", "Invite to 1:1").
function stepLink(stepName) {
  const n = String(stepName || '').toLowerCase();
  if (n.includes('networking wire')) return 'https://thenetworkingwire.com';
  if (n.includes('invite')) return 'https://schedule.austensmith.com';
  return null;
}

// Austen's writing voice, distilled from his real samples + the copy across his
// products. Used as the system prompt so every draft sounds like he wrote it.
const VOICE_PROFILE = `You are drafting a networking follow-up email AS Austen Smith. It must read like Austen personally typed it, never like AI.

VOICE: Warm, confident, educational, helpful-first. You are a guide who happens to do mortgages, not a salesperson. Write the way you talk.

GREETING: Use "Hi [First]," for clients, prospects, and newer contacts. Use "Hey [First]," for warm or partner relationships. For a milestone or congrats note, the first name alone on a line is fine. Never "Dear."

LENGTH: Short. Two to four short paragraphs, most one to three sentences each, roughly 100 to 250 words. One idea per email. Concise is respectful.

STRUCTURE: (1) Warm opener referencing where you met or the last conversation. (2) One genuine helpful-first reason for the note: teach one small thing, share a resource, or just check in. (3) A single soft next step, or simply end warmly with no ask at all. (4) A short warm closing line. (5) Sign-off plus your first name.

RHYTHM: Short declaratives and the occasional fragment for emphasis. Mix one longer warm clause in, then snap back short. Heavy contractions, active voice, natural speech. Use parentheses for asides. Never use em-dashes.

NEVER ANNOUNCE WHAT THE EMAIL IS NOT: no "No agenda," "No pitch," "Not trying to sell you anything," "This isn't a sales email," or any variant in any construction ("no agenda beyond...", "no agenda here", "zero pitch"). The words "agenda" and "pitch" must not appear anywhere in the email, period. Saying what the email isn't reads exactly like the thing it denies. If there is no ask, just end warmly without announcing it.

FACTS ARE SACRED: Only reference things explicitly present in the context you are given (where you met, notes, FORM details). NEVER invent meetings, conversations, referrals, introductions, favors, names, or shared history. If you have no specific detail to draw on, stay general and honest rather than making something up.

EARLY RELATIONSHIPS (roughly the first half of the follow-through steps, or any first-touch email): zero mortgage or financing content unless their notes show they asked. The only goal is the relationship. Business value can wait until it is earned.

CARRY-THE-WORK OFFERS to draw from (at most one per email, and only once the relationship warrants it): "I'm one text away," "give me 5 min on a call," "happy to point you in the right direction," "happy to think out loud with you," "let me know if there's ever anything I can help with."
Keep recommendations soft and collaborative: "probably makes the most sense," "Want me to...?" Never "You should" or "I recommend" as a command. Validate the person before suggesting anything.

SIGN-OFFS to rotate: "Thanks, Austen" / "Chat soon, Austen" / "Talk soon, Austen" / just "Austen." On a more formal first touch, "Thanks, Austen Smith." Never "Best regards," "Sincerely," or a title block.

NEVER USE: em-dashes, emoji, corporate filler ("I hope this finds you well," "circle back," "touch base," "per our conversation"), urgency or salesy lines ("act now," "don't miss out," "let's hop on a quick call to discuss how I can add value"), hype adjectives ("premier," "world-class," "stunning," "must-see"), menus of multiple asks, markdown headers or bold, or perfectly balanced robotic cadence. Vary your sentence length so it sounds human.

Examples of how Austen writes (match this voice and rhythm; do not copy verbatim or reuse their specifics):

EXAMPLE (good to meet you):
Hi John,

It was great meeting you today. I always enjoy connecting with people who are out building real relationships, not just chasing the next deal.

As promised, wanted to introduce myself properly. I've been in the mortgage world for over 20 years, but the part I actually care about is helping clients and referral partners understand the why behind a financing decision instead of just quoting rates.

If there's ever anything I can do for you, your clients, or even just a quick mortgage question, don't hesitate to reach out. And if you're ever not sure who to call on something, I'm happy to point you in the right direction.

Looking forward to staying in touch.

Thanks,
Austen

EXAMPLE (value, no ask):
Hey Sarah,

Came across this and thought of our conversation the other day.

One thing I've learned over the years: the people who stay in front of their database consistently are usually the ones still getting referrals years after a deal closes. It doesn't have to be complicated. Just staying top of mind does most of the work.

Figured you'd appreciate it since we were talking about building long-term relationships instead of constantly chasing new business.

Hope you're having a great week. Let me know if there's ever anything I can help with.

Chat soon,
Austen

EXAMPLE (check-in):
Hi Mike,

Hope you've been doing well.

It's been a little while since we last talked, so I just wanted to check in and see how things are going. How's business been?

If anything's changed, if you've got questions about the market, or if someone comes to mind who could use a second opinion on financing, I'm always happy to help.

Hope you have a great rest of your week.

Thanks,
Austen`;

// In-process drafter — called by the build job directly, no HTTP overhead.
async function draftWriteStep(ctx) {
  const { stepName, stepDescription, contactName, contactCompany, contactEvent,
          notesPreview, form, userFirstName, daysSinceClockStart,
          userFeedback, previousBody, signature, linkUrl } = ctx;

  const systemPrompt = VOICE_PROFILE + `

Return ONLY valid JSON, no prose, no markdown fences:
{"subject":"<email subject, 5-10 words, warm and specific, no em-dashes>","body":"<the full email body in Austen's voice, first-person, referencing the contact by first name. End with a short sign-off and his first name (e.g. Thanks, Austen). Do NOT add phone, email, or a contact block; that is appended automatically. No bracket placeholders, no em-dashes>","text":"<same as body>"}`;

  const userMessage = [
    `Step to complete: ${stepName}`,
    stepDescription ? `Step goal: ${stepDescription}` : '',
    `Contact: ${contactName}${contactCompany ? ' at ' + contactCompany : ''}`,
    contactEvent ? `Where we met: ${contactEvent}` : '',
    `Days since clock started: ${daysSinceClockStart || 0}`,
    notesPreview ? `My notes: ${notesPreview}` : '',
    form && (form.family || form.occupation || form.recreation || form.motivation)
      ? `FORM intel: ${JSON.stringify(form)}` : '',
    `My name: ${userFirstName || 'Austen'}`,
    linkUrl ? `IMPORTANT: you MUST include this exact link in the message, written out in full and unchanged — do not alter, shorten, or invent a different URL: ${linkUrl}` : '',
    previousBody ? `\nMy current draft (revise this, keep what works):\n${previousBody}` : '',
    userFeedback ? `What to change — apply exactly: ${userFeedback}` : '',
    '',
    userFeedback ? 'Revise my message with those instructions. Return the same JSON shape.' : 'Draft this message for me.',
  ].filter(Boolean).join('\n');

  const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY.value(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!apiResp.ok) throw new Error(`Anthropic ${apiResp.status}`);
  const result = await apiResp.json();
  const raw = result.content?.[0]?.text || '';

  const sig = signature ? '\n' + signature : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { subject: stepName, body: raw + sig, text: raw + sig };
  try {
    const parsed = JSON.parse(match[0]);
    const body = (parsed.body || parsed.text || raw) + sig;
    const text = (parsed.text || parsed.body || raw) + sig;
    return { subject: parsed.subject || stepName, body, text };
  } catch (_) {
    return { subject: stepName, body: raw + sig, text: raw + sig };
  }
}

const DEFAULT_STEP_OFFSETS_SERVER = [1, 3, 6, 10, 14, 21, 30, 45];
const DEFAULT_STEP_NAMES_SERVER = [
  'Good to Meet You Message', 'Social Connection', 'Value Touch (No Ask)',
  'Invite to 1:1', 'FORM Conversation (1:1)', 'Strategic Follow Through',
  'Stay Top of Mind', 'Long-Term Positioning',
];
const DEFAULT_STEP_PTS_SERVER = [5, 5, 5, 5, 10, 10, 5, 5];

async function runFollowThroughQueueBuild() {
  const todayKey = chicagoTodayKey();
  console.log('[buildFollowThroughQueue] running for', todayKey);

  // V1 gate: build for ADMIN_EMAILS directly. Drafting needs no email
  // connection — do NOT key on Nylas grants (Nylas is being replaced by
  // Unipile/Lola Connect; the send path migrates there, drafts shouldn't
  // die with the old stack).
  for (const adminEmail of ADMIN_EMAILS) {
    let uid = null;
    try {
      uid = (await admin.auth().getUserByEmail(adminEmail)).uid;
    } catch (_) {
      console.warn('[buildFollowThroughQueue] no auth user for', adminEmail);
      continue;
    }
    console.log('[buildFollowThroughQueue] uid', uid);

    const [userSnap, pbSnap, contactsSnap] = await Promise.all([
      admin.firestore().doc(`users/${uid}`).get(),
      admin.firestore().collection(`users/${uid}/playbooks`).get(),
      admin.firestore().collection(`users/${uid}/contacts`).get(),
    ]);

    const userDoc = userSnap.exists ? userSnap.data() : {};
    const userFirstName = (userDoc.displayName || userDoc.name || 'Austen').split(' ')[0];

    const playbooks = {};
    let defaultPbId = null;
    for (const pb of pbSnap.docs) {
      const d = pb.data();
      playbooks[pb.id] = d;
      if (d.isDefault) defaultPbId = pb.id;
    }

    for (const cd of contactsSnap.docs) {
      const c = cd.data();
      const contactId = cd.id;

      if (!c.clockStarted) continue;
      const clockKey = toDateKey(c.clockStarted);
      if (!clockKey) { console.warn('[buildFollowThroughQueue] skip', contactId, '- unparseable clockStarted:', c.clockStarted); continue; }
      if (c.wasted) continue;
      if (c.cadencePaused) continue;
      const stepsDone = c.steps || 0;
      if (stepsDone >= 8) continue;

      const pbId = c.playbookId && playbooks[c.playbookId] ? c.playbookId : defaultPbId;
      const pb = pbId ? playbooks[pbId] : null;
      const stepOffsets = pb?.steps?.map(s => s.offsetDays) || DEFAULT_STEP_OFFSETS_SERVER;
      const stepMetas = pb?.steps || null;

      const N = stepsDone;
      if (N >= stepOffsets.length) continue;

      const dueDate = addDaysServer(clockKey, stepOffsets[N]);
      if (dueDate > todayKey) continue;

      const docId = `${contactId}_${N}`;
      const existingSnap = await admin.firestore().doc(`users/${uid}/followThroughQueue/${docId}`).get();
      if (existingSnap.exists) {
        const ex = existingSnap.data();
        if (ex.status === 'sent' || ex.status === 'skipped') continue;
        if (ex.builtAt && ex.builtAt.slice(0, 10) === todayKey) continue;
      }

      const stepMeta = stepMetas?.[N] || {};
      const stepName = stepMeta.name || DEFAULT_STEP_NAMES_SERVER[N] || `Step ${N + 1}`;
      const stepDescription = stepMeta.description || '';
      const stepPoints = stepMeta.points || DEFAULT_STEP_PTS_SERVER[N] || 5;
      const notesPreview = c.notes ? String(c.notes).slice(0, 300) : '';
      const daysSinceClockStart = Math.floor(
        (Date.now() - new Date(clockKey + 'T12:00:00Z').getTime()) / 86400000
      );

      let draftSubject = stepName;
      let draftBody = '';
      try {
        const draft = await draftWriteStep({
          stepName, stepDescription,
          contactName: c.name,
          contactCompany: c.company || '',
          contactEvent: c.event || '',
          notesPreview,
          form: c.form || {},
          userFirstName,
          daysSinceClockStart,
          signature: buildSignature(userDoc),
          linkUrl: stepLink(stepName),
        });
        draftSubject = draft.subject;
        draftBody = draft.body;
      } catch (err) {
        console.error('[buildFollowThroughQueue] draft failed:', c.name, err.message);
      }

      await admin.firestore().doc(`users/${uid}/followThroughQueue/${docId}`).set({
        contactId,
        contactName: c.name,
        contactEmail: c.email || '',
        stepIndex: N,
        stepName,
        stepPoints,
        dueDate,
        draftSubject,
        draftBody,
        channel: 'email',
        status: 'pending',
        builtAt: new Date().toISOString(),
      });

      console.log('[buildFollowThroughQueue] queued', c.name, 'step', N + 1);
    }
  }

  console.log('[buildFollowThroughQueue] done');
}

exports.buildFollowThroughQueue = onSchedule({
  schedule: 'every day 08:00',
  timeZone: 'America/Chicago',
  secrets: [ANTHROPIC_API_KEY],
}, runFollowThroughQueueBuild);

// Manual trigger for the morning draft builder — refills the Morning
// Queue after an outage instead of waiting for the 8am cron. Idempotent
// (same builtAt/status skips as the nightly run) and internally gated to
// ADMIN_EMAILS grants, so any-authenticated-caller is safe.
exports.buildFollowThroughQueueNow = onRequest({
  cors: true,
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 540,
  invoker: 'public',
}, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    await requireAuth(req);
    await runFollowThroughQueueBuild();
    res.json({ ok: true });
  } catch (e) {
    const code = e.statusCode || 500;
    console.error('[buildFollowThroughQueueNow]', e.message);
    res.status(code).json({ error: e.message || 'Build failed' });
  }
});

// Regenerate a single follow-through draft with the user's revision notes.
// Called from the queue's "Regenerate" button. Reuses draftWriteStep with the
// previous draft + the user's instructions, then writes the new draft back.
exports.regenerateFollowThroughDraft = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const docId = request.data?.docId;
  const feedback = String(request.data?.feedback || '').slice(0, 500);
  if (!docId) throw new HttpsError('invalid-argument', 'docId required');

  const qRef = db.doc(`users/${uid}/followThroughQueue/${docId}`);
  const qSnap = await qRef.get();
  if (!qSnap.exists) throw new HttpsError('not-found', 'Queue item not found');
  const q = qSnap.data();

  const [contactSnap, userSnap] = await Promise.all([
    q.contactId ? db.doc(`users/${uid}/contacts/${q.contactId}`).get() : Promise.resolve(null),
    db.doc(`users/${uid}`).get(),
  ]);
  const c = (contactSnap && contactSnap.exists) ? contactSnap.data() : {};
  const ud = userSnap.data() || {};
  const userFirstName = String(ud.displayName || ud.name || 'Austen').split(' ')[0];

  const draft = await draftWriteStep({
    stepName: q.stepName,
    stepDescription: '',
    contactName: q.contactName || c.name || 'there',
    contactCompany: c.company || '',
    contactEvent: c.event || '',
    notesPreview: c.notes ? String(c.notes).slice(0, 300) : '',
    form: c.form || {},
    userFirstName,
    daysSinceClockStart: 0,
    userFeedback: feedback,
    previousBody: q.draftBody || '',
    signature: buildSignature(ud),
    linkUrl: stepLink(q.stepName),
  });

  await qRef.set({
    draftSubject: draft.subject,
    draftBody: draft.body,
    regeneratedAt: new Date().toISOString(),
  }, { merge: true });

  return { subject: draft.subject, body: draft.body };
});

// On-demand draft for any contact step — no queue item created.
// Called from the "Draft Email" button on a contact's step card.
exports.generateStepDraft = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid       = request.auth.uid;
  const contactId = String(request.data?.contactId || '').trim();
  const stepIndex = Number(request.data?.stepIndex  ?? -1);
  if (!contactId || stepIndex < 0 || stepIndex > 7)
    throw new HttpsError('invalid-argument', 'contactId and stepIndex (0-7) required');
  const guidance = String(request.data?.guidance || '').slice(0, 500);
  const prevBody = String(request.data?.previousDraft?.body || '').slice(0, 2500);

  const [contactSnap, userSnap, pbSnap] = await Promise.all([
    db.doc(`users/${uid}/contacts/${contactId}`).get(),
    db.doc(`users/${uid}`).get(),
    db.collection(`users/${uid}/playbooks`).get(),
  ]);
  if (!contactSnap.exists) throw new HttpsError('not-found', 'Contact not found');
  const c  = contactSnap.data();
  const ud = userSnap.data() || {};
  const userFirstName = String(ud.displayName || ud.name || 'Austen').split(' ')[0];

  const playbooks = {};
  let defaultPbId = null;
  for (const pb of pbSnap.docs) {
    const d = pb.data();
    playbooks[pb.id] = d;
    if (d.isDefault) defaultPbId = pb.id;
  }
  const pbId     = c.playbookId && playbooks[c.playbookId] ? c.playbookId : defaultPbId;
  const pb       = pbId ? playbooks[pbId] : null;
  const stepMeta = pb?.steps?.[stepIndex] || {};

  const stepName        = stepMeta.name        || DEFAULT_STEP_NAMES_SERVER[stepIndex] || `Step ${stepIndex + 1}`;
  const stepDescription = stepMeta.description || '';
  const clockKey        = toDateKey(c.clockStarted);
  const daysSinceClockStart = clockKey
    ? Math.floor((Date.now() - new Date(clockKey + 'T12:00:00Z').getTime()) / 86400000)
    : 0;

  const draft = await draftWriteStep({
    stepName, stepDescription,
    contactName:    c.name    || 'there',
    contactCompany: c.company || '',
    contactEvent:   c.event   || '',
    notesPreview:   c.notes   ? String(c.notes).slice(0, 300) : '',
    form:           c.form    || {},
    userFirstName,
    daysSinceClockStart,
    userFeedback: guidance,
    previousBody: prevBody,
    signature: buildSignature(ud),
    linkUrl:   stepLink(stepName),
  });

  return { subject: draft.subject, body: draft.body };
});

// Context-aware email draft — NOT tied to a specific step.
// Knows where the contact is in the sequence and pivots the prompt:
//   - mid-sequence: right touch for where the relationship is
//   - all 8 done:   creative reason to re-engage without an agenda
exports.draftContactEmail = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid       = request.auth.uid;
  const contactId = String(request.data?.contactId || '').trim();
  if (!contactId) throw new HttpsError('invalid-argument', 'contactId required');

  const [contactSnap, userSnap] = await Promise.all([
    db.doc(`users/${uid}/contacts/${contactId}`).get(),
    db.doc(`users/${uid}`).get(),
  ]);
  if (!contactSnap.exists) throw new HttpsError('not-found', 'Contact not found');
  const c  = contactSnap.data();
  const ud = userSnap.data() || {};
  const userFirstName = String(ud.displayName || ud.name || 'Austen').split(' ')[0];

  const stepsDone = c.steps || 0;
  const allDone   = stepsDone >= 8;
  const clockKey  = toDateKey(c.clockStarted);
  const daysSince = clockKey
    ? Math.floor((Date.now() - new Date(clockKey + 'T12:00:00Z').getTime()) / 86400000)
    : 0;

  // User-picked intent from the Lola Draft modal; 'auto' keeps the
  // step-aware default. Guidance + previousDraft come from Regenerate.
  const draftType = String(request.data?.draftType || 'auto');
  const guidance  = String(request.data?.guidance || '').slice(0, 500);
  const prev      = request.data?.previousDraft || null;
  const prevBody  = prev ? String(prev.body || '').slice(0, 2500) : '';
  // 1-on-1 drafts carry the user's own myappointment.ai booking link so the
  // contact can pick a time — bookings then flow back via apptMeetingSweep.
  const bookingUrlRaw = String(request.data?.bookingUrl || '');
  const bookingUrl = /^https:\/\/myappointment\.ai\/[\w\-\/]+$/.test(bookingUrlRaw) ? bookingUrlRaw : '';

  const INTENT_SITUATIONS = {
    one_on_one: 'Draft an invitation to get together for a 1-on-1: coffee, lunch, or a quick call in the next week or two. Warm and low-pressure, focused on getting to know them and what they are building. Make the ask easy to say yes to and let them pick the time.',
    check_in:   'Draft a short check-in: you were thinking about them and wanted them to know. Reference something specific they shared (family, work, season of life) if the context includes it. Do not include any request, offer, or business content. A few sentences is plenty.',
    thank_you:  'Draft a genuine thank-you. Look ONLY at the notes and FORM intel for what to thank them for; if nothing specific is recorded there, thank them for their time and the conversation when you met, and leave it at that. When you do have a real detail, be specific about what it meant. Gratitude only.',
    reconnect:  'It has been a while since you two connected. Draft a warm re-opening that acknowledges the gap without over-apologizing, references something you actually know about them from the context, and gives a genuine reason to reconnect. No guilt, no manufactured urgency.',
  };
  const relationshipLine = `Relationship status: ${stepsDone} of 8 follow-through steps completed${daysSince ? `, ${daysSince} days since you met` : ''}. Match the warmth and familiarity to that depth.`;

  const autoSituation = allDone
    ? `You have completed all 8 follow-through steps with this person. They are a real, cultivated relationship — not a prospect to chase. The goal of this email is to keep the relationship warm and prevent it from going stagnant. Find a genuine, specific reason to reach out grounded ONLY in what the context below tells you: a useful resource, something tied to what they shared (family, work, hobbies, goals), a milestone worth acknowledging, or a simple human check-in. A real touch that reminds them you think of them, with nothing to sell and no announcement that there is nothing to sell.`
    : `You have completed ${stepsDone} of 8 follow-through steps with this person (${daysSince} days since you met). This is NOT a scripted step — just draft the right email for where you are with them right now. Match the tone and depth to the relationship as it actually stands at this moment.`;

  const situation = INTENT_SITUATIONS[draftType]
    ? INTENT_SITUATIONS[draftType] + '\n' + relationshipLine
    : autoSituation;

  const formParts = c.form
    ? ['family','occupation','recreation','motivation'].map(k => c.form[k] ? `${k}: ${c.form[k]}` : '').filter(Boolean)
    : [];

  const userMessage = [
    situation,
    `Contact: ${c.name}${c.company ? ' at ' + c.company : ''}`,
    c.event   ? `Where we met: ${c.event}` : '',
    `My name: ${userFirstName}`,
    c.notes   ? `My notes on them: ${String(c.notes).slice(0, 300)}` : '',
    formParts.length ? `FORM intel — ${formParts.join(' | ')}` : '',
    (draftType === 'one_on_one' && bookingUrl)
      ? `IMPORTANT: you MUST include this exact scheduling link in the message, written out in full and unchanged — do not alter, shorten, or invent a different URL. Present it as the easy way to grab a time that works for them: ${bookingUrl}`
      : '',
    prevBody ? `\nMy current draft (revise this, keep what works):\nSubject: ${String(prev.subject || '')}\n${prevBody}` : '',
    guidance ? `What to change — apply exactly: ${guidance}` : '',
    '',
    (guidance || prevBody) ? 'Revise my email with those instructions. Return the same JSON shape.' : 'Draft this email for me.',
  ].filter(Boolean).join('\n');

  const systemPrompt = VOICE_PROFILE + `\n\nReturn ONLY valid JSON, no prose, no markdown fences:\n{"subject":"<email subject, 5-10 words, warm and specific, no em-dashes>","body":"<the full email body in Austen's voice, first-person, referencing the contact by first name. End with a short sign-off and his first name (e.g. Thanks, Austen). Do NOT add phone, email, or a contact block; that is appended automatically. No bracket placeholders, no em-dashes>","text":"<same as body>"}`;

  const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY.value(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!apiResp.ok) throw new Error(`Anthropic ${apiResp.status}`);
  const result = await apiResp.json();
  const raw    = result.content?.[0]?.text || '';
  const sig    = buildSignature(ud) ? '\n' + buildSignature(ud) : '';
  const match  = raw.match(/\{[\s\S]*\}/);
  if (!match) return { subject: 'Checking in', body: raw + sig };
  try {
    const parsed = JSON.parse(match[0]);
    return { subject: parsed.subject || 'Checking in', body: (parsed.body || raw) + sig };
  } catch (_) {
    return { subject: 'Checking in', body: raw + sig };
  }
});

// ===================================================================
// SWH CRM ONBOARDING DRIP
// 14 emails, one per business day (Mon-Fri 7am America/Chicago).
// Enrollment: top-level onboardingDrip/{uid} — single-field range query,
// no composite index needed. First-enrollment-only (idempotent).
// Unsubscribe: tokenized public HTTP endpoint (no login); sets
//   users/{uid}/config/settings.onboardingDripUnsubscribed = true.
// HMAC signing reuses OAUTH_STATE_SECRET (already deployed).
// ===================================================================

const _ARROWS_URL  = 'https://swh-crm.web.app/assets/swh/swh-arrows.png';
const _APPT_URL    = 'https://myappointment.ai/austensmith/welcome-call';
const _PREFS_URL   = 'https://crm.stopwastinghandshakes.com';
const _UNSUB_BASE  = 'https://us-central1-swh-scoreboard.cloudfunctions.net/unsubscribeEmail';
const _DRIP_FROM   = 'Austen with SWH <noreply@stopwastinghandshakes.com>';
const _DRIP_REPLY  = 'hello@mylola.ai';

// Curriculum — exact copy from SWH-Onboarding-Emails.html
const ONBOARDING_CURRICULUM = [
  { day: 1,  subject: "You're in. Your first 5 minutes.",                 preheader: "Three quick steps and you're rolling.",          heading: "You're in. Your first 5 minutes.",                 body: "Welcome to the networking CRM built on the 8-Step Follow-Through. Handshakes are the seed, follow through is the harvest. Five minutes gets you set up.",                                                                         tryline: "finish your profile, set your weekly goal, and open your Scorecard.", ctaText: "Open my Scorecard",    ctaUrl: "https://app.stopwastinghandshakes.com",  day1Book: true  },
  { day: 2,  subject: "The one habit that changes everything.",            preheader: "Log your day. Every day.",                        heading: "The one habit that changes everything.",            body: "The habit that separates great networkers from busy ones: they log their day, every day. Your Scorecard turns every call and coffee into points you can actually see.",                                                         tryline: "log today's activity on the Scorecard.",               ctaText: "Log my day",           ctaUrl: "https://app.stopwastinghandshakes.com"                   },
  { day: 3,  subject: "Lead vs lag: why activity wins.",                   preheader: "Chase the number you control.",                   heading: "Lead vs lag: why activity wins.",                   body: "Lag points are outcomes you can't force. Lead points are the reach-outs you control. Stack the lead points and the lag points follow.",                                                                                           tryline: "hit your lead-point goal before 5pm.",                 ctaText: "See my points",        ctaUrl: "https://app.stopwastinghandshakes.com"                   },
  { day: 4,  subject: "Handshakes are the seed. Here's the harvest.",      preheader: "Meet the 8-Step Follow-Through.",                 heading: "Handshakes are the seed. Here's the harvest.",      body: "Most people collect cards and never follow up. The 8-Step Follow-Through turns one handshake into a real relationship. Pick a contact and start their clock.",                                                                  tryline: "start the 8-step on one contact.",                     ctaText: "Start a follow-through", ctaUrl: "https://crm.stopwastinghandshakes.com"                },
  { day: 5,  subject: "Add the people you actually met.",                  preheader: "Every handshake becomes a contact.",              heading: "Add the people you actually met.",                  body: "Your follow-through is only as good as your list. Add the people you met this week so no one slips through the cracks.",                                                                                                        tryline: "add or import 5 contacts.",                            ctaText: "Add contacts",         ctaUrl: "https://crm.stopwastinghandshakes.com"                   },
  { day: 6,  subject: "Your follow-through on autopilot.",                 preheader: "Playbooks run the 8 steps for you.",              heading: "Your follow-through on autopilot.",                 body: "A Playbook is your 8-step cadence, ready to assign. Set it once and every new contact follows the same proven path, no remembering, no dropping the ball.",                                                                     tryline: "assign a Playbook to a contact.",                      ctaText: "Open Playbooks",       ctaUrl: "https://crm.stopwastinghandshakes.com"                   },
  { day: 7,  subject: "Step 1 of 8: the message that sounds like you.",    preheader: "The 24-hour touch.",                             heading: "Step 1 of 8: the message that sounds like you.",    body: "Step one is the 24-hour touch: short, genuine, sent while the handshake is still warm. Make it sound like you, not a template.",                                                                                                tryline: "send step one to a new contact.",                      ctaText: "Send step one",        ctaUrl: "https://crm.stopwastinghandshakes.com"                   },
  { day: 8,  subject: "Stop logging by hand. Connect your inbox.",         preheader: "Auto-log emails, sync your calendar.",           heading: "Stop logging by hand. Connect your inbox.",         body: "Connect your email once and SWH auto-logs your touches, syncs your calendar, and pulls your network into Contacts. Less data entry, more relationship.",                                                                         tryline: "connect your email in Settings.",                      ctaText: "Connect my inbox",     ctaUrl: "https://crm.stopwastinghandshakes.com"                   },
  { day: 9,  subject: "Turn contacts into opportunities.",                 preheader: "Your queue, cleared daily.",                     heading: "Turn contacts into opportunities.",                 body: "As contacts move through the 8 steps, real opportunities surface. Your follow-through queue shows exactly who's due today, so you never wonder who to call next.",                                                               tryline: "clear today's follow-through queue.",                  ctaText: "See my queue",         ctaUrl: "https://crm.stopwastinghandshakes.com"                   },
  { day: 10, subject: "The 1-to-1 that makes a referral partner.",         preheader: "Coffee is where it happens.",                    heading: "The 1-to-1 that makes a referral partner.",         body: "The 1-to-1 is the heart of it: a real FORM conversation (Family, Occupation, Recreation, Motivation) that turns an acquaintance into someone who sends you business.",                                                        tryline: "schedule one 1-to-1 this week.",                       ctaText: "Book a 1-to-1",        ctaUrl: "https://crm.stopwastinghandshakes.com"                   },
  { day: 11, subject: "Give to get: the referral flywheel.",               preheader: "The fastest way to receive is to give.",         heading: "Give to get: the referral flywheel.",               body: "Referrals compound. Give one intro this week and watch what comes back. Giving is a lead activity too, so log it.",                                                                                                              tryline: "give one referral or make one intro.",                 ctaText: "Log a referral",       ctaUrl: "https://crm.stopwastinghandshakes.com"                   },
  { day: 12, subject: "Don't break the streak.",                           preheader: "Consistency is the edge.",                       heading: "Don't break the streak.",                           body: "One great week doesn't build a network. Showing up every day does. Even a single touch keeps the streak alive.",                                                                                                                tryline: "log something today.",                                 ctaText: "Log today",            ctaUrl: "https://app.stopwastinghandshakes.com"                   },
  { day: 13, subject: "Your week in review.",                              preheader: "Your numbers don't lie.",                        heading: "Your week in review.",                              body: "Every week your recap shows what you actually did: lead points, lag points, your best day, your streak. Read it like game film, then set next week's goal.",                                                                     tryline: "review last week's recap.",                            ctaText: "See my recap",         ctaUrl: "https://app.stopwastinghandshakes.com"                   },
  { day: 14, subject: "You built the habit. What's next.",                 preheader: "Now scale it.",                                  heading: "You built the habit. What's next.",                 body: "Two weeks in, you've logged your days, started follow-throughs, and connected your network. This is where it compounds. Invite your team and set a bigger goal.",                                                               tryline: "invite a teammate or set next month's goal.",          ctaText: "Keep building",        ctaUrl: "https://crm.stopwastinghandshakes.com"                   },
];

function _makeUnsubUrl(uid, secret) {
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', secret).update(uid + ':onboarding').digest('hex').slice(0, 32);
  return `${_UNSUB_BASE}?uid=${encodeURIComponent(uid)}&cat=onboarding&t=${sig}`;
}

function _buildDripHtml(entry, firstName, unsubUrl, prefsUrl) {
  const fn = escHtml(firstName || 'there');
  const bookHead = entry.day1Book ? 'Want to meet the creator?' : 'Need a hand, or want to talk strategy?';
  const bookBody = entry.day1Book
    ? 'I built SWH, and I&#x27;d love to help you get rolling. Grab a free 30 minutes with me whenever works for you. Austen'
    : 'Book a free 30-minute call with Austen, the creator of SWH.';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${escHtml(entry.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#e9e9ec;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a0a" style="background:#0a0a0a;">
<tr><td align="center" style="padding:26px 16px 40px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
  <tr><td style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escHtml(entry.preheader)}</td></tr>
  <tr><td style="background:#0a0a0a;padding:16px 30px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" style="padding-right:11px;"><img src="${_ARROWS_URL}" width="26" height="28" alt="SWH" style="display:block;border:0;"></td>
      <td valign="middle" style="font:bold 20px/1 Georgia,serif;color:#ffffff;letter-spacing:.04em;">SWH</td>
      <td valign="middle" style="padding-left:13px;"><span style="font:600 11px/1 Arial,sans-serif;color:#9a9a9a;letter-spacing:.1em;text-transform:uppercase;">Stop&nbsp;Wasting&nbsp;Handshakes</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:34px 30px 24px;">
    <h1 style="margin:0 0 18px;font:bold 23px/1.25 Arial,sans-serif;color:#1a1a1a;">${escHtml(entry.heading)}</h1>
    <p style="margin:0 0 16px;font:400 15px/1.6 Arial,sans-serif;color:#333;">Hi&nbsp;${fn},</p>
    <p style="margin:0 0 22px;font:400 15px/1.6 Arial,sans-serif;color:#333;">${escHtml(entry.body)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 26px;"><tr>
      <td style="border-left:3px solid #E63946;background:#fcf3f4;padding:12px 16px;border-radius:0 6px 6px 0;">
        <span style="font:700 13px/1.5 Arial,sans-serif;color:#E63946;">Try today:</span>
        <span style="font:400 14px/1.5 Arial,sans-serif;color:#444;"> ${escHtml(entry.tryline)}</span>
      </td></tr></table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="#E63946" style="background:#E63946;border-radius:8px;">
        <a href="${entry.ctaUrl}" style="display:inline-block;padding:13px 26px;font:700 14px/1 Arial,sans-serif;color:#ffffff;text-decoration:none;">${escHtml(entry.ctaText)} &rarr;</a>
      </td></tr></table>
  </td></tr>
  <tr><td style="padding:0 30px 30px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#faf7f2;border:1px solid #f1eae1;border-radius:10px;">
      <tr><td style="padding:17px 19px;">
        <p style="margin:0 0 8px;font:700 14px/1.4 Arial,sans-serif;color:#1a1a1a;">${escHtml(bookHead)}</p>
        <p style="margin:0 0 14px;font:400 13px/1.55 Arial,sans-serif;color:#5a5a5a;">${bookBody}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="border:1.5px solid #E63946;border-radius:7px;">
            <a href="${_APPT_URL}" style="display:inline-block;padding:9px 18px;font:700 13px/1 Arial,sans-serif;color:#E63946;text-decoration:none;">Book a 30-min call with Austen &rarr;</a>
          </td></tr></table>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:22px 30px 26px;border-top:1px solid #eeeeee;">
    <p style="margin:0 0 6px;font:400 12px/1.5 Arial,sans-serif;color:#9a9a9a;">Sent by SWH &middot; Stop Wasting Handshakes</p>
    <p style="margin:0 0 6px;font:400 12px/1.5 Arial,sans-serif;color:#bbbbbb;">8600 N FM 620 #411, Austin, TX 78726</p>
    <p style="margin:0;font:400 12px/1.5 Arial,sans-serif;color:#9a9a9a;">
      <a href="${unsubUrl}" style="color:#E63946;text-decoration:underline;">Unsubscribe</a> &nbsp;&middot;&nbsp;
      <a href="${prefsUrl}" style="color:#9a9a9a;text-decoration:underline;">Manage preferences</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function _buildDripText(entry, firstName, unsubUrl) {
  const first = firstName || 'there';
  return `${entry.heading}\n\nHi ${first},\n\n${entry.body}\n\nTry today: ${entry.tryline}\n\n${entry.ctaText}: ${entry.ctaUrl}\n\n---\nWant to book a 30-min call with Austen?\n${_APPT_URL}\n\n---\nSent by SWH - Stop Wasting Handshakes\n8600 N FM 620 #411, Austin, TX 78726\n\nUnsubscribe: ${unsubUrl}\nManage preferences: ${_PREFS_URL}\n`;
}

// Idempotent enrollment — used by both the callable and mirrorSubscriptionToUser.
// Creates onboardingDrip/{uid}; no-ops if it already exists.
async function enrollOnboardingDripForUid(uid, email) {
  if (!uid || !email) return;
  const ref = db.collection('onboardingDrip').doc(uid);
  if ((await ref.get()).exists) return;
  const settingsSnap = await db.doc(`users/${uid}/config/settings`).get();
  const displayName = settingsSnap.data()?.displayName || '';
  const firstName = (displayName || email).split(/[\s@]/)[0];
  const enrolledDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  await ref.set({ uid, email, firstName, enrolledDate, dripIndex: 0, lastSentDate: null });
  console.log('[enrollOnboardingDrip] enrolled', uid, email, 'on', enrolledDate);
}

// Callable — invoked from CRM app load; idempotent no-op if already enrolled.
// Resolves effective plan so team-CRM members are covered without a per-user plan field.
exports.enrollOnboardingDrip = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const uid = request.auth.uid;
  const tokenEmail = request.auth.token.email || '';

  const userSnap = await db.collection('users').doc(uid).get();
  const ud = userSnap.data() || {};
  let plan = ud.plan || 'free';
  if (ud.teamId) {
    const teamSnap = await db.collection('teams').doc(ud.teamId).get();
    if (teamSnap.exists) {
      const t = teamSnap.data();
      const active = t.active || t.subscriptionStatus === 'active' || t.subscriptionStatus === 'trialing' || t.subscriptionStatus === 'comp';
      if (active && t.plan === 'team_crm') plan = 'pro';
    }
  }
  if (plan !== 'pro') return { enrolled: false, reason: 'no_crm_plan' };

  const email = tokenEmail || ud.email || '';
  await enrollOnboardingDripForUid(uid, email);
  return { enrolled: true };
});

// Scheduled — Mon-Fri 7am America/Chicago.
// Queries onboardingDrip where dripIndex < 14; sends next email; advances index.
exports.sendOnboardingDrip = onSchedule({
  schedule: '0 7 * * 1-5',
  timeZone: 'America/Chicago',
  secrets: [OAUTH_STATE_SECRET],
}, async () => {
  const todayCentral = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const snap = await db.collection('onboardingDrip').where('dripIndex', '<', 14).get();
  let sent = 0;

  await Promise.all(snap.docs.map(async (d) => {
    const { uid, email, firstName, enrolledDate, dripIndex, lastSentDate } = d.data();
    if (!email) return;
    if (enrolledDate >= todayCentral) return;   // enrolled today — email 1 waits for next day
    if (lastSentDate === todayCentral) return;   // retry-guard: already sent today

    const settingsSnap = await db.doc(`users/${uid}/config/settings`).get();
    if (settingsSnap.data()?.onboardingDripUnsubscribed) return;

    const entry = ONBOARDING_CURRICULUM[dripIndex];
    if (!entry) return;

    const unsubUrl = _makeUnsubUrl(uid, OAUTH_STATE_SECRET.value());
    const prefsUrl = _PREFS_URL;
    try {
      await db.collection('mail').add({
        from:    _DRIP_FROM,
        replyTo: _DRIP_REPLY,
        to:      [email],
        message: {
          subject: entry.subject,
          html:    _buildDripHtml(entry, firstName, unsubUrl, prefsUrl),
          text:    _buildDripText(entry, firstName, unsubUrl),
        },
      });
      await d.ref.set({ dripIndex: dripIndex + 1, lastSentDate: todayCentral }, { merge: true });
      sent++;
      console.log('[sendOnboardingDrip] day', entry.day, '->', email);
    } catch (e) {
      console.error('[sendOnboardingDrip] failed for', uid, e.message);
    }
  }));

  console.log(`[sendOnboardingDrip] sent=${sent} date=${todayCentral}`);
});

// Admin HTTP — one-shot backfill: marks all existing pro/team-CRM users as
// drip-complete (dripIndex:14) so they never receive the onboarding sequence.
// Safe to re-run — skips anyone who already has an onboardingDrip doc.
exports.backfillOnboardingDrip = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const decoded = await requireAuth(req);
    if (!ADMIN_EMAILS.includes((decoded.email || '').toLowerCase())) {
      res.status(403).json({ error: 'admin only' }); return;
    }

    const todayCentral = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    // Collect active team_crm team IDs so we can catch team members whose
    // personal plan field is still 'free'.
    const teamSnap = await db.collection('teams').where('plan', '==', 'team_crm').get();
    const activeCrmTeams = new Set();
    teamSnap.docs.forEach(d => {
      const t = d.data();
      if (t.active || t.subscriptionStatus === 'active' || t.subscriptionStatus === 'trialing' || t.subscriptionStatus === 'comp') {
        activeCrmTeams.add(d.id);
      }
    });

    const usersSnap = await db.collection('users').get();
    let marked = 0, skipped = 0, errors = 0;

    await Promise.all(usersSnap.docs.map(async (userDoc) => {
      try {
        const uid = userDoc.id;
        const ud = userDoc.data() || {};
        const hasCrm = ud.plan === 'pro' || (ud.teamId && activeCrmTeams.has(ud.teamId));
        if (!hasCrm) { skipped++; return; }

        const dripRef = db.collection('onboardingDrip').doc(uid);
        if ((await dripRef.get()).exists) { skipped++; return; }

        const email = ud.email || '';
        if (!email) { skipped++; return; }

        const settingsSnap = await db.doc(`users/${uid}/config/settings`).get();
        const displayName = settingsSnap.data()?.displayName || '';
        const firstName = (displayName || email).split(/[\s@]/)[0];

        await dripRef.set({ uid, email, firstName, enrolledDate: todayCentral, dripIndex: 14, lastSentDate: todayCentral });
        marked++;
      } catch (e) {
        console.error('[backfillOnboardingDrip] uid', userDoc.id, e.message);
        errors++;
      }
    }));

    console.log(`[backfillOnboardingDrip] marked=${marked} skipped=${skipped} errors=${errors}`);
    res.json({ ok: true, marked, skipped, errors, date: todayCentral });
  } catch (e) {
    console.error('[backfillOnboardingDrip]', e);
    res.status(500).json({ error: e.message });
  }
});

// Public HTTP — one-click unsubscribe (no login required, CAN-SPAM compliant).
// Verifies HMAC, sets users/{uid}/config/settings.onboardingDripUnsubscribed.
exports.unsubscribeEmail = onRequest({ cors: false, secrets: [OAUTH_STATE_SECRET] }, async (req, res) => {
  const { uid, cat, t } = req.query;
  if (!uid || !cat || !t) { res.status(400).send('Invalid unsubscribe link.'); return; }
  const expected = require('crypto').createHmac('sha256', OAUTH_STATE_SECRET.value())
    .update(uid + ':' + cat).digest('hex').slice(0, 32);
  if (expected !== t) { res.status(403).send('Invalid or expired unsubscribe link.'); return; }
  if (cat !== 'onboarding') { res.status(400).send('Unknown category.'); return; }

  await db.doc(`users/${uid}/config/settings`).set({ onboardingDripUnsubscribed: true }, { merge: true });
  console.log('[unsubscribeEmail] unsubscribed', uid, 'from', cat);

  res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed</title></head>
<body style="margin:0;padding:40px 20px;font-family:Arial,sans-serif;background:#f5f5f5;color:#333;text-align:center;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px 32px;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    <div style="font-size:36px;margin-bottom:16px;">&#10003;</div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#1a1a1a;">You are unsubscribed.</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#555;">You will not receive any more onboarding emails from SWH. If you change your mind, you can re-enable them in your <a href="${_PREFS_URL}" style="color:#E63946;">account settings</a>.</p>
    <a href="${_PREFS_URL}" style="display:inline-block;padding:11px 24px;background:#E63946;color:#fff;font-weight:700;font-size:14px;text-decoration:none;border-radius:8px;">Back to SWH CRM</a>
  </div>
</body></html>`);
});

// ===================================================================
// FOLLOW-THROUGH MORNING DIGEST
// Emails the day's pre-drafted touches (built by buildFollowThroughQueue
// at 08:00) with a one-tap link into the CRM dashboard to send / revise.
// Runs 08:30 Mon-Fri America/Chicago, admin-gated (V1, mirrors the build job),
// and only sends when there is at least one pending touch. Monday's digest
// bundles any touches that came due over the weekend.
// ===================================================================
const _QUEUE_URL   = 'https://crm.stopwastinghandshakes.com/?screen=tasks';
const _DIGEST_FROM = 'SWH Follow-Through <noreply@stopwastinghandshakes.com>';

function _buildDigestHtml(firstName, items, dateLabel) {
  const fn = escHtml(firstName || 'there');
  const n = items.length;
  const rows = items.map((it) => {
    const who     = escHtml(it.contactName || 'Contact');
    const step    = escHtml(it.stepName || ('Step ' + ((it.stepIndex || 0) + 1)));
    const subj    = escHtml(it.draftSubject || it.stepName || 'Follow-up');
    const clipped = String(it.draftBody || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    const preview = escHtml(clipped) + (clipped.length >= 150 ? '&hellip;' : '');
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;border:1px solid #ececec;border-radius:10px;">
        <tr><td style="padding:14px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="font:700 14px/1.3 Arial,sans-serif;color:#1a1a1a;">${who}</td>
            <td align="right" style="font:700 10px/1 Arial,sans-serif;color:#E63946;letter-spacing:.05em;text-transform:uppercase;">${step}</td>
          </tr></table>
          <p style="margin:8px 0 4px;font:700 13px/1.4 Arial,sans-serif;color:#333;">${subj}</p>
          <p style="margin:0;font:400 13px/1.55 Arial,sans-serif;color:#777;">${preview}</p>
        </td></tr>
      </table>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#e9e9ec;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a0a" style="background:#0a0a0a;">
<tr><td align="center" style="padding:26px 16px 40px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#0a0a0a;padding:16px 30px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" style="padding-right:11px;"><img src="${_ARROWS_URL}" width="26" height="28" alt="SWH" style="display:block;border:0;"></td>
      <td valign="middle" style="font:bold 20px/1 Georgia,serif;color:#ffffff;letter-spacing:.04em;">SWH</td>
      <td valign="middle" style="padding-left:13px;"><span style="font:600 11px/1 Arial,sans-serif;color:#9a9a9a;letter-spacing:.1em;text-transform:uppercase;">Stop&nbsp;Wasting&nbsp;Handshakes</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:32px 30px 6px;">
    <h1 style="margin:0 0 8px;font:bold 22px/1.25 Arial,sans-serif;color:#1a1a1a;">Good morning, ${fn}.</h1>
    <p style="margin:0;font:400 15px/1.6 Arial,sans-serif;color:#333;">Lola drafted <strong>${n} follow-through${n === 1 ? '' : 's'}</strong> for you, ${escHtml(dateLabel)}. Review and send in one tap.</p>
  </td></tr>
  <tr><td style="padding:18px 30px 4px;">
    ${rows}
  </td></tr>
  <tr><td align="center" style="padding:8px 30px 30px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="#E63946" style="background:#E63946;border-radius:8px;">
        <a href="${_QUEUE_URL}" style="display:inline-block;padding:13px 30px;font:700 14px/1 Arial,sans-serif;color:#ffffff;text-decoration:none;">Review &amp; send in my queue &rarr;</a>
      </td></tr></table>
  </td></tr>
  <tr><td style="padding:18px 30px 26px;border-top:1px solid #eeeeee;">
    <p style="margin:0 0 6px;font:400 12px/1.5 Arial,sans-serif;color:#9a9a9a;">Your daily Follow-Through digest &middot; SWH</p>
    <p style="margin:0;font:400 12px/1.5 Arial,sans-serif;color:#9a9a9a;"><a href="${_PREFS_URL}" style="color:#9a9a9a;text-decoration:underline;">Manage in settings</a></p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function _buildDigestText(firstName, items, dateLabel) {
  const lines = items.map((it, i) =>
    `${i + 1}. ${it.contactName || 'Contact'} — ${it.stepName || ('Step ' + ((it.stepIndex || 0) + 1))}\n   Subject: ${it.draftSubject || ''}\n   ${String(it.draftBody || '').replace(/\s+/g, ' ').trim().slice(0, 150)}`);
  return `Good morning, ${firstName || 'there'}.\n\nLola drafted ${items.length} follow-through${items.length === 1 ? '' : 's'} for you, ${dateLabel}.\nReview and send in your queue: ${_QUEUE_URL}\n\n${lines.join('\n\n')}\n\n— Your daily Follow-Through digest from SWH\nManage in settings: ${_PREFS_URL}\n`;
}

exports.sendFollowThroughDigest = onSchedule({
  schedule: '30 8 * * 1-5',
  timeZone: 'America/Chicago',
}, async () => {
  const todayCentral = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const dateLabel = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric',
  });

  const grants = await db.collectionGroup('integrations')
    .where('product', '==', 'swh-crm')
    .where('status', '==', 'active')
    .get();

  let sent = 0;
  for (const g of grants.docs) {
    const grantData = g.data();
    if (!ADMIN_EMAILS.includes(grantData.email)) continue; // V1 gate — mirrors buildFollowThroughQueue

    const uid = g.ref.parent.parent.id;
    const userSnap = await db.doc(`users/${uid}`).get();
    const ud = userSnap.data() || {};
    const email = ud.email || grantData.email;
    if (!email) continue;

    const settingsSnap = await db.doc(`users/${uid}/config/settings`).get();
    if (settingsSnap.data()?.followThroughDigestDisabled) continue;

    const firstName = String(ud.displayName || ud.name || email).split(/[\s@]/)[0];

    const qSnap = await db.collection(`users/${uid}/followThroughQueue`)
      .where('status', '==', 'pending').get();
    const items = qSnap.docs.map(d => d.data())
      .filter(it => !it.dueDate || it.dueDate <= todayCentral)
      .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));

    if (items.length === 0) continue; // never send an empty digest

    try {
      await db.collection('mail').add({
        from: _DIGEST_FROM,
        to: [email],
        message: {
          subject: `${items.length} follow-through${items.length === 1 ? '' : 's'} ready for today`,
          html: _buildDigestHtml(firstName, items, dateLabel),
          text: _buildDigestText(firstName, items, dateLabel),
        },
      });
      sent++;
      console.log('[sendFollowThroughDigest]', email, items.length, 'items');
    } catch (e) {
      console.error('[sendFollowThroughDigest] failed for', uid, e.message);
    }
  }
  console.log(`[sendFollowThroughDigest] sent=${sent} date=${todayCentral}`);
});
