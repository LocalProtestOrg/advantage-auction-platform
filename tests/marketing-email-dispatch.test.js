'use strict';

/**
 * Autonomous email dispatch seam (emailDispatchService) + SPF readiness heuristic correction.
 *
 * Certifies: A7 self-gating (inert when off), idempotent per-campaign enqueue (no duplicate dispatch), the
 * claim→sendCampaignLive→complete happy path, bounded retry on failure (fail, not complete), payload
 * validation, and that dispatch re-checks A7 at execution. Plus the SPF heuristic now evaluates the SES
 * custom MAIL FROM architecture (envelope domain) instead of only the root From domain.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-dispatch';

// ── collaborators mocked so this is pure orchestration logic (no DB / no SES) ──
const mockA7 = { on: false };
jest.mock('../src/services/marketingConfigService', () => ({
  a7SendEnabled: async () => mockA7.on,
  getBool: async (k, f) => (k === 'marketing.a7_send_enabled' ? mockA7.on : f),
  getInt: async (k, f) => f,
}));
const queueState = { jobs: [], completed: [], failed: [] };
jest.mock('../src/services/marketingQueueService', () => ({
  enqueue: jest.fn(async (runner, { jobType, payload, idempotencyKey }) => {
    const existing = queueState.jobs.find((j) => j.idempotency_key === idempotencyKey);
    if (existing) return existing;                                  // ON CONFLICT DO NOTHING → dedup
    const row = { id: 'job_' + (queueState.jobs.length + 1), job_type: jobType, payload, idempotency_key: idempotencyKey, state: 'queued', attempts: 0 };
    queueState.jobs.push(row); return row;
  }),
  claimNext: jest.fn(async (runner, jobType) => {
    const j = queueState.jobs.find((x) => x.state === 'queued' && (!jobType || x.job_type === jobType));
    if (j) { j.state = 'processing'; j.attempts++; }
    return j || null;
  }),
  complete: jest.fn(async (id) => { queueState.completed.push(id); const j = queueState.jobs.find((x) => x.id === id); if (j) j.state = 'done'; }),
  fail: jest.fn(async (id, err) => { queueState.failed.push({ id, err: String(err && err.message || err) }); const j = queueState.jobs.find((x) => x.id === id); if (j) j.state = j.attempts >= 5 ? 'dead' : 'queued'; }),
}));
const mockSendSpy = jest.fn(async () => ({ ok: true, sent: 3, skipped: 1, candidates: 4 }));
jest.mock('../src/services/marketingSendService', () => ({ sendCampaignLive: (...a) => mockSendSpy(...a), testSend: jest.fn() }));
jest.mock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })) }));

const dispatch = require('../src/services/emailDispatchService');
const queue = require('../src/services/marketingQueueService');

const rendered = { subject: 'Nearby auctions this week', html: '<p>…</p>', text: '…' };
beforeEach(() => { mockA7.on = false; queueState.jobs = []; queueState.completed = []; queueState.failed = []; mockSendSpy.mockClear(); queue.enqueue.mockClear(); queue.claimNext.mockClear(); queue.complete.mockClear(); queue.fail.mockClear(); });

describe('enqueueCampaignDispatch (producer)', () => {
  test('idempotency key is email_dispatch:<campaignId>; enqueuing the same campaign twice yields ONE job', async () => {
    await dispatch.enqueueCampaignDispatch(null, { campaignId: 'c1', rendered });
    await dispatch.enqueueCampaignDispatch(null, { campaignId: 'c1', rendered });
    expect(queueState.jobs.length).toBe(1);
    expect(queueState.jobs[0].idempotency_key).toBe('email_dispatch:c1');
  });
  test('rejects a campaign with no rendered content (never dispatch an empty email)', async () => {
    await expect(dispatch.enqueueCampaignDispatch(null, { campaignId: 'c2' })).rejects.toThrow(/rendered/);
  });
});

describe('runOnce (autonomous worker tick)', () => {
  test('A7 OFF → inert: claims nothing, sends nothing', async () => {
    mockA7.on = false;
    await dispatch.enqueueCampaignDispatch(null, { campaignId: 'c1', rendered });
    const out = await dispatch.runOnce();
    expect(out.ran).toBe(false); expect(out.reason).toBe('a7_disabled'); expect(out.dispatched).toBe(0);
    expect(mockSendSpy).not.toHaveBeenCalled();
    expect(queue.claimNext).not.toHaveBeenCalled();
  });
  test('A7 ON + queued job → claim → sendCampaignLive → complete', async () => {
    mockA7.on = true;
    await dispatch.enqueueCampaignDispatch(null, { campaignId: 'c1', marketingClass: 'local_event_alert', geoStrategy: { state: 'NJ' }, rendered });
    const out = await dispatch.runOnce();
    expect(out.dispatched).toBe(1);
    expect(mockSendSpy).toHaveBeenCalledTimes(1);
    const arg = mockSendSpy.mock.calls[0][0];
    expect(arg.campaignId).toBe('c1'); expect(arg.rendered.subject).toBe(rendered.subject);
    expect(queueState.completed).toContain('job_1');
    expect(out.results[0]).toMatchObject({ sent: 3, skipped: 1 });
  });
  test('sendCampaignLive throws → job FAILED (retry/backoff), NOT completed', async () => {
    mockA7.on = true;
    mockSendSpy.mockRejectedValueOnce(new Error('smtp 451 throttle'));
    await dispatch.enqueueCampaignDispatch(null, { campaignId: 'c9', rendered });
    // One claim per tick (production pushes run_after into the future on failure via bounded backoff).
    const out = await dispatch.runOnce({ max: 1 });
    expect(out.dispatched).toBe(0);
    expect(queueState.failed.map((f) => f.id)).toContain('job_1');
    expect(queueState.completed).not.toContain('job_1');
  });
  test('claim is scoped to email_dispatch (never claims an unrelated job type)', async () => {
    mockA7.on = true;
    await dispatch.runOnce();
    expect(queue.claimNext).toHaveBeenCalledWith(expect.anything(), 'email_dispatch');
  });
});

describe('dispatchClaimed (per-job)', () => {
  test('invalid payload throws (no campaign/rendered)', async () => {
    mockA7.on = true;
    await expect(dispatch.dispatchClaimed({ payload: {} })).rejects.toThrow(/invalid_dispatch_payload/);
  });
  test('re-checks A7 at execution — throws A7_DISABLED if flipped off', async () => {
    mockA7.on = false;
    await expect(dispatch.dispatchClaimed({ payload: { campaignId: 'c1', rendered } })).rejects.toMatchObject({ code: 'A7_DISABLED' });
  });
});

describe('SPF readiness heuristic — evaluates the SES custom MAIL FROM architecture', () => {
  const { evaluateSpf } = require('../src/services/a7ReadinessService');
  const rootSendgridOnly = ['v=spf1 a mx include:sendgrid.net include:spf.mtasv.net ~all'];
  const bounceMx = [{ exchange: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }];
  test('root uses another provider BUT custom MAIL FROM MX is SES → PASS (was incorrectly FAIL before)', () => {
    const r = evaluateSpf({ rootSpf: rootSendgridOnly, mailFromSpf: null, mailFromMx: bounceMx, rootDom: 'advantage.bid', mailFromDom: 'bounce.advantage.bid' });
    expect(r.status).toBe('PASS');
  });
  test('custom MAIL FROM SPF include:amazonses → PASS', () => {
    const r = evaluateSpf({ rootSpf: rootSendgridOnly, mailFromSpf: ['v=spf1 include:amazonses.com ~all'], mailFromMx: null, rootDom: 'advantage.bid', mailFromDom: 'bounce.advantage.bid' });
    expect(r.status).toBe('PASS');
  });
  test('root SPF already includes amazonses → PASS', () => {
    const r = evaluateSpf({ rootSpf: ['v=spf1 include:amazonses.com ~all'], mailFromSpf: null, mailFromMx: null, rootDom: 'advantage.bid', mailFromDom: 'bounce.advantage.bid' });
    expect(r.status).toBe('PASS');
  });
  test('SPF present but no SES anywhere → WARN (DKIM-aligned DMARC still authenticates), not a hard fail', () => {
    const r = evaluateSpf({ rootSpf: rootSendgridOnly, mailFromSpf: null, mailFromMx: null, rootDom: 'advantage.bid', mailFromDom: 'bounce.advantage.bid' });
    expect(r.status).toBe('WARN');
  });
  test('no SPF at all → FAIL (authentication not weakened)', () => {
    const r = evaluateSpf({ rootSpf: null, mailFromSpf: null, mailFromMx: null, rootDom: 'advantage.bid', mailFromDom: 'bounce.advantage.bid' });
    expect(r.status).toBe('FAIL');
  });
});
