'use strict';

/**
 * taxLedgerService - the permanent, append-only sales tax ledger (migration 231, tax_ledger_entries).
 *
 * HOW ENTRIES ARE POSTED. The ledger is derived from the platform's own financial records (auction payments, storefront
 * orders, their refunds, lost disputes) by sync(), which is idempotent: every entry has a stable idempotency_key, so
 * posting again changes nothing. It runs on a schedule, after refunds, and on demand; a backfill is the same code. No
 * payment, refund or payout path depends on it, so a ledger problem can never break or delay a charge.
 *
 * SIGNS. A sale is positive, a refund negative. Remittances and reserve transfers are their own entries.
 *   liability for a state and period = sum(tax_collected_cents where remitter = 'platform') - sum(tax_remitted_cents)
 *
 * CORRECTIONS. Rows are never updated or deleted (a database trigger refuses both). A correction is a new 'adjustment'
 * entry with a written reason; reconciliation (taxReconciliationService) reports any difference between the ledger and
 * its sources instead of rewriting history.
 *
 * Demo records and pre-launch test auctions are never posted.
 */

const db = require('../../db');

const PERIOD_SQL = (col) => `date_trunc('month', ${col} AT TIME ZONE 'America/New_York')::date`;
const COLS = ['idempotency_key', 'entry_type', 'channel', 'source_type', 'source_id', 'occurred_at', 'state', 'jurisdiction_detail', 'remitter',
  'tax_basis', 'seller_profile_id', 'buyer_user_id', 'auction_id', 'gross_cents', 'merchandise_cents', 'buyer_premium_cents', 'shipping_cents',
  'taxable_cents', 'exempt_cents', 'tax_calculated_cents', 'tax_collected_cents', 'seller_proceeds_cents', 'platform_fee_cents',
  'tax_remitted_cents', 'tax_reserved_cents', 'payment_intent_id', 'tax_calculation_id', 'tax_transaction_id', 'tax_reversal_id', 'filing_id',
  'reverses_entry_id', 'note', 'created_by'];
const CENT_COLS = new Set(['gross_cents', 'merchandise_cents', 'buyer_premium_cents', 'shipping_cents', 'taxable_cents', 'exempt_cents',
  'tax_calculated_cents', 'tax_collected_cents', 'seller_proceeds_cents', 'platform_fee_cents', 'tax_remitted_cents', 'tax_reserved_cents']);

const int = (v) => Math.trunc(Number(v) || 0);
const st = (v) => (v && /^[A-Za-z]{2}$/.test(String(v).trim()) ? String(v).trim().toUpperCase() : null);

