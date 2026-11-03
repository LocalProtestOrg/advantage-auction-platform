'use strict';

/**
 * storefrontSettlementService — storefront (fixed-price) sales in seller settlement and payouts (migration 213).
 *
 * Weekly, per seller: a payout record lists the storefront orders that are paid, fulfilled (picked up or delivered),
 * eligible for payout, not on hold, not under review, not refunded and without an open dispute, completed before the
 * cutoff (Wednesday 11:59 PM Eastern). Records are PREPARED automatically on Thursday (prepareWeek); money moves only when
 * an administrator approves Pay Seller (payPayout), with the same safeguards as auction settlements:
 *   - the seller's connected payout account can receive and pay out a transfer (settlementEngine.connectPayoutReady);
 *   - the record is not paid, void or on hold; no included order was refunded, disputed or held since it was prepared;
 *   - the admin confirms the amount, which must equal the record; one Stripe transfer, idempotency-keyed by the record;
 *   - transfer webhooks (transfer.created / transfer.reversed) update payout_status (settlementEngine.applyTransferEvent).
 * Amounts per order: the order's seller proceeds (item price + shipping - the order's storefront commission: 5% website or 9% marketplace, fixed on the order), plus the collected sales tax
 * ONLY when the seller remits it (tax_remitter 'seller', migration 214). Tax Advantage.Bid remits is never paid to the seller,
 * and sales tax is never platform revenue or part of the fee base.
 * A partially refunded order is under review (review_required) and is not included until an administrator clears it.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const auditService = require('./auditService');

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Cutoff: the most recent Wednesday 11:59:59.999 PM in America/New_York at or before `now` ─────────────────────
function etParts(d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}
// The UTC instant of a wall-clock time in New York (handles daylight saving by measuring the offset at that moment).
function nyInstant(y, m, d, h, mi, s, ms) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s, ms);
  const p = etParts(new Date(guess));
  const asIfUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, ms);
  return new Date(guess - (asIfUtc - guess));
}
function cutoffFor(now = new Date()) {
  const p = etParts(now);
  const back = (p.wd - 3 + 7) % 7;                        // days back to Wednesday
  const wed = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
  let c = nyInstant(wed.getUTCFullYear(), wed.getUTCMonth() + 1, wed.getUTCDate(), 23, 59, 59, 999);
  if (c > now) {                                          // a Wednesday before midnight: last week's cutoff
    const prev = new Date(Date.UTC(wed.getUTCFullYear(), wed.getUTCMonth(), wed.getUTCDate() - 7));
    c = nyInstant(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 23, 59, 59, 999);
  }
  return c;
}

// The one definition of "this order may be paid to its seller now".
const ELIGIBLE_SQL = `
  o.payment_status = 'paid' AND o.refund_status = 'none' AND o.payout_eligible = true AND o.payout_hold = false
  AND o.review_required = false AND o.fulfillment_status IN ('picked_up', 'completed') AND COALESCE(o.is_demo, false) = false
  AND (o.tax_cents = 0 OR o.tax_remitter IN ('platform', 'seller'))
  AND NOT EXISTS (SELECT 1 FROM payment_disputes d WHERE d.payment_intent_id = o.stripe_payment_intent_id
                   AND d.closed_at IS NULL AND d.status NOT IN ('won', 'lost', 'warning_closed'))`;

/**
 * Prepare (never pay) one payout record per seller for orders completed before the cutoff. Idempotent: an order is in at
 * most one live payout (unique index), and a seller has at most one live record per cutoff.
 */
