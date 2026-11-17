'use strict';

/**
 * taxFilingService - sales tax registrations and filings as an administrator RECORDS them (migration 231,
 * tax_registrations / tax_filings). Nothing here registers, files or pays anything: every row is a record of something a
 * person did outside the system (with a state, an accountant or a filing provider).
 *
 *   registrations  one non-closed registration per state. Only the last four characters of a registration number are
 *                  ever kept (data minimization: the full number stays with the state and the accountant).
 *   filings        one return per state and period. ensureCurrentFilings() opens the row for the most recently CLOSED
 *                  period of every active registration that has a filing frequency, so a zero-dollar return is not
 *                  forgotten. A due date is NEVER invented: due dates differ by state, so the row is created without one
 *                  and an alert asks an administrator to enter it.
 *   payments       recordPayment() posts the remittance to the tax ledger (taxLedgerService.recordRemittance) and marks
 *                  the filing paid.
 *
 * Mutations return { before, after } so the route can audit both.
 */

const db = require('../../db');
const { US_STATES } = require('../../lib/storefrontShipping');

const REG_STATUSES = ['pending', 'active', 'closed'];
const FREQUENCIES = ['monthly', 'quarterly', 'annual', 'other'];
const FILING_STATUSES = ['open', 'filed', 'paid'];
const METHODS = ['accountant', 'self', 'processor', 'service'];
const TZ = 'America/New_York';

const d = (c) => `to_char(${c}, 'YYYY-MM-DD') AS ${c}`;
const REG_COLS = `id, state, status, ${d('effective_from')}, ${d('effective_to')}, filing_frequency, zero_filing_required, registration_last4,
  processor_registered, notes, created_by, updated_by, created_at, updated_at`;
const FILING_COLS = `id, state, ${d('period_start')}, ${d('period_end')}, ${d('due_date')}, status, tax_due_cents, ${d('filed_at')}, filed_by_method,
  confirmation_number, notes, created_by, updated_by, created_at, updated_at`;

function fail(code, message, status = 422) { return Object.assign(new Error(message), { status, code }); }
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stateOf(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!US_STATES.has(s)) throw fail('STATE_INVALID', 'Choose a US state or territory.');
  return s;
}
/** 'YYYY-MM-DD' or null; throws on anything that is not a real calendar date. */
function dateOnly(v, label) {
  if (v == null || v === '') return null;
  const s = String(v).trim().slice(0, 10);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00Z') : null;
  if (!t || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== s) throw fail('DATE_INVALID', `Enter a valid date for ${label} (year, month, day).`);
  return s;
}
function text(v, max) { if (v == null) return null; const s = String(v).trim().slice(0, max); return s || null; }
function cents(v, label) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw fail('AMOUNT_INVALID', `Enter ${label} as a whole number of cents, zero or more.`);
  return n;
}
function num(v) { return v == null ? null : Number(v); }
const filingOut = (r) => (r ? { ...r, tax_due_cents: num(r.tax_due_cents) } : r);

// ── Period helpers ───────────────────────────────────────────────────────────────────────────────────────────────
/** Today's calendar date in America/New_York as { y, m, day } (m is 1 to 12). */
function nyParts(date = new Date()) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
  const [y, m, day] = s.split('-').map(Number);
  return { y, m, day, iso: s };
}
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1 to 12
function span(y, m1, m2) { return { start: `${y}-${pad(m1)}-01`, end: `${y}-${pad(m2)}-${pad(lastDay(y, m2))}` }; }

/** The filing period that CONTAINS the date. { start, end } as 'YYYY-MM-DD', or null for a frequency with no fixed period. */
function periodFor(frequency, date = new Date()) {
  const { y, m } = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) } : nyParts(date);
  if (frequency === 'monthly') return span(y, m, m);
  if (frequency === 'quarterly') { const q = Math.floor((m - 1) / 3); return span(y, q * 3 + 1, q * 3 + 3); }
  if (frequency === 'annual') return span(y, 1, 12);
  return null;
}
/** The most recently CLOSED period before the date. */
function previousPeriod(frequency, date = new Date()) {
  const cur = periodFor(frequency, date);
  if (!cur) return null;
  const y = Number(cur.start.slice(0, 4)); const m = Number(cur.start.slice(5, 7));
  const before = m === 1 ? `${y - 1}-12-15` : `${y}-${pad(m - 1)}-15`;
  return periodFor(frequency, before);
}

