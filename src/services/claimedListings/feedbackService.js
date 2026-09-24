'use strict';

/**
 * feedbackService — SES delivery / bounce / complaint events on the claimed_listing stream.
 *
 * Called after sesFeedbackService has recorded the event (which already applies the GLOBAL marketing
 * suppression for hard bounces and complaints). Here the listing programme:
 *   - marks its message delivered / bounced / complained and records the funnel event;
 *   - HARD bounce or COMPLAINT → listing suppression + the sequence stops before any queued send;
 *   - SOFT bounce → one retry 24 hours later; a second soft bounce for the same message is treated as hard;
 *   - checks stream health and, on a breach, AUTO-PAUSES the programme (sending_enabled = false,
 *     paused_reason set) and alerts the Owner.
 * Never throws into the SES webhook.
 */

const db = require('../../db');
const events = require('./claimEvents');
const suppression = require('./suppressionService');
const sendGate = require('./sendGate');

async function findMessage(sesMessageId, runner) {
  if (!sesMessageId) return null;
  const id = String(sesMessageId).replace(/^</, '').replace(/>$/, '').split('@')[0];
  return (await runner.query(
    `SELECT m.*, s.state AS sequence_state FROM listing_outreach_messages m LEFT JOIN listing_outreach_sequences s ON s.id = m.sequence_id
      WHERE m.ses_message_id = $1 AND m.direction = 'outbound' LIMIT 1`, [id])).rows[0] || null;
}

async function onFeedback(evt, runner = db) {
  try {
    const m = await findMessage(evt.sesMessageId, runner);
    const type = String(evt.eventType || '').toLowerCase();
    const soft = type === 'bounce' && String(evt.bounceSubtype || '').toLowerCase() === 'transient';
    const hard = type === 'bounce' && !soft;
    if (m) {
      if (type === 'delivery') {
        await events.record('delivered', { organizationId: m.organization_id, companyId: m.company_id, sequenceId: m.sequence_id, messageId: m.id,
          idempotencyKey: 'dlv:' + m.id }, runner);
      } else if (hard || type === 'complaint' || (soft && /soft_bounce_once/.test(m.error || ''))) {
        const reason = type === 'complaint' ? 'complaint' : 'hard_bounce';
        await runner.query(`UPDATE listing_outreach_messages SET status = $2 WHERE id = $1`, [m.id, type === 'complaint' ? 'complained' : 'bounced']);
        await suppression.suppress({ email: m.recipient_email_normalized, reason, source: 'ses_feedback', organizationId: m.organization_id, companyId: m.company_id }, runner);
        await events.record(type === 'complaint' ? 'complained' : 'bounced', { organizationId: m.organization_id, companyId: m.company_id,
          sequenceId: m.sequence_id, messageId: m.id, meta: { soft_twice: soft }, idempotencyKey: (type === 'complaint' ? 'cmp:' : 'bnc:') + m.id }, runner);
      } else if (soft) {
        // First soft bounce: retry the same step once, 24 hours later.
        await runner.query(`UPDATE listing_outreach_messages SET status = 'failed', error = 'soft_bounce_once' WHERE id = $1`, [m.id]);
        if (m.sequence_id) {
          await runner.query(
            `UPDATE listing_outreach_sequences SET step = GREATEST(step - 1, 0), next_send_at = now() + interval '24 hours', updated_at = now()
              WHERE id = $1 AND state IN ('active','queued')`, [m.sequence_id]);
        }
      }
    }
    if (hard || type === 'complaint') await checkHealthAndPause(runner);
    return { ok: true, matched: !!m };
  } catch (e) {
    console.error('[claimed-listing] feedback handling failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/** Auto-pause on a health breach and alert the Owner (once per day). */
async function checkHealthAndPause(runner = db) {
  const cfg = (await runner.query(`SELECT value FROM platform_config WHERE key = 'claimed_listings.health'`)).rows[0];
  const h = await sendGate.streamHealth(runner, cfg && cfg.value);
  if (h.ok) return { paused: false, health: h };
  const reason = 'stream health breach ' + new Date().toISOString().slice(0, 10) + ': ' + JSON.stringify(h);
  await runner.query(
    `UPDATE platform_config SET value = to_jsonb($1::text), updated_at = now() WHERE key = 'claimed_listings.paused_reason'`, [reason]);
  await runner.query(`UPDATE platform_config SET value = 'false'::jsonb, updated_at = now() WHERE key = 'claimed_listings.sending_enabled'`);
  try {
    await require('../ownerAlertService').sendOwnerAlertOnce({ alertType: 'claimed_listing_paused', entityType: 'program',
      entityId: 'claimed_listing:' + new Date().toISOString().slice(0, 10),
      message: 'Advantage.Bid: Claimed Listing outreach auto-paused (bounce/complaint threshold). Review in the Toolbox before resuming.' });
  } catch (_) { /* alert is best-effort */ }
  return { paused: true, health: h };
}

module.exports = { onFeedback, checkHealthAndPause };
