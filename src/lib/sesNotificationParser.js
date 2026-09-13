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
 * Each emitted event: { eventType, bounceSubtype, email, providerEventId, configurationSet,
 *                       mailStream, sesMessageId, raw }.
 * providerEventId is derived as `${messageId}:${recipient}` so per-recipient idempotency holds even when
 * one SES message names several recipients.
 *
 * TWO ADDITIONS (migration 156):
 *
 *   Stream attribution. SES stamps every published event with the configuration set that produced it,
 *   at mail.tags['ses:configuration-set']. This parser used to discard it, which meant an Event Partner
 *   Delivery was indistinguishable from a marketing Delivery. It is now carried through to storage.
 *   Attribution is metadata ONLY — it never participates in a suppression, bounce or complaint decision.
 *
 *   Known-but-unconsumed types. SES can publish ten event types; we act on three. The remaining seven
 *   are real, valid SES events that we deliberately do not consume. classify() lets the receiver
 *   ACKNOWLEDGE them with a 200 instead of rejecting them, because a 400 makes SNS retry and, after
 *   sustained failure, disable the subscription — which would also cost us the bounce and complaint
 *   data we depend on. Rejecting genuinely unrecognizable payloads is unchanged.
 */

// The three we act on. Widening this set is a deliberate product decision, not a configuration change.
const CONSUMED_TYPES = Object.freeze(['Bounce', 'Complaint', 'Delivery']);

// Valid SES event types we knowingly do not consume. Acknowledged, never acted upon.
const KNOWN_UNCONSUMED_TYPES = Object.freeze([
  'Send', 'Reject', 'RenderingFailure', 'DeliveryDelay', 'Subscription', 'Open', 'Click',
]);

// Configuration set -> our own stream name. Kept here so one mapping serves parsing and reporting.
const STREAM_BY_CONFIGURATION_SET = Object.freeze({
  'advantage-bid-event-partner': 'event_partner',
  'advantage-bid-marketing': 'marketing',
});

/** The configuration set SES stamped on the message, or null for untagged transactional mail. */
function configurationSetOf(mail) {
  if (!mail) return null;
  // Preferred: the tag SES always adds when a configuration set is used.
  const tags = mail.tags || {};
  const tagged = tags['ses:configuration-set'];
  if (Array.isArray(tagged) && tagged.length) return String(tagged[0]);
  if (typeof tagged === 'string' && tagged) return tagged;
  // Some shapes carry it at the top level of the mail object instead.
  if (typeof mail.configurationSet === 'string' && mail.configurationSet) return mail.configurationSet;
  // Last resort: the header we set ourselves on the way out.
  const headers = Array.isArray(mail.headers) ? mail.headers : [];
  const hdr = headers.find((h) => h && String(h.name || '').toLowerCase() === 'x-ses-configuration-set');
  return hdr && hdr.value ? String(hdr.value) : null;
}

/** Our own stream name for a configuration set. Unknown sets are reported as null, never guessed. */
function streamFor(configurationSet) {
  if (!configurationSet) return 'transactional';
  return STREAM_BY_CONFIGURATION_SET[configurationSet] || null;
}

function pushRecipients(out, list, base, mail) {
  const messageId = (mail && (mail.messageId || mail.commonHeaders && mail.commonHeaders.messageId)) || base.messageId || null;
  const configurationSet = configurationSetOf(mail);
  const mailStream = streamFor(configurationSet);
  (list || []).forEach((r) => {
    const email = typeof r === 'string' ? r : (r.emailAddress || r.email);
    if (!email) return;
    out.push({
      eventType: base.eventType,
      bounceSubtype: base.bounceSubtype || (r.diagnosticCode ? 'Permanent' : base.bounceSubtype),
      email,
      providerEventId: messageId ? `${messageId}:${String(email).toLowerCase()}` : null,
      sesMessageId: messageId,
      configurationSet,
      mailStream,
      raw: { base, recipient: r, configurationSet },
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
    // Simplified direct shape (our own tooling and tests).
    out.push({
      eventType: evt.eventType, bounceSubtype: evt.bounceSubtype || null,
      email: evt.email, providerEventId: evt.providerEventId || null,
      sesMessageId: evt.sesMessageId || null,
      configurationSet: evt.configurationSet || null,
      mailStream: evt.configurationSet ? streamFor(evt.configurationSet) : null,
      raw: evt,
    });
  }
}

/** Unwrap an SNS envelope to the SES event inside it, or return the payload unchanged. */
function innerEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.Type === 'Notification' && typeof payload.Message === 'string') {
    try { return JSON.parse(payload.Message); } catch (_) { return null; }
  }
  return payload;
}

function parse(payload) {
  const out = [];
  const inner = innerEvent(payload);
  if (!inner) return out;
  parseSesEvent(inner, out);
  return out;
}

/**
 * classify(payload) — what IS this callback, and may the receiver safely acknowledge it?
 *
 * Returns { eventType, configurationSet, mailStream, consumed, known }.
 *   consumed  — we act on it (Bounce / Complaint / Delivery)
 *   known     — a valid SES event type, whether or not we act on it
 *
 * A payload that is neither consumed nor known is genuinely unrecognizable and the receiver still
 * rejects it, so a malformed or foreign payload is never silently accepted.
 */
function classify(payload) {
  const inner = innerEvent(payload);
  if (!inner || typeof inner !== 'object') {
    return { eventType: null, configurationSet: null, mailStream: null, consumed: false, known: false };
  }
  const eventType = inner.notificationType || inner.eventType || null;
  const configurationSet = configurationSetOf(inner.mail || null);
  return {
    eventType,
    configurationSet,
    mailStream: streamFor(configurationSet),
    consumed: CONSUMED_TYPES.indexOf(eventType) !== -1,
    known: CONSUMED_TYPES.indexOf(eventType) !== -1 || KNOWN_UNCONSUMED_TYPES.indexOf(eventType) !== -1,
  };
}

// SNS control messages we deliberately do NOT auto-act on (no external activation from this app).
function isSnsControl(payload) {
  return !!(payload && (payload.Type === 'SubscriptionConfirmation' || payload.Type === 'UnsubscribeConfirmation'));
}

module.exports = {
  parse, isSnsControl, classify,
  configurationSetOf, streamFor, innerEvent,
  CONSUMED_TYPES, KNOWN_UNCONSUMED_TYPES, STREAM_BY_CONFIGURATION_SET,
};
