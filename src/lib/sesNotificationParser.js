'use strict';

/**
 * sesNotificationParser — turn an inbound SES-feedback payload into a flat list of normalized events
 * that sesFeedbackService.ingestEvent() understands. Pure (no I/O). Handles three shapes:
 *
 *   1. SNS envelope (Type: 'Notification') whose .Message is a JSON string carrying the SES event.
 *   2. A raw SES event object ({ notificationType | eventType, bounce/complaint/delivery, mail }).
 *   3. A simplified direct shape ({ eventType, email, bounceSubtype, providerEventId }) — used by our
 *      own tooling and tests.
 *
 * Each emitted event: { eventType, bounceSubtype, email, providerEventId, raw }.
 * providerEventId is derived as `${messageId}:${recipient}` so per-recipient idempotency holds even when
 * one SES message names several recipients.
 */

function pushRecipients(out, list, base, mail) {
  const messageId = (mail && (mail.messageId || mail.commonHeaders && mail.commonHeaders.messageId)) || base.messageId || null;
  (list || []).forEach((r) => {
    const email = typeof r === 'string' ? r : (r.emailAddress || r.email);
    if (!email) return;
    out.push({
      eventType: base.eventType,
      bounceSubtype: base.bounceSubtype || (r.diagnosticCode ? 'Permanent' : base.bounceSubtype),
      email,
      providerEventId: messageId ? `${messageId}:${String(email).toLowerCase()}` : null,
      raw: { base, recipient: r },
    });
  });
}

function parseSesEvent(evt, out) {
  const type = evt.notificationType || evt.eventType;
  const mail = evt.mail || null;
  if (type === 'Bounce' && evt.bounce) {
    const subtype = evt.bounce.bounceType === 'Transient' ? 'Transient'
      : (evt.bounce.bounceType === 'Permanent' ? 'Permanent' : (evt.bounce.bounceSubType || 'Permanent'));
    pushRecipients(out, evt.bounce.bouncedRecipients, { eventType: 'Bounce', bounceSubtype: subtype }, mail);
  } else if (type === 'Complaint' && evt.complaint) {
    pushRecipients(out, evt.complaint.complainedRecipients, { eventType: 'Complaint' }, mail);
  } else if (type === 'Delivery' && evt.delivery) {
    pushRecipients(out, evt.delivery.recipients, { eventType: 'Delivery' }, mail);
  } else if (evt.eventType && evt.email) {
    // Simplified direct shape.
    out.push({
      eventType: evt.eventType, bounceSubtype: evt.bounceSubtype || null,
      email: evt.email, providerEventId: evt.providerEventId || null, raw: evt,
    });
  }
}

function parse(payload) {
  const out = [];
  if (!payload || typeof payload !== 'object') return out;
  // SNS envelope.
  if (payload.Type === 'Notification' && typeof payload.Message === 'string') {
    let inner;
    try { inner = JSON.parse(payload.Message); } catch (_) { return out; }
    parseSesEvent(inner, out);
    return out;
  }
  parseSesEvent(payload, out);
  return out;
}

// SNS control messages we deliberately do NOT auto-act on (no external activation from this app).
function isSnsControl(payload) {
  return !!(payload && (payload.Type === 'SubscriptionConfirmation' || payload.Type === 'UnsubscribeConfirmation'));
}

module.exports = { parse, isSnsControl };
