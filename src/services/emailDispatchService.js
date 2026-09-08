'use strict';

/**
 * emailDispatchService — the autonomous email dispatch seam that closes the A7 operating gap. Before this,
 * `marketingSendService.sendCampaignLive()` had ZERO callers, so A7 was enabled but nothing ever executed.
 *
 * This does NOT create a parallel email system. It reuses the certified pieces end-to-end:
 *   producer  → enqueueCampaignDispatch() writes a durable `email_dispatch` job into marketing_job_queue
 *               (marketingQueueService; idempotent per campaign) inside the caller's transaction.
 *   worker    → runOnce() (driven by marketingDispatchWorker) claims due jobs (FOR UPDATE SKIP LOCKED),
 *               self-gates on marketing.a7_send_enabled, and dispatches each via sendCampaignLive.
 *   safety    → sendCampaignLive re-checks EVERY recipient at send time (suppression, permission/consent,
 *               unsubscribe, frequency/geo caps) and reserves marketing_campaign_recipients with a UNIQUE
 *               (campaign_id, contact_id) → no duplicate sends even on retry. Failures use the queue's bounded
 *               retry/backoff → 'dead' at max_attempts. Subscriber health always outranks fulfillment.
 *
 * Nothing here manufactures audience or widens scope; it only executes a campaign that already passed the
 * certified creation/QA path and was scheduled into the queue.
 */

const db = require('../db');
const queue = require('./marketingQueueService');
const marketingSend = require('./marketingSendService');
const marketingConfig = require('./marketingConfigService');

const JOB_TYPE = 'email_dispatch';

/**
 * Producer: durably schedule a QA-passed campaign for autonomous dispatch. Idempotent per campaign
 * (idempotency_key = email_dispatch:<campaignId>), so the same campaign can never be enqueued — or sent — twice.
 * Pass a transaction client to make the enqueue atomic with the campaign state change.
 */
async function enqueueCampaignDispatch(runner, { campaignId, marketingClass = 'local_event_alert', geoStrategy = null, rendered, runAfter = null } = {}) {
  if (!campaignId) throw new Error('campaignId required');
  if (!rendered || !rendered.subject || !rendered.html) throw new Error('rendered subject+html required');
  return queue.enqueue(runner, {
    jobType: JOB_TYPE,
    payload: { campaignId, marketingClass, geoStrategy, rendered },
    idempotencyKey: `${JOB_TYPE}:${campaignId}`,
    runAfter,
  });
}

/**
 * Worker-side: execute ONE claimed dispatch job. Throws on any failure so the caller records a bounded retry.
 * Re-checks A7 at execution (defense in depth — sendCampaignLive also refuses when A7 is off).
 */
async function dispatchClaimed(job, runner) {
  const r = runner || db;
  const p = (job && job.payload) || {};
  if (!p.campaignId || !p.rendered) throw new Error('invalid_dispatch_payload');
  if (!(await marketingConfig.a7SendEnabled())) { const e = new Error('A7 disabled'); e.code = 'A7_DISABLED'; throw e; }

  await r.query(
    `UPDATE marketing_campaigns SET state='executing', updated_at=now()
      WHERE id=$1 AND state IN ('qa_passed','published','queued')`, [p.campaignId]).catch(() => {});

  const result = await marketingSend.sendCampaignLive({
    campaignId: p.campaignId, marketingClass: p.marketingClass, geoStrategy: p.geoStrategy, rendered: p.rendered,
  }, r);

  await r.query(
    `UPDATE marketing_campaigns SET state='completed', updated_at=now() WHERE id=$1 AND state='executing'`,
    [p.campaignId]).catch(() => {});
  return { ok: true, result };
}

/**
 * Claim + dispatch a bounded batch. Self-gates on A7 (inert when off — claims nothing, sends nothing). Each job
 * is completed on success or failed (retry/backoff/dead) on error. Returns a summary (no recipient identities).
 */
async function runOnce({ max = 5 } = {}) {
  if (!(await marketingConfig.a7SendEnabled())) return { ran: false, reason: 'a7_disabled', dispatched: 0, results: [] };
  let dispatched = 0; const results = [];
  for (let i = 0; i < max; i++) {
    const job = await queue.claimNext(db, JOB_TYPE);
    if (!job) break;
    try {
      const out = await dispatchClaimed(job, db);
      await queue.complete(job.id, db);
      dispatched++;
      results.push({ id: job.id, sent: out.result && out.result.sent, skipped: out.result && out.result.skipped, candidates: out.result && out.result.candidates });
    } catch (e) {
      await queue.fail(job.id, e, db);
      results.push({ id: job.id, error: e.message });
    }
  }
  return { ran: true, dispatched, results };
}

module.exports = { JOB_TYPE, enqueueCampaignDispatch, dispatchClaimed, runOnce };