async function prepareWeek({ cutoff = cutoffFor(), actorId = null } = {}) {
  const sellers = (await db.query(
    `SELECT DISTINCT o.seller_id FROM marketplace_orders o
      WHERE ${ELIGIBLE_SQL} AND o.payout_eligible_at <= $1
        AND NOT EXISTS (SELECT 1 FROM storefront_payout_lines l WHERE l.marketplace_order_id = o.id AND l.active)`, [cutoff])).rows;
  const prepared = [];
  for (const { seller_id: sellerId } of sellers) {
    const out = await withTransaction(async (client) => {
      const sp = (await client.query('SELECT id, user_id FROM seller_profiles WHERE id = $1 FOR UPDATE', [sellerId])).rows[0];
      if (!sp) return null;
      const orders = (await client.query(
        `SELECT o.id, o.order_number, o.item_price_cents, o.shipping_cents, o.platform_fee_cents, o.seller_proceeds_cents, o.tax_cents, o.tax_remitter
           FROM marketplace_orders o
          WHERE o.seller_id = $1 AND ${ELIGIBLE_SQL} AND o.payout_eligible_at <= $2
            AND NOT EXISTS (SELECT 1 FROM storefront_payout_lines l WHERE l.marketplace_order_id = o.id AND l.active)
          ORDER BY o.paid_at FOR UPDATE OF o`, [sellerId, cutoff])).rows;
      if (!orders.length) return null;
      let payout = (await client.query(
        `SELECT * FROM storefront_payouts WHERE seller_profile_id = $1 AND period_cutoff_at = $2 AND settlement_status <> 'void' FOR UPDATE`,
        [sellerId, cutoff])).rows[0];
      if (payout && payout.settlement_status === 'paid') return null;   // a paid record is never changed; later orders go next week
      if (!payout) {
        payout = (await client.query(
          `INSERT INTO storefront_payouts (seller_profile_id, seller_user_id, period_cutoff_at, created_by_user_id) VALUES ($1,$2,$3,$4) RETURNING *`,
          [sellerId, sp.user_id, cutoff, actorId])).rows[0];
      }
      for (const o of orders) {
        const goods = Number(o.item_price_cents) + Number(o.shipping_cents);
        const taxToSeller = o.tax_remitter === 'seller' ? Math.max(0, Number(o.tax_cents) || 0) : 0;
        await client.query(
          `INSERT INTO storefront_payout_lines (storefront_payout_id, marketplace_order_id, order_number, goods_cents, platform_fee_cents, amount_cents, tax_to_seller_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [payout.id, o.id, o.order_number, goods, Number(o.platform_fee_cents),
            Math.max(0, Number(o.seller_proceeds_cents)) + taxToSeller, taxToSeller]);
        await client.query('UPDATE marketplace_orders SET storefront_payout_id = $2 WHERE id = $1', [o.id, payout.id]);
      }
      const t = (await client.query(
        `SELECT count(*)::int n, coalesce(sum(goods_cents),0)::int g, coalesce(sum(platform_fee_cents),0)::int f, coalesce(sum(amount_cents),0)::int a
           FROM storefront_payout_lines WHERE storefront_payout_id = $1 AND active`, [payout.id])).rows[0];
      // Recover refunds on orders this seller was already paid for (oldest first, each once, never below zero).
      let recovered = Number(payout.recovery_cents) || 0;
      const open = (await client.query(
        `SELECT id, amount_cents FROM storefront_payout_recoveries WHERE seller_profile_id = $1 AND applied_payout_id IS NULL ORDER BY created_at FOR UPDATE`,
        [sellerId])).rows;
      for (const r of open) {
        if (Number(r.amount_cents) > t.a - recovered) break;
        await client.query('UPDATE storefront_payout_recoveries SET applied_payout_id = $2, applied_at = now() WHERE id = $1', [r.id, payout.id]);
        recovered += Number(r.amount_cents);
      }
      const upd = (await client.query(
        `UPDATE storefront_payouts SET order_count = $2, goods_cents = $3, platform_fee_cents = $4, seller_payout_cents = $5, recovery_cents = $6, updated_at = now()
          WHERE id = $1 RETURNING *`, [payout.id, t.n, t.g, t.f, t.a - recovered, recovered])).rows[0];
      await auditService.logEvent(client, { eventType: 'storefront_settlement.prepared', entityType: 'storefront_payout', entityId: payout.id,
        actorId, metadata: { seller_profile_id: sellerId, cutoff: cutoff.toISOString(), added_orders: orders.length, seller_payout_cents: t.a } });
      return upd;
    });
    if (out) prepared.push(out);
  }
  return { cutoff: cutoff.toISOString(), prepared: prepared.length, payouts: prepared.map(view) };
}

function view(p) {
  if (!p) return null;
  return { id: p.id, seller_profile_id: p.seller_profile_id, period_cutoff_at: p.period_cutoff_at, order_count: p.order_count,
    goods_cents: p.goods_cents, platform_fee_cents: p.platform_fee_cents, seller_payout_cents: p.seller_payout_cents,
    recovery_cents: Number(p.recovery_cents) || 0,
    settlement_status: p.settlement_status, on_hold_reason: p.on_hold_reason, void_reason: p.void_reason, payout_status: p.payout_status,
    stripe_transfer_id: p.stripe_transfer_id || null, paid_at: p.paid_at, final_amount_paid_cents: p.final_amount_paid_cents,
    transfer_failure_message: p.transfer_failure_message || null, created_at: p.created_at };
}

async function lines(payoutId, runner = db) {
  return (await runner.query(
    `SELECT l.marketplace_order_id AS order_id, l.order_number, l.goods_cents, l.platform_fee_cents, l.amount_cents, l.active,
            l.tax_to_seller_cents, o.tax_cents, o.tax_remitter, o.tax_jurisdiction, o.sales_channel, o.platform_fee_bps,
            o.quantity, o.item_snapshot->>'title' AS title, o.paid_at, o.fulfillment_status
       FROM storefront_payout_lines l JOIN marketplace_orders o ON o.id = l.marketplace_order_id
      WHERE l.storefront_payout_id = $1 ORDER BY o.paid_at`, [payoutId])).rows;
}

// ── Admin ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function listForAdmin({ status } = {}) {
  const p = []; let where = '';
  if (status) { p.push(String(status)); where = 'WHERE sp.settlement_status = $1'; }
  const rows = (await db.query(
    `SELECT sp.*, COALESCE(prof.display_name, u.email) AS seller_name
       FROM storefront_payouts sp JOIN seller_profiles prof ON prof.id = sp.seller_profile_id LEFT JOIN users u ON u.id = sp.seller_user_id
       ${where} ORDER BY sp.period_cutoff_at DESC, sp.created_at DESC LIMIT 200`, p)).rows;
  return rows.map((r) => ({ ...view(r), seller_name: r.seller_name }));
}
async function getForAdmin(id) {
  if (!UUID_RE.test(String(id || ''))) throw err(404, 'NOT_FOUND', 'Payout not found.');
  const p = (await db.query('SELECT * FROM storefront_payouts WHERE id = $1', [id])).rows[0];
  if (!p) throw err(404, 'NOT_FOUND', 'Payout not found.');
  return { ...view(p), lines: await lines(id) };
}

async function setHold(id, adminId, { hold, reason } = {}) {
  if (!adminId) throw err(403, 'ADMIN_REQUIRED', 'Administrator only.');
  return withTransaction(async (client) => {
    const p = (await client.query('SELECT * FROM storefront_payouts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p) throw err(404, 'NOT_FOUND', 'Payout not found.');
    if (['paid', 'void'].includes(p.settlement_status)) throw err(409, 'NOT_CHANGEABLE', 'This payout is already ' + p.settlement_status + '.');
    const why = String(reason || '').trim().slice(0, 500);
    if (hold && why.length < 3) throw err(422, 'REASON_REQUIRED', 'Give a short reason for the hold.');
    const upd = (await client.query(`UPDATE storefront_payouts SET settlement_status = $2, on_hold_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, hold ? 'on_hold' : 'pending_review', hold ? why : null])).rows[0];
    await auditService.logEvent(client, { eventType: hold ? 'storefront_settlement.on_hold' : 'storefront_settlement.hold_released',
      entityType: 'storefront_payout', entityId: id, actorId: adminId, metadata: { reason: why || null } });
    return view(upd);
  });
}

