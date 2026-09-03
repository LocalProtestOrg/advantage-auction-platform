'use strict';

/**
 * marketingQueueService — a DURABLE, transactional job queue (Postgres outbox) for the Marketing Agency.
 *
 * Why not pg-boss: pg-boss is ABSENT from package.json and, critically, its send() uses its OWN pool, so a
 * financial/publishing enqueue could NOT participate in the caller's DB transaction — enqueue could commit
 * while the parent transaction rolled back (or vice-versa), weakening the transactional guarantee. This
 * outbox writes into marketing_job_queue using the SAME client the caller passes, so enqueue is atomic with
 * the parent state change. A separate worker (added when autonomous marketing is ACTIVATED — not in Phase
 * 3A) will claim rows with FOR UPDATE SKIP LOCKED. Financial/publishing jobs MUST enqueue via this service
 * inside their transaction, never through fire-and-forget.
 */

const db = require('../db');

/**
 * Durably enqueue a job. Pass a transaction client to make the enqueue atomic with the parent tx;
 * omit it to enqueue on the shared pool. Idempotent when an idempotencyKey is supplied.
 * @returns the queued row (or the existing row if the idempotency key already enqueued it).
 */
async function enqueue(runner, { jobType, payload = {}, idempotencyKey = null, runAfter = null }) {
  const r = runner || db;
  const res = await r.query(
    `INSERT INTO marketing_job_queue (job_type, payload, idempotency_key, run_after)
     VALUES ($1, $2::jsonb, $3, COALESCE($4::timestamptz, now()))
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [jobType, JSON.stringify(payload || {}), idempotencyKey, runAfter]);
  if (res.rows[0]) return res.rows[0];
  if (idempotencyKey) {
    const existing = await r.query('SELECT * FROM marketing_job_queue WHERE idempotency_key = $1', [idempotencyKey]);
    return existing.rows[0] || null;
  }
  return null;
}

// Worker-side claim (used only once autonomous marketing is activated — no worker runs in Phase 3A).
async function claimNext(runner) {
  const r = runner || db;
  const res = await r.query(
    `UPDATE marketing_job_queue SET state='processing', attempts = attempts + 1, updated_at = now()
      WHERE id = (SELECT id FROM marketing_job_queue
                   WHERE state='queued' AND run_after <= now()
                   ORDER BY run_after ASC FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`);
  return res.rows[0] || null;
}
async function complete(id, runner) { await (runner || db).query(`UPDATE marketing_job_queue SET state='done', updated_at=now() WHERE id=$1`, [id]); }
async function fail(id, err, runner) {
  await (runner || db).query(
    `UPDATE marketing_job_queue
        SET state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            last_error = $2, run_after = now() + (interval '1 minute' * attempts), updated_at = now()
      WHERE id = $1`, [id, String(err && err.message ? err.message : err).slice(0, 500)]);
}

module.exports = { enqueue, claimNext, complete, fail };
