require('dotenv').config();
const fetch = globalThis.fetch || require('node-fetch');
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const AfricasTalking = require('africastalking');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');

// ─── Fail fast on missing critical secrets (no guessable fallbacks) ───────────
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start with a guessable token secret.');
  process.exit(1);
}
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'admin') {
  console.warn('WARNING: ADMIN_PASSWORD is unset or set to "admin" — change it before production use.');
}

const app = express();

// CORS: the frontend is served by this same server, so cross-origin API access
// is not needed by default. Set CORS_ORIGIN (comma-separated) to allow specific origins.
app.use(cors(process.env.CORS_ORIGIN
  ? { origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()) }
  : { origin: false }));
app.use(express.json({ limit: '10mb' }));

// Security headers via helmet. CSP is disabled because the UI relies on inline
// scripts/styles + CDN assets; stored-XSS is mitigated by escaping in the client.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// helmet doesn't set Permissions-Policy — keep camera enabled for plate OCR.
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=*'); next(); });
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter kwa login                     //
const loginLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,  // Ongeza idadi ya majaribio
  message: { error: 'Umejaribu mara nyingi. Subiri dakika 1.' },
  skipSuccessfulRequests: true  // Usihesabu successful logins
});

// ─── Firebase ────────────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// ─── Africa's Talking ────────────────────────────────────────────────────────
const AT = AfricasTalking({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME });
const sms = AT.SMS;

async function sendSMS(to, message) {
  let phone = to.replace(/\s+/g, '');
  if (phone.startsWith('0')) phone = '+255' + phone.slice(1);
  if (!phone.startsWith('+')) phone = '+255' + phone;
  try {
    const result = await sms.send({ to: [phone], message });
    console.log('SMS sent:', JSON.stringify(result));
    return { success: true };
  } catch (err) {
    console.error('SMS error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Nodemailer ──────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});
async function sendEmail(to, subject, html) {
  if (!to || !process.env.EMAIL_USER) return { success: false };
  try {
    await mailer.sendMail({ from: `"Ngewa Car Wash" <${process.env.EMAIL_USER}>`, to, subject, html });
    return { success: true };
  } catch (err) { console.error('Email error:', err.message); return { success: false }; }
}

// ─── Vehicle helpers ─────────────────────────────────────────────────────────
function vehicleSwahili(type) {
  const map = {
    'Class B – Private car':'Gari','Class D – Goods vehicle':'Gari la Bidhaa',
    'Motorbike':'Pikipiki','Bajaji':'Bajaji','Electric Toyo':'Toyo ya Umeme',
    'Electric Motorcycle':'Pikipiki ya Umeme','Toyo':'Toyo','Truck':'Lori',
    'Bus':'Basi','Home Carpet':'Zulia la Nyumbani',
  };
  return map[type] || type;
}
function vehiclePossessive(type) {
  return ['Motorbike','Bajaji','Electric Motorcycle'].includes(type) ? 'yako' : 'lako';
}
function vehicleRegistered(type) {
  return ['Motorbike','Bajaji','Electric Motorcycle'].includes(type) ? 'imeandikishwa' : 'limeandikishwa';
}
function vehicleWaiting(type) {
  return ['Motorbike','Bajaji','Electric Motorcycle'].includes(type) ? 'inangoja' : 'linangoja';
}
function needsPlate(type) {
  return !['Home Carpet','Electric Toyo','Electric Motorcycle'].includes(type);
}

// ─── Ngewa ID Generator ──────────────────────────────────────────────────────
async function generateNgewaId(vehicleType) {
  let prefix = 'NGW';
  if (vehicleType === 'Electric Toyo') prefix = 'NGW-ET';
  else if (vehicleType === 'Electric Motorcycle') prefix = 'NGW-EM';
  else if (vehicleType === 'Home Carpet') prefix = 'NGW-HC';
  const counterRef = db.collection('counters').doc(prefix);
  const counter = await db.runTransaction(async (t) => {
    const doc = await t.get(counterRef);
    const next = doc.exists ? doc.data().count + 1 : 1;
    t.set(counterRef, { count: next });
    return next;
  });
  return `${prefix}-${String(counter).padStart(3, '0')}`;
}

// ─── Workers list ────────────────────────────────────────────────────────────
const WORKERS_LIST = ['NGOSHA','EMMANUEL','MICHAEL','HASSAN'];

// ─── Auth ────────────────────────────────────────────────────────────────────
// ─── Users — ONLY admin + named workers. No generic worker account. ─────────
const USERS = {
  [process.env.ADMIN_USERNAME||'admin']: { password: process.env.ADMIN_PASSWORD||'NgEwA@AdMiN2024', role: 'admin' },
  'NGOSHA':   { password: process.env.NGOSHA_PASS||'ngosha123',    role: 'worker' },
  'EMMANUEL': { password: process.env.EMMANUEL_PASS||'emmanuel123', role: 'worker' },
  'MICHAEL':  { password: process.env.MICHAEL_PASS||'michael123',   role: 'worker' },
  'HASSAN':   { password: process.env.HASSAN_PASS||'hassan123',     role: 'worker' },
};
// Hash passwords once at boot so plaintext isn't held for comparison, and logins
// use a constant-time bcrypt compare (mitigates timing attacks). A dummy hash is
// compared when the user is unknown so response time doesn't reveal valid usernames.
for (const u of Object.values(USERS)) { u.hash = bcrypt.hashSync(u.password, 10); delete u.password; }
const DUMMY_HASH = bcrypt.hashSync('invalid-password-placeholder', 10);

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'No token' });
  const token = header.split(' ')[1];
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── Login ───────────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string')
    return res.status(400).json({ error: 'Jina la mtumiaji na neno la siri vinahitajika.' });
  // Try uppercase first (for workers), then as-is (for admin)
  const user = USERS[username.toUpperCase()] || USERS[username];
  const resolvedUsername = USERS[username.toUpperCase()] ? username.toUpperCase() : username;
  // Always run a compare (dummy hash when user is unknown) to avoid timing leaks.
  const ok = await bcrypt.compare(password, user ? user.hash : DUMMY_HASH);
  if (!user || !ok)
    return res.status(401).json({ error: 'Jina la mtumiaji au neno la siri si sahihi.' });
  const token = jwt.sign({ username: resolvedUsername, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, role: user.role, username: resolvedUsername });
});

