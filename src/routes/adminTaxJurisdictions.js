'use strict';

/**
 * /api/admin/tax-jurisdictions - the sales tax rule per state, for EVERY channel: auctions, marketplace sales and
 * embedded storefront sales (migrations 214, 227, 231; decision logic in src/services/tax/taxPolicy.js). Maintained by an
 * administrator from professional tax advice; every change is audited and kept in tax_jurisdiction_history.
 *
 *   'platform'       collected at checkout; Advantage.Bid remits. Can be saved only when an ACTIVE sales tax registration
 *                    for the state is recorded (tax_registrations), and checkout refuses a sale when tax is not actually
 *                    being collected there.
 *   'seller_direct'  not collected at checkout; the seller is responsible for its own tax.
 *   'seller'         RETIRED (collected at checkout and paid to the seller). It is refused for a new or changed rule; a
 *                    historical one is still returned so it can be seen and replaced.
 *
 * A state without a rule is never permission to collect nothing: storefront orders there are refused, and auctions are
 * reported or held according to the tax.auction_enforcement setting.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const { US_STATES } = require('../lib/storefrontShipping');
const taxPolicy = require('../services/tax/taxPolicy');

router.use(auth, role(['admin']), express.json({ limit: '16kb' }));
const bad = (res, code, message, status = 422) => res.status(status).json({ success: false, code, message });

const COLS = `state, remitter, legal_basis, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, notes, source_reference, local_jurisdiction,
  to_char(last_verified_at, 'YYYY-MM-DD') AS last_verified_at, last_verified_by, updated_by, updated_at`;
const one = async (state) => (await db.query(`SELECT ${COLS} FROM marketplace_tax_jurisdictions WHERE state = $1`, [state])).rows[0] || null;
const history = (state, action, before, after, actorId) => db.query(
  `INSERT INTO tax_jurisdiction_history (state, action, before_value, after_value, actor_user_id) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)`,
  [state, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actorId]);
const optional = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

router.get('/', async (req, res, next) => {
  try {
    const rows = (await db.query(`SELECT ${COLS} FROM marketplace_tax_jurisdictions ORDER BY state`)).rows;
    const regs = (await db.query(`SELECT state FROM tax_registrations WHERE status = 'active'`)).rows.map((r) => r.state);
    res.json({ success: true, data: { rules: rows.map((r) => ({ ...r, retired: r.remitter === 'seller' })), states: [...US_STATES].sort(),
      remitters: taxPolicy.NEW_RULE_REMITTERS, registered_states: regs } });
  } catch (e) { next(e); }
});

router.get('/:state/history', async (req, res, next) => {
  try {
    const state = String(req.params.state || '').toUpperCase();
    if (!US_STATES.has(state)) return bad(res, 'STATE_INVALID', 'Choose a US state or territory.');
    const rows = (await db.query(
      `SELECT h.id, h.state, h.action, h.before_value, h.after_value, h.actor_user_id, u.full_name AS actor_name, h.created_at
         FROM tax_jurisdiction_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.state = $1 ORDER BY h.created_at DESC, h.id DESC LIMIT 200`, [state])).rows;
    res.json({ success: true, data: rows.map((r) => ({ ...r, id: Number(r.id) })) });
  } catch (e) { next(e); }
});

router.put('/:state', async (req, res, next) => {
  try {
    const state = String(req.params.state || '').toUpperCase();
    if (!US_STATES.has(state)) return bad(res, 'STATE_INVALID', 'Choose a US state or territory.');
    const b = req.body || {};
    const remitter = String(b.remitter || '');
    if (remitter === 'seller') {
      return bad(res, 'REMITTER_RETIRED', 'That option is retired: sales tax collected at checkout is no longer paid to the seller. Choose "collected at checkout; Advantage.Bid remits" or "not collected at checkout; the seller is responsible".');
    }
    if (!taxPolicy.NEW_RULE_REMITTERS.includes(remitter)) return bad(res, 'REMITTER_INVALID', 'Choose how sales tax is handled in this state.');
    const basis = String(b.legal_basis || '').trim().slice(0, 1000);
    if (basis.length < 10) return bad(res, 'BASIS_REQUIRED', 'Record the advice or law this rule relies on (who advised it and when).');
    const eff = b.effective_from ? new Date(b.effective_from) : new Date();
    if (Number.isNaN(eff.getTime())) return bad(res, 'DATE_INVALID', 'Enter a valid effective date.');
    if (remitter === 'platform' && !(await taxPolicy.activeRegistration(state))) {
      return bad(res, 'REGISTRATION_REQUIRED', `Record the active sales tax registration for ${state} first (Sales Tax, Registrations). A rule under which Advantage.Bid collects and remits can be saved only for a state where an active registration is recorded.`, 409);
    }
    const notes = optional(b.notes, 1000);
    const source = optional(b.source_reference, 1000);
    const local = optional(b.local_jurisdiction, 500);
    const before = await one(state);
    await db.query(
      `INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from, notes, source_reference, local_jurisdiction, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (state) DO UPDATE SET remitter = EXCLUDED.remitter, legal_basis = EXCLUDED.legal_basis, effective_from = EXCLUDED.effective_from,
         notes = EXCLUDED.notes, source_reference = EXCLUDED.source_reference, local_jurisdiction = EXCLUDED.local_jurisdiction,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [state, remitter, basis, eff.toISOString().slice(0, 10), notes, source, local, req.user.id]);
    const row = await one(state);
    await history(state, 'set', before, row, req.user.id);
    await writeAuditLog({ event_type: 'tax_jurisdiction_rule_set', entity_type: 'tax_jurisdiction', entity_id: req.user.id, actor_id: req.user.id,
      metadata: { state, before, after: row } });
    res.json({ success: true, data: row });
  } catch (e) { next(e); }
});

// An administrator confirms the rule was checked against its source today. Changes nothing else.
router.post('/:state/verify', async (req, res, next) => {
  try {
    const state = String(req.params.state || '').toUpperCase();
    const before = US_STATES.has(state) ? await one(state) : null;
    if (!before) return bad(res, 'RULE_NOT_FOUND', 'There is no rule for that state.', 404);
    await db.query(`UPDATE marketplace_tax_jurisdictions SET last_verified_at = (now() AT TIME ZONE 'America/New_York')::date, last_verified_by = $2 WHERE state = $1`, [state, req.user.id]);
    const row = await one(state);
    await history(state, 'verified', before, row, req.user.id);
    await writeAuditLog({ event_type: 'tax_jurisdiction_rule_verified', entity_type: 'tax_jurisdiction', entity_id: req.user.id, actor_id: req.user.id,
      metadata: { state, before: { last_verified_at: before.last_verified_at }, after: { last_verified_at: row.last_verified_at } } });
    res.json({ success: true, data: row });
  } catch (e) { next(e); }
});

router.delete('/:state', async (req, res, next) => {
  try {
    const state = String(req.params.state || '').toUpperCase();
    const gone = await one(state);
    if (gone) {
      await db.query('DELETE FROM marketplace_tax_jurisdictions WHERE state = $1', [state]);
      await history(state, 'removed', gone, null, req.user.id);
      await writeAuditLog({ event_type: 'tax_jurisdiction_rule_removed', entity_type: 'tax_jurisdiction', entity_id: req.user.id, actor_id: req.user.id, metadata: { state, before: gone } });
    }
    res.json({ success: true, data: { removed: !!gone } });
  } catch (e) { next(e); }
});

module.exports = router;
