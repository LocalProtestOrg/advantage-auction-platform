'use strict';

/**
 * taxReportService - what the Sales Tax dashboard and its exports read (migration 231). Read-only: everything is
 * computed from the tax ledger (tax_ledger_entries) and the records an administrator entered.
 *
 * Definitions (signed cents; a refund is negative in the ledger):
 *   gross sales        sum(gross_cents) of sale entries (what buyers were charged, sales tax included)
 *   refunds            sum(gross_cents) of refund entries, shown as a positive amount
 *   taxable / exempt   net of sales, refunds and adjustments
 *   tax collected      sum(tax_collected_cents) of sale entries
 *   tax refunded       tax returned by refund and dispute entries, shown as a positive amount
 *   net tax            sum(tax_collected_cents) of every entry
 *   platform net tax   the same for remitter = 'platform' (the tax Advantage.Bid must remit)
 *   outstanding        all time: platform net tax - tax remitted, per state
 *
 * Privacy: reports are aggregates. The drill-down names the seller (display name) and never the buyer: buyer_user_id is
 * not selected and no buyer name, email or address is joined.
 */

const db = require('../../db');
const taxPolicy = require('./taxPolicy');
const { nyParts } = require('./taxFilingService');

const ENTRY_TYPES = ['sale', 'refund', 'dispute', 'remittance', 'reserve_transfer', 'adjustment'];
const CHANNELS = ['auction', 'marketplace', 'seller_website', 'platform'];
const REMITTERS = ['platform', 'seller', 'seller_direct', 'none', 'unconfigured', 'exception'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const n = (v) => Number(v) || 0;
function fail(code, message, status = 422) { return Object.assign(new Error(message), { status, code }); }

// Queries run one after another, never side by side: these are small reports, and one query at a time keeps their load
// on the database predictable.
async function inOrder(tasks) { const out = []; for (const task of tasks) out.push(await task()); return out; }
// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * One CSV cell. Quotes, commas and line breaks are escaped; a text cell that begins with = + - @ (or a tab or carriage
 * return) is prefixed with an apostrophe so a spreadsheet never runs it as a formula. A plain number (including a
 * negative amount) is left as a number.
 */
