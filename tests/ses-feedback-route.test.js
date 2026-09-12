'use strict';

/**
 * SES feedback webhook route (/api/ses/feedback) — minimal SNS SubscriptionConfirmation support.
 *
 * Certifies: an AUTHENTICATED, genuine SNS SubscriptionConfirmation surfaces its one-time SubscribeURL to the
 * operator log ONLY (never the HTTP response, never the DB, never auto-visited); unauthenticated requests are
 * rejected; the webhook secret never leaks; and ordinary SNS Notification (bounce/complaint/delivery) behavior
 * is unchanged. No Express/supertest/DB — the real handler is pulled from the mounted router.
 */

const SECRET = 'test-ses-secret-value-do-not-log-abc123';
process.env.SES_FEEDBACK_WEBHOOK_SECRET = SECRET;

// Ingestion is stubbed so this suite is pure route behavior (no DB).
jest.mock('../src/services/sesFeedbackService', () => ({
  ingestEvent: jest.fn(async (evt) => ({ ok: true, action: 'recorded', email: evt.email })),
}));
// SNS signature verification is exercised separately (see the signature contract block at the bottom
// and tests/eventPartners/eventPartnerCommunications2a.test.js). These fixtures are synthetic SNS
// payloads with no real signature, so the verifier is stubbed to 'verified' here — this suite is about
// SubscribeURL handling, authentication and ingestion.
jest.mock('../src/lib/webhookSignature', () => ({
  verifySns: jest.fn(async () => ({ ok: true, status: 'verified', reason: 'stubbed' })),
  verifyPostmark: jest.fn(() => ({ ok: true, status: 'verified' })),
  payloadDigest: jest.fn(() => 'digest'),
}));
// platform_config is not available in this pure-route suite.
jest.mock('../src/services/configService', () => ({ get: jest.fn(async () => true) }));
// The quarantine store is exercised in tests/eventPartners/webhookVerificationQuarantine.test.js;
// here it is stubbed so the ROUTE contract can be asserted without a database.
jest.mock('../src/services/webhookQuarantineService', () => ({
  quarantine: jest.fn(async () => ({ quarantined: true, id: 'qr-1', duplicate: false })),
}));
const quarantine = require('../src/services/webhookQuarantineService');
const webhookSignature = require('../src/lib/webhookSignature');
const sesFeedback = require('../src/services/sesFeedbackService');
const router = require('../src/routes/sesFeedback');

function getHandler(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods && l.route.methods[method]);
  if (!layer) throw new Error('route not found: ' + method + ' ' + path);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const handler = getHandler('post', '/feedback');

function call({ token, header, body } = {}) {
  const req = {
    query: token ? { token } : {},
    get(name) { return header && name.toLowerCase() === 'x-webhook-secret' ? header : undefined; },
    body,
  };
  const res = {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(b) { this._body = b; return this; },
  };
  return Promise.resolve(handler(req, res, () => {})).then(() => res);
}

