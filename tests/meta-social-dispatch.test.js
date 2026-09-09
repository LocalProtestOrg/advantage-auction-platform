'use strict';

/** Autonomous social dispatch gating/idempotency/failure-isolation + socialAdapter provider resolution. */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-social2';

const mockGates = { a9: false, meta: false };
jest.mock('../src/services/marketingConfigService', () => ({
  getBool: async (k, f) => (k === 'marketing.a9_publish_enabled' ? mockGates.a9 : (k === 'marketing.destinations.meta_enabled' ? mockGates.meta : f)),
  a7SendEnabled: async () => false,
}));
const qState = { jobs: [], completed: [], failed: [] };
jest.mock('../src/services/marketingQueueService', () => ({
  enqueue: jest.fn(async (r, { jobType, payload, idempotencyKey }) => {
    const ex = qState.jobs.find((j) => j.idempotency_key === idempotencyKey); if (ex) return ex;
    const row = { id: 'j' + (qState.jobs.length + 1), job_type: jobType, payload, idempotency_key: idempotencyKey, state: 'queued', attempts: 0 };
    qState.jobs.push(row); return row;
  }),
  claimNext: jest.fn(async (r, jt) => { const j = qState.jobs.find((x) => x.state === 'queued' && (!jt || x.job_type === jt)); if (j) { j.state = 'processing'; j.attempts++; } return j || null; }),
  complete: jest.fn(async (id) => { qState.completed.push(id); }),
  fail: jest.fn(async (id, e) => { qState.failed.push({ id, e: String(e && e.message || e) }); }),
}));
const mockPublishWave = jest.fn(async () => ({ ok: true, shadow: false, job: { id: 'x' } }));
jest.mock('../src/services/socialAdapter', () => ({ publishWave: (...a) => mockPublishWave(...a) }));

const dispatch = require('../src/services/socialDispatchService');
beforeEach(() => { mockGates.a9 = false; mockGates.meta = false; qState.jobs = []; qState.completed = []; qState.failed = []; mockPublishWave.mockClear(); });

describe('socialDispatchService — double self-gate', () => {
  test('BOTH gates OFF → inert (claims nothing, publishes nothing)', async () => {
    await dispatch.enqueueSocialDispatch(null, { obligationId: 'o1', auctionId: 'A1', wave: 'ANY', platform: 'facebook' });
    const out = await dispatch.runOnce();
    expect(out.ran).toBe(false); expect(out.reason).toBe('not_authorized');
    expect(mockPublishWave).not.toHaveBeenCalled();
  });
  test('only A9 on (Meta off) → still inert', async () => {
    mockGates.a9 = true; mockGates.meta = false;
    expect((await dispatch.authorized()).ok).toBe(false);
    expect((await dispatch.runOnce()).ran).toBe(false);
  });
  test('BOTH gates ON → claims + publishes via adapter', async () => {
    mockGates.a9 = true; mockGates.meta = true;
    await dispatch.enqueueSocialDispatch(null, { obligationId: 'o1', auctionId: 'A1', wave: 'LAUNCH', platform: 'facebook' });
    const out = await dispatch.runOnce();
    expect(out.dispatched).toBe(1);
    expect(mockPublishWave).toHaveBeenCalledTimes(1);
    expect(qState.completed).toContain('j1');
  });
  test('dispatchClaimed throws SOCIAL_UNAUTHORIZED when gates off (defense in depth)', async () => {
    await expect(dispatch.dispatchClaimed({ payload: { auctionId: 'A1' } })).rejects.toMatchObject({ code: 'SOCIAL_UNAUTHORIZED' });
  });
});

describe('idempotency + failure isolation', () => {
  test('same obligation+wave+platform enqueues ONCE (no duplicate post)', async () => {
    await dispatch.enqueueSocialDispatch(null, { obligationId: 'o1', auctionId: 'A1', wave: 'ANY', platform: 'facebook' });
    await dispatch.enqueueSocialDispatch(null, { obligationId: 'o1', auctionId: 'A1', wave: 'ANY', platform: 'facebook' });
    expect(qState.jobs.length).toBe(1);
    expect(qState.jobs[0].idempotency_key).toBe('social_dispatch:o1:ANY:facebook');
  });
  test('different platforms are distinct jobs (FB + IG independent)', async () => {
    await dispatch.enqueueSocialDispatch(null, { obligationId: 'o1', auctionId: 'A1', wave: 'ANY', platform: 'facebook' });
    await dispatch.enqueueSocialDispatch(null, { obligationId: 'o1', auctionId: 'A1', wave: 'ANY', platform: 'instagram' });
    expect(qState.jobs.length).toBe(2);
  });
  test('publish failure → job FAILED (retry/backoff), not completed', async () => {
    mockGates.a9 = true; mockGates.meta = true;
    mockPublishWave.mockResolvedValueOnce({ ok: false, reason: 'provider_inactive' });
    await dispatch.enqueueSocialDispatch(null, { obligationId: 'o2', auctionId: 'A2', wave: 'ANY', platform: 'facebook' });
    const out = await dispatch.runOnce({ max: 1 });
    expect(out.dispatched).toBe(0);
    expect(qState.failed.map((f) => f.id)).toContain('j1');
    expect(qState.completed).not.toContain('j1');
  });
});

