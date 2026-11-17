'use strict';

/**
 * taxReconciliationService - compares the money records that must agree (owner 2026-11-16; migration 231):
 *   1. customer charges (auction payments, storefront orders) against the tax ledger;
 *   2. tax calculations and recorded tax transactions against the charges (and, when the provider can be reached, the
 *      provider's own record of each tax transaction);
 *   3. refunds against their tax reversals;
 *   4. seller transfers: no payout carried tax Advantage.Bid remits, and no auction paid its seller more than was
 *      collected for the seller;
 *   5. recorded tax remittances against the liability and against filings marked paid.
 *
 * It only READS money records and WRITES tax_reconciliation_runs and tax_alerts. A difference is reported to an
 * administrator (alert type 'reconciliation'); nothing is corrected automatically, and the ledger is never rewritten.
 * Never throws: a failed run is recorded as 'failed'.
 */

const db = require('../../db');
const ledger = require('./taxLedgerService');
const alerts = require('./taxAlerts');

const LIMIT = 50;   // examples kept per check

async function rows(sql, params = []) { return (await db.query(sql, params)).rows; }

const CHECKS = [
  {
    name: 'auction_payments_posted', note: 'Every paid auction payment has its sale in the ledger for the same amounts.',
    sql: `SELECT p.id::text AS id, p.amount_cents AS source_gross, l.gross_cents AS ledger_gross, p.sales_tax_cents AS source_tax, l.tax_collected_cents AS ledger_tax
            FROM payments p JOIN auctions a ON a.id = p.auction_id
            LEFT JOIN tax_ledger_entries l ON l.idempotency_key = 'sale:payment:' || p.id
           WHERE p.status IN ('paid','refunded','partially_refunded') AND a.is_demo IS NOT TRUE AND a.pre_launch_test IS NOT TRUE
             AND (l.id IS NULL OR l.gross_cents <> p.amount_cents OR l.tax_collected_cents <> COALESCE(p.sales_tax_cents, 0)) LIMIT ${LIMIT}`,
  },
  {
    name: 'orders_posted', note: 'Every paid storefront order has its sale in the ledger for the same amounts.',
    sql: `SELECT o.id::text AS id, o.order_number, o.total_charge_cents AS source_gross, l.gross_cents AS ledger_gross, o.tax_cents AS source_tax, l.tax_collected_cents AS ledger_tax
            FROM marketplace_orders o LEFT JOIN tax_ledger_entries l ON l.idempotency_key = 'sale:order:' || o.id
           WHERE o.paid_at IS NOT NULL AND o.is_demo IS NOT TRUE
             AND (l.id IS NULL OR l.gross_cents <> o.total_charge_cents OR l.tax_collected_cents <> COALESCE(o.tax_cents, 0)) LIMIT ${LIMIT}`,
  },
  {
    name: 'auction_refunds_posted', note: 'Refunded auction amounts equal the refunds in the ledger.',
    sql: `SELECT p.id::text AS id, p.refunded_amount_cents AS source_refunded, COALESCE(-SUM(l.gross_cents), 0)::bigint AS ledger_refunded
            FROM payments p JOIN auctions a ON a.id = p.auction_id
            LEFT JOIN tax_ledger_entries l ON l.source_type = 'auction_payment' AND l.source_id = p.id::text AND l.entry_type = 'refund'
           WHERE COALESCE(p.refunded_amount_cents, 0) > 0 AND a.is_demo IS NOT TRUE AND a.pre_launch_test IS NOT TRUE
           GROUP BY p.id, p.refunded_amount_cents, p.amount_cents
          HAVING COALESCE(-SUM(l.gross_cents), 0) <> LEAST(p.refunded_amount_cents, p.amount_cents) LIMIT ${LIMIT}`,
  },
  {
    name: 'order_refunds_posted', note: 'Refunded storefront amounts equal the refunds in the ledger.',
    sql: `SELECT o.id::text AS id, o.order_number, o.refunded_amount_cents AS source_refunded, COALESCE(-SUM(l.gross_cents), 0)::bigint AS ledger_refunded
            FROM marketplace_orders o
            LEFT JOIN tax_ledger_entries l ON l.source_type = 'marketplace_order' AND l.source_id = o.id::text AND l.entry_type = 'refund'
           WHERE COALESCE(o.refunded_amount_cents, 0) > 0 AND o.paid_at IS NOT NULL AND o.is_demo IS NOT TRUE
           GROUP BY o.id, o.order_number, o.refunded_amount_cents, o.total_charge_cents
          HAVING COALESCE(-SUM(l.gross_cents), 0) <> LEAST(o.refunded_amount_cents, o.total_charge_cents) LIMIT ${LIMIT}`,
  },
  {
    name: 'tax_transactions_recorded', note: 'Every sale with tax has a recorded tax transaction (older than one hour).',
    sql: `SELECT 'payment:' || p.id AS id, p.sales_tax_cents AS tax FROM payments p JOIN auctions a ON a.id = p.auction_id
           WHERE p.status IN ('paid','refunded','partially_refunded') AND COALESCE(p.sales_tax_cents, 0) > 0 AND p.stripe_tax_transaction_id IS NULL
             AND a.is_demo IS NOT TRUE AND COALESCE(p.charged_at, p.created_at) < now() - interval '1 hour'
          UNION ALL
          SELECT 'order:' || o.id, o.tax_cents FROM marketplace_orders o
           WHERE o.paid_at IS NOT NULL AND COALESCE(o.tax_cents, 0) > 0 AND o.stripe_tax_transaction_id IS NULL AND o.is_demo IS NOT TRUE
             AND o.paid_at < now() - interval '1 hour' LIMIT ${LIMIT}`,
  },
  {
    name: 'refund_tax_reversed', note: 'Every refunded sale with tax has a tax reversal (older than one hour).',
    sql: `SELECT 'payment:' || p.id AS id, p.refunded_amount_cents AS refunded FROM payments p JOIN auctions a ON a.id = p.auction_id
           WHERE COALESCE(p.refunded_amount_cents, 0) > 0 AND COALESCE(p.sales_tax_cents, 0) > 0 AND p.stripe_tax_transaction_id IS NOT NULL
             AND a.is_demo IS NOT TRUE AND COALESCE(p.refunded_at, now()) < now() - interval '1 hour'
             AND NOT EXISTS (SELECT 1 FROM payment_tax_reversals r WHERE r.payment_id = p.id) AND p.stripe_tax_reversal_id IS NULL
          UNION ALL
          SELECT 'order:' || o.id, o.refunded_amount_cents FROM marketplace_orders o
           WHERE o.refund_status = 'refunded' AND COALESCE(o.tax_cents, 0) > 0 AND o.stripe_tax_transaction_id IS NOT NULL
             AND o.stripe_tax_reversal_id IS NULL AND o.is_demo IS NOT TRUE AND COALESCE(o.refunded_at, now()) < now() - interval '1 hour' LIMIT ${LIMIT}`,
  },
  {
    name: 'storefront_payouts_exclude_platform_tax', note: 'No storefront payout line paid out sales tax that Advantage.Bid remits.',
    sql: `SELECT pl.storefront_payout_id::text AS id, o.order_number, pl.tax_to_seller_cents, o.tax_remitter
            FROM storefront_payout_lines pl JOIN marketplace_orders o ON o.id = pl.marketplace_order_id
           WHERE pl.tax_to_seller_cents > 0 AND COALESCE(o.tax_remitter, '') <> 'seller' LIMIT ${LIMIT}`,
  },
  {
    name: 'storefront_payout_amounts', note: 'No storefront payout line paid more than the order\'s seller proceeds.',
    sql: `SELECT pl.storefront_payout_id::text AS id, o.order_number, pl.amount_cents, o.seller_proceeds_cents
            FROM storefront_payout_lines pl JOIN marketplace_orders o ON o.id = pl.marketplace_order_id
           WHERE pl.amount_cents > GREATEST(o.seller_proceeds_cents, 0) + pl.tax_to_seller_cents LIMIT ${LIMIT}`,
  },
  {
    name: 'auction_payouts_exclude_tax', note: 'No auction paid its seller more than was collected for the seller (charges less refunds less sales tax).',
    sql: `SELECT sp.auction_id::text AS id, sp.final_amount_paid_cents AS paid, c.collected_ex_tax
            FROM seller_payouts sp
            JOIN LATERAL (SELECT COALESCE(SUM(p.amount_cents - COALESCE(p.refunded_amount_cents, 0) - COALESCE(p.sales_tax_cents, 0)), 0)::bigint AS collected_ex_tax
                            FROM payments p WHERE p.auction_id = sp.auction_id AND p.status IN ('paid','refunded','partially_refunded')) c ON true
           WHERE sp.stripe_transfer_id IS NOT NULL AND COALESCE(sp.final_amount_paid_cents, 0) > c.collected_ex_tax LIMIT ${LIMIT}`,
  },
  {
    name: 'remittances_within_liability', note: 'No state has more sales tax remitted than collected.',
    sql: `SELECT state AS id, COALESCE(SUM(tax_collected_cents) FILTER (WHERE remitter = 'platform'), 0)::bigint AS collected, COALESCE(SUM(tax_remitted_cents), 0)::bigint AS remitted
            FROM tax_ledger_entries WHERE state IS NOT NULL GROUP BY state
          HAVING COALESCE(SUM(tax_remitted_cents), 0) > COALESCE(SUM(tax_collected_cents) FILTER (WHERE remitter = 'platform'), 0) LIMIT ${LIMIT}`,
  },
  {
    name: 'paid_filings_have_remittance', note: 'Every filing marked paid with tax due has a recorded payment.',
    sql: `SELECT f.id::text AS id, f.state, f.period_start, f.tax_due_cents FROM tax_filings f
           WHERE f.status = 'paid' AND COALESCE(f.tax_due_cents, 0) > 0
             AND NOT EXISTS (SELECT 1 FROM tax_ledger_entries l WHERE l.filing_id = f.id AND l.entry_type = 'remittance') LIMIT ${LIMIT}`,
  },
  {
    name: 'platform_tax_has_registration', note: 'Sales tax was collected for Advantage.Bid to remit only in states with a recorded registration.',
    sql: `SELECT l.state AS id, SUM(l.tax_collected_cents)::bigint AS collected FROM tax_ledger_entries l
           WHERE l.remitter = 'platform' AND l.state IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM tax_registrations r WHERE r.state = l.state AND r.status IN ('active', 'closed'))
           GROUP BY l.state HAVING SUM(l.tax_collected_cents) > 0 LIMIT ${LIMIT}`,
  },
];

