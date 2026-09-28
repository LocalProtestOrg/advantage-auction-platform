#!/usr/bin/env node
/* reclassify-pre-launch-test-records.js — mark pre-launch TEST/pilot auction history so it can never be charged, paid out,
   or read as a real seller liability once live payments are on. Requires migration 176.

   NON-DESTRUCTIVE: nothing is deleted. Every change is written to audit_log ('finance.pre_launch_test_reclassified') with
   the record's previous values, and --revert restores them from that trail.

   What --apply changes (only inside the selected auctions):
     auctions               pre_launch_test = true (+ reason, marked_at, marked_by)       → every buyer payment path refuses them
     seller_payouts         unpaid → settlement_status 'void', payout_status 'void'        → never approved, held or paid
                            already 'paid' rows are left exactly as they are (history), the auction flag marks them as test
     invoices (per lot)     'issued' → 'void'                                              → no "Pay Now"
     buyer_auction_invoices unpaid → 'void'
     payments               'pending' → 'failed'                                            → never finalized/charged

   Selection: every closed auction, plus any auction still 'active' whose end time has passed (stuck test auctions).
   Refuses to run unless EVERY payment in the selection is a TEST-mode payment (retrieved from the provider with the TEST
   key, livemode=false; seeded 'pi_demo_*' placeholders excepted) and every recorded seller transfer is TEST-mode.

   Usage (production):
     railway run node scripts/reclassify-pre-launch-test-records.js                         # dry run (default)
     railway run node scripts/reclassify-pre-launch-test-records.js --apply --actor=<admin user id> --confirm=RECLASSIFY-PRE-LAUNCH
     railway run node scripts/reclassify-pre-launch-test-records.js --revert --apply --actor=<admin user id> --confirm=RECLASSIFY-PRE-LAUNCH */
const { Pool } = require('pg');

const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const EVENT = 'finance.pre_launch_test_reclassified';
const REVERT_EVENT = 'finance.pre_launch_test_reverted';
const CONFIRM = 'RECLASSIFY-PRE-LAUNCH';
const REASON = 'Pre-launch test/pilot record: every payment was made in TEST mode (verified with the payment provider); '
  + 'owner confirmed no real sales or payouts occurred before live payments.';

const arg = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : null; };
const flag = (k) => process.argv.includes('--' + k);
const money = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

