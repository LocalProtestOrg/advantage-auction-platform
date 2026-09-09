'use strict';

/**
 * socialDispatchService — the autonomous ORGANIC social dispatch seam, the social twin of
 * emailDispatchService. Producer enqueues a durable `social_dispatch` job into the existing marketing_job_queue
 * (idempotent per obligation+wave+platform → never posts twice); the worker claims due jobs and dispatches each
 * through the certified socialAdapter.publishWave (which resolves the multi-market destination, builds factual
 * copy, and persists post_id/permalink/proof/reconciliation).
 *
 * DOUBLE self-gate: it does nothing unless BOTH marketing.a9_publish_enabled (publish authorization) AND
 * marketing.destinations.meta_enabled (Meta provider authorization) are true. Both remain OFF during the build,
 * so this is completely inert — no external publish. Failures use the queue's bounded retry/backoff → dead.
 * A missing/blocked destination routes to resilience; it never guesses a Page.
 */

const db = require('../db');
const queue = require('./marketingQueueService');
const socialAdapter = require('./socialAdapter');
const marketingConfig = require('./marketingConfigService');

const JOB_TYPE = 'social_dispatch';

/** Producer: durably schedule one platform+wave social post. Idempotent (never enqueued/posted twice). */
async function enqueueSocialDispatch(runner, { obligationId, auctionId, wave = 'ANY', platform = 'facebook', stateCode = null, imageUrl = null, referenceAt = null, runAfter = null, event = null } = {}) {
  if (!auctionId) throw new Error('auctionId required');
  return queue.enqueue(runner, {
    jobType: JOB_TYPE,
    // `event` (optional) = factual event-record subject for event posts (estate sales / professional events):
    // { event_id, title, url, start_at, end_at, timezone, venue_name, city, state, organizer_name, address?, qa? }.
    payload: { obligationId: obligationId || null, auctionId, wave, platform, stateCode, imageUrl, referenceAt, event: event || null },
    idempotencyKey: `${JOB_TYPE}:${obligationId || auctionId}:${wave}:${platform}`,
    runAfter,
  });
}

// Both gates must be ON before anything can publish externally.
async function authorized() {
  const a9 = await marketingConfig.getBool('marketing.a9_publish_enabled', false);
  const meta = await marketingConfig.getBool('marketing.destinations.meta_enabled', false);
  return { ok: a9 && meta, a9, meta };
}

/** Worker-side: execute ONE claimed job via the certified adapter. Throws on failure (caller records retry). */
async function dispatchClaimed(job, runner) {
  const r = runner || db;
  const p = (job && job.payload) || {};
  if (!p.auctionId) throw new Error('invalid_social_dispatch_payload');
  const auth = await authorized();
  if (!auth.ok) { const e = new Error(`social publish not authorized (a9=${auth.a9}, meta=${auth.meta})`); e.code = 'SOCIAL_UNAUTHORIZED'; throw e; }

  const obligation = { id: p.obligationId };
  const auction = { auction_id: p.auctionId, title: p.title, lot_count: p.lot_count, closing_at: p.closing_at, event: p.event || null };
  const out = await socialAdapter.publishWave(obligation, {
    auction, wave: p.wave, referenceAt: p.referenceAt, platform: p.platform, stateCode: p.stateCode, imageUrl: p.imageUrl,
  }, r);
  if (!out.ok && !out.idempotent_replay) { const e = new Error('publish_' + (out.reason || 'failed')); e.social_result = out; throw e; }
  return { ok: true, result: out };
}

/** Claim + dispatch a bounded batch. Inert unless BOTH gates are ON (claims nothing, publishes nothing). */
async function runOnce({ max = 5 } = {}) {
  const auth = await authorized();
  if (!auth.ok) return { ran: false, reason: 'not_authorized', a9: auth.a9, meta: auth.meta, dispatched: 0, results: [] };
  let dispatched = 0; const results = [];
  for (let i = 0; i < max; i++) {
    const job = await queue.claimNext(db, JOB_TYPE);
    if (!job) break;
    try { const out = await dispatchClaimed(job, db); await queue.complete(job.id, db); dispatched++; results.push({ id: job.id, ok: true, shadow: out.result && out.result.shadow }); }
    catch (e) { await queue.fail(job.id, e, db); results.push({ id: job.id, error: e.message }); }
  }
  return { ran: true, dispatched, results };
}

module.exports = { JOB_TYPE, enqueueSocialDispatch, dispatchClaimed, runOnce, authorized };
