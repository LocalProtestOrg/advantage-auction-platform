'use strict';

/**
 * inboundService — replies to Claimed Listing outreach (handoff section 14).
 *
 * NO AUTOMATIC REPLY TO A PERSON, EVER. Routing uses the reply key in the Reply-To address
 * (listings+l<24 hex>@reply.advantage.bid), so a reply resolves to its company without anyone reading it.
 * Deterministic handling is limited to:
 *   - unsubscribe wording (STOP, remove me, unsubscribe) → suppress the address, stop the sequence;
 *   - bounces → recorded (hard: suppressed);
 *   - out-of-office / auto-replies → ignored (do not stop the sequence, do not count as a reply).
 * Everything else — interest, a question, "is this legit", wrong contact, removal, legal or angry — STOPS
 * all automation for that company and creates a staff task with a one-business-day SLA (legal and
 * disputes escalate to the Owner). The classifier is the Event Partner one, reused; the listing data set
 * is separate (listing_outreach_messages), never event_partner_messages.
 *
 * Gated by claimed_listings.inbound_enabled (default OFF).
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const { normalizeEmail } = require('../../lib/emailNormalize');
const classifier = require('../eventPartners/replyClassifier');
const suppression = require('./suppressionService');
const tasks = require('./taskService');
const events = require('./claimEvents');

const KEY_RE = /\+(l[0-9a-f]{24})@/i;

/** The listing reply key carried by an inbound message, or null. */
function extractListingKey(normalized) {
  const cands = [];
  if (normalized.mailboxHash) cands.push(String(normalized.mailboxHash));
  for (const a of [].concat(normalized.to || [], normalized.toEmail || [])) {
    const m = String(a || '').match(KEY_RE);
    if (m) cands.push(m[1]);
  }
  const hit = cands.map((c) => String(c).toLowerCase()).find((c) => /^l[0-9a-f]{24}$/.test(c));
  return hit || null;
}

async function inboundEnabled(runner = db) {
  const r = (await runner.query(`SELECT value FROM platform_config WHERE key = 'claimed_listings.inbound_enabled'`).catch(() => ({ rows: [] }))).rows[0];
  return !!(r && r.value === true);
}

/**
 * Ingest one verified inbound message. Returns { ok, duplicate?, classification, action }.
 * `meta` = { digest, signatureStatus }. Unverified callbacks are refused.
 */