// The provider's own record of recent tax transactions against the ledger. Skipped (not a mismatch) when the provider
// cannot be reached or tax calculation is switched off; every difference found is a mismatch.
async function providerCheck(deps = {}) {
  const out = { name: 'provider_tax_transactions', note: 'Recent tax transactions match the tax calculation provider\'s records.', ok: true, count: 0, examples: [], skipped: null };
  const taxService = deps.taxService || require('../taxCalculationService');
  if (!taxService.taxEnabled() || (!deps.stripe && !process.env.STRIPE_SECRET_KEY)) { out.skipped = 'tax calculation is switched off or not configured'; return out; }
  const recent = await rows(
    `SELECT id, tax_transaction_id, tax_collected_cents FROM tax_ledger_entries
      WHERE entry_type = 'sale' AND tax_transaction_id IS NOT NULL AND occurred_at > now() - interval '45 days' ORDER BY occurred_at DESC LIMIT 40`);
  if (!recent.length) return out;
  let stripe;
  try { stripe = deps.stripe || require('stripe')(process.env.STRIPE_SECRET_KEY); } catch (e) { out.skipped = 'provider client unavailable'; return out; }
  for (const r of recent) {
    try {
      const items = await stripe.tax.transactions.listLineItems(r.tax_transaction_id, { limit: 100 });
      const tx = await stripe.tax.transactions.retrieve(r.tax_transaction_id);
      const lineTax = (items.data || []).reduce((s, li) => s + (Number(li.amount_tax) || 0), 0);
      const shipTax = tx && tx.shipping_cost ? Number(tx.shipping_cost.amount_tax) || 0 : 0;
      if (lineTax + shipTax !== Number(r.tax_collected_cents)) {
        out.ok = false; out.count++;
        if (out.examples.length < LIMIT) out.examples.push({ id: String(r.id), ledger_tax: Number(r.tax_collected_cents), provider_tax: lineTax + shipTax });
      }
    } catch (e) { out.skipped = 'the provider could not be reached for every transaction'; break; }
  }
  return out;
}

