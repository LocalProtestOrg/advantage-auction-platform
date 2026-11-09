'use strict';

/**
 * /api/admin/tax-jurisdictions — who remits sales tax on storefront orders, per state (migration 214; owner decision
 * 2026-11-02). Maintained by an administrator from professional tax advice; every change is audited. EVERY storefront order
 * in a state without a rule is refused, even with no tax calculated (safeguard 2026-11-09, marketplaceOrderService.taxConfiguration).
 *   remitter 'platform' = collected at checkout, Advantage.Bid remits; 'seller' = collected at checkout and paid to the seller
 *   with their proceeds, the seller remits; 'seller_direct' = not collected at checkout, the seller handles its own tax
 *   (migration 227). For 'platform' and 'seller' checkout also refuses an order when tax is not actually being collected.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const { US_STATES } = require('../lib/storefrontShipping');

router.use(auth, role(['admin']), express.json({ limit: '16kb' }));
const bad = (res, code, message) => res.status(422).json({ success: false, code, message });

router.get('/', async (req, res, next) => {
  try {
    const rows = (await db.query(`SELECT state, remitter, legal_basis, effective_from, notes, updated_at FROM marketplace_tax_jurisdictions ORDER BY state`)).rows;
    res.json({ success: true, data: { rules: rows, states: [...US_STATES].sort() } });
  } catch (e) { next(e); }
});

router.put('/:state', async (req, res, next) => {
  try {
    const state = String(req.params.state || '').toUpperCase();
    if (!US_STATES.has(state)) return bad(res, 'STATE_INVALID', 'Choose a US state or territory.');
    const b = req.body || {};
    const remitter = String(b.remitter || '');
    if (!['platform', 'seller', 'seller_direct'].includes(remitter)) return bad(res, 'REMITTER_INVALID', 'Choose how sales tax is handled in this state.');
    const basis = String(b.legal_basis || '').trim().slice(0, 1000);
    if (basis.length < 10) return bad(res, 'BASIS_REQUIRED', 'Record the advice or law this rule relies on (who advised it and when).');
    const eff = b.effective_from ? new Date(b.effective_from) : new Date();
    if (Number.isNaN(eff.getTime())) return bad(res, 'DATE_INVALID', 'Enter a valid effective date.');
    const notes = b.notes == null ? null : String(b.notes).trim().slice(0, 1000) || null;
    const before = (await db.query('SELECT remitter, legal_basis, effective_from FROM marketplace_tax_jurisdictions WHERE state = $1', [state])).rows[0] || null;
    const row = (await db.query(
      `INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from, notes, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (state) DO UPDATE SET remitter = EXCLUDED.remitter, legal_basis = EXCLUDED.legal_basis, effective_from = EXCLUDED.effective_from,
         notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
      [state, remitter, basis, eff.toISOString().slice(0, 10), notes, req.user.id])).rows[0];
    await writeAuditLog({ event_type: 'tax_jurisdiction_rule_set', entity_type: 'tax_jurisdiction', entity_id: req.user.id, actor_id: req.user.id,
      metadata: { state, before, after: { remitter, legal_basis: basis, effective_from: row.effective_from } } });
    res.json({ success: true, data: row });
  } catch (e) { next(e); }
});

router.delete('/:state', async (req, res, next) => {
  try {
    const state = String(req.params.state || '').toUpperCase();
    const gone = (await db.query('DELETE FROM marketplace_tax_jurisdictions WHERE state = $1 RETURNING state, remitter, legal_basis', [state])).rows[0];
    if (gone) await writeAuditLog({ event_type: 'tax_jurisdiction_rule_removed', entity_type: 'tax_jurisdiction', entity_id: req.user.id, actor_id: req.user.id, metadata: { state, before: gone } });
    res.json({ success: true, data: { removed: !!gone } });
  } catch (e) { next(e); }
});

module.exports = router;
