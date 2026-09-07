'use strict';

/**
 * /api/admin/marketing-runtime — Super-Admin inspection + control of the Phase 3O execution runtime:
 * NEEDS_OWNER queue, obligation state history, channel readiness, the Desktop Marketing bridge (runtime
 * export + validated proposal intake), and a manual shadow monitor tick. Super-Admin-only (confidential
 * runtime + economics). Reuses the certified Admin Action Required SMS for NEEDS_OWNER (fired by the engine).
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const readiness = require('../services/channelReadinessService');
const bridge = require('../services/desktopBridgeService');
const worker = require('../services/marketingFulfillmentWorker');
const contract = require('../services/phase3oContract');

router.use(auth, role(['admin']));

router.get('/needs-owner', async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT id, purchase_kind, purchase_id, auction_id, obligation_key, feature_key, needs_owner_reason, needs_owner_options, deadline_at, updated_at
         FROM marketing_obligations WHERE state='needs_owner' ORDER BY updated_at DESC`)).rows;
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

router.get('/obligations/:id/events', async (req, res, next) => {
  try {
    const events = (await db.query(`SELECT * FROM marketing_obligation_events WHERE obligation_id=$1 ORDER BY created_at ASC`, [req.params.id])).rows;
    const ob = (await db.query(`SELECT * FROM marketing_obligations WHERE id=$1`, [req.params.id])).rows[0];
    return res.json({ success: true, data: { obligation: ob, events } });
  } catch (err) { next(err); }
});

router.get('/readiness', async (req, res, next) => {
  try { return res.json({ success: true, data: await readiness.phase3oMatrix() }); } catch (err) { next(err); }
});

// Build + return an anonymized RUNTIME_EXPORT (vs_to_desktop). Persisted; never contains PII.
router.post('/runtime-export', async (req, res, next) => {
  try { return res.json({ success: true, data: await bridge.buildRuntimeExport((req.body || {}).window_label) }); } catch (err) { next(err); }
});

// Ingest a Desktop → VS structured proposal (validated + routed to a controlled path; never applied live).
router.post('/desktop-proposal', async (req, res, next) => {
  try { return res.json({ success: true, data: await bridge.ingestProposal(req.body || {}, req.user.id) }); } catch (err) { next(err); }
});

router.get('/desktop-messages', async (req, res, next) => {
  try { return res.json({ success: true, data: (await db.query(`SELECT id, message_id, direction, message_type, schema_valid, applies_via, status, created_at FROM marketing_desktop_messages ORDER BY created_at DESC LIMIT 100`)).rows }); }
  catch (err) { next(err); }
});

// Manual shadow monitor tick (admin-triggered).
router.post('/tick', async (req, res, next) => {
  try { return res.json({ success: true, data: await worker.tick() }); } catch (err) { next(err); }
});

// Contract catalogue (features/recipes/ladders) read from the authoritative pack.
router.get('/contract', async (req, res, next) => {
  try { return res.json({ success: true, data: { features: contract.features().length, recipes: contract.recipes().length, ladders: Object.keys(contract.ladders()) } }); }
  catch (err) { next(err); }
});

module.exports = router;