// ── Registrations ────────────────────────────────────────────────────────────────────────────────────────────────
function registrationFields(b, existing) {
  const out = {};
  const take = (k, fn) => { if (has(b, k)) out[k] = fn(b[k]); };
  take('status', (v) => { if (!REG_STATUSES.includes(v)) throw fail('STATUS_INVALID', 'Choose a registration status: pending, active or closed.'); return v; });
  take('effective_from', (v) => dateOnly(v, 'the effective date'));
  take('effective_to', (v) => dateOnly(v, 'the end date'));
  take('filing_frequency', (v) => { if (v == null || v === '') return null; if (!FREQUENCIES.includes(v)) throw fail('FREQUENCY_INVALID', 'Choose a filing frequency: monthly, quarterly, annual or other.'); return v; });
  take('zero_filing_required', (v) => v !== false && v !== 'false');
  take('processor_registered', (v) => v === true || v === 'true');
  take('registration_last4', (v) => {
    const s = v == null ? '' : String(v).trim();
    if (s.length > 4) throw fail('LAST4_INVALID', 'Enter only the last four characters of the registration number. The full number is never stored here.');
    return s || null;
  });
  take('notes', (v) => text(v, 2000));
  const from = has(out, 'effective_from') ? out.effective_from : existing && existing.effective_from;
  const to = has(out, 'effective_to') ? out.effective_to : existing && existing.effective_to;
  if (from && to && to < from) throw fail('DATE_INVALID', 'The end date cannot be before the effective date.');
  return out;
}

async function listRegistrations() {
  return (await db.query(`SELECT ${REG_COLS} FROM tax_registrations ORDER BY state, created_at DESC`)).rows;
}
async function getRegistration(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return (await db.query(`SELECT ${REG_COLS} FROM tax_registrations WHERE id = $1`, [id])).rows[0] || null;
}
const DUPLICATE_REG = 'This state already has a registration that is not closed. Update it, or close it first.';

