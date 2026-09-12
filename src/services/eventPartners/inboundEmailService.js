'use strict';

/**
 * inboundEmailService — turns a verified provider callback into a threaded, classified, evidenced
 * message, and performs ONLY the safe automated actions.
 *
 * The safety boundary, restated because this is where it is actually enforced: every action this
 * service performs either stops something, ignores something, records something, or hands a company a
 * link. Not one of them grants, broadens or re-scopes permission. `authorizationService.authorizeWithToken`
 * is never called from here and cannot be — an affirmative reply produces a PROPOSAL to send the
 * deterministic link, and in Phase 2A even that proposal is not sent, because sending is not enabled.
 *
 * Order of operations is deliberate:
 *   1. Verify the callback (caller does this; we refuse to ingest an unverified payload).
 *   2. Record the delivery, digest-keyed, so a replay is visible and idempotent.
 *   3. Resolve the thread from the reply key — never by guessing at company identity.
 *   4. Append the message idempotently on the provider's message id.
 *   5. Classify: deterministic signals first, heuristics second.
 *   6. Apply the safe action for that classification, and escalate whenever a human is required.
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const configService = require('../configService');
const { normalizeEmail } = require('../../lib/emailNormalize');
const tokens = require('./tokens');
const threads = require('./threadService');
const classifier = require('./replyClassifier');
const suppression = require('./partnerSuppressionService');
const escalations = require('./escalationService');
const authorization = require('./authorizationService');

function err(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e;
}

/** Normalize a Postmark inbound payload into the shape the classifier and thread store expect. */
function fromPostmark(payload) {
  payload = payload || {};
  const headers = {};
  (payload.Headers || []).forEach((h) => { if (h && h.Name) headers[h.Name] = h.Value; });
  const firstTo = (payload.ToFull && payload.ToFull[0]) || null;
  return {
    provider: 'postmark',
    providerMessageId: payload.MessageID || null,
    messageIdHeader: headers['Message-ID'] || headers['Message-Id'] || null,
    inReplyTo: headers['In-Reply-To'] || null,
    references: headers.References || null,
    mailboxHash: payload.MailboxHash || (firstTo && firstTo.MailboxHash) || null,
    to: (payload.ToFull || []).map((t) => t && t.Email).filter(Boolean),
    fromEmail: (payload.FromFull && payload.FromFull.Email) || payload.From || null,
    fromName: (payload.FromFull && payload.FromFull.Name) || null,
    toEmail: (firstTo && firstTo.Email) || payload.To || null,
    subject: payload.Subject || null,
    textBody: payload.TextBody || payload.StrippedTextReply || null,
    htmlBody: payload.HtmlBody || null,
    headers,
    spamScore: payload.SpamScore != null ? Number(payload.SpamScore) : null,
    bounceType: payload.Type || null,
  };
}

/** Record the callback itself. Digest-keyed, so a replayed payload is detected before any work. */
async function recordDelivery(client, input) {
  try {
    const { rows } = await client.query(
      `INSERT INTO event_partner_webhook_deliveries
         (provider, event_kind, payload_sha256, signature_status, outcome, remote_ip_hash, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (provider, payload_sha256) DO NOTHING
       RETURNING id`,
      [input.provider, input.eventKind || null, input.digest, input.signatureStatus,
       input.outcome, input.remoteIpHash || null, JSON.stringify(input.detail || {})]);
    return rows[0] ? { id: rows[0].id, replay: false } : { id: null, replay: true };
  } catch (e) {
    return { id: null, replay: false, error: e.message };
  }
}

/** Attach the message id to its delivery row once we have one (evidence links both ways). */
async function linkDelivery(client, provider, digest, messageId, outcome) {
  await client.query(
    `UPDATE event_partner_webhook_deliveries
        SET message_id = COALESCE($3, message_id), outcome = $4
      WHERE provider = $1 AND payload_sha256 = $2`,
    [provider, digest, messageId || null, outcome]).catch(() => {});
}

/**
 * The safe-action dispatcher. Everything here is a stop, an ignore, a record, or a link proposal.
 *
 * Returns a description of what was done, which is stored on the message as `action_taken` so the
 * audit trail says not merely what the reply was but what we did about it.
 */
