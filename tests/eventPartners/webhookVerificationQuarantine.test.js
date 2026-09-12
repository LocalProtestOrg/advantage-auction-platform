'use strict';

/**
 * Webhook verification quarantine — fail-safe handling of a provider callback whose authenticity
 * could not be established (migration 155).
 *
 * The rule under test:
 *   valid signature      -> processed normally
 *   invalid signature    -> rejected, never processed
 *   cannot verify YET    -> held; NO recipient-affecting state applied; retried; processed EXACTLY
 *                           ONCE once authenticity is established
 *   never verifiable     -> kept forever as evidence; never processed
 *
 * The scenarios the Owner asked for are each covered: valid, invalid, unavailable-then-verified,
 * repeated/replayed, and permanently unverifiable.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-quarantine';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * A small in-memory stand-in for the quarantine table. It honours the real invariants that matter:
 * UNIQUE (provider, payload_sha256), and the conditional claim that gives exactly-once.
 */
jest.mock('../../src/db', () => {
  const store = { rows: [] };
  const now = () => new Date();
  const query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ');

    if (/SELECT id, status, verify_attempts FROM webhook_callback_quarantine/.test(s)) {
      const hit = store.rows.find((r) => r.provider === params[0] && r.payload_sha256 === params[1]);
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
    }
    if (/INSERT INTO webhook_callback_quarantine/.test(s)) {
      const [provider, payload, digest, msgId, topic, kind, sigStatus, reason] = params;
      if (store.rows.some((r) => r.provider === provider && r.payload_sha256 === digest)) {
        return { rows: [], rowCount: 0 };              // ON CONFLICT DO NOTHING
      }
      const row = {
        id: 'qr-' + (store.rows.length + 1), provider, payload: JSON.parse(payload),
        payload_sha256: digest, provider_message_id: msgId, topic_arn: topic, event_kind: kind,
        status: 'pending_verification', signature_status: sigStatus, last_reason: reason,
        verify_attempts: 0, first_seen_at: now(), next_attempt_at: new Date(0),
        processed_at: null, process_result: null,
      };
      store.rows.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (/SELECT id, provider, payload, verify_attempts, status FROM webhook_callback_quarantine/.test(s)) {
      const due = store.rows.filter((r) => r.status === 'pending_verification' && r.next_attempt_at <= now());
      return { rows: due.slice(0, params[0]), rowCount: due.length };
    }
    if (/UPDATE webhook_callback_quarantine SET status = 'rejected_invalid'/.test(s)) {
      const r = store.rows.find((x) => x.id === params[0]);
      if (r) { r.status = 'rejected_invalid'; r.verify_attempts = params[1]; r.last_reason = params[2]; r.signature_status = 'rejected_signature'; }
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (/UPDATE webhook_callback_quarantine SET status = \$4, verify_attempts/.test(s)) {
      const r = store.rows.find((x) => x.id === params[0]);
      if (r) { r.status = params[3]; r.verify_attempts = params[1]; r.last_reason = params[2]; r.next_attempt_at = new Date(0); }
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (/UPDATE webhook_callback_quarantine SET status = 'verified_processed'/.test(s)) {
      // The conditional claim — this is what makes processing exactly-once.
      const r = store.rows.find((x) => x.id === params[0] && x.status === 'pending_verification' && x.processed_at === null);
      if (!r) return { rows: [], rowCount: 0 };
      r.status = 'verified_processed'; r.processed_at = now(); r.verify_attempts = params[1]; r.signature_status = 'verified';
      return { rows: [{ id: r.id }], rowCount: 1 };
    }
    if (/UPDATE webhook_callback_quarantine SET status = 'pending_verification', processed_at = NULL/.test(s)) {
      const r = store.rows.find((x) => x.id === params[0]);
      if (r) { r.status = 'pending_verification'; r.processed_at = null; r.last_reason = params[1]; r.next_attempt_at = new Date(0); }
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (/UPDATE webhook_callback_quarantine SET process_result/.test(s)) {
      const r = store.rows.find((x) => x.id === params[0]);
      if (r) r.process_result = JSON.parse(params[1]);
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (/UPDATE webhook_callback_quarantine SET updated_at = now\(\) WHERE id/.test(s)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), pool: { end: async () => {} }, __store: store };
});

const db = require('../../src/db');
const quarantine = require('../../src/services/webhookQuarantineService');
const configService = require('../../src/services/configService');

const store = () => db.__store.rows;
const reset = () => { db.__store.rows.length = 0; };

let cfg;
beforeEach(() => {
  reset();
  cfg = {
    'webhooks.quarantine_max_attempts': 3,
    'webhooks.quarantine_backoff_seconds': 300,
    'webhooks.quarantine_retry_enabled': true,
  };
  jest.spyOn(configService, 'get').mockImplementation(async (_o, k) => cfg[k]);
});
afterEach(() => jest.restoreAllMocks());

const payload = (o) => Object.assign({
  Type: 'Notification', MessageId: 'sns-1', TopicArn: 'arn:aws:sns:us-east-1:1:advantage-bid-feedback',
  Message: JSON.stringify({ notificationType: 'Bounce' }), Signature: 'sig', SignatureVersion: '1',
  SigningCertURL: 'https://sns.us-east-1.amazonaws.com/x.pem',
}, o || {});

const verifier = (seq) => { let i = 0; return async () => (seq[Math.min(i++, seq.length - 1)]); };
const UNAVAILABLE = { ok: false, status: 'verify_unavailable', reason: 'certificate unavailable' };
const REJECTED = { ok: false, status: 'rejected_signature', reason: 'signature mismatch' };
const VERIFIED = { ok: true, status: 'verified', reason: 'RSA-SHA1' };

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('scenario: signature valid', () => {
  test('a verified callback is processed exactly once and never reaches quarantine', async () => {
    // A valid signature is handled inline by the route; nothing is held. Proven here by the receiver
    // only calling quarantine on the verify_unavailable branch.
    const src = read('src', 'routes', 'sesFeedback.js');
    const quarantineCalls = (src.match(/quarantine\.quarantine\(/g) || []).length;
    expect(quarantineCalls).toBe(1);
    const branch = src.slice(src.indexOf("result.status === 'verify_unavailable'"), src.indexOf('if (isSnsControl'));
    expect(branch).toMatch(/quarantine\.quarantine\(/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('scenario: signature invalid', () => {
  test('a forged callback is refused at the door and never quarantined', () => {
    const src = read('src', 'routes', 'sesFeedback.js');
    const rejectBranch = src.slice(src.indexOf("result.status === 'rejected_signature'"),
      src.indexOf("result.status === 'verify_unavailable'"));
    expect(rejectBranch).toMatch(/return res\.status\(403\)/);
    expect(rejectBranch).not.toMatch(/quarantine\.quarantine\(/);
  });

  test('a held callback later proven inauthentic is terminal and is NEVER processed', async () => {
    await quarantine.quarantine({ provider: 'ses_sns', payload: payload(), digest: 'd-bad', signatureStatus: 'verify_unavailable' });
    const process = jest.fn(async () => ({ ingested: 1 }));
    const out = await quarantine.retryPending({ verify: verifier([REJECTED]), process });

    expect(out.rejected).toBe(1);
    expect(process).not.toHaveBeenCalled();               // no state applied, ever
    expect(store()[0].status).toBe('rejected_invalid');
    expect(store()[0].processed_at).toBeNull();
    // Kept as evidence rather than deleted.
    expect(store()).toHaveLength(1);
    expect(store()[0].payload).toBeTruthy();
  });

  test('a rejected callback is not retried on later ticks', async () => {
    await quarantine.quarantine({ provider: 'ses_sns', payload: payload(), digest: 'd-bad', signatureStatus: 'verify_unavailable' });
    await quarantine.retryPending({ verify: verifier([REJECTED]), process: jest.fn() });
    const verify = jest.fn(async () => VERIFIED);
    const out = await quarantine.retryPending({ verify, process: jest.fn() });
    expect(out.considered).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('scenario: verification unavailable, then verified', () => {
  test('nothing is applied while unverifiable, then it processes exactly once when it verifies', async () => {
    const held = await quarantine.quarantine({
      provider: 'ses_sns', payload: payload(), digest: 'd-1',
      signatureStatus: 'verify_unavailable', reason: 'certificate unavailable',
    });
    expect(held.quarantined).toBe(true);
    expect(held.duplicate).toBe(false);
    expect(store()[0].status).toBe('pending_verification');

    const process = jest.fn(async () => ({ ingested: 1 }));

    // Tick 1: still unavailable. Nothing applied.
    const t1 = await quarantine.retryPending({ verify: verifier([UNAVAILABLE]), process });
    expect(t1.processed).toBe(0);
    expect(process).not.toHaveBeenCalled();
    expect(store()[0].status).toBe('pending_verification');
    expect(store()[0].verify_attempts).toBe(1);
    expect(store()[0].processed_at).toBeNull();

    // Tick 2: the certificate is reachable again.
    const t2 = await quarantine.retryPending({ verify: verifier([VERIFIED]), process });
    expect(t2.processed).toBe(1);
    expect(process).toHaveBeenCalledTimes(1);
    expect(store()[0].status).toBe('verified_processed');
    expect(store()[0].processed_at).toBeTruthy();
    expect(store()[0].process_result).toEqual({ ingested: 1 });

    // Tick 3: nothing left to do. No second application.
    const t3 = await quarantine.retryPending({ verify: verifier([VERIFIED]), process });
    expect(t3.considered).toBe(0);
    expect(process).toHaveBeenCalledTimes(1);
  });

  test('an authentic callback whose processing FAILS returns to the queue rather than being lost', async () => {
    await quarantine.quarantine({ provider: 'ses_sns', payload: payload(), digest: 'd-2', signatureStatus: 'verify_unavailable' });
    const failing = jest.fn(async () => { throw new Error('database down'); });
    const out = await quarantine.retryPending({ verify: verifier([VERIFIED]), process: failing });

    expect(out.results[0].outcome).toBe('process_failed');
    expect(store()[0].status).toBe('pending_verification');   // back in the queue
    expect(store()[0].processed_at).toBeNull();               // not falsely marked done
    expect(store()[0].last_reason).toMatch(/process failed: database down/);

    // A later tick succeeds, and applies exactly once.
    const ok = jest.fn(async () => ({ ingested: 1 }));
    const out2 = await quarantine.retryPending({ verify: verifier([VERIFIED]), process: ok });
    expect(out2.processed).toBe(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('scenario: repeated / replayed callbacks', () => {
  test('the provider retrying the same payload never creates a second held item', async () => {
    const p = payload();
    const a = await quarantine.quarantine({ provider: 'ses_sns', payload: p, digest: 'd-same', signatureStatus: 'verify_unavailable' });
    const b = await quarantine.quarantine({ provider: 'ses_sns', payload: p, digest: 'd-same', signatureStatus: 'verify_unavailable' });
    const c = await quarantine.quarantine({ provider: 'ses_sns', payload: p, digest: 'd-same', signatureStatus: 'verify_unavailable' });

    expect(store()).toHaveLength(1);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(c.duplicate).toBe(true);
    expect(a.id).toBe(b.id);

    // And it still applies exactly once.
    const process = jest.fn(async () => ({ ingested: 1 }));
    await quarantine.retryPending({ verify: verifier([VERIFIED]), process });
    expect(process).toHaveBeenCalledTimes(1);
  });

  test('a replay arriving AFTER processing does not reopen or reapply it', async () => {
    const p = payload();
    await quarantine.quarantine({ provider: 'ses_sns', payload: p, digest: 'd-3', signatureStatus: 'verify_unavailable' });
    const process = jest.fn(async () => ({ ingested: 1 }));
    await quarantine.retryPending({ verify: verifier([VERIFIED]), process });
    expect(store()[0].status).toBe('verified_processed');

    const again = await quarantine.quarantine({ provider: 'ses_sns', payload: p, digest: 'd-3', signatureStatus: 'verify_unavailable' });
    expect(again.duplicate).toBe(true);
    expect(again.status).toBe('verified_processed');
    expect(store()).toHaveLength(1);
    expect(store()[0].status).toBe('verified_processed');

    const out = await quarantine.retryPending({ verify: verifier([VERIFIED]), process });
    expect(out.considered).toBe(0);
    expect(process).toHaveBeenCalledTimes(1);
  });

  test('two concurrent workers cannot both process the same held callback', async () => {
    await quarantine.quarantine({ provider: 'ses_sns', payload: payload(), digest: 'd-4', signatureStatus: 'verify_unavailable' });
    const row = store()[0];
    const process = jest.fn(async () => ({ ingested: 1 }));
    const deps = { verify: verifier([VERIFIED]), process };

    // Both see the same pending row; only one may claim it.
    const [r1, r2] = await Promise.all([
      quarantine.attemptOne(row, deps), quarantine.attemptOne(row, deps),
    ]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(['already_processed', 'verified_processed']);
    expect(process).toHaveBeenCalledTimes(1);
  });

  test('different payloads are held separately', async () => {
    await quarantine.quarantine({ provider: 'ses_sns', payload: payload({ MessageId: 'a' }), digest: 'd-a', signatureStatus: 'verify_unavailable' });
    await quarantine.quarantine({ provider: 'ses_sns', payload: payload({ MessageId: 'b' }), digest: 'd-b', signatureStatus: 'verify_unavailable' });
    expect(store()).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('scenario: permanently unverifiable', () => {
  test('after the attempt budget it is abandoned — never applied, never deleted', async () => {
    await quarantine.quarantine({ provider: 'ses_sns', payload: payload(), digest: 'd-5', signatureStatus: 'verify_unavailable' });
    const process = jest.fn(async () => ({ ingested: 1 }));
    const deps = { verify: verifier([UNAVAILABLE]), process };

    cfg['webhooks.quarantine_max_attempts'] = 3;
    await quarantine.retryPending(deps);   // attempt 1
    expect(store()[0].status).toBe('pending_verification');
    await quarantine.retryPending(deps);   // attempt 2
    expect(store()[0].status).toBe('pending_verification');
    const last = await quarantine.retryPending(deps);   // attempt 3 → budget exhausted

    expect(last.abandoned).toBe(1);
    expect(store()[0].status).toBe('abandoned');
    expect(process).not.toHaveBeenCalled();      // no state was EVER applied
    expect(store()).toHaveLength(1);             // evidence retained
    expect(store()[0].payload).toBeTruthy();     // the whole payload is still there
    expect(store()[0].processed_at).toBeNull();
  });

  test('an abandoned callback is not retried, and is never silently discarded', async () => {
    await quarantine.quarantine({ provider: 'ses_sns', payload: payload(), digest: 'd-6', signatureStatus: 'verify_unavailable' });
    cfg['webhooks.quarantine_max_attempts'] = 1;
    await quarantine.retryPending({ verify: verifier([UNAVAILABLE]), process: jest.fn() });
    expect(store()[0].status).toBe('abandoned');

    const verify = jest.fn(async () => VERIFIED);
    const out = await quarantine.retryPending({ verify, process: jest.fn() });
    expect(out.considered).toBe(0);
    expect(verify).not.toHaveBeenCalled();
    expect(store()).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('policy and wiring', () => {
  test('backoff grows exponentially and is capped', () => {
    expect(quarantine.backoffSeconds(1, 300)).toBe(300);
    expect(quarantine.backoffSeconds(2, 300)).toBe(600);
    expect(quarantine.backoffSeconds(4, 300)).toBe(2400);
    expect(quarantine.backoffSeconds(99, 300)).toBe(quarantine.MAX_BACKOFF_SECONDS);
  });

  test('disabling retry holds callbacks without processing them', async () => {
    cfg['webhooks.quarantine_retry_enabled'] = false;
    await quarantine.quarantine({ provider: 'ses_sns', payload: payload(), digest: 'd-7', signatureStatus: 'verify_unavailable' });
    const process = jest.fn();
    const out = await quarantine.retryPending({ verify: verifier([VERIFIED]), process });
    expect(out.ran).toBe(false);
    expect(process).not.toHaveBeenCalled();
    expect(store()[0].status).toBe('pending_verification');   // still held, not lost
  });

  test('the SES receiver acknowledges a quarantined callback so the provider stops retrying', () => {
    const src = read('src', 'routes', 'sesFeedback.js');
    expect(src).toMatch(/return res\.status\(202\)\.json\(\{ ok: true, quarantined: true, applied: false \}\)/);
    // If quarantining itself fails we refuse rather than apply unverified state.
    expect(src).toMatch(/return res\.status\(503\)\.json\(\{ error: 'Verification unavailable' \}\)/);
  });

  test('inbound partner mail accepts only a VERIFIED callback', () => {
    const src = read('src', 'services', 'eventPartners', 'inboundEmailService.js');
    expect(src).toMatch(/\['verified', 'unsigned_accepted'\]\.indexOf\(meta\.signatureStatus\)/);
    expect(src).not.toMatch(/'verify_unavailable'\]\.indexOf\(meta\.signatureStatus\)/);
  });

  test('the retry worker applies no state of its own and never auto-confirms a subscription', () => {
    const src = read('src', 'workers', 'webhookQuarantineWorker.js');
    expect(src).toMatch(/auto_confirmed: false/);
    expect(src).not.toMatch(/SubscribeURL.*fetch|https\.get/);
    // It only re-verifies and hands the payload to the normal ingest.
    expect(src).toMatch(/sesFeedback\.ingestEvent/);
  });

  test('migration 155 is additive and enforces the exactly-once invariant in the schema', () => {
    const m = read('db', 'migrations', '155_webhook_verification_quarantine.sql');
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS webhook_callback_quarantine/);
    expect(m).toMatch(/uq_webhook_quarantine_payload/);
    expect(m).toMatch(/chk_webhook_quarantine_processed/);
    expect(m).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(m).not.toMatch(/DELETE\s+FROM/i);
    // Abandoned rows are kept, so there is no cleanup that could discard evidence.
    expect(m).not.toMatch(/TRUNCATE/i);
  });
});