// ─── Workers list endpoint ───────────────────────────────────────────────────
app.get('/api/workers', authMiddleware, (req, res) => {
  res.json(WORKERS_LIST);
});


// ─── Google Cloud Vision — Plate OCR ─────────────────────────────────────────
app.post('/api/scan/plate', authMiddleware, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Picha inahitajika' });
    const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GOOGLE_CLOUD_VISION_API_KEY haijawekwa kwenye .env' });

    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: imageBase64 },
            features: [{ type: 'TEXT_DETECTION', maxResults: 10 }],
          }]
        })
      }
    );
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'Vision API error' });

    const fullText = data.responses?.[0]?.fullTextAnnotation?.text || '';
    // Extract plate-like patterns — Tanzania format: T123ABC, MC330EBV, T 123 ABC etc
    const lines = fullText.toUpperCase().replace(/\n/g,' ').split(' ').filter(w => w.length >= 4);
    const plateRegex = /^([A-Z]{1,3}\d{2,4}[A-Z]{1,4}|[A-Z]{2}\d{3}[A-Z]{2,4})$/;
    const candidates = lines.map(w => w.replace(/[^A-Z0-9]/g,'')).filter(w => plateRegex.test(w));
    
    if (candidates.length > 0) {
      res.json({ success: true, plate: candidates[0], candidates, rawText: fullText });
    } else {
      // Return raw text so user can pick manually
      const cleaned = fullText.replace(/\n/g,' ').replace(/\s+/g,' ').trim();
      res.json({ success: false, plate: null, rawText: cleaned, message: 'Namba haikupatikana kwa uhakika — angalia maandishi' });
    }
  } catch (err) {
    console.error('Vision API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Check-in ────────────────────────────────────────────────────────────────
app.post('/api/checkin', authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, plate, type, service, amount, noPlate, assignedWorker } = req.body;
    if (!plate && !noPlate && type !== 'Home Carpet')
      return res.status(400).json({ error: 'Namba ya usajili inahitajika.' });

    const now = new Date().toISOString();
    let vehicleId = (plate || '').toUpperCase().trim();
    if (!vehicleId || noPlate) vehicleId = await generateNgewaId(type);

    const custRef = db.collection('customers').doc(vehicleId);
    const custSnap = await custRef.get();
    const isNew = !custSnap.exists;
    const firstVisit = isNew ? now : (custSnap.data().firstVisit || now);
    const visits = isNew ? 1 : (custSnap.data().visits || 1) + 1;

    await custRef.set({
      name: name || '', phone: phone || '', email: email || '',
      plate: vehicleId, isNoPlate: noPlate || false, type,
      lastService: service, lastAmount: amount,
      lastVisit: now, firstVisit, visits,
    });

    // Save visit with worker assignment + pending approval
    const visitRef = await db.collection('visits').add({
      name: name || '', phone: phone || '', email: email || '',
      plate: vehicleId, type, service, amount, time: now, isNew,
      recordedBy: req.user.username,
      assignedWorker: assignedWorker || '',
      approved: false,
      approvedAt: null,
    });

    // SMS + email only for new customers with phone
    let smsSent = false, emailSent = false;
    if (isNew && phone) {
      const vSw = vehicleSwahili(type);
      const poss = vehiclePossessive(type);
      const reg  = vehicleRegistered(type);
      const welcomeSMS = `Karibu Ngewa Car Wash, ${name||'Mteja'}! 🚗✨ Asante kwa kutuchagua. ${vSw} ${poss} lenye usajili (${vehicleId}) ${reg} kikamilifu. Mteja kwetu ni Mfalme, karibu tena. -Ngewa Car Wash`;
      const smsResult = await sendSMS(phone, welcomeSMS);
      smsSent = smsResult.success;

      if (email) {
        const vSw2 = vehicleSwahili(type);
        const html = buildWelcomeEmail(name||'Mteja', vehicleId, type, service, noPlate, vSw2, poss, reg);
        const eResult = await sendEmail(email, `Karibu Ngewa Car Wash, ${name||'Mteja'}! 🚗`, html);
        emailSent = eResult.success;
      }
    }

    res.json({ success: true, isNew, visits, vehicleId, visitId: visitRef.id, smsSent, emailSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function buildWelcomeEmail(name, vehicleId, type, service, noPlate, vSw, poss, reg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
  <body style="margin:0;padding:0;background:#F0F4F2;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F4F2;padding:32px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
        <tr><td style="background:linear-gradient(135deg,#0B5E47,#1aaa80);padding:32px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:24px;letter-spacing:1px;">🚗 NGEWA CAR WASH</h1>
          <p style="color:rgba(255,255,255,.75);margin:4px 0 0;font-size:13px;">Huduma Nzuri na Bora</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <h2 style="color:#0F6E56;margin:0 0 8px;">Karibu, ${name}! 👋</h2>
          <p style="color:#444;line-height:1.7;margin:0 0 20px;">Asante kwa kutuchagua. ${vSw} ${poss} lenye usajili <strong>${vehicleId}</strong> ${reg} kikamilifu kwenye mfumo wetu.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F4F2;border-radius:10px;margin-bottom:20px;">
            <tr><td style="padding:20px;">
              <table width="100%" cellpadding="6" cellspacing="0">
                <tr><td style="color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px;width:130px;">Aina ya chombo</td><td style="font-weight:600;">${type}</td></tr>
                <tr><td style="color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Huduma</td><td style="font-weight:600;">${service}</td></tr>
                <tr><td style="color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Tarehe</td><td style="font-weight:600;">${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'})}</td></tr>
                ${noPlate ? `<tr><td style="color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Namba ya chombo</td><td><span style="background:#0F6E56;color:#fff;font-size:18px;font-weight:700;padding:4px 14px;border-radius:8px;">${vehicleId}</span></td></tr>` : ''}
              </table>
            </td></tr>
          </table>
          ${noPlate ? `<p style="color:#444;line-height:1.7;"><strong>Muhimu:</strong> Namba yako ya chombo ni <strong style="color:#0F6E56;font-size:18px;">${vehicleId}</strong>. Hii ndiyo utakayotumia kupata huduma tena.</p>` : ''}
          <p style="color:#444;line-height:1.7;margin-top:16px;"><strong>Mteja kwetu ni Mfalme.</strong> Karibu tena! 👑🙏</p>
        </td></tr>
        <tr><td style="background:#F0F4F2;padding:20px;text-align:center;border-top:1px solid #e8eaed;">
          <p style="color:#aaa;font-size:12px;margin:0;">© ${new Date().getFullYear()} Ngewa Car Wash · Huduma Nzuri na Bora</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// ─── Lookup ──────────────────────────────────────────────────────────────────
app.get('/api/customer/:plate', authMiddleware, async (req, res) => {
  try {
    const snap = await db.collection('customers').doc(req.params.plate.toUpperCase()).get();
    if (!snap.exists) return res.status(404).json({ error: 'Haijapata' });
    res.json(snap.data());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const snap = await db.collection('customers').get();
    const lower = q.toLowerCase();
    const results = snap.docs.map(d => d.data()).filter(c =>
      (c.phone||'').includes(q) || (c.name||'').toLowerCase().includes(lower) || (c.plate||'').toUpperCase().includes(q.toUpperCase())
    );
    res.json(results.slice(0, 5));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Check-in returning ──────────────────────────────────────────────────────
app.post('/api/checkin-returning/:plate', authMiddleware, async (req, res) => {
  try {
    const plate = req.params.plate.toUpperCase();
    const { assignedWorker, service, amount } = req.body;
    const ref = db.collection('customers').doc(plate);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Haijapata' });
    const c = snap.data();
    const now = new Date().toISOString();
    const visits = (c.visits || 1) + 1;
    await ref.update({ lastVisit: now, visits, lastService: service||c.lastService });
    await db.collection('visits').add({
      name: c.name, phone: c.phone, email: c.email||'',
      plate, type: c.type, service: service||c.lastService,
      amount: amount||'', time: now, isNew: false,
      recordedBy: req.user.username,
      assignedWorker: assignedWorker || '',
      approved: false,
      approvedAt: null,
    });
    res.json({ success: true, visits });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Edit customer (admin only) ──────────────────────────────────────────────
app.put('/api/customer/:plate', authMiddleware, adminOnly, async (req, res) => {
  try {
    const plate = req.params.plate.toUpperCase();
    const { name, phone, email, type, lastService, lastAmount, lastWorker } = req.body;
    const ref = db.collection('customers').doc(plate);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Mteja hajapatikana' });
    await ref.update({
      name: name || '',
      phone: phone || '',
      email: email || '',
      type: type || snap.data().type,
      lastService: lastService || snap.data().lastService,
      lastAmount: lastAmount || snap.data().lastAmount,
      lastWorker: lastWorker || snap.data().lastWorker || '',
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});;

// ─── Worker approval ─────────────────────────────────────────────────────────
// Worker approves their own visit
app.post('/api/visits/:id/approve', authMiddleware, async (req, res) => {
  try {
    const ref = db.collection('visits').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Haijapata' });
    const visit = snap.data();
    // Worker can only approve visits assigned to them
    if (req.user.role !== 'admin' && visit.assignedWorker !== req.user.username.toUpperCase())
      return res.status(403).json({ error: 'Huna ruhusa ya kuidhinisha hii' });
    if (visit.approved)
      return res.status(400).json({ error: 'Imeidhinishwa tayari' });
    await ref.update({ approved: true, approvedAt: new Date().toISOString(), approvedBy: req.user.username });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin revoke approval
app.post('/api/visits/:id/revoke', authMiddleware, adminOnly, async (req, res) => {
  try {
    const ref = db.collection('visits').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Haijapata' });
    await ref.update({ approved: false, approvedAt: null, approvedBy: null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Visits ──────────────────────────────────────────────────────────────────
app.get('/api/visits', authMiddleware, async (req, res) => {
  try {
    // ?all=1 → no cap (used by finance totals). Default keeps the recent feed light.
    const base = db.collection('visits').orderBy('time', 'desc');
    const snap = await (req.query.all ? base.get() : base.limit(500).get());
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Worker visits — filter in memory to avoid needing composite index
app.get('/api/my-visits', authMiddleware, async (req, res) => {
  try {
    const workerName = req.user.username.toUpperCase();
    const snap = await db.collection('visits')
      .orderBy('time', 'desc')
      .limit(500)
      .get();
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const filtered = all.filter(v => (v.assignedWorker || '').toUpperCase() === workerName);
    res.json(filtered);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── All customers ───────────────────────────────────────────────────────────
app.get('/api/customers', authMiddleware, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('customers').orderBy('lastVisit', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Reminder ────────────────────────────────────────────────────────────────
app.post('/api/reminder', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { plate, channel } = req.body;
    const snap = await db.collection('customers').doc(plate.toUpperCase()).get();
    if (!snap.exists) return res.status(404).json({ error: 'Haijapata' });
    const c = snap.data();
    const vSw = vehicleSwahili(c.type);
    const poss2 = vehiclePossessive(c.type);
    const wait2 = vehicleWaiting(c.type);
    const msg = `Habari ${c.name||'Mteja'}! 👋 Imekuwa siku 7 tangu ulipofika Ngewa Car Wash. ${vSw} ${poss2} (${c.plate}) ${wait2} kuoshwa tena! Mteja kwetu ni Mfalme, karibu tena. - Ngewa Car Wash`;
    let smsSent = false, emailSent = false;
    if (channel === 'sms' || channel === 'both') { const r = await sendSMS(c.phone, msg); smsSent = r.success; }
    if ((channel === 'email' || channel === 'both') && c.email) {
      const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F0F4F2;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F4F2;padding:32px 0;">
          <tr><td align="center"><table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
            <tr><td style="background:linear-gradient(135deg,#0B5E47,#1aaa80);padding:28px;text-align:center;">
              <h1 style="color:#fff;margin:0;">🚗 NGEWA CAR WASH</h1>
              <p style="color:rgba(255,255,255,.75);margin:4px 0 0;font-size:13px;">Huduma Nzuri na Bora</p>
            </td></tr>
            <tr><td style="padding:32px;">
              <h2 style="color:#0F6E56;margin:0 0 12px;">Habari ${c.name||'Mteja'}! 👋</h2>
              <p style="color:#444;line-height:1.7;">Imekuwa siku 7 tangu ulipofika kwetu. ${vSw} ${poss2} <strong>${c.plate}</strong> ${wait2} kuoshwa tena!</p>
              <p style="color:#444;line-height:1.7;"><strong>Mteja kwetu ni Mfalme.</strong> Karibu tena! 👑🙏</p>
            </td></tr>
            <tr><td style="background:#F0F4F2;padding:16px;text-align:center;border-top:1px solid #e8eaed;">
              <p style="color:#aaa;font-size:12px;margin:0;">© ${new Date().getFullYear()} Ngewa Car Wash · Huduma Nzuri na Bora</p>
            </td></tr>
          </table></td></tr>
        </table></body></html>`;
      const r = await sendEmail(c.email, `${vSw} ${poss2} ${wait2} kuoshwa! 🚗 - Ngewa Car Wash`, html);
      emailSent = r.success;
    }
    await db.collection('customers').doc(plate.toUpperCase()).update({ lastReminderSent: new Date().toISOString() });
    res.json({ success: true, smsSent, emailSent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Stats ───────────────────────────────────────────────────────────────────

// ─── Admin: view specific worker orders with period filter ────────────────────
app.get('/api/worker-orders/:workerName', authMiddleware, adminOnly, async (req, res) => {
  try {
    const workerName = req.params.workerName.toUpperCase();
    const { period, from, to } = req.query;
    const snap = await db.collection('visits').orderBy('time', 'desc').limit(1000).get();
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    let filtered = all.filter(v => (v.assignedWorker || '').toUpperCase() === workerName);

    const now = new Date();
    if (period === 'today') {
      filtered = filtered.filter(v => new Date(v.time).toDateString() === now.toDateString());
    } else if (period === 'yesterday') {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      filtered = filtered.filter(v => new Date(v.time).toDateString() === y.toDateString());
    } else if (period === 'week') {
      const s = new Date(now); s.setDate(now.getDate() - now.getDay()); s.setHours(0,0,0,0);
      filtered = filtered.filter(v => new Date(v.time) >= s);
    } else if (period === 'month') {
      filtered = filtered.filter(v => {
        const d = new Date(v.time);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
    } else if (period === 'custom' && from && to) {
      filtered = filtered.filter(v => {
        const d = new Date(v.time);
        return d >= new Date(from) && d <= new Date(to + 'T23:59:59');
      });
    }
    res.json(filtered);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [custSnap, visitSnap, posSnap] = await Promise.all([
      db.collection('customers').get(),
      db.collection('visits').orderBy('time', 'desc').get(),   // uncapped: total must be accurate
      db.collection('pos_sales').get(),
    ]);
    const visits = visitSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const posSales = posSnap.docs.map(d => d.data());
    const todayStr = new Date().toDateString();
    const todayVisits = visits.filter(v => new Date(v.time).toDateString() === todayStr);
    // Revenue = APPROVED washes + POS sales (POS has no approval step).
    const amt = v => (v.approved ? parseFloat(v.amount) || 0 : 0);
    const todayPos = posSales.filter(p => new Date(p.createdAt).toDateString() === todayStr)
      .reduce((s, p) => s + (parseFloat(p.total) || 0), 0);
    const totalPos = posSales.reduce((s, p) => s + (parseFloat(p.total) || 0), 0);
    const todayRevenue = todayVisits.reduce((s, v) => s + amt(v), 0) + todayPos;
    const totalRevenue = visits.reduce((s, v) => s + amt(v), 0) + totalPos;

    // Per-worker stats for today (approved washes only)
    const workerStats = {};
    WORKERS_LIST.forEach(w => { workerStats[w] = { visits: 0, revenue: 0, approved: 0 }; });
    todayVisits.forEach(v => {
      const w = (v.assignedWorker || '').toUpperCase();
      if (workerStats[w]) {
        workerStats[w].visits++;
        workerStats[w].revenue += amt(v);
        if (v.approved) workerStats[w].approved++;
      }
    });

    res.json({ totalCustomers: custSnap.size, todayVisits: todayVisits.length, todayRevenue, totalRevenue, workerStats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚗 Ngewa Car Wash v5 running at http://localhost:${PORT}\n`));

// ═══════════════════════════════════════════════════════════════════════════
// EXPENSES MODULE
// ═══════════════════════════════════════════════════════════════════════════

// ─── Expense Categories ───────────────────────────────────────────────────
const EXPENSE_CATEGORIES = [
  { id: 'umeme',       label: 'Umeme',           icon: 'ti-bolt',          color: '#F5A623' },
  { id: 'maji',        label: 'Maji',             icon: 'ti-droplet',       color: '#1A6BAB' },
  { id: 'oil',         label: 'Oil / Mafuta',     icon: 'ti-engine',        color: '#7A5200' },
  { id: 'labor',       label: 'Labor / Matengenezo', icon: 'ti-tools',     color: '#5B4CC4' },
  { id: 'accessories', label: 'Accessories (POS)', icon: 'ti-shopping-cart',color: '#0B5E47' },
];

app.get('/api/expense-categories', authMiddleware, (req, res) => {
  res.json(EXPENSE_CATEGORIES);
});

// ─── Add Expense ─────────────────────────────────────────────────────────
app.post('/api/expenses', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { category, description, amount, date } = req.body;
    if (!category || !amount) return res.status(400).json({ error: 'Kategoria na kiasi vinahitajika.' });
    const ref = await db.collection('expenses').add({
      category, description: description || '',
      amount: parseFloat(amount),
      date: date || new Date().toISOString(),
      recordedBy: req.user.username,
      createdAt: new Date().toISOString(),
    });
    res.json({ success: true, id: ref.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Get Expenses ─────────────────────────────────────────────────────────
app.get('/api/expenses', authMiddleware, adminOnly, async (req, res) => {
  try {
    // ?all=1 → no cap (used by finance totals).
    const base = db.collection('expenses').orderBy('createdAt', 'desc');
    const snap = await (req.query.all ? base.get() : base.limit(500).get());
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Delete Expense ───────────────────────────────────────────────────────
app.delete('/api/expenses/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.collection('expenses').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// POS — ACCESSORIES / INVENTORY
// ═══════════════════════════════════════════════════════════════════════════

// ─── Create / Update POS Item ─────────────────────────────────────────────
app.post('/api/pos/items', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, unitPrice, unit, stockQty, lowStockAlert } = req.body;
    if (!name || !unitPrice) return res.status(400).json({ error: 'Jina na bei vinahitajika.' });
    const ref = await db.collection('pos_items').add({
      name, unitPrice: parseFloat(unitPrice),
      unit: unit || 'pcs',
      stockQty: parseFloat(stockQty) || 0,
      lowStockAlert: parseFloat(lowStockAlert) || 2,
      createdAt: new Date().toISOString(),
      active: true,
    });
    res.json({ success: true, id: ref.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pos/items/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, unitPrice, unit, stockQty, lowStockAlert } = req.body;
    await db.collection('pos_items').doc(req.params.id).update({
      name, unitPrice: parseFloat(unitPrice),
      unit: unit || 'pcs',
      stockQty: parseFloat(stockQty) || 0,
      lowStockAlert: parseFloat(lowStockAlert) || 2,
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/pos/items/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.collection('pos_items').doc(req.params.id).update({ active: false });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Get POS Items ────────────────────────────────────────────────────────
app.get('/api/pos/items', authMiddleware, async (req, res) => {
  try {
    const snap = await db.collection('pos_items').where('active', '==', true).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Low-stock items (stockQty at or below the item's alert threshold) ────────
app.get('/api/pos/low-stock', authMiddleware, async (req, res) => {
  try {
    const snap = await db.collection('pos_items').where('active', '==', true).get();
    const low = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(i => (parseFloat(i.stockQty) || 0) <= (parseFloat(i.lowStockAlert) || 0))
      .sort((a, b) => (parseFloat(a.stockQty) || 0) - (parseFloat(b.stockQty) || 0));
    res.json(low);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POS Sale (checkout) ──────────────────────────────────────────────────
app.post('/api/pos/sales', authMiddleware, async (req, res) => {
  try {
    const { items, note } = req.body;
    // items = [{ itemId, qty }] — name/price are taken from the catalog server-side.
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'Hakuna bidhaa zilizochaguliwa.' });

    const saleRef = db.collection('pos_sales').doc();
    // Transaction: read all stock, compute total from trusted server prices, then
    // deduct + record atomically. Fixes the read-then-write race where two
    // concurrent sales could oversell the same stock.
    const result = await db.runTransaction(async (t) => {
      const refs = items.map(i => db.collection('pos_items').doc(i.itemId));
      const snaps = await Promise.all(refs.map(r => t.get(r)));   // all reads before any write

      let total = 0;
      const lineItems = [];
      const newQtys = [];
      const lowStock = [];
      for (let k = 0; k < items.length; k++) {
        const snap = snaps[k];
        const qty = parseFloat(items[k].qty) || 0;
        if (qty <= 0) throw new Error('Idadi ya bidhaa si sahihi.');
        if (!snap.exists) throw new Error('Bidhaa haipo kwenye orodha.');
        const d = snap.data();
        const unitPrice = parseFloat(d.unitPrice) || 0;          // trust catalog price, not client
        const current = parseFloat(d.stockQty) || 0;
        const newQty = Math.max(0, current - qty);               // floor at 0 (oversell allowed but flagged)
        total += qty * unitPrice;
        lineItems.push({ itemId: items[k].itemId, name: d.name, qty, unitPrice });
        newQtys.push(newQty);
        if (newQty <= (parseFloat(d.lowStockAlert) || 0))
          lowStock.push({ name: d.name, stockQty: newQty, lowStockAlert: parseFloat(d.lowStockAlert) || 0 });
      }
      refs.forEach((ref, k) => t.update(ref, { stockQty: newQtys[k] }));
      t.set(saleRef, {
        items: lineItems, total, note: note || '',
        soldBy: req.user.username,
        createdAt: new Date().toISOString(),
      });
      return { total, lowStock };
    });

    // NOTE: A POS sale is REVENUE, not an expense — stored only in pos_sales and
    // counted as income by the finance view. lowStock lets the UI warn the seller.
    res.json({ success: true, id: saleRef.id, total: result.total, lowStock: result.lowStock });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── POS Sales history ────────────────────────────────────────────────────
app.get('/api/pos/sales', authMiddleware, adminOnly, async (req, res) => {
  try {
    // ?all=1 → no cap (used by finance totals).
    const base = db.collection('pos_sales').orderBy('createdAt', 'desc');
    const snap = await (req.query.all ? base.get() : base.limit(200).get());
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Finance summary (admin) ──────────────────────────────────────────────
app.get('/api/finance/summary', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [visitSnap, expenseSnap, posSnap] = await Promise.all([
      db.collection('visits').get(),
      db.collection('expenses').get(),
      db.collection('pos_sales').get(),
    ]);
    const visits = visitSnap.docs.map(d => d.data());
    const expenses = expenseSnap.docs.map(d => d.data());
    const posSales = posSnap.docs.map(d => d.data());
    const todayStr = new Date().toDateString();

    // Revenue = APPROVED car-wash visits + POS accessory sales (POS has no approval).
    const amt = v => (v.approved ? parseFloat(v.amount) || 0 : 0);
    const washRevenue = visits.reduce((s, v) => s + amt(v), 0);
    const posRevenue = posSales.reduce((s, p) => s + (parseFloat(p.total) || 0), 0);
    const totalRevenue = washRevenue + posRevenue;
    const todayRevenue =
      visits.filter(v => new Date(v.time).toDateString() === todayStr)
        .reduce((s, v) => s + amt(v), 0) +
      posSales.filter(p => new Date(p.createdAt).toDateString() === todayStr)
        .reduce((s, p) => s + (parseFloat(p.total) || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const todayExpenses = expenses.filter(e => new Date(e.date || e.createdAt).toDateString() === todayStr)
      .reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    // By category
    const byCategory = {};
    EXPENSE_CATEGORIES.forEach(c => { byCategory[c.id] = 0; });
    expenses.forEach(e => {
      if (byCategory[e.category] !== undefined) byCategory[e.category] += parseFloat(e.amount) || 0;
    });

    res.json({
      totalRevenue, todayRevenue,
      washRevenue, posRevenue,
      totalExpenses, todayExpenses,
      netProfit: totalRevenue - totalExpenses,
      todayProfit: todayRevenue - todayExpenses,
      byCategory,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