// Void a prepared (unpaid) payout: its orders become available for a later payout (e.g. after a refund or correction).
async function voidPayout(id, adminId, { reason } = {}) {
  if (!adminId) throw err(403, 'ADMIN_REQUIRED', 'Administrator only.');
  const why = String(reason || '').trim().slice(0, 500);
  if (why.length < 3) throw err(422, 'REASON_REQUIRED', 'Give a short reason.');
  return withTransaction(async (client) => {
    const p = (await client.query('SELECT * FROM storefront_payouts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p) throw err(404, 'NOT_FOUND', 'Payout not found.');
    if (p.settlement_status === 'paid' || p.stripe_transfer_id) throw err(409, 'ALREADY_PAID', 'A paid payout cannot be voided.');
    if (p.settlement_status === 'void') return view(p);
    await client.query('UPDATE storefront_payout_lines SET active = false WHERE storefront_payout_id = $1', [id]);
    await client.query('UPDATE storefront_payout_recoveries SET applied_payout_id = NULL, applied_at = NULL WHERE applied_payout_id = $1', [id]);
    await client.query('UPDATE marketplace_orders SET storefront_payout_id = NULL WHERE storefront_payout_id = $1', [id]);
    const upd = (await client.query(`UPDATE storefront_payouts SET settlement_status = 'void', void_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, why])).rows[0];
    await auditService.logEvent(client, { eventType: 'storefront_settlement.voided', entityType: 'storefront_payout', entityId: id, actorId: adminId,
      metadata: { reason: why } });
    return view(upd);
  });
}

class PayError extends Error {}
/**
 * Administrator-approved payment: one Stripe transfer to the seller's connected account. Locks the record; re-checks every
 * included order (still paid, unrefunded, undisputed, not held); the confirmed amount must equal the record. If the transfer
 * fails nothing is marked paid (retry-safe; the idempotency key returns the same transfer).
 */
async function payPayout(id, { actorId = null, confirmedCompleted = false, finalAmountCents } = {}) {
  if (!actorId) throw err(403, 'ADMIN_REQUIRED', 'Administrator only.');
  if (!UUID_RE.test(String(id || ''))) throw err(404, 'NOT_FOUND', 'Payout not found.');
  const engine = require('./settlementEngine');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query('SELECT * FROM storefront_payouts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p) throw err(404, 'NOT_FOUND', 'Payout not found.');
    const fail = (m) => { throw Object.assign(new PayError(m), { status: 409, code: 'NOT_PAYABLE' }); };
    if (p.settlement_status === 'paid' || p.stripe_transfer_id) fail('This payout is already paid.');
    if (p.settlement_status === 'void') fail('This payout is void.');
    if (p.settlement_status === 'on_hold') fail('This payout is on hold' + (p.on_hold_reason ? ' (' + p.on_hold_reason + ')' : '') + '. Release the hold first.');
    if (!confirmedCompleted) fail('Confirm that every included order was fulfilled.');
    const changed = (await client.query(
      `SELECT o.order_number FROM storefront_payout_lines l JOIN marketplace_orders o ON o.id = l.marketplace_order_id
        WHERE l.storefront_payout_id = $1 AND l.active AND NOT (${ELIGIBLE_SQL})`, [id])).rows;
    if (changed.length) fail('Order ' + changed.map((r) => r.order_number).join(', ') + ' changed since this payout was prepared (refund, dispute, hold or review). Void this payout and prepare it again.');
    const lineSum = Number((await client.query(`SELECT coalesce(sum(amount_cents),0)::int a FROM storefront_payout_lines WHERE storefront_payout_id = $1 AND active`, [id])).rows[0].a);
    const recSum = Number((await client.query(`SELECT coalesce(sum(amount_cents),0)::int a FROM storefront_payout_recoveries WHERE applied_payout_id = $1`, [id])).rows[0].a);
    const sum = lineSum - recSum;
    if (sum !== Number(p.seller_payout_cents) || recSum !== (Number(p.recovery_cents) || 0)) fail('The payout total no longer matches its orders. Void it and prepare it again.');
    if (Math.trunc(Number(finalAmountCents)) !== sum) fail('Final amount (' + finalAmountCents + ') does not match the payout (' + sum + ').');
    if (sum <= 0) fail('Nothing to pay.');
    const pref = await require('./payoutPreferenceService').getSellerPayoutPreference(p.seller_user_id);
    if (!pref || pref.payout_method !== 'ach' || !engine.connectPayoutReady(pref)) fail('Seller Direct Deposit is not ready (onboarding incomplete or payouts disabled).');

    let transfer;
    try {
      transfer = await require('./stripeConnectService').getStripe().transfers.create({
        amount: sum, currency: 'usd', destination: pref.stripe_account_id,
        metadata: { storefront_payout_id: String(id), seller_user_id: String(p.seller_user_id), period_cutoff_at: new Date(p.period_cutoff_at).toISOString(),
          platform: 'advantage.bid', kind: 'storefront' },
      }, { idempotencyKey: 'storefront-transfer:' + id });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw Object.assign(new PayError('The transfer could not be created: ' + (e && e.message ? e.message : 'unknown error')), { status: 502, code: 'TRANSFER_FAILED' });
    }
    await client.query(
      `UPDATE storefront_payouts SET settlement_status = 'paid', payout_status = 'processing', stripe_transfer_id = $2, transfer_initiated_at = now(),
              final_amount_paid_cents = $3, paid_at = now(), paid_by_user_id = $4, updated_at = now() WHERE id = $1`, [id, transfer.id, sum, actorId]);
    await client.query(`UPDATE marketplace_orders SET settled_at = now() WHERE storefront_payout_id = $1`, [id]);
    await auditService.logEvent(client, { eventType: 'storefront_settlement.paid', entityType: 'storefront_payout', entityId: id, actorId,
      metadata: { amount_cents: sum, stripe_transfer_id: transfer.id, orders: Number(p.order_count) } });
    await client.query('COMMIT');
    return { paid: true, amount_cents: sum, stripe_transfer_id: transfer.id, payout_status: 'processing' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Seller: their own storefront payouts (company from the session) ─────────────────────────────────────────────
async function listForSeller(sellerProfileId) {
  const rows = (await db.query(
    `SELECT * FROM storefront_payouts WHERE seller_profile_id = $1 AND settlement_status <> 'void' ORDER BY period_cutoff_at DESC LIMIT 100`, [sellerProfileId])).rows;
  const out = [];
  for (const r of rows) {
    const v = view(r);
    delete v.stripe_transfer_id; delete v.on_hold_reason; delete v.void_reason; delete v.transfer_failure_message;
    out.push({ ...v, lines: (await lines(r.id)).filter((l) => l.active) });
  }
  return out;
}

// A refund on an order whose storefront payout was already PAID: record what must be recovered from the seller (the lesser
// of the refunded amount and what the seller received for that order). Applied by the next prepared payout. Idempotent; a
// larger later refund raises an unapplied recovery, never an applied one (that is flagged for an administrator instead).
async function recordRecovery(orderId) {
  const o = (await db.query(
    `SELECT o.id, o.seller_id, o.order_number, o.refunded_amount_cents, o.settled_at,
            (SELECT l.amount_cents FROM storefront_payout_lines l JOIN storefront_payouts p ON p.id = l.storefront_payout_id
              WHERE l.marketplace_order_id = o.id AND l.active AND p.settlement_status = 'paid' LIMIT 1) AS paid_cents
       FROM marketplace_orders o WHERE o.id = $1`, [orderId])).rows[0];
  if (!o || !o.settled_at || !(Number(o.paid_cents) > 0) || !(Number(o.refunded_amount_cents) > 0)) return null;
  const amount = Math.min(Number(o.refunded_amount_cents), Number(o.paid_cents));
  const row = (await db.query(
    `INSERT INTO storefront_payout_recoveries (marketplace_order_id, seller_profile_id, amount_cents, reason, kind)
     VALUES ($1, $2, $3, 'refund after payout', 'refund')
     ON CONFLICT (marketplace_order_id, kind) DO UPDATE SET amount_cents = GREATEST(storefront_payout_recoveries.amount_cents, EXCLUDED.amount_cents)
       WHERE storefront_payout_recoveries.applied_payout_id IS NULL
     RETURNING *`, [o.id, o.seller_id, amount])).rows[0];
  if (!row) {
    await db.query(`UPDATE marketplace_orders SET review_required = true, review_note = $2 WHERE id = $1`,
      [o.id, 'A further refund came after this order\'s recovery was already deducted; adjust the seller manually.']).catch(() => {});
  }
  return row || null;
}

// Seller-caused refund (owner policy direction 2026-11-03): the documented, nonrefundable card processing cost of the
// order (processing_fee_cents, recorded from the processor) may be recovered from the seller's next payout, ONLY when the
// owner has turned on STOREFRONT_SELLER_FAULT_RECOVERY_ENABLED (off until approved with counsel-reviewed seller terms),
// only for a refund an administrator marked as the seller's responsibility, and never more than that recorded cost.
// Recorded once per order (kind 'processing_fee'); applied by prepareWeek like any other recovery. Returns the row or null.
function sellerFaultRecoveryEnabled() { return process.env.STOREFRONT_SELLER_FAULT_RECOVERY_ENABLED === 'true'; }
async function recordSellerFaultCost(orderId) {
  if (!sellerFaultRecoveryEnabled()) return null;
  const o = (await db.query('SELECT id, seller_id, refund_fault, processing_fee_cents FROM marketplace_orders WHERE id = $1', [orderId])).rows[0];
  if (!o || o.refund_fault !== 'seller' || !(Number(o.processing_fee_cents) > 0)) return null;
  return (await db.query(
    `INSERT INTO storefront_payout_recoveries (marketplace_order_id, seller_profile_id, amount_cents, reason, kind)
     VALUES ($1, $2, $3, 'card processing cost of a seller-caused refund', 'processing_fee')
     ON CONFLICT (marketplace_order_id, kind) DO NOTHING RETURNING *`, [o.id, o.seller_id, Number(o.processing_fee_cents)])).rows[0] || null;
}

// Weekly preparation tick (a worker calls this; it is safe to call often). Runs on Thursday (Eastern) and later; prepares
// the week ending at the latest cutoff. Self-gated on seller settlements and storefront checkout being switched on.
async function weeklyTick(now = new Date()) {
  const guards = require('../lib/launchGuards');
  if (!guards.sellerSettlementsEnabled() || !guards.marketplaceCheckoutEnabled()) return { ran: false };
  return { ran: true, ...(await prepareWeek({ cutoff: cutoffFor(now) })) };
}

module.exports = { recordRecovery, recordSellerFaultCost, sellerFaultRecoveryEnabled, cutoffFor, prepareWeek, listForAdmin, getForAdmin, setHold, voidPayout, payPayout, listForSeller, weeklyTick, ELIGIBLE_SQL, PayError };