const SUBSCRIBE_URL = 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:us-east-1:111:advantage-bid-feedback&Token=SECRET_ONE_TIME_TOKEN_XYZ';
const subConfirmation = () => ({ Signature: 'c3R1Yg==', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/x.pem', Type: 'SubscriptionConfirmation', TopicArn: 'arn:aws:sns:us-east-1:111:advantage-bid-feedback', MessageId: 'mid-1', Timestamp: '2026-09-08T00:00:00Z', SubscribeURL: SUBSCRIBE_URL, Token: 'SECRET_ONE_TIME_TOKEN_XYZ' });
const notification = () => ({ Signature: 'c3R1Yg==', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/x.pem', Type: 'Notification', Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'hb@example.com' }] }, mail: { messageId: 'm-1' } }) });

let logs;
beforeEach(() => {
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  jest.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.join(' ')));
  sesFeedback.ingestEvent.mockClear();
  webhookSignature.verifySns.mockImplementation(async () => ({ ok: true, status: 'verified', reason: 'stubbed' }));
});
afterEach(() => jest.restoreAllMocks());

describe('SES feedback route — SubscriptionConfirmation support', () => {
  test('authenticated SubscriptionConfirmation surfaces the SubscribeURL to the operator log ONLY (not auto-confirmed)', async () => {
    const res = await call({ token: SECRET, body: JSON.stringify(subConfirmation()) });
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, acknowledged: 'SubscriptionConfirmation', auto_confirmed: false, subscribe_url_logged: true });
    // NEVER returned in the HTTP response body.
    expect(JSON.stringify(res._body)).not.toContain('amazonaws.com');
    expect(JSON.stringify(res._body)).not.toContain('Token');
    // Present in the operator log exactly for the Owner to visit once.
    expect(logs.join('\n')).toContain(SUBSCRIBE_URL);
    // No DB ingestion for a control message.
    expect(sesFeedback.ingestEvent).not.toHaveBeenCalled();
  });

  test('unauthenticated SubscriptionConfirmation is rejected (401) and logs NOTHING', async () => {
    const res = await call({ token: 'wrong-token', body: JSON.stringify(subConfirmation()) });
    expect(res._status).toBe(401);
    expect(logs.join('\n')).not.toContain('amazonaws.com');
    expect(logs.join('\n')).not.toContain('SubscribeURL');
  });

  test('SubscriptionConfirmation with a non-AWS SubscribeURL is NOT logged (host validated)', async () => {
    const forged = { ...subConfirmation(), SubscribeURL: 'https://evil.example.com/confirm?Token=x' };
    const res = await call({ token: SECRET, body: JSON.stringify(forged) });
    expect(res._status).toBe(200);
    expect(res._body.subscribe_url_logged).toBeUndefined();      // fell through to the plain control-ack path
    expect(logs.join('\n')).not.toContain('evil.example.com');
  });

  test('the webhook secret NEVER appears in logs or response', async () => {
    const res = await call({ token: SECRET, body: JSON.stringify(subConfirmation()) });
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(res._body)).not.toContain(SECRET);
  });

  test('ordinary SNS Notification (bounce) still ingests unchanged', async () => {
    const res = await call({ token: SECRET, body: JSON.stringify(notification()) });
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(res._body.ingested).toBe(1);
    expect(sesFeedback.ingestEvent).toHaveBeenCalledTimes(1);
    expect(sesFeedback.ingestEvent.mock.calls[0][0].email).toBe('hb@example.com');
  });

  test('unauthenticated ordinary Notification is rejected and never ingests', async () => {
    const res = await call({ token: 'nope', body: JSON.stringify(notification()) });
    expect(res._status).toBe(401);
    expect(sesFeedback.ingestEvent).not.toHaveBeenCalled();
  });

  test('header-based auth (x-webhook-secret) also works for confirmation', async () => {
    const res = await call({ header: SECRET, body: JSON.stringify(subConfirmation()) });
    expect(res._status).toBe(200);
    expect(res._body.subscribe_url_logged).toBe(true);
  });

  test('UnsubscribeConfirmation is acknowledged but never logs a SubscribeURL', async () => {
    const res = await call({ token: SECRET, body: JSON.stringify({ Signature: 'c3R1Yg==', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/x.pem', Type: 'UnsubscribeConfirmation', SubscribeURL: SUBSCRIBE_URL }) });
    expect(res._status).toBe(200);
    expect(res._body.auto_confirmed).toBe(false);
    expect(res._body.subscribe_url_logged).toBeUndefined();
  });
});

describe('SES feedback route — SNS signature contract (migration 154)', () => {
  test('a forged signature is refused, and ingestion never runs', async () => {
    webhookSignature.verifySns.mockImplementation(async () => ({
      ok: false, status: 'rejected_signature', reason: 'RSA-SHA1 signature mismatch',
    }));
    const res = await call({ token: SECRET, body: JSON.stringify(notification()) });
    expect(res._status).toBe(403);
    expect(sesFeedback.ingestEvent).not.toHaveBeenCalled();
  });

  test('an SNS-shaped payload with no Signature at all is refused', async () => {
    const unsigned = { Type: 'Notification', Message: JSON.stringify({ notificationType: 'Bounce' }) };
    const res = await call({ token: SECRET, body: JSON.stringify(unsigned) });
    expect(res._status).toBe(403);
    expect(sesFeedback.ingestEvent).not.toHaveBeenCalled();
  });

  test('an unreachable signing certificate QUARANTINES the callback and applies nothing', async () => {
    // Migration 155 replaced the earlier fail-open behaviour: an unverified callback must never apply
    // suppression, complaint, bounce, deliverability or consent state. It is held, retried, and
    // processed exactly once only after authenticity has been established.
    webhookSignature.verifySns.mockImplementation(async () => ({
      ok: false, status: 'verify_unavailable', reason: 'certificate unavailable: network down',
    }));
    quarantine.quarantine.mockClear();
    const res = await call({ token: SECRET, body: JSON.stringify(notification()) });

    expect(res._status).toBe(202);                            // acknowledged: we now own the retry
    expect(res._body).toEqual({ ok: true, quarantined: true, applied: false });
    expect(quarantine.quarantine).toHaveBeenCalledTimes(1);
    expect(sesFeedback.ingestEvent).not.toHaveBeenCalled();   // NO recipient state applied
    expect(logs.join('\n')).toMatch(/QUARANTINED, no state applied/);
  });

  test('if quarantining itself fails we refuse rather than apply unverified state', async () => {
    webhookSignature.verifySns.mockImplementation(async () => ({
      ok: false, status: 'verify_unavailable', reason: 'certificate unavailable',
    }));
    quarantine.quarantine.mockImplementation(async () => { throw new Error('db down'); });
    const res = await call({ token: SECRET, body: JSON.stringify(notification()) });
    expect(res._status).toBe(503);                            // the provider retries; nothing lost
    expect(sesFeedback.ingestEvent).not.toHaveBeenCalled();
    quarantine.quarantine.mockImplementation(async () => ({ quarantined: true, id: 'qr-1', duplicate: false }));
  });

  test('the shared secret is still required regardless of a valid signature', async () => {
    const res = await call({ token: 'wrong-secret', body: JSON.stringify(notification()) });
    expect(res._status).toBe(401);
    expect(sesFeedback.ingestEvent).not.toHaveBeenCalled();
  });
});