async function applySafeAction(client, ctx) {
  const { verdict, thread, message, fromEmail } = ctx;
  const orgId = thread.organization_id || null;
  const authId = thread.authorization_id || null;
  const escalate = async (reasonCode, severity, summary) => {
    await escalations.open({
      threadId: thread.id, messageId: message.id, authorizationId: authId,
      reasonCode, severity: severity || 'normal', summary,
    }, client);
    await threads.setStatus(thread.id, 'awaiting_human', client);
  };

  switch (verdict.classification) {
    case 'HARD_BOUNCE':
      // Terminal deliverability. Suppress so no further outreach is attempted to a dead address.
      await suppression.suppress({
        email: fromEmail || thread.company_email, reason: 'hard_bounce',
        source: 'inbound_bounce', organizationId: orgId, messageId: message.id,
      }, client);
      return 'suppressed_hard_bounce';

    case 'SOFT_BOUNCE':
      // Transient. Recorded, never suppressed on a single failure.
      return 'recorded_soft_bounce';

    case 'OUT_OF_OFFICE':
      // Explicitly a non-event: no state change, no timer reset, no engagement recorded.
      return 'ignored_auto_reply';

    case 'STOP_UNSUBSCRIBE':
      // Stops OUTREACH only. Does not revoke an authorized source and does not touch consumer
      // marketing consent — six separate records, never coupled.
      await suppression.suppress({
        email: fromEmail || thread.company_email, reason: 'stop_request',
        source: 'inbound_reply', organizationId: orgId, messageId: message.id,
      }, client);
      await threads.setStatus(thread.id, 'closed', client);
      return 'suppressed_stop_request';

    case 'DECLINE': {
      // Moves the company to a terminal 'declined' state — safe, because it only ever does less.
      await suppression.suppress({
        email: fromEmail || thread.company_email, reason: 'decline',
        source: 'inbound_reply', organizationId: orgId, messageId: message.id,
      }, client);
      if (authId) {
        const row = (await client.query(
          'SELECT id, status FROM authorized_event_sources WHERE id = $1 FOR UPDATE', [authId])).rows[0];
        if (row && authorization.canTransition(row.status, 'declined')) {
          await authorization.transition(client, row, 'declined', null, { via: 'inbound_reply', message_id: message.id });
        }
      }
      await threads.setStatus(thread.id, 'closed', client);
      return 'recorded_decline';
    }

    case 'ALREADY_AUTHORIZED':
      await threads.setStatus(thread.id, 'closed', client);
      return 'confirmed_already_authorized';

    case 'YES_AFFIRMATIVE': {
      // THE critical branch. An affirmative reply becomes a PROPOSAL to send the deterministic
      // single-use authorization link. It does not authorize, and in Phase 2A it does not even send:
      // sending requires the double lock plus an approved template, none of which is enabled.
      if (authId) {
        await client.query(
          `INSERT INTO event_partner_outreach_proposals
             (authorization_id, thread_id, kind, recipient_email, subject, body_text, status, proposed_by)
           VALUES ($1,$2,'authorization_resend',$3,$4,$5,'proposed','A15')`,
          [authId, thread.id, fromEmail || thread.company_email,
           'Your free event promotion — one click to confirm',
           'Thanks! Please click the secure link to confirm your free event-promotion authorization.']);
      }
      await threads.setStatus(thread.id, 'awaiting_company', client);
      // Flagged for a human when the reply also asked something.
      if (verdict.requiresHuman) await escalate('affirmative_with_question', 'low', 'Interested, and asked a question');
      return 'proposed_authorization_resend';
    }

    case 'CORRECTED_WEBSITE':
      // Changing the authorized domain re-scopes permission. Always a human decision, and an already
      // authorized company must re-authorize rather than have its scope edited underneath it.
      await escalate('corrected_website', 'high',
        'Company supplied a different website: ' + ((verdict.extracted && verdict.extracted.urls) || []).join(', '));
      return 'escalated_domain_change_proposal';

    case 'WRONG_CONTACT':
      // Stop mailing this person; do not read it as interest or refusal by the company.
      await suppression.suppress({
        email: fromEmail || thread.company_email, reason: 'wrong_contact',
        source: 'inbound_reply', organizationId: orgId, messageId: message.id,
      }, client);
      await escalate('wrong_contact', 'normal', 'Recipient is not the right contact');
      return 'suppressed_wrong_contact';

    case 'LEGAL_RIGHTS':
      await escalate('legal_rights', 'high', 'Legal or rights concern raised');
      return 'escalated_legal';

    case 'QUESTION': {
      const draftAllowed = (await configService.get(null, 'event_partners.a15_draft_reply_enabled')) === true;
      await escalate('question', 'normal', draftAllowed ? 'Question — draft available for review' : 'Question — needs an answer');
      return draftAllowed ? 'escalated_question_draft_allowed' : 'escalated_question';
    }

    default:
      await escalate('unclassified', 'normal', 'Reply could not be classified');
      return 'escalated_unknown';
  }
}

/**
 * ingest(normalized, meta) — the one entry point.
 *
 * @param {object} normalized  a provider payload already shaped by fromPostmark()
 * @param {object} meta        { digest, signatureStatus, remoteIp, provider, rawForEvidence }
 */
