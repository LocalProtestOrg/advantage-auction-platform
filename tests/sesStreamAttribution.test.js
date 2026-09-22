'use strict';

/**
 * SES mail-stream attribution and safe event acknowledgement (migration 156).
 *
 * Three promises under test:
 *   1. Event Partner mail carries its OWN configuration set, so its telemetry is distinguishable.
 *   2. The configuration set survives parsing and reaches storage — previously it was discarded, which
 *      made tagging messages pointless.
 *   3. A valid SES event type we do not consume is ACKNOWLEDGED, not rejected, so widening the event
 *      types in SES can never make SNS disable the subscription (and cost us bounce/complaint data).
 *
 * And one guarantee that matters more than any of them: attribution is metadata. Suppression, bounce,
 * complaint and consent behaviour must be byte-for-byte unchanged, and must never branch on the stream.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ses-stream';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const parser = require('../src/lib/sesNotificationParser');

// ── Fixtures shaped exactly like real SES output ────────────────────────────────────────────────
const mailWithSet = (set) => ({
  messageId: 'ses-msg-1',
  tags: set ? { 'ses:configuration-set': [set], 'ses:source-ip': ['1.2.3.4'] } : { 'ses:source-ip': ['1.2.3.4'] },
});
const sns = (inner) => ({ Type: 'Notification', Message: JSON.stringify(inner) });
const bounce = (set, type) => sns({
  notificationType: 'Bounce',
  bounce: { bounceType: type || 'Permanent', bouncedRecipients: [{ emailAddress: 'hb@example.com' }] },
  mail: mailWithSet(set),
});
const complaint = (set) => sns({
  notificationType: 'Complaint',
  complaint: { complainedRecipients: [{ emailAddress: 'c@example.com' }] },
  mail: mailWithSet(set),
});
const delivery = (set) => sns({
  notificationType: 'Delivery',
  delivery: { recipients: ['ok@example.com'] },
  mail: mailWithSet(set),
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the configuration set survives parsing', () => {
  test('an Event Partner bounce carries its set and our stream name', () => {
    const [e] = parser.parse(bounce('advantage-bid-event-partner'));
    expect(e.configurationSet).toBe('advantage-bid-event-partner');
    expect(e.mailStream).toBe('event_partner');
    expect(e.email).toBe('hb@example.com');
    expect(e.sesMessageId).toBe('ses-msg-1');
    expect(e.providerEventId).toBe('ses-msg-1:hb@example.com');
  });

  test('a marketing event is attributed to the marketing stream', () => {
    expect(parser.parse(complaint('advantage-bid-marketing'))[0].mailStream).toBe('marketing');
    expect(parser.parse(delivery('advantage-bid-marketing'))[0].configurationSet).toBe('advantage-bid-marketing');
  });

  test('untagged mail is transactional, not attributed to a programme', () => {
    const [e] = parser.parse(delivery(null));
    expect(e.configurationSet).toBeNull();
    expect(e.mailStream).toBe('transactional');
  });

  test('an UNKNOWN configuration set is reported as null, never guessed into a stream', () => {
    const [e] = parser.parse(delivery('some-other-set'));
    expect(e.configurationSet).toBe('some-other-set');
    expect(e.mailStream).toBeNull();
  });

  test('the set is found in every shape SES uses for it', () => {
    expect(parser.configurationSetOf({ tags: { 'ses:configuration-set': ['a-set'] } })).toBe('a-set');
    expect(parser.configurationSetOf({ tags: { 'ses:configuration-set': 'a-set' } })).toBe('a-set');
    expect(parser.configurationSetOf({ configurationSet: 'a-set' })).toBe('a-set');
    expect(parser.configurationSetOf({ headers: [{ name: 'X-SES-CONFIGURATION-SET', value: 'a-set' }] })).toBe('a-set');
    expect(parser.configurationSetOf({ tags: {} })).toBeNull();
    expect(parser.configurationSetOf(null)).toBeNull();
  });

  test('multi-recipient events all carry the same attribution', () => {
    const evts = parser.parse(sns({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@x.com' }, { emailAddress: 'b@x.com' }] },
      mail: mailWithSet('advantage-bid-event-partner'),
    }));
    expect(evts).toHaveLength(2);
    evts.forEach((e) => expect(e.mailStream).toBe('event_partner'));
    // Per-recipient idempotency still holds.
    expect(new Set(evts.map((e) => e.providerEventId)).size).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('valid-but-unconsumed event types are acknowledged, not rejected', () => {
  test('we consume exactly three types', () => {
    expect(parser.CONSUMED_TYPES.slice().sort()).toEqual(['Bounce', 'Complaint', 'Delivery']);
  });

  test('the other seven SES types are known and acknowledgeable', () => {
    expect(parser.KNOWN_UNCONSUMED_TYPES.slice().sort())
      .toEqual(['Click', 'DeliveryDelay', 'Open', 'Reject', 'RenderingFailure', 'Send', 'Subscription']);
  });

  test.each(['Send', 'Reject', 'RenderingFailure', 'DeliveryDelay', 'Subscription', 'Open', 'Click'])(
    '%s is known but not consumed', (type) => {
      const c = parser.classify(sns({ eventType: type, mail: mailWithSet('advantage-bid-event-partner') }));
      expect(c.eventType).toBe(type);
      expect(c.known).toBe(true);
      expect(c.consumed).toBe(false);
      expect(c.mailStream).toBe('event_partner');
      // And it produces no ingestible event, so nothing is acted upon.
      expect(parser.parse(sns({ eventType: type, mail: mailWithSet('advantage-bid-event-partner') }))).toEqual([]);
    });

  test.each(['Bounce', 'Complaint', 'Delivery'])('%s is consumed', (type) => {
    const payload = { Bounce: bounce, Complaint: complaint, Delivery: delivery }[type]('advantage-bid-event-partner');
    const c = parser.classify(payload);
    expect(c.consumed).toBe(true);
    expect(c.known).toBe(true);
  });

  test('a genuinely unrecognizable payload is neither known nor consumed', () => {
    expect(parser.classify(sns({ eventType: 'Nonsense' })).known).toBe(false);
    expect(parser.classify({ hello: 'world' }).known).toBe(false);
    expect(parser.classify(null).known).toBe(false);
    expect(parser.classify({ Type: 'Notification', Message: 'not json' }).known).toBe(false);
  });

  test('the receiver returns 200 for a known type and 400 only for the unrecognizable', () => {
    const src = read('src', 'routes', 'sesFeedback.js');
    expect(src).toMatch(/const c = classify\(payload\);/);
    expect(src).toMatch(/if \(c\.known\) \{/);
    expect(src).toMatch(/acknowledged: c\.eventType, ingested: 0, consumed: false/);
    // The 400 survives for anything not recognised.
    expect(src).toMatch(/No recognizable SES events in payload/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the event_partner mail stream', () => {
  const emailService = require('../src/services/emailService');

  test('each stream maps to its own configuration set, and unknown streams get none', () => {
    const prevM = process.env.SES_MARKETING_CONFIGURATION_SET;
    const prevE = process.env.SES_EVENT_PARTNER_CONFIGURATION_SET;
    try {
      // configurationSetForStream reads module-level constants captured at require time, so assert the
      // MAPPING shape here and the env wiring by source below.
      expect(typeof emailService.configurationSetForStream).toBe('function');
      expect(emailService.configurationSetForStream('nope')).toBeNull();
      expect(emailService.configurationSetForStream(undefined)).toBeNull();
      expect(typeof emailService.eventPartnerConfigurationSet).toBe('function');
    } finally {
      process.env.SES_MARKETING_CONFIGURATION_SET = prevM;
      process.env.SES_EVENT_PARTNER_CONFIGURATION_SET = prevE;
    }
  });

  test('the stream reads its own env var, never the marketing one', () => {
    const src = read('src', 'services', 'emailService.js');
    expect(src).toMatch(/SES_EVENT_PARTNER_CONFIGURATION_SET = process\.env\.SES_EVENT_PARTNER_CONFIGURATION_SET \|\| null/);
    expect(src).toMatch(/if \(mailStream === 'event_partner'\) return SES_EVENT_PARTNER_CONFIGURATION_SET;/);
    // An unknown stream must not fall back to another programme's set.
    // Matched EOL-agnostically so a CRLF checkout cannot fail a test about email routing.
    expect(src.replace(/\r\n/g, '\n')).toMatch(/return null;\n\}/);
  });

  test('the header is stamped from the resolved set, for whichever stream resolves one', () => {
    const src = read('src', 'services', 'emailService.js');
    expect(src).toMatch(/configurationSet \? \{ 'X-SES-CONFIGURATION-SET': configurationSet \} : \{\}/);
  });

  test('Event Partner shares the marketing POOL so it can never starve transactional mail', () => {
    const src = read('src', 'services', 'emailService.js');
    expect(src).toMatch(/const usesMarketingPool = isMarketing \|\| isEventPartner;/);
  });

  test('nothing in this change enables sending', () => {
    const src = read('src', 'services', 'emailService.js');
    // sendEmail is still the single transport; no new auto-send path was introduced.
    expect(src).not.toMatch(/setInterval|cron|autoSend/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('protections are unchanged — attribution is metadata only', () => {
  const svc = read('src', 'services', 'sesFeedbackService.js');

  test('the suppression decisions do not branch on the stream', () => {
    // Isolate the decision block and prove the stream is absent from it.
    const decisions = svc.slice(svc.indexOf("let action = 'recorded';"), svc.indexOf('return { ok: true, action'));
    expect(decisions.length).toBeGreaterThan(200);
    expect(decisions).toMatch(/isHard/);
    expect(decisions).toMatch(/complaint/);
    expect(decisions).toMatch(/soft_bounce_suppress_threshold/);
    expect(decisions).not.toMatch(/mailStream|configurationSet|configuration_set|mail_stream/);
  });

  test('hard bounce and complaint still suppress terminally, for marketing scope', () => {
    expect(svc).toMatch(/suppressMarketing\(client, normalized, 'hard_bounce'/);
    expect(svc).toMatch(/suppressMarketing\(client, normalized, 'complaint'/);
    const helper = svc.slice(svc.indexOf('async function suppressMarketing'), svc.indexOf('async function setDeliverability'));
    expect(helper).toMatch(/scope/);                 // the suppression is scoped
    expect(helper).toMatch(/'marketing'/);           // ...to marketing, exactly as before
    expect(helper).toMatch(/ON CONFLICT \(normalized_email\) DO UPDATE/);   // still idempotent
  });

  test('soft bounces still accumulate to the configured threshold', () => {
    expect(svc).toMatch(/count >= threshold/);
    expect(svc).toMatch(/'soft_bounce_threshold'/);
  });

  test('idempotency on provider_event_id is preserved', () => {
    expect(svc).toMatch(/SELECT 1 FROM ses_feedback_events WHERE provider_event_id = \$1/);
    expect(svc).toMatch(/ON CONFLICT \(provider_event_id\) DO NOTHING/);
  });

  test('the new columns are written but never read by a decision', () => {
    expect(svc).toMatch(/configuration_set, mail_stream, ses_message_id/);
    const decisions = svc.slice(svc.indexOf("let action = 'recorded';"), svc.indexOf('return { ok: true, action'));
    expect(decisions).not.toMatch(/configuration_set/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('migration 156', () => {
  const m = read('db', 'migrations', '156_ses_stream_attribution.sql');

  test('it is additive only', () => {
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS configuration_set text/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS mail_stream text/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS ses_message_id text/);
    expect(m).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(m).not.toMatch(/DELETE\s+FROM/i);
    expect(m).not.toMatch(/UPDATE\s+email_suppressions/i);
    expect(m).not.toMatch(/UPDATE\s+email_deliverability/i);
  });

  test('the stream vocabulary is closed so a typo cannot invent a reporting bucket', () => {
    expect(m).toMatch(/chk_ses_feedback_mail_stream/);
    expect(m).toMatch(/'transactional','marketing','event_partner'/);
  });

  test('the configuration set names are recorded and match the parser mapping', () => {
    expect(m).toMatch(/'"advantage-bid-event-partner"'/);
    expect(m).toMatch(/'"advantage-bid-marketing"'/);
    expect(Object.keys(parser.STREAM_BY_CONFIGURATION_SET).sort())
      .toEqual(['advantage-bid-event-partner', 'advantage-bid-marketing']);
    expect(parser.STREAM_BY_CONFIGURATION_SET['advantage-bid-event-partner']).toBe('event_partner');
  });

  test('it enables no gate and grants no capability', () => {
    expect(m).not.toMatch(/outreach_enabled|a15_|marketing_agents|'true'/);
  });
});
