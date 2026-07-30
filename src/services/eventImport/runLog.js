'use strict';

/**
 * runLog — the run + per-record ledger (§9, §10 of the plan). startRun claims a scheduled slot via the
 * partial UNIQUE(source_id, scheduled_for) index (true mutual exclusion across replicas); recordItem
 * writes the per-record dead-letter trail; finishRun closes out the run with counters and status.
 */

async function startRun(client, { sourceId, trigger, scheduledFor }) {
  if (trigger === 'scheduled') {
    // The weekly run claim: a second replica's INSERT conflicts on the partial unique index → no row.
    const { rows } = await client.query(
      `INSERT INTO import_runs (source_id, trigger, scheduled_for, status)
       VALUES ($1, 'scheduled', $2, 'running')
       ON CONFLICT (source_id, scheduled_for) WHERE trigger = 'scheduled' DO NOTHING
       RETURNING id, started_at`,
      [sourceId, scheduledFor]);
    return rows[0] || null; // null → another replica owns this week's run
  }
  const { rows } = await client.query(
    `INSERT INTO import_runs (source_id, trigger, scheduled_for, status)
     VALUES ($1, $2, $3, 'running') RETURNING id, started_at`,
    [sourceId, trigger || 'manual', scheduledFor || null]);
  return rows[0];
}

async function recordItem(client, runId, it) {
  await client.query(
    `INSERT INTO import_run_items
       (run_id, source_event_id, event_id, outcome, match_via, market_via, reason, error, raw_excerpt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [runId, it.sourceEventId != null ? String(it.sourceEventId) : null, it.eventId || null, it.outcome,
     it.matchVia || null, it.marketVia || null, it.reason || null, it.error || null,
     it.rawExcerpt != null ? JSON.stringify(it.rawExcerpt) : null]);
}

async function finishRun(client, runId, r) {
  const c = (r && r.counters) || {};
  await client.query(
    `UPDATE import_runs SET
        status = $2, finished_at = now(),
        duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
        fetched = $3, eligible = $4, created = $5, updated = $6, skipped_duplicate = $7,
        skipped_quality = $8, skipped_ambiguous = $9, images_queued = $10, failed = $11,
        capped = $12, remaining_available = $13, last_error = $14, stats = $15
      WHERE id = $1`,
    [runId, (r && r.status) || 'completed',
     c.fetched || 0, c.eligible || 0, c.created || 0, c.updated || 0, c.skipped_duplicate || 0,
     c.skipped_quality || 0, c.skipped_ambiguous || 0, c.images_queued || 0, c.failed || 0,
     !!(r && r.capped), (r && r.remainingAvailable != null) ? r.remainingAvailable : null,
     (r && r.lastError) || null, JSON.stringify((r && r.stats) || {})]);
}

// Map a per-record pipeline/dedupe outcome to a counter key + the final import_run_items outcome.
function counterFor(outcome) {
  switch (outcome) {
    case 'created': return 'created';
    case 'updated': return 'updated';
    case 'unchanged': return 'skipped_duplicate';
    case 'duplicate': return 'skipped_duplicate';
    case 'ambiguous': return 'skipped_ambiguous';
    case 'rejected_quality': return 'skipped_quality';
    case 'failed': return 'failed';
    default: return null;
  }
}

module.exports = { startRun, recordItem, finishRun, counterFor };
