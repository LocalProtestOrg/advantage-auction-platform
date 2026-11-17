'use strict';

/**
 * /api/admin/tax - the Sales Tax administration API (migration 231; page public/admin/tax.html). Administrators only.
 *
 * Nothing here registers with a state, files a return or pays tax: every write RECORDS something an administrator did
 * outside the system, or changes configuration. The two safeguard settings (tax.auction_enforcement, tax.reserve_guard)
 * are written through configService.setPlatformConfig, so only the platform owner can change them. Every write is
 * audited with the values before and after. Reports are aggregates and never return buyer personal data.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const { US_STATES } = require('../lib/storefrontShipping');
const { CATEGORIES } = require('../constants/lotCategories');

const filings = require('../services/tax/taxFilingService');
const nexus = require('../services/tax/taxNexusService');
const reports = require('../services/tax/taxReportService');
const sellerReports = require('../services/tax/sellerTaxReportService');
const ledger = require('../services/tax/taxLedgerService');
const alerts = require('../services/tax/taxAlerts');
const categories = require('../services/tax/taxCategoryService');
const reserve = require('../services/tax/taxReserveService');
const taxPolicy = require('../services/tax/taxPolicy');

router.use(auth, role(['admin']), express.json({ limit: '32kb' }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(code, message, status = 422) { return Object.assign(new Error(message), { status, code }); }
function refuse(res, e) {
  return res.status(e.status).json({ success: false, code: e.code || null, message: e.message, ...(e.data ? { data: e.data } : {}) });
}
const send = (fn) => async (req, res, next) => {
  try { return res.json({ success: true, data: await fn(req, res) }); }
  catch (e) { if (e && e.status && e.status < 500) return refuse(res, e); return next(e); }
};
const sendCsv = (name, fn) => async (req, res, next) => {
  try {
    const body = await fn(req);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name(req).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    return res.send('﻿' + body);
  } catch (e) { if (e && e.status && e.status < 500) return refuse(res, e); return next(e); }
};
// entity_id is a UUID column: records without one (a state, a category, a setting) are filed under the acting administrator.
const audit = (req, event, entityType, entityId, metadata, extra = {}) => writeAuditLog({ event_type: event, entity_type: entityType,
  entity_id: UUID_RE.test(String(entityId || '')) ? entityId : req.user.id, actor_id: req.user.id, metadata, ...extra });
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// ── Overview and reports ─────────────────────────────────────────────────────────────────────────────────────────
router.get('/overview', send((req) => reports.overview({ period: req.query.period })));
router.get('/ledger', send((req) => reports.ledger(req.query)));
router.get('/ledger.csv', sendCsv(() => 'sales-tax-ledger.csv', (req) => reports.ledgerCsv(req.query)));
router.get('/state-summary.csv', sendCsv(() => 'sales-tax-by-state.csv', (req) => reports.stateSummaryCsv({ from: req.query.from, to: req.query.to })));
router.get('/filing-export.csv', sendCsv((req) => `sales-tax-return-${req.query.state || ''}-${req.query.from || ''}-${req.query.to || ''}.csv`,
  (req) => reports.filingExportCsv({ state: req.query.state, from: req.query.from, to: req.query.to })));
router.get('/auction-audit', send(() => reports.auctionAudit()));

// ── Registrations ────────────────────────────────────────────────────────────────────────────────────────────────
router.get('/registrations', send(async () => ({ registrations: await filings.listRegistrations(), states: [...US_STATES].sort() })));
router.post('/registrations', send(async (req) => {
  const r = await filings.createRegistration(body(req), req.user.id);
  await audit(req, 'tax_registration_recorded', 'tax_registration', r.after.id, { state: r.after.state, before: null, after: r.after });
  return r.after;
}));
router.put('/registrations/:id', send(async (req) => {
  const r = await filings.updateRegistration(req.params.id, body(req), req.user.id);
  await audit(req, 'tax_registration_updated', 'tax_registration', r.after.id, { state: r.after.state, before: r.before, after: r.after });
  return r.after;
}));

// ── Filings ──────────────────────────────────────────────────────────────────────────────────────────────────────
router.get('/filings', send((req) => filings.listFilings({ state: req.query.state || null, status: req.query.status || null })));
router.post('/filings', send(async (req) => {
  const r = await filings.createFiling(body(req), req.user.id);
  await audit(req, 'tax_filing_recorded', 'tax_filing', r.after.id, { state: r.after.state, before: null, after: r.after });
  return r.after;
}));
// Open the filing row for the most recently closed period of every active registration (the daily worker does the same).
router.post('/filings/ensure-current', send(async (req) => {
  const created = await filings.ensureCurrentFilings({ actorId: req.user.id });
  if (created.length) await audit(req, 'tax_filings_opened', 'tax_filing', null, { before: null, after: created });
  return { created };
}));
router.put('/filings/:id', send(async (req) => {
  const r = await filings.updateFiling(req.params.id, body(req), req.user.id);
  await audit(req, 'tax_filing_updated', 'tax_filing', r.after.id, { state: r.after.state, before: r.before, after: r.after });
  return r.after;
}));
router.post('/filings/:id/payment', send(async (req) => {
  const b = body(req);
  const r = await filings.recordPayment(req.params.id, { amountCents: b.amount_cents, paidOn: b.paid_on, reference: b.reference, note: b.note }, req.user.id);
  await audit(req, 'tax_filing_payment_recorded', 'tax_filing', r.after.id, { state: r.after.state, before: r.before, after: r.after, ledger_entry: r.entry });
  return r.after;
}));

// ── Tax codes (merchandise category to tax product code) ─────────────────────────────────────────────────────────
router.get('/category-codes', send(async () => ({ mappings: await categories.list(), categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label })) })));
router.put('/category-codes/:key', send(async (req) => {
  const key = String(req.params.key || '');
  if (!CATEGORIES.some((c) => c.key === key)) throw fail('CATEGORY_INVALID', 'Choose a category from the list.');
  const before = (await categories.list()).find((m) => m.category_key === key) || null;
  const after = await categories.set({ ...body(req), category_key: key }, req.user.id);
  await audit(req, 'tax_category_code_set', 'tax_category_code', null, { category_key: key, before, after });
  return after;
}));
router.delete('/category-codes/:key', send(async (req) => {
  const gone = await categories.remove(req.params.key);
  if (gone) await audit(req, 'tax_category_code_removed', 'tax_category_code', null, { category_key: gone.category_key, before: gone, after: null });
  return { removed: !!gone };
}));

// ── Economic nexus ───────────────────────────────────────────────────────────────────────────────────────────────
router.get('/nexus/thresholds', send(async () => ({ thresholds: await nexus.list(), states: [...US_STATES].sort(), measurement_periods: nexus.PERIODS })));
router.get('/nexus/status', send(() => nexus.status()));
router.put('/nexus/thresholds/:state', send(async (req) => {
  const r = await nexus.set({ ...body(req), state: req.params.state }, req.user.id);
  await audit(req, 'tax_nexus_threshold_set', 'tax_nexus_threshold', null, { state: r.after.state, before: r.before, after: r.after });
  return r.after;
}));
router.delete('/nexus/thresholds/:state', send(async (req) => {
  const gone = await nexus.remove(req.params.state);
  if (gone) await audit(req, 'tax_nexus_threshold_removed', 'tax_nexus_threshold', null, { state: gone.state, before: gone, after: null });
  return { removed: !!gone };
}));

// ── Exceptions (an auction allowed to be paid without sales tax collected) ───────────────────────────────────────
const EXC_COLS = `e.id, e.auction_id, a.title AS auction_title, e.state, e.decision, e.reason, e.approved_by, e.created_at, e.revoked_at, e.revoked_by`;
router.get('/exceptions', send(async () => (await db.query(
  `SELECT ${EXC_COLS} FROM tax_payment_exceptions e LEFT JOIN auctions a ON a.id = e.auction_id ORDER BY (e.revoked_at IS NULL) DESC, e.created_at DESC LIMIT 500`)).rows));
router.post('/exceptions', send(async (req) => {
  const b = body(req);
  const auctionId = String(b.auction_id || '').trim();
  const state = String(b.state || '').trim().toUpperCase();
  const reason = String(b.reason || '').trim().slice(0, 2000);
  if (!UUID_RE.test(auctionId)) throw fail('AUCTION_INVALID', 'Enter the auction ID.');
  if (!US_STATES.has(state)) throw fail('STATE_INVALID', 'Choose a US state or territory.');
  if (reason.length < 20) throw fail('REASON_REQUIRED', 'Explain the exception in writing (at least 20 characters): who decided it and why.');
  const auction = (await db.query('SELECT id, title FROM auctions WHERE id = $1', [auctionId])).rows[0];
  if (!auction) throw fail('AUCTION_NOT_FOUND', 'That auction was not found.', 404);
  let row;
  try {
    row = (await db.query(
      `INSERT INTO tax_payment_exceptions (auction_id, state, decision, reason, approved_by) VALUES ($1,$2,'proceed_tax_not_collected',$3,$4)
       RETURNING id, auction_id, state, decision, reason, approved_by, created_at, revoked_at`, [auctionId, state, reason, req.user.id])).rows[0];
  } catch (e) { if (e && e.code === '23505') throw fail('EXCEPTION_EXISTS', 'This auction already has an active exception for that state.', 409); throw e; }
  await audit(req, 'tax_payment_exception_recorded', 'tax_payment_exception', row.id, { state, before: null, after: row }, { auction_id: auctionId });
  return { ...row, auction_title: auction.title };
}));
router.post('/exceptions/:id/revoke', send(async (req) => {
  if (!UUID_RE.test(String(req.params.id))) throw fail('NOT_FOUND', 'That exception was not found.', 404);
  const before = (await db.query('SELECT id, auction_id, state, decision, reason, approved_by, created_at, revoked_at FROM tax_payment_exceptions WHERE id = $1', [req.params.id])).rows[0];
  if (!before) throw fail('NOT_FOUND', 'That exception was not found.', 404);
  if (before.revoked_at) throw fail('ALREADY_REVOKED', 'That exception was already revoked.', 409);
  const after = (await db.query(
    `UPDATE tax_payment_exceptions SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL
     RETURNING id, auction_id, state, decision, reason, approved_by, created_at, revoked_at, revoked_by`, [before.id, req.user.id])).rows[0];
  await audit(req, 'tax_payment_exception_revoked', 'tax_payment_exception', before.id, { state: before.state, before, after }, { auction_id: before.auction_id });
  return after;
}));

// ── Alerts ───────────────────────────────────────────────────────────────────────────────────────────────────────
router.get('/alerts', send((req) => alerts.list({ open: req.query.status !== 'resolved', limit: req.query.limit })));
router.post('/alerts/:id/resolve', send(async (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw fail('NOT_FOUND', 'That alert was not found.', 404);
  const note = String(body(req).note || '').trim();
  if (note.length < 5) throw fail('NOTE_REQUIRED', 'Enter a short note saying how this was resolved.');
  const before = (await db.query('SELECT id, alert_key, alert_type, severity, message, created_at FROM tax_alerts WHERE id = $1 AND resolved_at IS NULL', [id])).rows[0];
  if (!before) throw fail('NOT_FOUND', 'That alert is not open.', 404);
  const ok = await alerts.resolveById(id, req.user.id, note);
  if (!ok) throw fail('NOT_FOUND', 'That alert is not open.', 404);
  await audit(req, 'tax_alert_resolved', 'tax_alert', null, { alert_id: id, before, after: { resolved: true, resolution: note.slice(0, 500) } });
  return { resolved: true };
}));

// ── Reconciliation ───────────────────────────────────────────────────────────────────────────────────────────────
router.get('/reconciliation', send(() => require('../services/tax/taxReconciliationService').latest(20)));
router.post('/reconciliation/run', send(async (req) => {
  const run = await require('../services/tax/taxReconciliationService').run({ actorId: req.user.id });
  await audit(req, 'tax_reconciliation_run', 'tax_reconciliation_run', null, { before: null, after: { run_id: run && run.id, status: run && run.status } });
  return run;
}));

// ── Reserve (sales tax held for remittance) and ledger corrections ───────────────────────────────────────────────
router.get('/reserve', send(async () => ({ position: await reserve.position(), guard_enabled: await reserve.guardEnabled() })));
const entryOut = (e) => ({ id: Number(e.id), entry_type: e.entry_type, state: e.state, occurred_at: e.occurred_at, tax_collected_cents: Number(e.tax_collected_cents),
  gross_cents: Number(e.gross_cents), taxable_cents: Number(e.taxable_cents), tax_reserved_cents: Number(e.tax_reserved_cents), remitter: e.remitter, channel: e.channel, note: e.note });
router.post('/reserve/transfers', send(async (req) => {
  const b = body(req);
  if (!Number.isInteger(Number(b.amount_cents))) throw fail('AMOUNT_INVALID', 'Enter the amount moved as a whole number of cents.');
  const before = await reserve.position();
  const entry = await ledger.recordReserveTransfer({ amountCents: b.amount_cents, movedOn: b.moved_on, reference: b.reference, note: b.note }, req.user.id);
  if (!entry) throw fail('TRANSFER_ALREADY_RECORDED', 'A transfer with this bank reference is already recorded.', 409);
  const after = await reserve.position();
  await audit(req, 'tax_reserve_transfer_recorded', 'tax_ledger_entry', null, { before, after, ledger_entry: entryOut(entry) });
  return { entry: entryOut(entry), position: after };
}));
router.post('/adjustments', send(async (req) => {
  const b = body(req);
  for (const k of ['tax_collected_cents', 'gross_cents', 'taxable_cents']) {
    if (b[k] != null && b[k] !== '' && !Number.isInteger(Number(b[k]))) throw fail('AMOUNT_INVALID', 'Enter each amount as a whole number of cents (negative to reduce).');
  }
  if (b.state && !US_STATES.has(String(b.state).toUpperCase())) throw fail('STATE_INVALID', 'Choose the state the correction applies to.');
  if (b.remitter != null && b.remitter !== '' && !['platform', 'seller_direct', 'none'].includes(b.remitter)) throw fail('REMITTER_INVALID', 'Choose who is responsible for the tax.');
  if (b.reverses_entry_id != null && b.reverses_entry_id !== '' && !(Number.isInteger(Number(b.reverses_entry_id)) && Number(b.reverses_entry_id) > 0)) throw fail('ENTRY_INVALID', 'Enter the number of the ledger entry being corrected.');
  const entry = await ledger.recordAdjustment({ state: b.state, channel: b.channel || undefined, taxCollectedCents: b.tax_collected_cents, grossCents: b.gross_cents,
    taxableCents: b.taxable_cents, remitter: b.remitter || undefined, reason: b.reason, occurredOn: b.occurred_on || undefined,
    reversesEntryId: b.reverses_entry_id ? Number(b.reverses_entry_id) : null }, req.user.id);
  await audit(req, 'tax_ledger_adjustment_posted', 'tax_ledger_entry', null, { state: entry.state, before: null, after: entryOut(entry) });
  return entryOut(entry);
}));

// ── Settings (platform owner only, enforced by configService) ────────────────────────────────────────────────────
async function readSettings() {
  const rows = (await db.query(`SELECT key, value FROM platform_config WHERE key IN ('tax.auction_enforcement', 'tax.reserve_guard')`)).rows;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { auction_enforcement: map['tax.auction_enforcement'] === 'enforce' ? 'enforce' : 'report', reserve_guard: map['tax.reserve_guard'] !== false };
}
router.get('/settings', send(async (req) => ({ ...(await readSettings()), is_owner: await require('../lib/platformOwner').isPlatformOwner(req.user) })));
router.put('/settings', send(async (req) => {
  const b = body(req);
  const hasMode = Object.prototype.hasOwnProperty.call(b, 'auction_enforcement');
  const hasGuard = Object.prototype.hasOwnProperty.call(b, 'reserve_guard');
  if (!hasMode && !hasGuard) throw fail('NOTHING_TO_CHANGE', 'Nothing to change.');
  if (hasMode && !['report', 'enforce'].includes(b.auction_enforcement)) throw fail('MODE_INVALID', 'Choose "report" or "enforce".');
  if (hasGuard && typeof b.reserve_guard !== 'boolean') throw fail('GUARD_INVALID', 'Choose on or off for the payout safeguard.');
  // Checked before anything else is read or written, so an administrator who is not the owner learns nothing more.
  const owner = require('../lib/platformOwner');
  if (!(await owner.isPlatformOwner(req.user))) throw owner.ownerRequiredError();
  const before = await readSettings();
  if (hasMode && b.auction_enforcement === 'enforce' && before.auction_enforcement !== 'enforce' && b.acknowledge_unconfigured !== true) {
    const a = await reports.auctionAudit();
    if (a.blocking.length) {
      throw Object.assign(fail('UNCONFIGURED_AUCTIONS',
        `Enforcement was not turned on: ${a.blocking.length} published or active auction(s) are in a state without a usable sales tax rule, and their payments would be held. Add the rules, or confirm that you accept this.`, 409),
      { data: { blocking: a.blocking, states_without_rule: [...new Set(a.blocking.map((x) => x.pickup_state))].sort() } });
    }
  }
  const config = require('../services/configService');
  const opts = { actor: req.user, category: 'tax', source: 'PUT /api/admin/tax/settings', adminPath: '/admin/tax.html' };
  if (hasMode) await config.setPlatformConfig('tax.auction_enforcement', b.auction_enforcement, opts);
  if (hasGuard) await config.setPlatformConfig('tax.reserve_guard', b.reserve_guard, opts);
  taxPolicy.clearCache();
  const after = await readSettings();
  await audit(req, 'tax_settings_changed', 'tax_settings', null, { before, after, acknowledged_unconfigured: b.acknowledge_unconfigured === true });
  return after;
}));

// ── Seller information reporting (preparation only; nothing is filed) ────────────────────────────────────────────
router.get('/seller-reporting', send((req) => sellerReports.byYear(req.query.year)));
router.get('/seller-reporting.csv', sendCsv((req) => `seller-reporting-${req.query.year || 'current'}.csv`, (req) => sellerReports.byYearCsv(req.query.year)));

module.exports = router;
