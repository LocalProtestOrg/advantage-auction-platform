'use strict';

/**
 * /api/admin/event-imports — the Admin Review Queue API (Commit 10 of the Event Import
 * Framework). The operational control center for imported listings: administrators browse
 * pending imported events, inspect source attribution + import metadata, and approve/reject
 * them (individually, in bulk, or "approve all" behind an expectedCount safety guard).
 *
 * Governance (non-negotiable):
 *  • Admin-only — authMiddleware + roleMiddleware(['admin']) on every route.
 *  • Every decision runs inside a single DB transaction (withTransaction) and is audited
 *    (writeAuditLog) with the acting admin as actor_id. Nothing bypasses either.
 *  • Railway is canonical; no Brilliant Directories record is ever created. Approval only
 *    flips an existing imported DRAFT to published; rejection moves it to 'rejected'
 *    (record + provenance + audit preserved, never deleted).
 *  • Nothing publishes without an explicit admin approval here.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const { asyncRoute } = require('../utils/apiError');
const { withTransaction } = require('../utils/withTransaction');
const db = require('../db');
const reviewQueue = require('../services/eventImport/reviewQueue');

router.use(authMiddleware, roleMiddleware(['admin']));

// Cap a bulk id list and keep only well-formed UUIDs (deduped, order-preserving).
function cleanIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(); const out = [];
  for (const v of raw) {
    if (reviewQueue.isUuid(v) && !seen.has(v)) { seen.add(v); out.push(v); }
    if (out.length >= 500) break; // hard safety cap per bulk call
  }
  return out;
}

// GET /queue — browse pending imported events (pagination + filter + search).
//   ?page= &limit= &sourceId= &market= &q=
router.get('/queue', asyncRoute(async (req, res) => {
  const out = await reviewQueue.list({
    page: req.query.page, limit: req.query.limit,
    sourceId: req.query.sourceId, market: req.query.market, q: req.query.q,
  });
  res.json({ success: true, ...out });
}));

// GET /queue/:id — full review detail (event + attribution + import metadata + company match).
router.get('/queue/:id', asyncRoute(async (req, res) => {
  const data = await reviewQueue.detail(req.params.id);
  if (!data) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Imported event not found.' });
  res.json({ success: true, data });
}));

// POST /queue/:id/approve { note? } — publish one pending imported event.
router.post('/queue/:id/approve', asyncRoute(async (req, res) => {
  const result = await withTransaction((client) =>
    reviewQueue.approveOne(client, req.params.id, req.user.id, (req.body || {}).note));
  if (!result.ok) return res.status(409).json({ success: false, code: result.reason.toUpperCase(), message: 'Event is not pending review.', data: result });
  res.json({ success: true, data: result });
}));

// POST /queue/:id/reject { reason? } — reject one pending imported event.
router.post('/queue/:id/reject', asyncRoute(async (req, res) => {
  const result = await withTransaction((client) =>
    reviewQueue.rejectOne(client, req.params.id, req.user.id, (req.body || {}).reason));
  if (!result.ok) return res.status(409).json({ success: false, code: result.reason.toUpperCase(), message: 'Event is not pending review.', data: result });
  res.json({ success: true, data: result });
}));

// POST /bulk-approve { ids: [...] } — approve many in ONE transaction (skips non-pending).
router.post('/bulk-approve', asyncRoute(async (req, res) => {
  const ids = cleanIds((req.body || {}).ids);
  if (!ids.length) return res.status(400).json({ success: false, code: 'NO_IDS', message: 'Provide a non-empty list of event ids.' });
  const results = await withTransaction(async (client) => {
    const out = [];
    for (const id of ids) out.push(await reviewQueue.approveOne(client, id, req.user.id, (req.body || {}).note));
    return out;
  });
  res.json({ success: true, data: summarize(results) });
}));

// POST /bulk-reject { ids: [...], reason? } — reject many in ONE transaction.
router.post('/bulk-reject', asyncRoute(async (req, res) => {
  const ids = cleanIds((req.body || {}).ids);
  if (!ids.length) return res.status(400).json({ success: false, code: 'NO_IDS', message: 'Provide a non-empty list of event ids.' });
  const reason = (req.body || {}).reason;
  const results = await withTransaction(async (client) => {
    const out = [];
    for (const id of ids) out.push(await reviewQueue.rejectOne(client, id, req.user.id, reason));
    return out;
  });
  res.json({ success: true, data: summarize(results) });
}));

// POST /approve-all { expectedCount, sourceId?, market?, q? } — approve every pending event
// matching the current filters, but ONLY if the live count equals expectedCount. If the queue
// changed since the admin looked (new imports arrived, someone else acted), publish NOTHING
// and return 409 so the admin re-reviews. The whole thing is one row-locked transaction.
router.post('/approve-all', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const expectedCount = parseInt(body.expectedCount, 10);
  if (!Number.isFinite(expectedCount) || expectedCount < 0) {
    return res.status(400).json({ success: false, code: 'EXPECTED_COUNT_REQUIRED', message: 'expectedCount (a non-negative integer) is required.' });
  }
  const filters = { sourceId: body.sourceId, market: body.market, q: body.q };
  try {
    const results = await withTransaction(async (client) => {
      const ids = await reviewQueue.lockPendingIds(client, filters);
      if (ids.length !== expectedCount) throw new reviewQueue.CountMismatchError(expectedCount, ids.length);
      const out = [];
      for (const id of ids) out.push(await reviewQueue.approveOne(client, id, req.user.id, body.note));
      return out;
    });
    res.json({ success: true, data: { ...summarize(results), expectedCount } });
  } catch (e) {
    if (e instanceof reviewQueue.CountMismatchError) {
      return res.status(409).json({ success: false, code: e.code, message: e.message, data: { expectedCount: e.expected, actualCount: e.actual } });
    }
    throw e;
  }
}));

// GET /sources — the configured import sources (for the filter dropdown + policy display).
router.get('/sources', asyncRoute(async (req, res) => {
  const { rows } = await db.query(
    `SELECT s.id, s.key, s.name, s.kind, s.status, s.media_policy, s.auto_publish,
            s.weekly_cap, s.owner_organization_id,
            (SELECT count(*)::int FROM events e
               WHERE e.source = 'imported' AND e.status = 'draft'
                 AND EXISTS (SELECT 1 FROM event_sources es WHERE es.event_id = e.id AND es.source_id = s.id)) AS pending_count
       FROM import_sources s ORDER BY s.name ASC`);
  res.json({ success: true, data: rows });
}));

// Roll a list of per-id outcomes into counts + the detail array.
function summarize(results) {
  const approved = results.filter((r) => r.ok && r.status === 'published').length;
  const rejected = results.filter((r) => r.ok && r.status === 'rejected').length;
  const skipped = results.filter((r) => !r.ok).length;
  return { total: results.length, approved, rejected, skipped, results };
}

module.exports = router;
