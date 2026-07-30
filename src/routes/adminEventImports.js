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
const worker = require('../workers/eventImportWorker');
const { writeAuditLog } = require('../lib/auditLog');

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

// ── Commit 15: manual controls, worker status, and run history ────────────────

// Map an import_runs row to the operator-facing shape (imported/updated/skipped/dupes/errors).
function mapRun(r) {
  return {
    id: r.id, source_id: r.source_id, source_key: r.source_key || null, source_name: r.source_name || null,
    trigger: r.trigger, status: r.status,
    started_at: r.started_at, finished_at: r.finished_at, duration_ms: r.duration_ms,
    fetched: r.fetched, eligible: r.eligible,
    imported: r.created, updated: r.updated,
    skipped: (r.skipped_quality || 0) + (r.skipped_ambiguous || 0),
    duplicates: r.skipped_duplicate, errors: r.failed,
    capped: r.capped, remaining_available: r.remaining_available, last_error: r.last_error || null,
  };
}

// GET /status — scheduler config (from the worker's env-driven cfg) + live worker state (derived
// from the shared DB: whether a run is in progress + the most recent run). No secrets exposed.
router.get('/status', asyncRoute(async (req, res) => {
  const c = worker.cfg();
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const running = (await db.query(
    `SELECT r.id, r.source_id, s.key AS source_key, r.trigger, r.started_at
       FROM import_runs r LEFT JOIN import_sources s ON s.id = r.source_id
      WHERE r.status = 'running' ORDER BY r.started_at DESC LIMIT 1`)).rows[0] || null;
  const last = (await db.query(
    `SELECT r.*, s.key AS source_key, s.name AS source_name
       FROM import_runs r LEFT JOIN import_sources s ON s.id = r.source_id
      ORDER BY r.started_at DESC LIMIT 1`)).rows[0] || null;
  const activeSources = (await db.query(`SELECT count(*)::int AS n FROM import_sources WHERE status = 'active'`)).rows[0].n;
  res.json({
    success: true,
    data: {
      scheduler: {
        enabled: c.enabled, cadence: 'weekly', weekday: c.weekday, weekday_label: WD[c.weekday],
        hour: c.hour, timezone: 'America/New_York',
        schedule_label: 'Weekly on ' + WD[c.weekday] + ' at ' + String(c.hour).padStart(2, '0') + ':00 America/New_York',
      },
      worker: {
        running_now: !!running,
        running_run: running ? { id: running.id, source_key: running.source_key, trigger: running.trigger, started_at: running.started_at } : null,
        last_run: last ? mapRun(last) : null,
      },
      sources: { active: activeSources },
    },
  });
}));

// GET /runs — run history (import_runs). Filters: sourceId, status, trigger. Paginated.
router.get('/runs', asyncRoute(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const params = []; const where = [];
  if (reviewQueue.isUuid(req.query.sourceId)) { params.push(req.query.sourceId); where.push(`r.source_id = $${params.length}`); }
  if (['running', 'completed', 'partial', 'failed'].includes(req.query.status)) { params.push(req.query.status); where.push(`r.status = $${params.length}`); }
  if (['scheduled', 'manual', 'backfill'].includes(req.query.trigger)) { params.push(req.query.trigger); where.push(`r.trigger = $${params.length}`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = parseInt((await db.query(`SELECT count(*)::int AS n FROM import_runs r ${whereSql}`, params)).rows[0].n, 10);
  const rows = (await db.query(
    `SELECT r.*, s.key AS source_key, s.name AS source_name
       FROM import_runs r LEFT JOIN import_sources s ON s.id = r.source_id
       ${whereSql}
      ORDER BY r.started_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset])).rows;
  res.json({ success: true, items: rows.map(mapRun), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
}));

// GET /runs/:id — one run + its per-record trail (the dead-letter items: outcomes + errors).
router.get('/runs/:id', asyncRoute(async (req, res) => {
  if (!reviewQueue.isUuid(req.params.id)) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Run not found.' });
  const run = (await db.query(
    `SELECT r.*, s.key AS source_key, s.name AS source_name
       FROM import_runs r LEFT JOIN import_sources s ON s.id = r.source_id WHERE r.id = $1`, [req.params.id])).rows[0];
  if (!run) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Run not found.' });
  const items = (await db.query(
    `SELECT id, source_event_id, event_id, outcome, match_via, market_via, reason, error, created_at
       FROM import_run_items WHERE run_id = $1 ORDER BY created_at ASC LIMIT 500`, [req.params.id])).rows;
  res.json({ success: true, data: { run: mapRun(run), items } });
}));

// POST /run { sourceKey? | all?, apply? } — manual trigger. Reuses the Commit 14 worker service
// (runNow/runAllNow), which ALWAYS forces draft-only (noAutoPublish). apply defaults FALSE (dry
// run writes nothing). Every manual trigger is audited with the acting admin.
router.post('/run', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const apply = !!body.apply;
  const all = !!body.all;
  const sourceKey = body.sourceKey;
  if (!all && !sourceKey) return res.status(400).json({ success: false, code: 'SOURCE_REQUIRED', message: 'Provide a sourceKey or set all=true.' });

  let data;
  try {
    if (all) {
      data = await worker.runAllNow({ apply, trigger: 'manual' });
    } else {
      const one = await worker.runNow({ sourceKey: String(sourceKey), apply, trigger: 'manual' });
      data = worker.summarize(null, Date.now(), [one], { trigger: 'manual', apply });
    }
  } catch (e) {
    return res.status(400).json({ success: false, code: 'RUN_FAILED', message: (e && e.message) || 'Import run failed.' });
  }

  try {
    await writeAuditLog({
      event_type: apply ? 'event_import_manual_run' : 'event_import_dry_run',
      entity_type: 'event_import_scheduler', entity_id: worker.AUDIT_ENTITY_ID, actor_id: req.user.id,
      metadata: { apply, dryRun: !apply, all, sourceKey: sourceKey || null, counts: data && data.counts, sources_failed: data && data.sources_failed },
    });
  } catch (_) { /* audit best-effort; never blocks the response */ }

  res.json({ success: true, data: Object.assign({ apply, dryRun: !apply }, data) });
}));

// Roll a list of per-id outcomes into counts + the detail array.
function summarize(results) {
  const approved = results.filter((r) => r.ok && r.status === 'published').length;
  const rejected = results.filter((r) => r.ok && r.status === 'rejected').length;
  const skipped = results.filter((r) => !r.ok).length;
  return { total: results.length, approved, rejected, skipped, results };
}

module.exports = router;
