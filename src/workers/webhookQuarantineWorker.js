'use strict';

/**
 * webhookQuarantineWorker — retries verification of provider callbacks that were held because the
 * verification infrastructure was temporarily unavailable, and applies each exactly once when its
 * authenticity is finally established.
 *
 * Why this exists: a callback we could not authenticate is not the same as a callback that did not
 * happen. Dropping it would lose real bounce and complaint signals (a compliance harm); applying it
 * unverified would let a network error drive recipient-affecting, effectively irreversible state. So
 * it waits here until it can be proven genuine.
 *
 * Each tick re-runs the real signature check against the stored payload:
 *   verified            -> atomically claimed and processed once through the normal ingest path
 *   rejected_signature  -> terminal; never processed; kept as evidence of a forgery attempt
 *   still unavailable   -> backs off exponentially and waits
 *   attempts exhausted  -> 'abandoned': we stop retrying, but the row and payload are kept forever
 *                          and are still never applied
 *
 * The worker applies no state of its own. It only decides whether the ORIGINAL callback may finally
 * run through the same ingest that a signature-valid callback would have used, and that ingest is
 * itself idempotent on the provider event id.
 */
require('dotenv').config();

const quarantine = require('../services/webhookQuarantineService');
const webhookSignature = require('../lib/webhookSignature');
const { parse, isSnsControl } = require('../lib/sesNotificationParser');
const sesFeedback = require('../services/sesFeedbackService');

const POLL_MS = 5 * 60 * 1000;   // verification outages are minutes-to-hours; five minutes is ample
const BATCH = 20;

/** Re-verify a stored SNS payload using the real verifier. */
async function verifySns(payload) {
  return webhookSignature.verifySns(payload);
}

/**
 * Process a now-verified SES/SNS callback through exactly the path it would have taken had its
 * signature verified on arrival. Control messages are acknowledged without side effects.
 */
async function processSes(payload) {
  if (isSnsControl(payload)) {
    // A SubscriptionConfirmation is never auto-confirmed here either — that stays an Owner action.
    return { acknowledged: payload.Type, auto_confirmed: false, applied: false };
  }
  const events = parse(payload);
  if (!events.length) return { ingested: 0, note: 'no recognizable SES events' };
  const results = [];
  for (const evt of events) results.push(await sesFeedback.ingestEvent(evt));
  return { ingested: results.length, results };
}

async function tick() {
  try {
    const out = await quarantine.retryPending({ verify: verifySns, process: processSes }, { limit: BATCH });
    if (out.ran && out.considered > 0) {
      console.log('[webhookQuarantine] considered', out.considered,
        '— processed', out.processed, 'rejected', out.rejected, 'abandoned', out.abandoned);
      // A rejection here means somebody sent us a payload that does not verify. Worth seeing.
      out.results.filter((r) => r.outcome === 'rejected_invalid').forEach((r) => {
        console.error('[webhookQuarantine] REJECTED as inauthentic:', r.id, r.reason);
      });
      out.results.filter((r) => r.outcome === 'abandoned').forEach((r) => {
        console.warn('[webhookQuarantine] ABANDONED after', r.attempts, 'attempts (kept as evidence, never applied):', r.id);
      });
    }
  } catch (e) { console.error('[webhookQuarantine] tick failed:', e.message); }
}

if (require.main === module) {
  console.log('[webhookQuarantine] worker started (poll 5m; re-verifies held provider callbacks; '
    + 'applies each exactly once only after authenticity is established)');
  setTimeout(tick, 60_000);        // stagger the first run after startup
  setInterval(tick, POLL_MS);
}

module.exports = { tick, verifySns, processSes };