/** Post one entry. Returns the new row, or null when that idempotency_key was already posted. */
async function post(entry, runner = db) {
  const e = { ...entry };
  if (!e.idempotency_key || !e.entry_type || !e.channel || !e.source_type) throw new Error('tax ledger: idempotency_key, entry_type, channel and source_type are required');
  e.occurred_at = e.occurred_at ? new Date(e.occurred_at) : new Date();
  e.state = st(e.state);
  if (e.jurisdiction_detail && typeof e.jurisdiction_detail !== 'string') e.jurisdiction_detail = JSON.stringify(e.jurisdiction_detail);
  const vals = COLS.map((c) => (CENT_COLS.has(c) ? int(e[c]) : (e[c] === undefined ? null : e[c])));
  const ph = COLS.map((c, i) => (c === 'jurisdiction_detail' ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const occurredIdx = COLS.indexOf('occurred_at') + 1;
  const r = await runner.query(
    `INSERT INTO tax_ledger_entries (${COLS.join(', ')}, tax_period)
     VALUES (${ph.join(', ')}, ${PERIOD_SQL(`$${occurredIdx}::timestamptz`)})
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, vals);
  return r.rows[0] || null;
}

// The tax share of a cumulative refund, to the cent: proportional to the refunded part of the charge (the same way the
// tax calculation provider spreads a partial reversal).
function taxShare(taxCents, refundedCents, chargeCents) {
  const tax = int(taxCents); const refunded = int(refundedCents); const charge = int(chargeCents);
  if (tax <= 0 || refunded <= 0 || charge <= 0) return 0;
  if (refunded >= charge) return tax;
  return Math.min(tax, Math.floor((tax * refunded) / charge + 0.5));
}

async function postedRefundTotals(sourceType, sourceId, runner) {
  const r = (await runner.query(
    `SELECT COALESCE(SUM(gross_cents),0)::bigint g, COALESCE(SUM(tax_collected_cents),0)::bigint t, COALESCE(SUM(seller_proceeds_cents),0)::bigint p,
            COALESCE(SUM(platform_fee_cents),0)::bigint f, COALESCE(SUM(merchandise_cents),0)::bigint m, COALESCE(SUM(shipping_cents),0)::bigint s
       FROM tax_ledger_entries WHERE source_type = $1 AND source_id = $2 AND entry_type = 'refund'`, [sourceType, String(sourceId)])).rows[0];
  return { gross: -int(r.g), tax: -int(r.t), proceeds: -int(r.p), fee: -int(r.f), merch: -int(r.m), ship: -int(r.s) };
}

// ── Auction payments ─────────────────────────────────────────────────────────────────────────────────────────────
async function syncAuctionPayments(runner = db) {
  let posted = 0;
  const rows = (await runner.query(
    `SELECT p.id, p.auction_id, p.buyer_user_id, p.amount_cents, p.sales_tax_cents, p.taxable_base_cents, p.refunded_amount_cents, p.status,
            p.charged_at, p.created_at, p.refunded_at, p.payment_intent_id, p.stripe_tax_calculation_id, p.stripe_tax_transaction_id,
            p.stripe_tax_reversal_id, p.tax_remitter, p.tax_jurisdiction, p.tax_basis, p.tax_detail,
            a.seller_id AS seller_profile_id, a.address_state,
            bai.hammer_cents, bai.buyer_premium_cents, bai.shipping_cents AS inv_shipping_cents
       FROM payments p
       JOIN auctions a ON a.id = p.auction_id
       LEFT JOIN buyer_auction_invoices bai ON bai.payment_id = p.id
      WHERE p.status IN ('paid', 'refunded', 'partially_refunded')
        AND a.is_demo IS NOT TRUE AND a.pre_launch_test IS NOT TRUE
        AND (NOT EXISTS (SELECT 1 FROM tax_ledger_entries l WHERE l.idempotency_key = 'sale:payment:' || p.id)
             OR (COALESCE(p.refunded_amount_cents, 0) > 0
                 AND NOT EXISTS (SELECT 1 FROM tax_ledger_entries l WHERE l.idempotency_key = 'refund:payment:' || p.id || ':' || p.refunded_amount_cents)))
      ORDER BY p.created_at LIMIT 2000`)).rows;
  for (const p of rows) {
    const gross = int(p.amount_cents); const tax = int(p.sales_tax_cents);
    const goods = gross - tax;
    const ship = int(p.inv_shipping_cents);
    const premium = p.hammer_cents != null ? int(p.buyer_premium_cents) : 0;
    const merch = p.hammer_cents != null ? int(p.hammer_cents) : goods - ship;
    const detail = p.tax_detail && typeof p.tax_detail === 'object' ? p.tax_detail : null;
    const taxable = tax > 0 ? (detail && int(detail.taxable_cents) > 0 ? int(detail.taxable_cents) : int(p.taxable_base_cents) || goods) : 0;
    const remitter = p.tax_remitter || (tax > 0 ? 'platform' : 'unconfigured');
    const state = st(p.tax_jurisdiction) || st(p.address_state);
    const base = { channel: 'auction', source_type: 'auction_payment', source_id: String(p.id), state, remitter,
      tax_basis: p.tax_basis || (tax > 0 ? 'taxed' : 'unconfigured'), seller_profile_id: p.seller_profile_id, buyer_user_id: p.buyer_user_id,
      auction_id: p.auction_id, payment_intent_id: p.payment_intent_id, tax_calculation_id: p.stripe_tax_calculation_id,
      tax_transaction_id: p.stripe_tax_transaction_id };
    if (await post({ ...base, idempotency_key: 'sale:payment:' + p.id, entry_type: 'sale', occurred_at: p.charged_at || p.created_at,
      jurisdiction_detail: detail, gross_cents: gross, merchandise_cents: merch, buyer_premium_cents: premium, shipping_cents: ship,
      taxable_cents: taxable, exempt_cents: goods - taxable, tax_calculated_cents: tax, tax_collected_cents: tax }, runner)) posted++;
    const refunded = Math.min(gross, int(p.refunded_amount_cents));
    if (refunded > 0) {
      const done = await postedRefundTotals('auction_payment', p.id, runner);
      const dGross = refunded - done.gross; const dTax = taxShare(tax, refunded, gross) - done.tax;
      if (dGross > 0 || dTax > 0) {
        const dGoods = dGross - dTax;
        const dTaxable = tax > 0 && goods > 0 ? Math.min(dGoods, Math.floor((taxable * dGoods) / goods + 0.5)) : 0;
        if (await post({ ...base, idempotency_key: `refund:payment:${p.id}:${int(p.refunded_amount_cents)}`, entry_type: 'refund',
          occurred_at: p.refunded_at || new Date(), tax_reversal_id: p.stripe_tax_reversal_id, gross_cents: -dGross, merchandise_cents: -dGoods,
          taxable_cents: -dTaxable, exempt_cents: -(dGoods - dTaxable), tax_calculated_cents: -dTax, tax_collected_cents: -dTax,
          note: refunded >= gross ? 'full refund' : 'partial refund' }, runner)) posted++;
      }
    }
  }
  return posted;
}

// ── Storefront orders (marketplace and embedded storefront) ──────────────────────────────────────────────────────────
function orderState(o) {
  if (st(o.tax_jurisdiction)) return st(o.tax_jurisdiction);
  const pick = (j) => { try { const v = typeof j === 'string' ? JSON.parse(j) : j; return v && (v.state || v.pickup_state); } catch (_e) { return null; } };
  return st(o.fulfillment_method === 'shipping' ? pick(o.ship_to) : pick(o.pickup_snapshot));
}

async function syncOrders(runner = db) {
  let posted = 0;
  const rows = (await runner.query(
    `SELECT o.* FROM marketplace_orders o
      WHERE o.paid_at IS NOT NULL AND o.is_demo IS NOT TRUE
        AND (NOT EXISTS (SELECT 1 FROM tax_ledger_entries l WHERE l.idempotency_key = 'sale:order:' || o.id)
             OR (COALESCE(o.refunded_amount_cents, 0) > 0
                 AND NOT EXISTS (SELECT 1 FROM tax_ledger_entries l WHERE l.idempotency_key = 'refund:order:' || o.id || ':' || o.refunded_amount_cents)))
      ORDER BY o.paid_at LIMIT 2000`)).rows;
  for (const o of rows) {
    const gross = int(o.total_charge_cents); const tax = int(o.tax_cents);
    const merch = int(o.item_price_cents); const ship = int(o.shipping_cents);
    const goods = merch + ship;
    const detail = o.tax_detail && typeof o.tax_detail === 'object' ? o.tax_detail : null;
    const taxable = tax > 0 ? (detail && int(detail.taxable_cents) > 0 ? Math.min(goods, int(detail.taxable_cents)) : goods) : 0;
    // Orders record 'none' when nothing was collected; the basis says why (seller_direct, exempt, not_taxable).
    const basis = o.tax_basis || (tax > 0 ? 'taxed' : null);
    const remitter = o.tax_remitter === 'none' && basis === 'seller_direct' ? 'seller_direct' : (o.tax_remitter || (tax > 0 ? 'platform' : 'unconfigured'));
    const base = { channel: o.sales_channel === 'seller_website' ? 'seller_website' : 'marketplace', source_type: 'marketplace_order', source_id: String(o.id),
      state: orderState(o), remitter, tax_basis: basis, seller_profile_id: o.seller_id, buyer_user_id: o.buyer_user_id,
      payment_intent_id: o.stripe_payment_intent_id, tax_calculation_id: o.stripe_tax_calculation_id, tax_transaction_id: o.stripe_tax_transaction_id };
    if (await post({ ...base, idempotency_key: 'sale:order:' + o.id, entry_type: 'sale', occurred_at: o.paid_at, jurisdiction_detail: detail,
      gross_cents: gross, merchandise_cents: merch, shipping_cents: ship, taxable_cents: taxable, exempt_cents: goods - taxable,
      tax_calculated_cents: tax, tax_collected_cents: tax, seller_proceeds_cents: int(o.seller_proceeds_cents), platform_fee_cents: int(o.platform_fee_cents),
      note: o.order_number || null }, runner)) posted++;
    const refunded = Math.min(gross, int(o.refunded_amount_cents));
    if (refunded > 0) {
      const done = await postedRefundTotals('marketplace_order', o.id, runner);
      const full = refunded >= gross;
      const dGross = refunded - done.gross; const dTax = taxShare(tax, refunded, gross) - done.tax;
      if (dGross > 0 || dTax > 0) {
        const dGoods = dGross - dTax;
        const dTaxable = tax > 0 && goods > 0 ? Math.min(dGoods, Math.floor((taxable * dGoods) / goods + 0.5)) : 0;
        // A full refund undoes the whole sale (item, shipping, commission, proceeds). A partial refund is an amount, not a
        // line: it is recorded against merchandise, and the commission and proceeds stay as the order records them.
        const dShip = full ? ship - done.ship : 0;
        if (await post({ ...base, idempotency_key: `refund:order:${o.id}:${int(o.refunded_amount_cents)}`, entry_type: 'refund',
          occurred_at: o.refunded_at || new Date(), tax_reversal_id: o.stripe_tax_reversal_id, gross_cents: -dGross,
          merchandise_cents: -(dGoods - dShip), shipping_cents: -dShip, taxable_cents: -dTaxable, exempt_cents: -(dGoods - dTaxable),
          tax_calculated_cents: -dTax, tax_collected_cents: -dTax,
          seller_proceeds_cents: full ? -(int(o.seller_proceeds_cents) - done.proceeds) : 0, platform_fee_cents: full ? -(int(o.platform_fee_cents) - done.fee) : 0,
          note: (o.order_number ? o.order_number + ': ' : '') + (full ? 'full refund' : 'partial refund') }, runner)) posted++;
      }
    }
  }
  return posted;
}

// ── Lost disputes (chargebacks): the money left; the tax treatment is the accountant's call, so tax is not changed here ──
async function syncDisputes(runner = db) {
  let posted = 0;
  let rows = [];
  try {
    rows = (await runner.query(
      `SELECT d.id, d.stripe_dispute_id, d.amount_cents, d.payment_id, d.marketplace_order_id, d.auction_id, d.payment_intent_id, d.closed_at, d.updated_at,
              d.marketplace_seller_id, o.sales_channel, o.tax_jurisdiction AS order_state, p.tax_jurisdiction AS payment_state, a.address_state, a.seller_id AS auction_seller
         FROM payment_disputes d
         LEFT JOIN marketplace_orders o ON o.id = d.marketplace_order_id
         LEFT JOIN payments p ON p.id = d.payment_id
         LEFT JOIN auctions a ON a.id = d.auction_id
        WHERE d.status = 'lost' AND COALESCE(d.livemode, true) = true
          AND NOT EXISTS (SELECT 1 FROM tax_ledger_entries l WHERE l.idempotency_key = 'dispute:' || d.stripe_dispute_id || ':lost')
        LIMIT 500`)).rows;
  } catch (e) { if (e && (e.code === '42P01' || e.code === '42703')) return 0; throw e; }
  for (const d of rows) {
    const isOrder = !!d.marketplace_order_id;
    if (await post({ idempotency_key: `dispute:${d.stripe_dispute_id}:lost`, entry_type: 'dispute',
      channel: isOrder ? (d.sales_channel === 'seller_website' ? 'seller_website' : 'marketplace') : 'auction',
      source_type: isOrder ? 'marketplace_order' : 'auction_payment', source_id: String(d.marketplace_order_id || d.payment_id || d.id),
      occurred_at: d.closed_at || d.updated_at, state: st(d.order_state) || st(d.payment_state) || st(d.address_state),
      seller_profile_id: d.marketplace_seller_id || d.auction_seller || null, auction_id: d.auction_id || null, payment_intent_id: d.payment_intent_id,
      gross_cents: -int(d.amount_cents), note: 'Chargeback lost. Sales tax on this sale is unchanged in the ledger; ask the accountant how to treat it on the return.' }, runner)) posted++;
  }
  return posted;
}

/** Bring the ledger up to date with every source. Idempotent; safe to run at any time and concurrently. */
async function sync(runner = db) {
  const out = { auction: 0, orders: 0, disputes: 0 };
  out.auction = await syncAuctionPayments(runner);
  out.orders = await syncOrders(runner);
  out.disputes = await syncDisputes(runner);
  out.posted = out.auction + out.orders + out.disputes;
  return out;
}

// ── Manual entries (administrator) ───────────────────────────────────────────────────────────────────────────────
function need(cond, code, message) { if (!cond) throw Object.assign(new Error(message), { status: 422, code }); }

/** A sales tax payment to a state, recorded against a filing. amountCents > 0. */
async function recordRemittance({ filingId, state, amountCents, paidOn, reference, note }, actorId, runner = db) {
  const amt = int(amountCents);
  need(st(state), 'STATE_INVALID', 'Choose the state the payment was made to.');
  need(amt > 0, 'AMOUNT_INVALID', 'Enter the amount paid.');
  need(String(reference || '').trim().length >= 3, 'REFERENCE_REQUIRED', 'Enter the payment confirmation or reference.');
  const when = paidOn ? new Date(paidOn) : new Date();
  need(!Number.isNaN(when.getTime()), 'DATE_INVALID', 'Enter a valid payment date.');
  const ref = String(reference).trim().slice(0, 120);
  return post({ idempotency_key: `remit:${filingId || 'none'}:${st(state)}:${ref}`, entry_type: 'remittance', channel: 'platform',
    source_type: filingId ? 'filing' : 'manual', source_id: filingId ? String(filingId) : null, occurred_at: when, state, remitter: 'platform',
    tax_remitted_cents: amt, filing_id: filingId || null, note: ('Reference ' + ref + (note ? '. ' + String(note).trim().slice(0, 400) : '')), created_by: actorId }, runner);
}

/** Money moved to (positive) or back from (negative) the dedicated tax bank account, as recorded by an administrator. */
async function recordReserveTransfer({ amountCents, movedOn, reference, note }, actorId, runner = db) {
  const amt = int(amountCents);
  need(amt !== 0, 'AMOUNT_INVALID', 'Enter the amount moved.');
  need(String(reference || '').trim().length >= 3, 'REFERENCE_REQUIRED', 'Enter the bank reference for the transfer.');
  const when = movedOn ? new Date(movedOn) : new Date();
  need(!Number.isNaN(when.getTime()), 'DATE_INVALID', 'Enter a valid date.');
  const ref = String(reference).trim().slice(0, 120);
  return post({ idempotency_key: `reserve:${ref}`, entry_type: 'reserve_transfer', channel: 'platform', source_type: 'manual', occurred_at: when,
    tax_reserved_cents: amt, note: ('Reference ' + ref + (note ? '. ' + String(note).trim().slice(0, 400) : '')), created_by: actorId }, runner);
}

/** A correction. Never edits history: posts a signed adjustment with a written reason. */
async function recordAdjustment({ state, channel, taxCollectedCents, grossCents, taxableCents, remitter, reason, occurredOn, reversesEntryId }, actorId, runner = db) {
  need(st(state), 'STATE_INVALID', 'Choose the state the correction applies to.');
  need(String(reason || '').trim().length >= 10, 'REASON_REQUIRED', 'Explain the correction (at least a sentence).');
  need(int(taxCollectedCents) !== 0 || int(grossCents) !== 0 || int(taxableCents) !== 0, 'AMOUNT_INVALID', 'Enter at least one amount to correct.');
  need(['auction', 'marketplace', 'seller_website', 'platform'].includes(channel || 'platform'), 'CHANNEL_INVALID', 'Choose a sales channel.');
  const when = occurredOn ? new Date(occurredOn) : new Date();
  need(!Number.isNaN(when.getTime()), 'DATE_INVALID', 'Enter a valid date.');
  return post({ idempotency_key: 'adj:' + require('crypto').randomUUID(), entry_type: 'adjustment', channel: channel || 'platform', source_type: 'manual',
    occurred_at: when, state, remitter: ['platform', 'seller_direct', 'none'].includes(remitter) ? remitter : 'platform',
    gross_cents: int(grossCents), taxable_cents: int(taxableCents), tax_calculated_cents: int(taxCollectedCents), tax_collected_cents: int(taxCollectedCents),
    reverses_entry_id: reversesEntryId || null, note: String(reason).trim().slice(0, 1000), created_by: actorId }, runner);
}

module.exports = { post, sync, syncAuctionPayments, syncOrders, syncDisputes, recordRemittance, recordReserveTransfer, recordAdjustment, taxShare, PERIOD_SQL };