async function audit(c, { entityType, entityId, auctionId, paymentId, actorId, metadata, eventType = EVENT }) {
  await c.query(
    `INSERT INTO audit_log (event_type, entity_type, entity_id, auction_id, payment_id, actor_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [eventType, entityType, entityId, auctionId || null, paymentId || null, actorId || null, JSON.stringify(metadata)]);
}

async function selectAuctions(c) {
  return (await c.query(
    `SELECT a.id, a.title, a.state, a.is_demo, a.end_time, u.email AS seller_email
       FROM auctions a LEFT JOIN seller_profiles sp ON sp.id = a.seller_id LEFT JOIN users u ON u.id = sp.user_id
      WHERE a.pre_launch_test = false
        AND (a.state = 'closed' OR (a.state = 'active' AND a.end_time < now()))
      ORDER BY a.end_time`)).rows;
}

// Every payment in scope must be a TEST-mode object at the provider. Anything else aborts the run.
async function verifyTestMode(c, ids) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!/^sk_test_/.test(key)) return { ok: false, problems: ['the configured payment key is not a TEST key; verification must run in TEST mode'] };
  const stripe = require('stripe')(key);
  const problems = []; let verified = 0, placeholders = 0, noIntent = 0;
  const pays = (await c.query(`SELECT id, status, amount_cents, payment_intent_id FROM payments WHERE auction_id = ANY($1::uuid[])`, [ids])).rows;
  for (const p of pays) {
    if (!p.payment_intent_id) { noIntent++; continue; }
    if (/^pi_demo_/.test(p.payment_intent_id)) { placeholders++; continue; }
    try {
      const pi = await stripe.paymentIntents.retrieve(p.payment_intent_id);
      if (pi.livemode) problems.push(`payment ${p.id}: ${p.payment_intent_id} is LIVE`); else verified++;
    } catch (e) { problems.push(`payment ${p.id}: ${p.payment_intent_id} not found in TEST mode (${e.code || e.message})`); }
  }
  const transfers = (await c.query(
    `SELECT id, stripe_transfer_id FROM seller_payouts WHERE auction_id = ANY($1::uuid[]) AND stripe_transfer_id IS NOT NULL`, [ids])).rows;
  for (const t of transfers) {
    try {
      const tr = await stripe.transfers.retrieve(t.stripe_transfer_id);
      if (tr.livemode) problems.push(`seller payout ${t.id}: transfer ${t.stripe_transfer_id} is LIVE`);
    } catch (e) { problems.push(`seller payout ${t.id}: transfer ${t.stripe_transfer_id} not found in TEST mode (${e.code || e.message})`); }
  }
  return { ok: problems.length === 0, problems, payments: pays.length, verified, placeholders, noIntent, transfers: transfers.length };
}

async function plan(c, ids) {
  const q = async (sql) => (await c.query(sql, [ids])).rows;
  return {
    payouts_void: await q(`SELECT id, auction_id, settlement_status, payout_status, seller_payout_cents FROM seller_payouts
                            WHERE auction_id = ANY($1::uuid[]) AND settlement_status <> 'paid' AND settlement_status <> 'void'`),
    payouts_paid_kept: await q(`SELECT id, auction_id, seller_payout_cents, final_amount_paid_cents FROM seller_payouts
                                 WHERE auction_id = ANY($1::uuid[]) AND settlement_status = 'paid'`),
    invoices_void: await q(`SELECT id, auction_id, status, total_cents FROM invoices WHERE auction_id = ANY($1::uuid[]) AND status = 'issued'`),
    bai_void: await q(`SELECT id, auction_id, status, total_cents FROM buyer_auction_invoices
                        WHERE auction_id = ANY($1::uuid[]) AND status NOT IN ('paid', 'void')`),
    payments_fail: await q(`SELECT id, auction_id, status, amount_cents, payment_intent_id FROM payments
                             WHERE auction_id = ANY($1::uuid[]) AND status = 'pending'`),
  };
}

async function apply(c, auctions, p, actorId) {
  const ids = auctions.map((a) => a.id);
  for (const a of auctions) {
    await c.query(`UPDATE auctions SET pre_launch_test = true, pre_launch_test_reason = $2, pre_launch_test_marked_at = now(),
                          pre_launch_test_marked_by = $3 WHERE id = $1 AND pre_launch_test = false`, [a.id, REASON, actorId]);
    await audit(c, { entityType: 'auction', entityId: a.id, auctionId: a.id, actorId,
      metadata: { table: 'auctions', before: { pre_launch_test: false }, after: { pre_launch_test: true }, reason: REASON } });
  }
  for (const r of p.payouts_void) {
    await c.query(`UPDATE seller_payouts SET settlement_status = 'void', payout_status = 'void', void_reason = $2, voided_at = now(),
                          voided_by_user_id = $3, updated_at = now() WHERE id = $1`, [r.id, REASON, actorId]);
    await audit(c, { entityType: 'seller_payout', entityId: r.id, auctionId: r.auction_id, actorId,
      metadata: { table: 'seller_payouts', before: { settlement_status: r.settlement_status, payout_status: r.payout_status },
        after: { settlement_status: 'void', payout_status: 'void' }, amount_cents: r.seller_payout_cents, reason: REASON } });
  }
  for (const r of p.invoices_void) {
    await c.query(`UPDATE invoices SET status = 'void' WHERE id = $1 AND status = 'issued'`, [r.id]);
    await audit(c, { entityType: 'invoice', entityId: r.id, auctionId: r.auction_id, actorId,
      metadata: { table: 'invoices', before: { status: r.status }, after: { status: 'void' }, amount_cents: r.total_cents, reason: REASON } });
  }
  for (const r of p.bai_void) {
    await c.query(`UPDATE buyer_auction_invoices SET status = 'void', updated_at = now() WHERE id = $1 AND status NOT IN ('paid', 'void')`, [r.id]);
    await audit(c, { entityType: 'buyer_auction_invoice', entityId: r.id, auctionId: r.auction_id, actorId,
      metadata: { table: 'buyer_auction_invoices', before: { status: r.status }, after: { status: 'void' }, amount_cents: r.total_cents, reason: REASON } });
  }
  for (const r of p.payments_fail) {
    await c.query(`UPDATE payments SET status = 'failed', last_attempted_at = now() WHERE id = $1 AND status = 'pending'`, [r.id]);
    await audit(c, { entityType: 'payment', entityId: r.id, auctionId: r.auction_id, paymentId: r.id, actorId,
      metadata: { table: 'payments', before: { status: r.status }, after: { status: 'failed' }, amount_cents: r.amount_cents,
        payment_intent_id: r.payment_intent_id, reason: REASON } });
  }
  return ids.length;
}

// Restore every record from its most recent reclassification audit entry (only where it still holds the reclassified value).
async function revert(c, actorId) {
  const rows = (await c.query(
    `SELECT DISTINCT ON (entity_id) entity_id, entity_type, auction_id, payment_id, metadata FROM audit_log
      WHERE event_type = $1 ORDER BY entity_id, created_at DESC`, [EVENT])).rows;
  let n = 0;
  for (const r of rows) {
    const m = r.metadata || {}; const b = m.before || {};
    let res;
    if (m.table === 'auctions') {
      res = await c.query(`UPDATE auctions SET pre_launch_test = false, pre_launch_test_reason = NULL, pre_launch_test_marked_at = NULL,
                                  pre_launch_test_marked_by = NULL WHERE id = $1 AND pre_launch_test = true`, [r.entity_id]);
    } else if (m.table === 'seller_payouts') {
      res = await c.query(`UPDATE seller_payouts SET settlement_status = $2, payout_status = $3, void_reason = NULL, voided_at = NULL,
                                  voided_by_user_id = NULL, updated_at = now() WHERE id = $1 AND settlement_status = 'void'`,
        [r.entity_id, b.settlement_status, b.payout_status]);
    } else if (m.table === 'invoices') {
      res = await c.query(`UPDATE invoices SET status = $2 WHERE id = $1 AND status = 'void'`, [r.entity_id, b.status]);
    } else if (m.table === 'buyer_auction_invoices') {
      res = await c.query(`UPDATE buyer_auction_invoices SET status = $2, updated_at = now() WHERE id = $1 AND status = 'void'`, [r.entity_id, b.status]);
    } else if (m.table === 'payments') {
      res = await c.query(`UPDATE payments SET status = $2 WHERE id = $1 AND status = 'failed'`, [r.entity_id, b.status]);
    } else continue;
    if (res.rowCount) {
      n++;
      await audit(c, { eventType: REVERT_EVENT, entityType: r.entity_type, entityId: r.entity_id, auctionId: r.auction_id,
        paymentId: r.payment_id, actorId, metadata: { table: m.table, restored: b } });
    }
  }
  return n;
}

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const doApply = flag('apply'); const doRevert = flag('revert'); const actorId = arg('actor');
  if (doApply && arg('confirm') !== CONFIRM) { console.error(`REFUSE: --apply requires --confirm=${CONFIRM}`); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const hasCol = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='auctions' AND column_name='pre_launch_test'`)).rowCount;
    if (!hasCol) { console.error('REFUSE: migration 176 is not applied.'); return 2; }
    if (doApply) {
      const admin = actorId && (await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'admin'`, [actorId])).rowCount;
      if (!admin) { console.error('REFUSE: --actor must be an admin user id.'); return 2; }
    }

    if (doRevert) {
      if (!doApply) {
        const n = (await c.query(`SELECT count(DISTINCT entity_id)::int n FROM audit_log WHERE event_type = $1`, [EVENT])).rows[0].n;
        console.log(`DRY RUN (revert): ${n} reclassified record(s) would be restored from the audit trail.`); return 0;
      }
      await c.query('BEGIN');
      const n = await revert(c, actorId);
      await c.query('COMMIT');
      console.log(`REVERTED ${n} record(s).`); return 0;
    }

    const auctions = await selectAuctions(c);
    const ids = auctions.map((a) => a.id);
    console.log(`Auctions selected: ${auctions.length}`);
    for (const a of auctions) console.log(`  ${a.id}  ${a.state.padEnd(6)} ${a.is_demo ? 'demo ' : '     '} ${(a.seller_email || '(no seller)').padEnd(52)} ${a.title}`);
    const v = await verifyTestMode(c, ids);
    console.log(`TEST-mode verification: payments ${v.payments || 0} (verified TEST ${v.verified || 0}, seeded placeholders ${v.placeholders || 0}, `
      + `no intent ${v.noIntent || 0}); seller transfers ${v.transfers || 0}`);
    if (!v.ok) { console.error('REFUSE: not every record is TEST-mode:\n  ' + v.problems.join('\n  ')); return 1; }

    const p = await plan(c, ids);
    const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
    console.log('Plan:');
    console.log(`  seller settlements → void:       ${p.payouts_void.length} (${money(sum(p.payouts_void, 'seller_payout_cents'))})`);
    console.log(`  seller settlements already paid: ${p.payouts_paid_kept.length} (${money(sum(p.payouts_paid_kept, 'final_amount_paid_cents'))}) — left as recorded; auction flagged as test`);
    console.log(`  per-lot invoices issued → void:  ${p.invoices_void.length} (${money(sum(p.invoices_void, 'total_cents'))})`);
    console.log(`  combined invoices unpaid → void: ${p.bai_void.length} (${money(sum(p.bai_void, 'total_cents'))})`);
    console.log(`  payments pending → failed:       ${p.payments_fail.length} (${money(sum(p.payments_fail, 'amount_cents'))})`);
    if (!doApply) { console.log('DRY RUN: nothing changed. Re-run with --apply --actor=<admin id> --confirm=' + CONFIRM); return 0; }

    await c.query('BEGIN');
    try {
      await apply(c, auctions, p, actorId);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED (rolled back):', e.message); return 1; }

    const left = await plan(c, ids);
    const flagged = (await c.query(`SELECT count(*)::int n FROM auctions WHERE id = ANY($1::uuid[]) AND pre_launch_test = true`, [ids])).rows[0].n;
    const checks = {
      auctions_flagged: flagged === ids.length,
      no_unpaid_settlements_left: left.payouts_void.length === 0,
      no_issued_invoices_left: left.invoices_void.length === 0 && left.bai_void.length === 0,
      no_pending_payments_left: left.payments_fail.length === 0,
      paid_history_unchanged: JSON.stringify(left.payouts_paid_kept) === JSON.stringify(p.payouts_paid_kept),
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
