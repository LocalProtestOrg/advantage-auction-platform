'use strict';

/**
 * taxNexusService - economic nexus monitoring (migration 231, tax_nexus_thresholds). Reports only: it never registers
 * anything and never changes a tax rule.
 *
 * THRESHOLDS are entered by an administrator from the state's published rule, with the legal reference. None is seeded
 * or guessed. A threshold can have a sales amount, a transaction count, or both (combined with OR or AND), a measurement
 * period, and a determination of whether the sales Advantage.Bid facilitates count toward it:
 *   counts_marketplace_sales  true   every sale on the platform (auction, marketplace, seller website) is counted
 *                             false  those sales are not counted toward this threshold (measured sales are reported, not compared)
 *                             null   not yet determined: the state is flagged for review
 *
 * MEASURES come from the tax ledger (entry types sale and refund; channels auction, marketplace, seller_website):
 *   sales        = sum(gross_cents - tax_collected_cents), so refunds reduce it and sales tax is not counted as sales
 *   transactions = number of sale entries
 * Calendar years follow tax_period (America/New_York); the rolling period is the last 12 months to the moment of the check.
 *
 * STATUS per state: physical_presence, registered, exceeded (100%+), near (90%+), approaching (70%+), below,
 * no_threshold (no threshold entered), review (the threshold cannot be evaluated yet).
 */

const db = require('../../db');
const { US_STATES } = require('../../lib/storefrontShipping');
const { nyParts, dateOnly } = require('./taxFilingService');

const PERIODS = ['calendar_year', 'previous_calendar_year', 'current_or_previous_calendar_year', 'rolling_12_months'];
const CHANNELS = ['auction', 'marketplace', 'seller_website'];
const d = (c) => `to_char(${c}, 'YYYY-MM-DD') AS ${c}`;
const COLS = `state, sales_threshold_cents, transaction_threshold, combine_rule, measurement_period, counts_marketplace_sales, physical_presence,
  legal_reference, source_url, ${d('effective_from')}, ${d('verified_at')}, verified_by, notes, updated_by, updated_at`;

function fail(code, message, status = 422) { return Object.assign(new Error(message), { status, code }); }
const out = (r) => (r ? { ...r, sales_threshold_cents: r.sales_threshold_cents == null ? null : Number(r.sales_threshold_cents) } : r);

async function list() {
  return (await db.query(`SELECT ${COLS} FROM tax_nexus_thresholds ORDER BY state`)).rows.map(out);
}
async function get(state) {
  return out((await db.query(`SELECT ${COLS} FROM tax_nexus_thresholds WHERE state = $1`, [String(state || '').toUpperCase()])).rows[0] || null);
}

function wholeNumber(v, code, message) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw fail(code, message);
  return n;
}

