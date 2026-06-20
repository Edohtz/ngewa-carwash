#!/usr/bin/env node
/**
 * One-time cleanup: remove the old POS-sale rows that were wrongly written into
 * the `expenses` collection.
 *
 * Background: before the accounting fix, every POS sale also created an expense
 * document (tagged with a `posRefId`). Those rows double-counted POS sales as
 * costs and distorted profit. POS sales now live only in `pos_sales` and count
 * as revenue, so these leftover expense rows must be deleted ONCE.
 *
 * Only documents in `expenses` that have a `posRefId` field are touched — manual
 * expenses (umeme, maji, oil, labor, hand-entered accessories) are never deleted.
 *
 * SAFETY: dry-run by default. It prints what it WOULD delete and changes nothing.
 * Re-run with --confirm to actually delete.
 *
 *   node scripts/cleanup-pos-expenses.js            # preview only
 *   node scripts/cleanup-pos-expenses.js --confirm  # perform deletion
 *
 * Requires the same Firebase env vars as the server (loaded from .env):
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *
 * Run AFTER rotating the leaked Firebase key, with fresh credentials in place.
 */

require('dotenv').config();
const admin = require('firebase-admin');

const CONFIRM = process.argv.includes('--confirm');

for (const v of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {
  if (!process.env[v]) {
    console.error(`FATAL: ${v} is not set. Put fresh Firebase credentials in .env first.`);
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

(async () => {
  console.log(`\n=== POS-expense cleanup — ${CONFIRM ? 'LIVE (will delete)' : 'DRY RUN (no changes)'} ===\n`);

  // Find expense docs that originated from a POS sale.
  const snap = await db.collection('expenses').where('posRefId', '!=', null).get();
  const targets = snap.docs;

  if (!targets.length) {
    console.log('Nothing to clean up — no expense rows with a posRefId found. ✅\n');
    process.exit(0);
  }

  let sum = 0;
  targets.forEach((d, i) => {
    const e = d.data();
    sum += parseFloat(e.amount) || 0;
    console.log(
      `${String(i + 1).padStart(3)}. ${d.id}  ` +
      `TZS ${(parseFloat(e.amount) || 0).toLocaleString()}  ` +
      `| ${e.description || '—'}  | posRefId=${e.posRefId}`
    );
  });
  console.log(`\n${targets.length} expense rows, totalling TZS ${sum.toLocaleString()}.\n`);

  if (!CONFIRM) {
    console.log('Dry run only — nothing deleted. Re-run with --confirm to delete these rows.\n');
    process.exit(0);
  }

  // Delete in batches of 500 (Firestore batch limit).
  let deleted = 0;
  for (let i = 0; i < targets.length; i += 500) {
    const batch = db.batch();
    targets.slice(i, i + 500).forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += Math.min(500, targets.length - i);
    console.log(`Deleted ${deleted}/${targets.length}…`);
  }
  console.log(`\n✅ Done — removed ${deleted} POS-expense rows.\n`);
  process.exit(0);
})().catch(err => {
  console.error('\nCleanup failed:', err.message);
  process.exit(1);
});
