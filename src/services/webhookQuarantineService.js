'use strict';

/**
 * webhookQuarantineService — holds a provider callback whose authenticity could not be established,
 * applies nothing, retries verification, and processes it exactly once when it finally verifies.
 *
 * The rule, stated once so every caller can be checked against it:
 *
 *   valid signature      -> process normally (never reaches this service)
 *   invalid signature    -> reject; recorded, never processed
 *   cannot verify YET    -> quarantine; NO suppression, complaint, bounce, deliverability or consent
 *                           state is applied; retry with backoff; process exactly once when verified
 *   never verifiable     -> keep forever as evidence; never processed
 *
 * Nothing is discarded. A callback that we could not authenticate is not the same as a callback that
 * did not happen, and the payload is kept whole so it can be replayed byte-for-byte once trusted.
 *
 * Exactly-once has two independent guards:
 *   1. An atomic claim: the row moves out of 'pending_verification' in the same statement that selects
 *      it, so two workers cannot both process it.
 *   2. The downstream ingest is itself idempotent on the provider event id, so even a pathological
 *      double-claim cannot double-apply suppression.
 *
 * Idempotency on arrival is the UNIQUE (provider, payload_sha256): a provider retrying while we are
 * still unable to verify updates the existing row rather than creating a second pending item.
 */

const db = require('../db');
const configService = require('./configService');
const signature = require('../lib/webhookSignature');

const q = (client) => (client || db);

const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_BACKOFF_SECONDS = 300;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;   // never wait longer than six hours between attempts

/** Exponential backoff with a ceiling, from the attempt count. */
function backoffSeconds(attempts, base) {
  const b = Number(base) > 0 ? Number(base) : DEFAULT_BACKOFF_SECONDS;
  return Math.min(b * Math.pow(2, Math.max(0, attempts - 1)), MAX_BACKOFF_SECONDS);
}

/**
 * Quarantine a callback we could not verify. Idempotent on the payload bytes.
 *
 * Returns { quarantined: true, id, duplicate } — the caller should acknowledge the callback to the
 * provider (so it stops retrying, because WE now own the retry) and apply nothing.
 */
async function quarantine(input, client) {
  input = input || {};
  const payload = input.payload;
  const digest = input.digest || signature.payloadDigest(payload);
  const provider = input.provider || 'unknown';

  const existing = (await q(client).query(
    `SELECT id, status, verify_attempts FROM webhook_callback_quarantine
      WHERE provider = $1 AND payload_sha256 = $2`, [provider, digest])).rows[0];
  if (existing) {
    // The provider is retrying something we are already holding. Nothing new to apply.
    await q(client).query(
      'UPDATE webhook_callback_quarantine SET updated_at = now() WHERE id = $1', [existing.id]);
    return { quarantined: true, id: existing.id, duplicate: true, status: existing.status };
  }

  const { rows } = await q(client).query(
    `INSERT INTO webhook_callback_quarantine
       (provider, payload, payload_sha256, provider_message_id, topic_arn, event_kind,
        signature_status, last_reason, remote_ip_hash, next_attempt_at)
     VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' seconds')::interval)
     ON CONFLICT (provider, payload_sha256) DO NOTHING
     RETURNING id`,
    [provider, JSON.stringify(payload), digest,
     (payload && payload.MessageId) || null, (payload && payload.TopicArn) || null,
     input.eventKind || null, input.signatureStatus || 'verify_unavailable',
     input.reason || null, input.remoteIpHash || null,
     String(backoffSeconds(1, await configService.get(null, 'webhooks.quarantine_backoff_seconds')))]);

  if (!rows[0]) {
    // Lost an insert race with a concurrent identical callback — still exactly one row.
    const row = (await q(client).query(
      `SELECT id, status FROM webhook_callback_quarantine WHERE provider = $1 AND payload_sha256 = $2`,
      [provider, digest])).rows[0];
    return { quarantined: true, id: row && row.id, duplicate: true, status: row && row.status };
  }
  return { quarantined: true, id: rows[0].id, duplicate: false, status: 'pending_verification' };
}

/**
 * Re-verify one held callback and, if it is authentic, process it exactly once.
 *
 * @param {object} row      the quarantine row
 * @param {object} deps     { verify(payload) -> {ok,status,reason}, process(payload) -> result }
 */