function csvCell(v) {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
/** Signed cents as a plain decimal amount ("-12.34"), exact (no floating point). */
function dollars(c) {
  const v = Math.trunc(Number(c) || 0); const a = Math.abs(v);
  return (v < 0 ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
}

// ── Overview ─────────────────────────────────────────────────────────────────────────────────────────────────────
const AGG = `
  COALESCE(SUM(gross_cents) FILTER (WHERE entry_type = 'sale'), 0)::bigint AS gross_cents,
  COALESCE(-SUM(gross_cents) FILTER (WHERE entry_type = 'refund'), 0)::bigint AS refunds_cents,
  COALESCE(SUM(taxable_cents) FILTER (WHERE entry_type IN ('sale', 'refund', 'adjustment')), 0)::bigint AS taxable_cents,
  COALESCE(SUM(exempt_cents) FILTER (WHERE entry_type IN ('sale', 'refund', 'adjustment')), 0)::bigint AS exempt_cents,
  COALESCE(SUM(tax_collected_cents) FILTER (WHERE entry_type = 'sale'), 0)::bigint AS tax_collected_cents,
  COALESCE(-SUM(tax_collected_cents) FILTER (WHERE entry_type IN ('refund', 'dispute')), 0)::bigint AS tax_refunded_cents,
  COALESCE(SUM(tax_collected_cents) FILTER (WHERE entry_type = 'adjustment'), 0)::bigint AS tax_adjusted_cents,
  COALESCE(SUM(tax_collected_cents), 0)::bigint AS net_tax_cents,
  COALESCE(SUM(tax_collected_cents) FILTER (WHERE remitter = 'platform'), 0)::bigint AS platform_net_tax_cents,
  COALESCE(SUM(tax_remitted_cents), 0)::bigint AS remitted_cents,
  COUNT(*) FILTER (WHERE entry_type = 'sale')::int AS sale_count`;
const AGG_KEYS = ['gross_cents', 'refunds_cents', 'taxable_cents', 'exempt_cents', 'tax_collected_cents', 'tax_refunded_cents', 'tax_adjusted_cents',
  'net_tax_cents', 'platform_net_tax_cents', 'remitted_cents', 'sale_count'];
const zero = () => Object.fromEntries(AGG_KEYS.map((k) => [k, 0]));
const addInto = (t, r) => { for (const k of AGG_KEYS) t[k] += n(r[k]); return t; };

function currentPeriod(now = new Date()) { const p = nyParts(now); return `${p.y}-${String(p.m).padStart(2, '0')}`; }

async function overview({ period, now = new Date() } = {}) {
  const per = PERIOD_RE.test(String(period || '')) ? String(period) : currentPeriod(now);
  const first = per + '-01';
  const [agg, allTime, rules, regs, filings, alertCounts, recon, flagged, periods, reserve, enforcement, guard] = await inOrder([
    () => db.query(`SELECT state, channel, ${AGG} FROM tax_ledger_entries WHERE tax_period = $1::date AND entry_type <> 'reserve_transfer' GROUP BY state, channel`, [first]),
    () => db.query(`SELECT state, COALESCE(SUM(tax_collected_cents) FILTER (WHERE remitter = 'platform'), 0)::bigint AS collected,
                     COALESCE(SUM(tax_remitted_cents), 0)::bigint AS remitted
                FROM tax_ledger_entries WHERE entry_type <> 'reserve_transfer' GROUP BY state`),
    () => db.query(`SELECT state, remitter, legal_basis, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, (effective_from <= CURRENT_DATE) AS in_effect,
                     to_char(last_verified_at, 'YYYY-MM-DD') AS last_verified_at FROM marketplace_tax_jurisdictions`),
    () => db.query(`SELECT state, status, filing_frequency, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, processor_registered
                FROM tax_registrations ORDER BY (status = 'closed'), created_at DESC`),
    () => db.query(`SELECT id, state, to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end,
                     to_char(due_date, 'YYYY-MM-DD') AS due_date, status, tax_due_cents
                FROM tax_filings WHERE period_start <= $1::date AND period_end >= $1::date ORDER BY period_end - period_start`, [first]),
    () => db.query(`SELECT severity, COUNT(*)::int AS c FROM tax_alerts WHERE resolved_at IS NULL GROUP BY severity`),
    () => db.query(`SELECT id, started_at, finished_at, status, summary FROM tax_reconciliation_runs ORDER BY id DESC LIMIT 1`),
    () => db.query(`SELECT remitter, COUNT(*)::int AS c FROM tax_ledger_entries
               WHERE tax_period = $1::date AND entry_type = 'sale' AND remitter IN ('unconfigured', 'exception') GROUP BY remitter`, [first]),
    () => db.query(`SELECT DISTINCT to_char(tax_period, 'YYYY-MM') AS p FROM tax_ledger_entries ORDER BY 1 DESC LIMIT 240`),
    () => require('./taxReserveService').position(),
    () => taxPolicy.auctionEnforcement(),
    () => require('./taxReserveService').guardEnabled(),
  ]);

  const states = new Map();
  const at = (s) => {
    const key = s || '';
    if (!states.has(key)) states.set(key, { state: s || null, ...zero(), by_channel: {}, all_time_collected_cents: 0, all_time_remitted_cents: 0, outstanding_cents: 0,
      rule: null, registration: null, filing: null });
    return states.get(key);
  };
  for (const r of agg.rows) {
    const e = at(r.state);
    addInto(e, r);
    const ch = e.by_channel[r.channel] || (e.by_channel[r.channel] = zero());
    addInto(ch, r);
  }
  for (const r of allTime.rows) {
    const collected = n(r.collected); const remitted = n(r.remitted);
    if (!collected && !remitted && !states.has(r.state || '')) continue;
    const e = at(r.state);
    e.all_time_collected_cents = collected; e.all_time_remitted_cents = remitted; e.outstanding_cents = collected - remitted;
  }
  for (const r of rules.rows) at(r.state).rule = { remitter: r.remitter, retired: r.remitter === 'seller', usable: taxPolicy.NEW_RULE_REMITTERS.includes(r.remitter) && r.in_effect === true,
    in_effect: r.in_effect === true, effective_from: r.effective_from, last_verified_at: r.last_verified_at };
  for (const r of regs.rows) { const e = at(r.state); if (!e.registration) e.registration = { status: r.status, filing_frequency: r.filing_frequency, effective_from: r.effective_from, processor_registered: r.processor_registered }; }
  for (const f of filings.rows) { const e = at(f.state); if (!e.filing) e.filing = { id: f.id, period_start: f.period_start, period_end: f.period_end, due_date: f.due_date, status: f.status, tax_due_cents: f.tax_due_cents == null ? null : Number(f.tax_due_cents) }; }

  const list = [...states.values()].sort((a, b) => String(a.state || '~~').localeCompare(String(b.state || '~~')));
  const totals = { ...zero(), all_time_collected_cents: 0, all_time_remitted_cents: 0, outstanding_cents: 0, by_channel: {} };
  for (const s of list) {
    addInto(totals, s);
    totals.all_time_collected_cents += s.all_time_collected_cents; totals.all_time_remitted_cents += s.all_time_remitted_cents; totals.outstanding_cents += s.outstanding_cents;
    for (const [ch, v] of Object.entries(s.by_channel)) addInto(totals.by_channel[ch] || (totals.by_channel[ch] = zero()), v);
  }
  const open = { info: 0, warning: 0, critical: 0, total: 0 };
  for (const r of alertCounts.rows) { open[r.severity] = n(r.c); open.total += n(r.c); }
  const flags = { unconfigured: 0, exception: 0 };
  for (const r of flagged.rows) flags[r.remitter] = n(r.c);
  const all = periods.rows.map((r) => r.p);
  if (!all.includes(per)) all.unshift(per);
  const cur = currentPeriod(now);
  if (!all.includes(cur)) all.unshift(cur);
  all.sort().reverse();
  return { period: per, current_period: cur, periods: all, states: list, totals, reserve, enforcement, reserve_guard: guard, open_alerts: open,
    reconciliation: recon.rows[0] ? { ...recon.rows[0], id: Number(recon.rows[0].id) } : null,
    unconfigured_sales: flags.unconfigured, exception_sales: flags.exception };
}

// ── Ledger drill-down ────────────────────────────────────────────────────────────────────────────────────────────
// Explicit column list: buyer_user_id is deliberately absent.
const LEDGER_COLS = `l.id, l.entry_type, l.channel, l.source_type, l.source_id, l.occurred_at, to_char(l.tax_period, 'YYYY-MM') AS tax_period, l.state,
  l.remitter, l.tax_basis, l.seller_profile_id, sp.display_name AS seller_name, l.auction_id, l.gross_cents, l.merchandise_cents, l.buyer_premium_cents,
  l.shipping_cents, l.taxable_cents, l.exempt_cents, l.tax_calculated_cents, l.tax_collected_cents, l.seller_proceeds_cents, l.platform_fee_cents,
  l.tax_remitted_cents, l.tax_reserved_cents, l.filing_id, l.reverses_entry_id, l.note, l.created_at`;
const LEDGER_CENTS = ['gross_cents', 'merchandise_cents', 'buyer_premium_cents', 'shipping_cents', 'taxable_cents', 'exempt_cents', 'tax_calculated_cents',
  'tax_collected_cents', 'seller_proceeds_cents', 'platform_fee_cents', 'tax_remitted_cents', 'tax_reserved_cents'];

function ledgerWhere(f = {}) {
  const where = []; const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  if (f.state) {
    const s = String(f.state).toUpperCase();
    if (s === 'NONE') where.push('l.state IS NULL');
    else if (/^[A-Z]{2}$/.test(s)) add('l.state = ?', s);
    else throw fail('STATE_INVALID', 'Choose a state.');
  }
  if (f.period) { if (!PERIOD_RE.test(String(f.period))) throw fail('PERIOD_INVALID', 'Choose a month.'); add('l.tax_period = ?::date', f.period + '-01'); }
  if (f.from) { if (!DATE_RE.test(String(f.from))) throw fail('DATE_INVALID', 'Enter a valid start date.'); add(`(l.occurred_at AT TIME ZONE 'America/New_York')::date >= ?::date`, f.from); }
  if (f.to) { if (!DATE_RE.test(String(f.to))) throw fail('DATE_INVALID', 'Enter a valid end date.'); add(`(l.occurred_at AT TIME ZONE 'America/New_York')::date <= ?::date`, f.to); }
  if (f.channel) { if (!CHANNELS.includes(f.channel)) throw fail('CHANNEL_INVALID', 'Choose a sales channel.'); add('l.channel = ?', f.channel); }
  if (f.remitter) { if (!REMITTERS.includes(f.remitter)) throw fail('REMITTER_INVALID', 'Choose who is responsible for the tax.'); add('l.remitter = ?', f.remitter); }
  if (f.entry_type) { if (!ENTRY_TYPES.includes(f.entry_type)) throw fail('ENTRY_TYPE_INVALID', 'Choose an entry type.'); add('l.entry_type = ?', f.entry_type); }
  if (f.seller_profile_id) { if (!UUID_RE.test(String(f.seller_profile_id))) throw fail('SELLER_INVALID', 'That seller reference is not valid.'); add('l.seller_profile_id = ?', f.seller_profile_id); }
  if (f.source_id) add('l.source_id = ?', String(f.source_id).slice(0, 100));
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
const ledgerOut = (r) => { const o = { ...r, id: Number(r.id), reverses_entry_id: r.reverses_entry_id == null ? null : Number(r.reverses_entry_id) }; for (const k of LEDGER_CENTS) o[k] = n(r[k]); return o; };

async function ledger(filters = {}) {
  const w = ledgerWhere(filters);
  const limit = Math.min(500, Math.max(1, Math.trunc(Number(filters.limit)) || 100));
  const offset = Math.max(0, Math.trunc(Number(filters.offset)) || 0);
  const [rows, total] = await inOrder([
    () => db.query(`SELECT ${LEDGER_COLS} FROM tax_ledger_entries l LEFT JOIN seller_profiles sp ON sp.id = l.seller_profile_id ${w.sql}
              ORDER BY l.occurred_at DESC, l.id DESC LIMIT ${limit} OFFSET ${offset}`, w.params),
    () => db.query(`SELECT COUNT(*)::int AS c FROM tax_ledger_entries l ${w.sql}`, w.params),
  ]);
  return { rows: rows.rows.map(ledgerOut), total: n(total.rows[0].c), limit, offset };
}

const CSV_MAX = 50000;
async function ledgerCsv(filters = {}) {
  const w = ledgerWhere(filters);
  const rows = (await db.query(`SELECT ${LEDGER_COLS} FROM tax_ledger_entries l LEFT JOIN seller_profiles sp ON sp.id = l.seller_profile_id ${w.sql}
    ORDER BY l.occurred_at, l.id LIMIT ${CSV_MAX}`, w.params)).rows;
  return csv(['Entry', 'Date', 'Tax period', 'Type', 'Channel', 'State', 'Tax responsibility', 'Tax basis', 'Seller', 'Seller profile ID', 'Source', 'Source ID',
    'Gross', 'Merchandise', 'Buyer premium', 'Shipping', 'Taxable', 'Exempt', 'Tax calculated', 'Tax collected', 'Seller proceeds', 'Platform fee',
    'Tax remitted', 'Moved to tax account', 'Filing ID', 'Corrects entry', 'Note'],
  rows.map((r) => [Number(r.id), new Date(r.occurred_at).toISOString(), r.tax_period, r.entry_type, r.channel, r.state, r.remitter, r.tax_basis, r.seller_name, r.seller_profile_id,
    r.source_type, r.source_id, dollars(r.gross_cents), dollars(r.merchandise_cents), dollars(r.buyer_premium_cents), dollars(r.shipping_cents), dollars(r.taxable_cents),
    dollars(r.exempt_cents), dollars(r.tax_calculated_cents), dollars(r.tax_collected_cents), dollars(r.seller_proceeds_cents), dollars(r.platform_fee_cents),
    dollars(r.tax_remitted_cents), dollars(r.tax_reserved_cents), r.filing_id, r.reverses_entry_id == null ? '' : Number(r.reverses_entry_id), r.note]));
}

/** State x month rows between two months (inclusive), 'YYYY-MM'. */
async function stateSummaryCsv({ from, to } = {}) {
  const where = [`entry_type <> 'reserve_transfer'`]; const params = [];
  if (from) { if (!PERIOD_RE.test(String(from))) throw fail('PERIOD_INVALID', 'Choose a starting month.'); params.push(from + '-01'); where.push(`tax_period >= $${params.length}::date`); }
  if (to) { if (!PERIOD_RE.test(String(to))) throw fail('PERIOD_INVALID', 'Choose an ending month.'); params.push(to + '-01'); where.push(`tax_period <= $${params.length}::date`); }
  const rows = (await db.query(`SELECT state, to_char(tax_period, 'YYYY-MM') AS period, ${AGG} FROM tax_ledger_entries WHERE ${where.join(' AND ')}
    GROUP BY state, tax_period ORDER BY tax_period, state`, params)).rows;
  return csv(['State', 'Period', 'Sales', 'Gross sales', 'Refunds', 'Taxable sales', 'Exempt sales', 'Tax collected', 'Tax refunded', 'Tax adjustments', 'Net tax',
    'Net tax Advantage.Bid remits', 'Tax remitted'],
  rows.map((r) => [r.state || 'Unknown', r.period, n(r.sale_count), dollars(r.gross_cents), dollars(r.refunds_cents), dollars(r.taxable_cents), dollars(r.exempt_cents),
    dollars(r.tax_collected_cents), dollars(r.tax_refunded_cents), dollars(r.tax_adjusted_cents), dollars(r.net_tax_cents), dollars(r.platform_net_tax_cents), dollars(r.remitted_cents)]));
}

/**
 * What an accountant or a filing provider needs for one return: totals for the state and dates, by channel, and the local
 * jurisdiction breakdown (from each entry's jurisdiction_detail.jurisdictions; a refund reverses its sale's jurisdictions
 * in proportion). from / to are calendar dates (America/New_York), inclusive.
 */
async function filingExportCsv({ state, from, to } = {}) {
  const st = String(state || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(st)) throw fail('STATE_INVALID', 'Choose a state.');
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) throw fail('DATE_INVALID', 'Enter the first and last day of the filing period.');
  if (to < from) throw fail('DATE_INVALID', 'The last day cannot be before the first day.');
  const range = `state = $1 AND (occurred_at AT TIME ZONE 'America/New_York')::date >= $2::date AND (occurred_at AT TIME ZONE 'America/New_York')::date <= $3::date
    AND entry_type <> 'reserve_transfer'`;
  const p = [st, from, to];
  const [tot, byChannel, byRemitter, entries] = await inOrder([
    () => db.query(`SELECT ${AGG} FROM tax_ledger_entries WHERE ${range}`, p),
    () => db.query(`SELECT channel, ${AGG} FROM tax_ledger_entries WHERE ${range} GROUP BY channel ORDER BY channel`, p),
    () => db.query(`SELECT COALESCE(remitter, 'none') AS remitter, ${AGG} FROM tax_ledger_entries WHERE ${range} GROUP BY 1 ORDER BY 1`, p),
    () => db.query(
      `SELECT l.entry_type, l.tax_collected_cents, l.jurisdiction_detail, s.jurisdiction_detail AS sale_detail, s.tax_collected_cents AS sale_tax
         FROM tax_ledger_entries l
         LEFT JOIN tax_ledger_entries s ON l.entry_type = 'refund' AND s.entry_type = 'sale' AND s.source_type = l.source_type AND s.source_id = l.source_id
        WHERE l.state = $1 AND (l.occurred_at AT TIME ZONE 'America/New_York')::date >= $2::date AND (l.occurred_at AT TIME ZONE 'America/New_York')::date <= $3::date
          AND l.entry_type IN ('sale', 'refund', 'dispute', 'adjustment') AND l.remitter = 'platform' AND l.tax_collected_cents <> 0
        ORDER BY l.id`, p),
  ]);
  const t = tot.rows[0];
  const rows = [];
  const line = (section, item, level, amount) => rows.push([section, item, level || '', amount]);
  line('Return', 'State', '', st); line('Return', 'First day', '', from); line('Return', 'Last day', '', to);
  line('Totals', 'Number of sales', '', n(t.sale_count));
  line('Totals', 'Gross sales (sales tax included)', '', dollars(t.gross_cents));
  line('Totals', 'Refunds', '', dollars(t.refunds_cents));
  line('Totals', 'Taxable sales (net of refunds)', '', dollars(t.taxable_cents));
  line('Totals', 'Exempt or non-taxable sales (net of refunds)', '', dollars(t.exempt_cents));
  line('Totals', 'Tax collected', '', dollars(t.tax_collected_cents));
  line('Totals', 'Tax refunded', '', dollars(t.tax_refunded_cents));
  line('Totals', 'Tax adjustments', '', dollars(t.tax_adjusted_cents));
  line('Totals', 'Net tax', '', dollars(t.net_tax_cents));
  line('Totals', 'Net tax Advantage.Bid remits', '', dollars(t.platform_net_tax_cents));
  line('Totals', 'Tax already remitted in these dates', '', dollars(t.remitted_cents));
  for (const c of byChannel.rows) {
    line('By channel', c.channel + ': gross sales', '', dollars(c.gross_cents));
    line('By channel', c.channel + ': taxable sales', '', dollars(c.taxable_cents));
    line('By channel', c.channel + ': net tax', '', dollars(c.net_tax_cents));
  }
  for (const c of byRemitter.rows) line('By tax responsibility', c.remitter + ': net tax', '', dollars(c.net_tax_cents));

  // Local breakdown. An entry without jurisdiction detail is reported on its own line so the total always ties out.
  const places = new Map(); let unallocated = 0;
  for (const e of entries.rows) {
    const tax = n(e.tax_collected_cents);
    const own = e.jurisdiction_detail && Array.isArray(e.jurisdiction_detail.jurisdictions) ? e.jurisdiction_detail.jurisdictions : null;
    const src = own && own.length ? { list: own, base: own.reduce((s, j) => s + n(j.amount_cents), 0) }
      : (e.entry_type === 'refund' && e.sale_detail && Array.isArray(e.sale_detail.jurisdictions) && e.sale_detail.jurisdictions.length
        ? { list: e.sale_detail.jurisdictions, base: e.sale_detail.jurisdictions.reduce((s, j) => s + n(j.amount_cents), 0) } : null);
    if (!src || !src.base) { unallocated += tax; continue; }
    // Share the entry's tax across its jurisdictions in proportion, to the cent (the last one takes the remainder).
    let left = tax;
    src.list.forEach((j, i) => {
      const share = i === src.list.length - 1 ? left : Math.trunc((tax * n(j.amount_cents)) / src.base);
      left -= share;
      const key = (j.level || '') + '|' + (j.name || '');
      const cur = places.get(key) || { name: j.name || 'Unnamed', level: j.level || '', cents: 0 };
      cur.cents += share; places.set(key, cur);
    });
  }
  const order = ['state', 'county', 'city', 'district'];
  [...places.values()].sort((a, b) => (order.indexOf(a.level) - order.indexOf(b.level)) || a.name.localeCompare(b.name))
    .forEach((j) => line('Local jurisdictions (tax Advantage.Bid remits)', j.name, j.level, dollars(j.cents)));
  if (unallocated) line('Local jurisdictions (tax Advantage.Bid remits)', 'Not broken down by jurisdiction', '', dollars(unallocated));
  return csv(['Section', 'Item', 'Jurisdiction level', 'Amount'], rows);
}

// ── Auction audit (before enforcement is turned on) ──────────────────────────────────────────────────────────────
/**
 * Every real auction that is not finished (draft, submitted, under review, published, active) with its pickup state and
 * whether that state has a usable tax rule. `blocking` lists the published or active ones in a known state WITHOUT a
 * usable rule: with enforcement on, their payments would be held.
 */
async function auctionAudit() {
  const rows = (await db.query(
    `SELECT a.id, a.title, a.state AS auction_state, upper(a.address_state) AS pickup_state, a.start_time, a.end_time, a.published_at,
            sp.display_name AS seller_name, r.remitter AS rule_remitter, (r.effective_from <= CURRENT_DATE) AS rule_in_effect
       FROM auctions a
       LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
       LEFT JOIN marketplace_tax_jurisdictions r ON r.state = upper(a.address_state)
      WHERE a.state IN ('draft', 'submitted', 'under_review', 'published', 'active')
        AND a.is_demo IS NOT TRUE AND a.pre_launch_test IS NOT TRUE AND a.is_archived IS NOT TRUE
      ORDER BY (a.state IN ('published', 'active')) DESC, a.end_time NULLS LAST, a.created_at
      LIMIT 2000`)).rows;
  const auctions = rows.map((a) => {
    const known = /^[A-Z]{2}$/.test(String(a.pickup_state || ''));
    const usable = known && a.rule_in_effect === true && taxPolicy.NEW_RULE_REMITTERS.includes(a.rule_remitter);
    return { id: a.id, title: a.title, auction_state: a.auction_state, pickup_state: known ? a.pickup_state : null, seller_name: a.seller_name,
      bidding_starts_at: a.start_time, bidding_ends_at: a.end_time, published_at: a.published_at,
      rule: a.rule_remitter || null, rule_usable: usable, live: ['published', 'active'].includes(a.auction_state) };
  });
  const blocking = auctions.filter((a) => a.live && a.pickup_state && !a.rule_usable);
  const missingStates = [...new Set(auctions.filter((a) => a.pickup_state && !a.rule_usable).map((a) => a.pickup_state))].sort();
  return { auctions, blocking, states_without_rule: missingStates, unknown_state: auctions.filter((a) => !a.pickup_state).length };
}

module.exports = { ENTRY_TYPES, CHANNELS, REMITTERS, csv, csvCell, dollars, currentPeriod, overview, ledger, ledgerCsv, stateSummaryCsv, filingExportCsv, auctionAudit };