async function ingest(normalized, meta) {
  normalized = normalized || {}; meta = meta || {};
  if (!meta.digest) throw err(400, 'NO_DIGEST', 'A payload digest is required.');
  // Unverified payloads never reach the conversation store. 'verify_unavailable' is deliberately NOT
  // accepted here (migration 155): an inbound reply drives suppression and decline, which are
  // recipient-affecting state, so an unauthenticated callback is quarantined by the caller instead.
  if (['verified', 'unsigned_accepted'].indexOf(meta.signatureStatus) === -1) {
    throw err(403, 'UNVERIFIED_CALLBACK', 'Callback was not verified.');
  }
  const enabled = await configService.get(null, 'event_partners.inbound_enabled');
  if (enabled !== true) throw err(404, 'INBOUND_DISABLED', 'Inbound processing is disabled.');

  const remoteIpHash = tokens.hashIp(meta.remoteIp);
  const provider = normalized.provider || meta.provider || 'postmark';

  return withTransaction(async (client) => {
    const delivery = await recordDelivery(client, {
      provider, digest: meta.digest, signatureStatus: meta.signatureStatus,
      outcome: 'accepted', remoteIpHash,
      eventKind: 'inbound_email',
      detail: { subject: normalized.subject || null, has_hash: !!normalized.mailboxHash },
    });
    if (delivery.replay) {
      // The exact same payload has already been processed. Replay protection independent of the
      // provider's own message id.
      return { ok: true, duplicate: true, reason: 'payload_replay' };
    }

    // Resolve the conversation. Reply key first (authoritative), then the sender address, then an
    // orphan thread so evidence is never thrown away.
    const replyKey = threads.extractReplyKey(normalized);
    let thread = replyKey ? await threads.getByReplyKey(replyKey, client) : null;
    let association = replyKey && thread ? 'reply_key' : null;
    if (!thread) {
      thread = await threads.findByParticipant(normalized.fromEmail, client);
      if (thread) association = 'sender_address';
    }
    if (!thread) {
      thread = await threads.createOrphanThread(normalized.fromEmail, normalized.subject, client);
      association = 'orphan';
    }

    // Classify BEFORE storing, so the stored row carries its verdict and the action it produced.
    const verdict = classifier.classify(normalized, {
      authorizationStatus: thread.authorization_status || null,
      authorizedDomain: thread.authorized_domain || null,
    });

    const classifyByAgent = (await configService.get(null, 'event_partners.a15_classify_enabled')) === true;
    const appended = await threads.appendMessage({
      threadId: thread.id, direction: 'inbound', provider,
      providerMessageId: normalized.providerMessageId,
      messageIdHeader: normalized.messageIdHeader, inReplyTo: normalized.inReplyTo,
      fromEmail: normalized.fromEmail, fromName: normalized.fromName,
      toEmail: normalized.toEmail, subject: normalized.subject,
      textBody: normalized.textBody, htmlBody: normalized.htmlBody,
      headers: normalized.headers, spamScore: normalized.spamScore,
      classification: verdict.classification,
      classificationSource: verdict.source,
      classificationConfidence: verdict.confidence,
      classificationSignals: { signals: verdict.signals, association, extracted: verdict.extracted },
      // A15 is credited only where the Owner gate allows it to classify; deterministic verdicts are
      // the system's own and are attributed to the rule engine regardless.
      classifiedBy: verdict.source === 'deterministic' ? 'deterministic' : (classifyByAgent ? 'A15' : 'deterministic'),
      rawEvidenceSha256: meta.digest,
    }, client);

    if (appended.duplicate) {
      await linkDelivery(client, provider, meta.digest, appended.message.id, 'duplicate');
      return { ok: true, duplicate: true, reason: 'provider_message_replay', messageId: appended.message.id };
    }

    const actionTaken = await applySafeAction(client, {
      verdict, thread, message: appended.message, fromEmail: normalized.fromEmail,
    });
    await client.query('UPDATE event_partner_messages SET action_taken = $2 WHERE id = $1',
      [appended.message.id, actionTaken]);
    await linkDelivery(client, provider, meta.digest, appended.message.id, 'accepted');

    await auditService.logEvent(client, {
      eventType: 'event_partner.inbound_reply', entityType: 'event_partner_thread', entityId: thread.id,
      actorId: null,
      metadata: {
        classification: verdict.classification, source: verdict.source, confidence: verdict.confidence,
        action_taken: actionTaken, association, signature_status: meta.signatureStatus,
        authorization_id: thread.authorization_id || null, message_id: appended.message.id,
      },
    });

    return {
      ok: true, duplicate: false, threadId: thread.id, messageId: appended.message.id,
      classification: verdict.classification, action: actionTaken, association,
      requiresHuman: verdict.requiresHuman,
    };
  });
}

/** Record a rejected callback so a forgery attempt is visible rather than silently dropped. */
async function recordRejection(meta) {
  try {
    await db.query(
      `INSERT INTO event_partner_webhook_deliveries
         (provider, event_kind, payload_sha256, signature_status, outcome, remote_ip_hash, detail)
       VALUES ($1,$2,$3,$4,'rejected',$5,$6::jsonb)
       ON CONFLICT (provider, payload_sha256) DO NOTHING`,
      [meta.provider || 'unknown', meta.eventKind || 'inbound_email', meta.digest,
       meta.signatureStatus, tokens.hashIp(meta.remoteIp), JSON.stringify({ reason: meta.reason || null })]);
  } catch (e) { /* evidence is best-effort; the rejection itself already happened */ }
}

module.exports = { ingest, fromPostmark, recordRejection, applySafeAction, recordDelivery };