async function attemptOne(row, deps, client) {
  deps = deps || {};
  const maxAttempts = Number(await configService.get(null, 'webhooks.quarantine_max_attempts')) || DEFAULT_MAX_ATTEMPTS;
  const base = await configService.get(null, 'webhooks.quarantine_backoff_seconds');
  const attempts = (row.verify_attempts || 0) + 1;

  let verdict;
  try {
    verdict = await deps.verify(row.payload);
  } catch (e) {
    verdict = { ok: false, status: 'verify_unavailable', reason: 'verify threw: ' + e.message };
  }

  // Authenticity DISPROVED. Terminal, and it is never processed.
  if (!verdict.ok && verdict.status === 'rejected_signature') {
    await q(client).query(
      `UPDATE webhook_callback_quarantine
          SET status = 'rejected_invalid', verify_attempts = $2, last_attempt_at = now(),
              last_reason = $3, signature_status = 'rejected_signature', updated_at = now()
        WHERE id = $1`, [row.id, attempts, verdict.reason || null]);
    return { id: row.id, outcome: 'rejected_invalid', reason: verdict.reason };
  }

  // Still cannot tell. Back off and try later; nothing is applied, nothing is lost.
  if (!verdict.ok) {
    const exhausted = attempts >= maxAttempts;
    await q(client).query(
      `UPDATE webhook_callback_quarantine
          SET status = $4, verify_attempts = $2, last_attempt_at = now(), last_reason = $3,
              next_attempt_at = now() + ($5 || ' seconds')::interval, updated_at = now()
        WHERE id = $1`,
      [row.id, attempts, verdict.reason || null,
       // 'abandoned' still means kept forever and never applied — only that we stop retrying.
       exhausted ? 'abandoned' : 'pending_verification',
       String(backoffSeconds(attempts, base))]);
    return { id: row.id, outcome: exhausted ? 'abandoned' : 'still_unavailable', attempts, reason: verdict.reason };
  }

  // VERIFIED. Claim it atomically, so only one worker can ever process it.
  const claimed = (await q(client).query(
    `UPDATE webhook_callback_quarantine
        SET status = 'verified_processed', processed_at = now(), verify_attempts = $2,
            last_attempt_at = now(), signature_status = 'verified', last_reason = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending_verification' AND processed_at IS NULL
      RETURNING id`, [row.id, attempts])).rows[0];
  if (!claimed) {
    // Another worker won, or it was already processed. Exactly-once holds.
    return { id: row.id, outcome: 'already_processed' };
  }

  let result;
  try {
    result = await deps.process(row.payload);
  } catch (e) {
    // The callback IS authentic but processing failed. Return it to the queue so the data is not
    // lost — the downstream ingest is idempotent, so a later retry cannot double-apply.
    await q(client).query(
      `UPDATE webhook_callback_quarantine
          SET status = 'pending_verification', processed_at = NULL, last_reason = $2,
              next_attempt_at = now() + ($3 || ' seconds')::interval, updated_at = now()
        WHERE id = $1`, [row.id, 'process failed: ' + e.message, String(backoffSeconds(attempts, base))]);
    return { id: row.id, outcome: 'process_failed', reason: e.message };
  }

  await q(client).query(
    'UPDATE webhook_callback_quarantine SET process_result = $2::jsonb, updated_at = now() WHERE id = $1',
    [row.id, JSON.stringify(result || {})]);
  return { id: row.id, outcome: 'verified_processed', result };
}

/** Claim and attempt a bounded batch of due callbacks. */
async function retryPending(deps, opts, client) {
  opts = opts || {};
  const enabled = await configService.get(null, 'webhooks.quarantine_retry_enabled');
  if (enabled === false) return { ran: false, reason: 'retry_disabled', processed: 0, results: [] };

  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 100);
  const { rows } = await q(client).query(
    `SELECT id, provider, payload, verify_attempts, status
       FROM webhook_callback_quarantine
      WHERE status = 'pending_verification' AND next_attempt_at <= now()
      ORDER BY first_seen_at ASC
      LIMIT $1`, [limit]);

  const results = [];
  for (const row of rows) results.push(await attemptOne(row, deps, client));
  return {
    ran: true,
    considered: rows.length,
    processed: results.filter((r) => r.outcome === 'verified_processed').length,
    rejected: results.filter((r) => r.outcome === 'rejected_invalid').length,
    abandoned: results.filter((r) => r.outcome === 'abandoned').length,
    results,
  };
}

/** Operational view. Nothing here mutates state. */
async function stats(client) {
  const { rows } = await q(client).query(
    `SELECT provider, status, count(*)::int n, min(first_seen_at) oldest, max(verify_attempts) max_attempts
       FROM webhook_callback_quarantine GROUP BY 1,2 ORDER BY 1,2`);
  return rows;
}

async function list(opts, client) {
  opts = opts || {};
  const params = []; const where = [];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.provider) { params.push(opts.provider); where.push(`provider = $${params.length}`); }
  params.push(Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200));
  const { rows } = await q(client).query(
    `SELECT id, provider, provider_message_id, topic_arn, event_kind, status, signature_status,
            last_reason, verify_attempts, first_seen_at, last_attempt_at, next_attempt_at, processed_at
       FROM webhook_callback_quarantine
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY first_seen_at DESC LIMIT $${params.length}`, params);
  return rows;   // the payload itself is deliberately not listed
}

module.exports = {
  quarantine, attemptOne, retryPending, stats, list, backoffSeconds,
  DEFAULT_MAX_ATTEMPTS, DEFAULT_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS,
};
