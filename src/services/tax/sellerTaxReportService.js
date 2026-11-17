'use strict';

/**
 * sellerTaxReportService - PREPARATION for seller information reporting (Form 1099-K). NOTHING IS FILED and nothing is
 * sent to a seller or to any tax authority from here. It only totals, per seller and calendar year, what the platform's
 * own records already hold, so the figures are ready when the reporting entity, thresholds and responsibilities are
 * confirmed.
 *
 *   gross sales processed   sum(gross_cents) of the seller's ledger sale entries (what buyers paid, not reduced by fees or refunds)
 *   refunds                 the seller's ledger refund entries, shown as a positive amount
 *   transactions            number of sale entries
 *   paid to seller          money actually paid out that year: auction settlements (seller_payouts.final_amount_paid_cents
 *                           by paid_at) and storefront payouts (storefront_payouts.final_amount_paid_cents by paid_at)
 *
 * Data minimization: a seller is identified by display name and seller profile id only. No taxpayer number exists in
 * this database and none may be added; no buyer data is read. Years are calendar years in America/New_York.
 */

const db = require('../../db');
const { csv, dollars } = require('./taxReportService');
const { nyParts } = require('./taxFilingService');

const FILING_ENABLED = false;
const n = (v) => Number(v) || 0;

// Queries run one after another, never side by side: these are small reports, and one query at a time keeps their load
// on the database predictable.
async function inOrder(tasks) { const out = []; for (const task of tasks) out.push(await task()); return out; }
function status() {
  return { filing_enabled: FILING_ENABLED,
    message: 'Seller information reporting (Form 1099-K) is not enabled. These figures are preparation only: nothing is filed or sent until the reporting entity, the reporting thresholds and the responsibilities are confirmed.' };
}

function yearOf(year) {
  const y = year == null || year === '' ? nyParts().y : Number(year);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) throw Object.assign(new Error('Choose a valid calendar year.'), { status: 422, code: 'YEAR_INVALID' });
  return y;
}

async function byYear(year) {
  const y = yearOf(year);
  const from = `${y}-01-01`; const to = `${y + 1}-01-01`;
  const inYear = (col) => `(${col} AT TIME ZONE 'America/New_York') >= $1::date AND (${col} AT TIME ZONE 'America/New_York') < $2::date`;
  const [sales, auctionPaid, storePaid] = await inOrder([
    () => db.query(
      `SELECT seller_profile_id,
              COALESCE(SUM(gross_cents) FILTER (WHERE entry_type = 'sale'), 0)::bigint AS gross,
              COALESCE(-SUM(gross_cents) FILTER (WHERE entry_type = 'refund'), 0)::bigint AS refunds,
              COUNT(*) FILTER (WHERE entry_type = 'sale')::int AS tx
         FROM tax_ledger_entries
        WHERE entry_type IN ('sale', 'refund') AND seller_profile_id IS NOT NULL AND tax_period >= $1::date AND tax_period < $2::date
        GROUP BY seller_profile_id`, [from, to]),
    () => db.query(
      `SELECT a.seller_id AS seller_profile_id, COALESCE(SUM(p.final_amount_paid_cents), 0)::bigint AS paid
         FROM seller_payouts p JOIN auctions a ON a.id = p.auction_id
        WHERE p.paid_at IS NOT NULL AND p.final_amount_paid_cents IS NOT NULL AND a.is_demo IS NOT TRUE AND a.pre_launch_test IS NOT TRUE
          AND ${inYear('p.paid_at')}
        GROUP BY a.seller_id`, [from, to]),
    () => db.query(
      `SELECT seller_profile_id, COALESCE(SUM(final_amount_paid_cents), 0)::bigint AS paid
         FROM storefront_payouts
        WHERE paid_at IS NOT NULL AND final_amount_paid_cents IS NOT NULL AND ${inYear('paid_at')}
        GROUP BY seller_profile_id`, [from, to]),
  ]);
  const sellers = new Map();
  const at = (id) => { if (!sellers.has(id)) sellers.set(id, { seller_profile_id: id, seller_name: null, gross_sales_cents: 0, refunds_cents: 0, transaction_count: 0,
    paid_auction_cents: 0, paid_storefront_cents: 0, paid_total_cents: 0 }); return sellers.get(id); };
  for (const r of sales.rows) { const e = at(r.seller_profile_id); e.gross_sales_cents = n(r.gross); e.refunds_cents = n(r.refunds); e.transaction_count = n(r.tx); }
  for (const r of auctionPaid.rows) { if (r.seller_profile_id) at(r.seller_profile_id).paid_auction_cents = n(r.paid); }
  for (const r of storePaid.rows) { if (r.seller_profile_id) at(r.seller_profile_id).paid_storefront_cents = n(r.paid); }
  const ids = [...sellers.keys()];
  if (ids.length) {
    const names = (await db.query('SELECT id, display_name FROM seller_profiles WHERE id = ANY($1::uuid[])', [ids])).rows;
    for (const r of names) sellers.get(r.id).seller_name = r.display_name || null;
  }
  const list = [...sellers.values()];
  for (const s of list) s.paid_total_cents = s.paid_auction_cents + s.paid_storefront_cents;
  list.sort((a, b) => b.gross_sales_cents - a.gross_sales_cents || String(a.seller_name || '').localeCompare(String(b.seller_name || '')));
  const totals = list.reduce((t, s) => ({ gross_sales_cents: t.gross_sales_cents + s.gross_sales_cents, refunds_cents: t.refunds_cents + s.refunds_cents,
    transaction_count: t.transaction_count + s.transaction_count, paid_total_cents: t.paid_total_cents + s.paid_total_cents }),
  { gross_sales_cents: 0, refunds_cents: 0, transaction_count: 0, paid_total_cents: 0 });
  return { year: y, ...status(), sellers: list, totals };
}

async function byYearCsv(year) {
  const r = await byYear(year);
  return csv(['Year', 'Seller', 'Seller profile ID', 'Gross sales processed', 'Refunds', 'Sale transactions', 'Paid to seller: auctions', 'Paid to seller: storefront', 'Paid to seller: total'],
    r.sellers.map((s) => [r.year, s.seller_name, s.seller_profile_id, dollars(s.gross_sales_cents), dollars(s.refunds_cents), s.transaction_count,
      dollars(s.paid_auction_cents), dollars(s.paid_storefront_cents), dollars(s.paid_total_cents)]));
}

module.exports = { FILING_ENABLED, status, byYear, byYearCsv };