/** Create or replace the threshold for a state. Returns { before, after }. */
async function set(body, actorId) {
  const b = body || {};
  const state = String(b.state || '').trim().toUpperCase();
  if (!US_STATES.has(state)) throw fail('STATE_INVALID', 'Choose a US state or territory.');
  const legal = String(b.legal_reference || '').trim().slice(0, 1000);
  if (legal.length < 5) throw fail('LEGAL_REFERENCE_REQUIRED', 'Record the legal reference for this threshold (the statute, rule or official publication).');
  const sales = wholeNumber(b.sales_threshold_cents, 'SALES_THRESHOLD_INVALID', 'Enter the sales threshold as a whole number of cents, or leave it empty.');
  const tx = wholeNumber(b.transaction_threshold, 'TRANSACTION_THRESHOLD_INVALID', 'Enter the transaction threshold as a whole number, or leave it empty.');
  if (tx != null && tx > 2147483647) throw fail('TRANSACTION_THRESHOLD_INVALID', 'That transaction threshold is too large.');
  const combine = b.combine_rule == null || b.combine_rule === '' ? 'or' : String(b.combine_rule);
  if (!['or', 'and'].includes(combine)) throw fail('COMBINE_RULE_INVALID', 'Choose whether either threshold or both thresholds must be met.');
  const period = b.measurement_period == null || b.measurement_period === '' ? 'calendar_year' : String(b.measurement_period);
  if (!PERIODS.includes(period)) throw fail('MEASUREMENT_PERIOD_INVALID', 'Choose a measurement period.');
  let counts = null;
  if (b.counts_marketplace_sales === true || b.counts_marketplace_sales === 'true') counts = true;
  else if (b.counts_marketplace_sales === false || b.counts_marketplace_sales === 'false') counts = false;
  const physical = b.physical_presence === true || b.physical_presence === 'true';
  let url = null;
  if (b.source_url != null && String(b.source_url).trim()) {
    url = String(b.source_url).trim().slice(0, 500);
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw fail('SOURCE_URL_INVALID', 'Enter the source as a full web address, or leave it empty.');
  }
  const eff = dateOnly(b.effective_from, 'the effective date');
  const verified = dateOnly(b.verified_at, 'the verified date');
  const notes = b.notes == null ? null : String(b.notes).trim().slice(0, 2000) || null;
  const before = await get(state);
  await db.query(
    `INSERT INTO tax_nexus_thresholds (state, sales_threshold_cents, transaction_threshold, combine_rule, measurement_period, counts_marketplace_sales,
       physical_presence, legal_reference, source_url, effective_from, verified_at, verified_by, notes, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     ON CONFLICT (state) DO UPDATE SET sales_threshold_cents = EXCLUDED.sales_threshold_cents, transaction_threshold = EXCLUDED.transaction_threshold,
       combine_rule = EXCLUDED.combine_rule, measurement_period = EXCLUDED.measurement_period, counts_marketplace_sales = EXCLUDED.counts_marketplace_sales,
       physical_presence = EXCLUDED.physical_presence, legal_reference = EXCLUDED.legal_reference, source_url = EXCLUDED.source_url,
       effective_from = EXCLUDED.effective_from, verified_at = EXCLUDED.verified_at, verified_by = EXCLUDED.verified_by, notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [state, sales, tx, combine, period, counts, physical, legal, url, eff, verified, verified ? actorId || null : null, notes, actorId || null]);
  return { before, after: await get(state) };
}

async function remove(state) {
  const before = await get(state);
  if (!before) return null;
  await db.query('DELETE FROM tax_nexus_thresholds WHERE state = $1', [before.state]);
  return before;
}

// Queries run one after another, never side by side: these are small reports, and one query at a time keeps their load
// on the database predictable.
async function inOrder(tasks) { const out = []; for (const task of tasks) out.push(await task()); return out; }

// ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Rounded DOWN to two decimals with whole-number arithmetic, so 99.999% is never shown or treated as 100%.
const pct = (value, threshold) => (threshold == null ? null : (threshold === 0 ? (value >= 0 ? 100 : 0) : Math.floor((Math.max(0, value) * 10000) / threshold) / 100));

/** Pure: the percentage of a threshold one window has reached. { sales_pct, transaction_pct, overall_pct } (null = not measurable). */
function evaluateWindow(threshold, window) {
  const sp = pct(window.sales_cents, threshold.sales_threshold_cents);
  const tp = pct(window.transactions, threshold.transaction_threshold);
  let overall = null;
  if (sp != null && tp != null) overall = threshold.combine_rule === 'and' ? Math.min(sp, tp) : Math.max(sp, tp);
  else overall = sp != null ? sp : tp;
  return { sales_pct: sp, transaction_pct: tp, overall_pct: overall };
}

/** Pure: status for one state. windows = { current, previous, rolling }, each { sales_cents, transactions }. */
function evaluate({ threshold, windows, hasSales, registered }) {
  if (threshold && threshold.physical_presence) return { status: 'physical_presence', overall_pct: null, sales_pct: null, transaction_pct: null, measured: null };
  if (registered) return { status: 'registered', ...(threshold ? measure(threshold, windows) : { overall_pct: null, sales_pct: null, transaction_pct: null, measured: null }) };
  if (!threshold) return { status: 'no_threshold', overall_pct: null, sales_pct: null, transaction_pct: null, measured: null };
  const m = measure(threshold, windows);
  if (threshold.counts_marketplace_sales == null || m.overall_pct == null) return { status: 'review', ...m };
  if (threshold.counts_marketplace_sales === false) return { status: 'below', ...m, overall_pct: 0, sales_pct: m.sales_pct == null ? null : 0, transaction_pct: m.transaction_pct == null ? null : 0 };
  const p = m.overall_pct;
  return { status: p >= 100 ? 'exceeded' : p >= 90 ? 'near' : p >= 70 ? 'approaching' : 'below', ...m };
  // hasSales is used by alerts(); it does not change the status.
}
function measure(threshold, windows) {
  const mp = threshold.measurement_period;
  if (mp === 'current_or_previous_calendar_year') {
    const a = evaluateWindow(threshold, windows.current); const b = evaluateWindow(threshold, windows.previous);
    const pick = (b.overall_pct || 0) > (a.overall_pct || 0) ? { e: b, w: windows.previous, name: 'previous_calendar_year' } : { e: a, w: windows.current, name: 'calendar_year' };
    return { ...pick.e, measured: { window: pick.name, ...pick.w } };
  }
  const name = mp === 'previous_calendar_year' ? 'previous' : mp === 'rolling_12_months' ? 'rolling' : 'current';
  return { ...evaluateWindow(threshold, windows[name]), measured: { window: mp, ...windows[name] } };
}

const emptyWindow = () => ({ sales_cents: 0, transactions: 0, by_channel: Object.fromEntries(CHANNELS.map((c) => [c, { sales_cents: 0, transactions: 0 }])) });

async function status({ now = new Date() } = {}) {
  const { y } = nyParts(now);
  const rollingFrom = new Date(now); rollingFrom.setUTCFullYear(rollingFrom.getUTCFullYear() - 1);
  const [thresholds, regs, agg] = await inOrder([
    () => list(),
    () => db.query(`SELECT state, status FROM tax_registrations WHERE status <> 'closed'`),
    () => db.query(
      `SELECT state, channel,
              COALESCE(SUM(gross_cents - tax_collected_cents) FILTER (WHERE tax_period >= $1::date AND tax_period < $2::date), 0)::bigint AS cur_sales,
              COUNT(*) FILTER (WHERE entry_type = 'sale' AND tax_period >= $1::date AND tax_period < $2::date)::int AS cur_tx,
              COALESCE(SUM(gross_cents - tax_collected_cents) FILTER (WHERE tax_period >= $3::date AND tax_period < $1::date), 0)::bigint AS prev_sales,
              COUNT(*) FILTER (WHERE entry_type = 'sale' AND tax_period >= $3::date AND tax_period < $1::date)::int AS prev_tx,
              COALESCE(SUM(gross_cents - tax_collected_cents) FILTER (WHERE occurred_at > $4 AND occurred_at <= $5), 0)::bigint AS roll_sales,
              COUNT(*) FILTER (WHERE entry_type = 'sale' AND occurred_at > $4 AND occurred_at <= $5)::int AS roll_tx,
              COUNT(*) FILTER (WHERE entry_type = 'sale')::int AS all_tx
         FROM tax_ledger_entries
        WHERE entry_type IN ('sale', 'refund') AND channel IN ('auction', 'marketplace', 'seller_website') AND state IS NOT NULL
        GROUP BY state, channel`, [`${y}-01-01`, `${y + 1}-01-01`, `${y - 1}-01-01`, rollingFrom, new Date(now)]),
  ]);
  const states = new Map();
  const at = (s) => { if (!states.has(s)) states.set(s, { state: s, threshold: null, registration_status: null, has_sales: false,
    windows: { current: emptyWindow(), previous: emptyWindow(), rolling: emptyWindow() } }); return states.get(s); };
  for (const t of thresholds) at(t.state).threshold = t;
  for (const r of regs.rows) { const e = at(r.state); if (r.status === 'active' || !e.registration_status) e.registration_status = r.status; }
  for (const r of agg.rows) {
    const e = at(r.state);
    if (Number(r.all_tx) > 0) e.has_sales = true;
    for (const [name, sales, tx] of [['current', r.cur_sales, r.cur_tx], ['previous', r.prev_sales, r.prev_tx], ['rolling', r.roll_sales, r.roll_tx]]) {
      const w = e.windows[name];
      w.sales_cents += Number(sales) || 0; w.transactions += Number(tx) || 0;
      if (w.by_channel[r.channel]) { w.by_channel[r.channel].sales_cents += Number(sales) || 0; w.by_channel[r.channel].transactions += Number(tx) || 0; }
    }
  }
  return [...states.values()].sort((a, b) => a.state.localeCompare(b.state)).map((e) => {
    const registered = e.registration_status === 'active';
    const ev = evaluate({ threshold: e.threshold, windows: e.windows, hasSales: e.has_sales, registered });
    return { state: e.state, status: ev.status, registered, registration_status: e.registration_status, has_sales: e.has_sales,
      overall_pct: ev.overall_pct, sales_pct: ev.sales_pct, transaction_pct: ev.transaction_pct, measured: ev.measured,
      threshold: e.threshold, windows: e.windows };
  });
}

const money = (c) => '$' + (Math.round(Number(c) || 0) / 100).toFixed(2);

/** Raise an alert for every state that needs a person's attention; clear alerts whose condition no longer holds. Never registers anything. */
async function alerts({ now = new Date() } = {}) {
  const taxAlerts = require('./taxAlerts');
  const rows = await status({ now });
  const seen = [];
  for (const s of rows) {
    let a = null;
    const m = s.measured ? `Measured sales ${money(s.measured.sales_cents)} in ${s.measured.transactions} transaction(s)` : '';
    if (s.status === 'physical_presence' && !s.registered) a = { severity: 'critical', message: `${s.state} is recorded as a physical presence state and has no active sales tax registration recorded. Review with the accountant.` };
    else if (s.status === 'exceeded') a = { severity: 'critical', message: `${s.state}: the recorded economic nexus threshold has been reached (${s.overall_pct}%). ${m}. No active registration is recorded. Review with the accountant.` };
    else if (s.status === 'near') a = { severity: 'warning', message: `${s.state}: sales are at ${s.overall_pct}% of the recorded economic nexus threshold. ${m}. Review with the accountant.` };
    else if (s.status === 'approaching') a = { severity: 'info', message: `${s.state}: sales are at ${s.overall_pct}% of the recorded economic nexus threshold. ${m}.` };
    else if (s.status === 'no_threshold' && s.has_sales) a = { severity: 'warning', message: `${s.state} has sales but no economic nexus threshold is entered. Enter the threshold from the state's published rule.` };
    else if (s.status === 'review' && s.has_sales) a = { severity: 'warning', message: `${s.state} has sales and a threshold that cannot be evaluated yet: record whether sales made through the platform count toward it, and at least one threshold amount.` };
    if (!a) continue;
    const key = `nexus:${s.state}:${s.status}`;
    seen.push(key);
    await taxAlerts.raise({ key, type: 'nexus', severity: a.severity, message: a.message,
      detail: { state: s.state, status: s.status, overall_pct: s.overall_pct, measured: s.measured ? { window: s.measured.window, sales_cents: s.measured.sales_cents, transactions: s.measured.transactions } : null } });
  }
  await taxAlerts.resolveStale('nexus', seen);
  return { states: rows.length, alerts: seen.length };
}

module.exports = { PERIODS, CHANNELS, list, get, set, remove, status, alerts, evaluate, evaluateWindow };