async function ingest(normalized, meta = {}) {
  if (['verified', 'unsigned_accepted'].indexOf(meta.signatureStatus) === -1) {
    throw Object.assign(new Error('Callback was not verified.'), { status: 403, code: 'UNVERIFIED_CALLBACK' });
  }
  if (!(await inboundEnabled())) throw Object.assign(new Error('Inbound processing is disabled.'), { status: 404, code: 'INBOUND_DISABLED' });
  const key = extractListingKey(normalized);
  return withTransaction(async (client) => {
    if (meta.digest) {
      const dup = (await client.query(`SELECT 1 FROM listing_outreach_messages WHERE raw_digest = $1 LIMIT 1`, [meta.digest])).rows[0];
      if (dup) return { ok: true, duplicate: true, reason: 'payload_replay' };
    }
    const out = key ? (await client.query(
      `SELECT m.*, o.name AS organization_name FROM listing_outreach_messages m LEFT JOIN organizations o ON o.id = m.organization_id
        WHERE m.reply_key = $1 AND m.direction = 'outbound'`, [key])).rows[0] : null;
    const verdict = classifier.classify(normalized, {});
    const ins = (await client.query(
      `INSERT INTO listing_outreach_messages (sequence_id, organization_id, company_id, direction, provider_message_id, sender_email_normalized,
          status, subject, body_text, classification, raw_digest)
       VALUES ($1,$2,$3,'inbound',$4,$5,'received',$6,$7,$8,$9)
       ON CONFLICT DO NOTHING RETURNING id`,
      [out ? out.sequence_id : null, out ? out.organization_id : null, out ? out.company_id : null, normalized.providerMessageId || null,
       normalizeEmail(normalized.fromEmail || '') || null, (normalized.subject || '').slice(0, 500), (normalized.textBody || '').slice(0, 20000),
       verdict.classification, meta.digest || null])).rows[0];
    if (!ins) return { ok: true, duplicate: true, reason: 'provider_message_replay' };

    const orgId = out ? out.organization_id : null;
    const companyId = out ? out.company_id : null;
    const from = normalized.fromEmail || (out && out.recipient_email_normalized);
    const stopAll = async (why) => {
      await client.query(
        `UPDATE listing_outreach_sequences SET state = 'stopped', stop_reason = $3, next_send_at = NULL, updated_at = now()
          WHERE state IN ('queued','active','paused','dormant') AND (($1::uuid IS NOT NULL AND organization_id = $1) OR ($2::uuid IS NOT NULL AND company_id = $2))`,
        [orgId, companyId, why]);
    };
    let action;
    switch (verdict.classification) {
      case 'OUT_OF_OFFICE':
        action = 'ignored_auto_reply';
        break;
      case 'HARD_BOUNCE':
        await suppression.suppress({ email: from, reason: 'hard_bounce', source: 'inbound_bounce', organizationId: orgId, companyId }, client);
        action = 'suppressed_hard_bounce';
        break;
      case 'SOFT_BOUNCE':
        action = 'recorded_soft_bounce';
        break;
      case 'STOP_UNSUBSCRIBE':
        await suppression.suppress({ email: from, reason: 'stop_request', source: 'inbound_reply', organizationId: orgId, companyId }, client);
        await events.record('unsubscribed', { organizationId: orgId, companyId, meta: { via: 'reply' }, idempotencyKey: 'unsub-reply:' + ins.id }, client);
        action = 'suppressed_stop_request';
        break;
      default: {
        // A person wrote to us. Automation stops for the whole company and a person answers.
        await stopAll('human_reply');
        const legal = verdict.classification === 'LEGAL_RIGHTS';
        await tasks.open({ type: legal ? 'legal_escalation' : 'reply_received', organizationId: orgId, companyId, priority: legal ? 'high' : 'normal',
          summary: (legal ? 'Legal or rights concern: ' : 'Reply: ') + ((out && out.organization_name) || normalizeEmail(from || '') || 'unmatched sender'),
          payload: { message_id: ins.id, classification: verdict.classification, matched: !!out, subject: normalized.subject || null,
            suggested_reply_template: suggestedTemplate(verdict.classification), rule: 'Answer personally within one business day. Never from an automatic reply.' },
          dedupeKey: 'reply:' + ins.id }, client);
        await events.record('reply_received', { organizationId: orgId, companyId, messageId: ins.id, meta: { classification: verdict.classification } }, client);
        action = legal ? 'escalated_legal' : 'task_reply_received';
      }
    }
    await client.query(`UPDATE listing_outreach_messages SET action_taken = $2 WHERE id = $1`, [ins.id, action]);
    await auditService.logEvent(client, { eventType: 'claimed_listing.inbound_reply', entityType: 'organization', entityId: orgId, actorId: null,
      metadata: { classification: verdict.classification, action, matched: !!out, signature_status: meta.signatureStatus } });
    if (action === 'task_reply_received' || action === 'escalated_legal') notifyInfoInbox(out, action).catch(() => {});
    return { ok: true, duplicate: false, classification: verdict.classification, action };
  });
}

/** Rep reply template suggested in the task (a PERSON sends it). R1-R4 from the blueprint. */
function suggestedTemplate(classification) {
  return { YES_AFFIRMATIVE: 'R1', QUESTION: 'R2', WRONG_CONTACT: 'R3', DECLINE: 'R4' }[classification] || null;
}

/** Internal heads-up to info@advantage.bid (the Owner's inbox). No message body is forwarded. */
async function notifyInfoInbox(out, action) {
  const emailService = require('../emailService');
  const name = (out && out.organization_name) || 'an unmatched sender';
  await emailService.sendEmail({
    to: process.env.OUTREACH_BCC || 'info@advantage.bid',
    subject: 'Claimed Listing reply waiting: ' + name,
    text: 'A reply to Claimed Listing outreach from ' + name + ' is waiting in the Sales & Marketing Toolbox (Claimed Listings tab).'
      + (action === 'escalated_legal' ? ' It raises a legal or rights concern and is escalated to the Owner.' : '') + ' Please answer within one business day.',
    html: '<p>A reply to Claimed Listing outreach from <b>' + String(name).replace(/[<>&]/g, '') + '</b> is waiting in the Sales &amp; Marketing Toolbox (Claimed Listings tab).'
      + (action === 'escalated_legal' ? ' It raises a legal or rights concern and is escalated to the Owner.' : '') + ' Please answer within one business day.</p>',
  });
}

module.exports = { extractListingKey, inboundEnabled, ingest, suggestedTemplate };