async function createRegistration(body, actorId) {
  const b = body || {};
  const state = stateOf(b.state);
  const f = { status: 'pending', zero_filing_required: true, processor_registered: false, ...registrationFields(b, null) };
  if (f.status !== 'closed') {
    const open = (await db.query(`SELECT id FROM tax_registrations WHERE state = $1 AND status <> 'closed'`, [state])).rows[0];
    if (open) throw fail('REGISTRATION_EXISTS', DUPLICATE_REG, 409);
  }
  try {
    const row = (await db.query(
      `INSERT INTO tax_registrations (state, status, effective_from, effective_to, filing_frequency, zero_filing_required, registration_last4,
         processor_registered, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
      [state, f.status, f.effective_from || null, f.effective_to || null, f.filing_frequency || null, f.zero_filing_required, f.registration_last4 || null,
        f.processor_registered, f.notes || null, actorId || null])).rows[0];
    return { before: null, after: await getRegistration(row.id) };
  } catch (e) { if (e && e.code === '23505') throw fail('REGISTRATION_EXISTS', DUPLICATE_REG, 409); throw e; }
}

async function updateRegistration(id, body, actorId) {
  const before = await getRegistration(id);
  if (!before) throw fail('NOT_FOUND', 'That registration was not found.', 404);
  const f = registrationFields(body || {}, before);
  const keys = Object.keys(f);
  if (!keys.length) throw fail('NOTHING_TO_CHANGE', 'Nothing to change.');
  if (f.status && f.status !== 'closed' && before.status === 'closed') {
    const open = (await db.query(`SELECT id FROM tax_registrations WHERE state = $1 AND status <> 'closed' AND id <> $2`, [before.state, id])).rows[0];
    if (open) throw fail('REGISTRATION_EXISTS', DUPLICATE_REG, 409);
  }
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  try {
    await db.query(`UPDATE tax_registrations SET ${sets.join(', ')}, updated_by = $2, updated_at = now() WHERE id = $1`, [id, actorId || null, ...keys.map((k) => f[k])]);
  } catch (e) { if (e && e.code === '23505') throw fail('REGISTRATION_EXISTS', DUPLICATE_REG, 409); throw e; }
  return { before, after: await getRegistration(id) };
}

// ── Filings ──────────────────────────────────────────────────────────────────────────────────────────────────────
function filingFields(b) {
  const out = {};
  const take = (k, fn) => { if (has(b, k)) out[k] = fn(b[k]); };
  take('due_date', (v) => dateOnly(v, 'the due date'));
  take('status', (v) => { if (!FILING_STATUSES.includes(v)) throw fail('STATUS_INVALID', 'Choose a filing status: open, filed or paid.'); return v; });
  take('tax_due_cents', (v) => cents(v, 'the amount on the return'));
  take('filed_at', (v) => dateOnly(v, 'the filed date'));
  take('filed_by_method', (v) => { if (v == null || v === '') return null; if (!METHODS.includes(v)) throw fail('METHOD_INVALID', 'Choose how the return was filed.'); return v; });
  take('confirmation_number', (v) => text(v, 120));
  take('notes', (v) => text(v, 2000));
  return out;
}

async function listFilings({ state = null, status = null } = {}) {
  const where = []; const params = [];
  if (state) { params.push(String(state).toUpperCase()); where.push(`state = $${params.length}`); }
  if (status && FILING_STATUSES.includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
  return (await db.query(`SELECT ${FILING_COLS} FROM tax_filings ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY period_end DESC, state LIMIT 1000`, params)).rows.map(filingOut);
}
async function getFiling(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return filingOut((await db.query(`SELECT ${FILING_COLS} FROM tax_filings WHERE id = $1`, [id])).rows[0] || null);
}
const DUPLICATE_FILING = 'A filing for this state and period already exists.';
// A return marked filed says when it was filed; 'paid' is reached only by recording the payment, so the ledger and the
// filing can never disagree.
function checkStatus(f, current) {
  if (f.status === 'paid' && (!current || current.status !== 'paid')) throw fail('RECORD_PAYMENT', 'To mark a filing paid, record the payment. A zero-dollar return stays "filed".');
  if (f.status === 'filed' && !(has(f, 'filed_at') ? f.filed_at : current && current.filed_at)) throw fail('FILED_DATE_REQUIRED', 'Enter the date the return was filed.');
}

async function createFiling(body, actorId) {
  const b = body || {};
  const state = stateOf(b.state);
  const start = dateOnly(b.period_start, 'the period start'); const end = dateOnly(b.period_end, 'the period end');
  if (!start || !end) throw fail('PERIOD_REQUIRED', 'Enter the first and last day of the filing period.');
  if (end < start) throw fail('PERIOD_INVALID', 'The period end cannot be before the period start.');
  const f = { status: 'open', ...filingFields(b) };
  checkStatus(f, null);
  try {
    const row = (await db.query(
      `INSERT INTO tax_filings (state, period_start, period_end, due_date, status, tax_due_cents, filed_at, filed_by_method, confirmation_number, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
      [state, start, end, f.due_date || null, f.status, f.tax_due_cents == null ? null : f.tax_due_cents, f.filed_at || null, f.filed_by_method || null,
        f.confirmation_number || null, f.notes || null, actorId || null])).rows[0];
    return { before: null, after: await getFiling(row.id) };
  } catch (e) { if (e && e.code === '23505') throw fail('FILING_EXISTS', DUPLICATE_FILING, 409); throw e; }
}

async function updateFiling(id, body, actorId) {
  const before = await getFiling(id);
  if (!before) throw fail('NOT_FOUND', 'That filing was not found.', 404);
  const f = filingFields(body || {});
  const keys = Object.keys(f);
  if (!keys.length) throw fail('NOTHING_TO_CHANGE', 'Nothing to change.');
  checkStatus(f, before);
  if (before.status === 'paid' && f.status && f.status !== 'paid') throw fail('FILING_PAID', 'A payment is recorded against this filing, so it stays paid. Post a ledger adjustment to correct a payment.', 409);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  await db.query(`UPDATE tax_filings SET ${sets.join(', ')}, updated_by = $2, updated_at = now() WHERE id = $1`, [id, actorId || null, ...keys.map((k) => f[k])]);
  return { before, after: await getFiling(id) };
}

/** Record a payment an administrator made to the state for this return. Posts the remittance and marks the filing paid. */
async function recordPayment(filingId, { amountCents, paidOn, reference, note } = {}, actorId) {
  const before = await getFiling(filingId);
  if (!before) throw fail('NOT_FOUND', 'That filing was not found.', 404);
  const paid = dateOnly(paidOn, 'the payment date');
  const entry = await require('./taxLedgerService').recordRemittance(
    { filingId: before.id, state: before.state, amountCents, paidOn: paid ? paid + 'T12:00:00-05:00' : null, reference, note }, actorId);
  if (!entry) throw fail('PAYMENT_ALREADY_RECORDED', 'A payment with this reference is already recorded for this filing.', 409);
  await db.query(`UPDATE tax_filings SET status = 'paid', filed_at = COALESCE(filed_at, $3::date), updated_by = $2, updated_at = now() WHERE id = $1`,
    [before.id, actorId || null, paid || nyParts().iso]);
  return { before, after: await getFiling(before.id), entry: { id: Number(entry.id), tax_remitted_cents: Number(entry.tax_remitted_cents) } };
}

/**
 * Open the filing row for the most recently closed period of every ACTIVE registration with a monthly, quarterly or
 * annual frequency. A registration that does not require zero-dollar returns gets a row only when tax was collected in
 * the period. Idempotent. Returns the rows created.
 */
async function ensureCurrentFilings({ now = new Date(), actorId = null } = {}) {
  const regs = (await db.query(`SELECT ${REG_COLS} FROM tax_registrations WHERE status = 'active' AND filing_frequency IN ('monthly', 'quarterly', 'annual')`)).rows;
  const created = [];
  for (const r of regs) {
    const p = previousPeriod(r.filing_frequency, now);
    if (!p) continue;
    if (r.effective_from && r.effective_from > p.end) continue;   // not registered during that period
    if (r.effective_to && r.effective_to < p.start) continue;
    if (r.zero_filing_required === false) {
      const t = (await db.query(
        `SELECT COALESCE(SUM(tax_collected_cents), 0)::bigint AS t FROM tax_ledger_entries
          WHERE state = $1 AND remitter = 'platform' AND tax_period >= $2::date AND tax_period <= $3::date`, [r.state, p.start, p.end])).rows[0];
      if (!(Number(t.t) !== 0)) continue;
    }
    const row = (await db.query(
      `INSERT INTO tax_filings (state, period_start, period_end, status, created_by, updated_by) VALUES ($1,$2,$3,'open',$4,$4)
       ON CONFLICT (state, period_start, period_end) DO NOTHING RETURNING id`, [r.state, p.start, p.end, actorId])).rows[0];
    if (row) created.push({ id: row.id, state: r.state, period_start: p.start, period_end: p.end });
  }
  return created;
}

/** Alerts for open filings: no due date entered, due within 14 days, or overdue. Clears alerts that no longer apply. */
async function deadlineAlerts({ now = new Date() } = {}) {
  const alerts = require('./taxAlerts');
  const today = nyParts(now).iso;
  const soon = new Date(new Date(today + 'T00:00:00Z').getTime() + 14 * 864e5).toISOString().slice(0, 10);
  const rows = (await db.query(`SELECT ${FILING_COLS} FROM tax_filings WHERE status = 'open'`)).rows;
  const seen = [];
  for (const f of rows) {
    const label = `${f.state} sales tax return for ${f.period_start} to ${f.period_end}`;
    let a = null;
    if (!f.due_date) a = { kind: 'no_due_date', severity: 'warning', message: `The ${label} has no due date entered. Enter the due date from the state's filing calendar.` };
    else if (f.due_date < today) a = { kind: 'overdue', severity: 'critical', message: `The ${label} was due ${f.due_date} and is still open.` };
    else if (f.due_date <= soon) a = { kind: 'due_soon', severity: 'warning', message: `The ${label} is due ${f.due_date}.` };
    if (!a) continue;
    const key = `filing_deadline:${f.id}:${a.kind}`;
    seen.push(key);
    await alerts.raise({ key, type: 'filing_deadline', severity: a.severity, message: a.message,
      detail: { filing_id: f.id, state: f.state, period_start: f.period_start, period_end: f.period_end, due_date: f.due_date, kind: a.kind } });
  }
  await alerts.resolveStale('filing_deadline', seen);
  return { open: rows.length, alerts: seen.length };
}

module.exports = { REG_STATUSES, FREQUENCIES, FILING_STATUSES, METHODS, periodFor, previousPeriod, nyParts, dateOnly,
  listRegistrations, getRegistration, createRegistration, updateRegistration,
  listFilings, getFiling, createFiling, updateFiling, recordPayment, ensureCurrentFilings, deadlineAlerts };