async function run({ actorId = null } = {}, deps = {}) {
  let runId = null;
  try {
    runId = (await db.query('INSERT INTO tax_reconciliation_runs (triggered_by) VALUES ($1) RETURNING id', [actorId])).rows[0].id;
    const posted = await ledger.sync();
    const checks = [];
    const seen = [];
    for (const c of CHECKS) {
      let found = [];
      let error = null;
      try { found = await rows(c.sql); } catch (e) { error = e.message; }
      const ok = !error && found.length === 0;
      checks.push({ name: c.name, note: c.note, ok, count: found.length, examples: found.slice(0, 10), error });
      if (!ok) {
        const key = 'recon:' + c.name;
        seen.push(key);
        await alerts.raise({ key, type: 'reconciliation', severity: 'critical',
          message: error ? `Reconciliation check could not run: ${c.note}` : `Reconciliation difference (${found.length}${found.length >= LIMIT ? '+' : ''}): ${c.note}`,
          detail: { check: c.name, examples: found.slice(0, 10), error } });
      }
    }
    const pc = await providerCheck(deps).catch((e) => ({ name: 'provider_tax_transactions', ok: true, count: 0, examples: [], skipped: 'check failed: ' + e.message }));
    checks.push(pc);
    if (!pc.ok) {
      seen.push('recon:' + pc.name);
      await alerts.raise({ key: 'recon:' + pc.name, type: 'reconciliation', severity: 'critical',
        message: `Reconciliation difference (${pc.count}): ${pc.note}`, detail: { check: pc.name, examples: pc.examples } });
    }
    await alerts.resolveStale('reconciliation', seen);
    const clean = checks.every((c) => c.ok);
    const summary = { checks, posted, alerts: seen.length };
    return (await db.query(
      `UPDATE tax_reconciliation_runs SET finished_at = now(), status = $2, summary = $3::jsonb WHERE id = $1 RETURNING *`,
      [runId, clean ? 'clean' : 'mismatches', JSON.stringify(summary)])).rows[0];
  } catch (e) {
    console.error('[tax-reconciliation] run failed:', e.message);
    if (runId) {
      try {
        return (await db.query(`UPDATE tax_reconciliation_runs SET finished_at = now(), status = 'failed', summary = $2::jsonb WHERE id = $1 RETURNING *`,
          [runId, JSON.stringify({ error: e.message })])).rows[0];
      } catch (_e) { /* fall through */ }
    }
    return { id: runId, status: 'failed', summary: { error: e.message } };
  }
}

async function latest(limit = 10) {
  return rows('SELECT id, started_at, finished_at, status, summary, triggered_by FROM tax_reconciliation_runs ORDER BY id DESC LIMIT $1', [Math.min(50, Math.max(1, Number(limit) || 10))]);
}

module.exports = { run, latest, CHECKS, providerCheck };
