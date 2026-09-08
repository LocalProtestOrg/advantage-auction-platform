'use strict';

/**
 * Node <-> Python creative engine integration (Phase 3O Wave 1, blocker 5). Verifies the bounded contract:
 * structured errors (never throws), timeout handling, idempotency by job_id, provenance persistence, no
 * arbitrary command injection (fixed script + stdin only), graceful degrade when the engine is unavailable.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── Contract / safety (source-level) ──
describe('creativeEngineService contract + safety', () => {
  const s = read('src', 'services', 'creativeEngineService.js');
  test('fixed script path + stdin-only input (no arbitrary command injection)', () => {
    expect(s).toMatch(/const ENGINE = path\.join\([^)]*'creative-engine', 'produce\.py'\)/);
    expect(s).toMatch(/child\.stdin\.write\(JSON\.stringify\(job\)\)/);
    expect(s).not.toMatch(/exec\(|shell:\s*true/);   // spawn, not shell exec; no shell string interpolation
  });
  test('bounded: timeout kills the child; never throws (structured errors)', () => {
    expect(s).toMatch(/setTimeout\(/);
    expect(s).toMatch(/child\.kill\('SIGKILL'\)/);
    expect(s).toMatch(/resolve\(\{ ok: false, error: 'timeout' \}\)/);
    expect(s).toMatch(/engine_unavailable/);
  });
  test('idempotent by job_id; persists provenance (rgb_edited/generative must stay false)', () => {
    expect(s).toMatch(/idempotent_replay: true/);
    expect(s).toMatch(/INSERT INTO marketing_creative_provenance/);
    expect(s).toMatch(/p\.rgb_edited === true, p\.generative === true/);
  });
});

// ── requestCreative behavior (mock db + engine) ──
describe('requestCreative', () => {
  jest.resetModules();
  const store = { jobs: {}, provenance: [] };
  jest.doMock('../src/db', () => ({ query: jest.fn(async (sql, params) => {
    const s = String(sql);
    if (/SELECT status, result FROM marketing_creative_jobs/.test(s)) { const j = store.jobs[params[0]]; return { rows: j ? [{ status: j.status, result: j.result }] : [] }; }
    if (/INSERT INTO marketing_creative_jobs/.test(s)) { store.jobs[params[0]] = { status: 'running', request: params[2] }; return { rows: [] }; }
    if (/UPDATE marketing_creative_jobs SET status/.test(s)) { store.jobs[params[0]] = { status: params[1], result: params[2] }; return { rows: [] }; }
    if (/INSERT INTO marketing_creative_provenance/.test(s)) { store.provenance.push(params); return { rows: [] }; }
    return { rows: [] };
  }) }));
  const svc = require('../src/services/creativeEngineService');
  // stub the Python engine so the test never spawns a real process.
  svc.runEngine = jest.fn(async () => ({ ok: true, runtime_version: '3M.3+wave1', audit: { violations: [] }, qa: { pass: true },
    creative: { object_lots: ['f1', 't1'] }, provenance: [{ lot_id: 'f1', fidelity: 'CLEAN', rgb_edited: false, generative: false }] }));

  beforeEach(() => { store.jobs = {}; store.provenance = []; svc.runEngine.mockClear(); });

  test('runs the engine, persists result + provenance, returns ok', async () => {
    const r = await svc.requestCreative({ jobId: 'j1', auctionId: 'a1', lots: [{ lot_id: 'f1', cat: 'Furniture' }] });
    expect(r.ok).toBe(true);
    expect(store.jobs['j1'].status).toBe('completed');
    expect(store.provenance.length).toBe(1);
    expect(store.provenance[0][6]).toBe(false); // rgb_edited stays false
  });
  test('idempotent: a completed job returns its stored result without re-running', async () => {
    store.jobs['j2'] = { status: 'completed', result: { ok: true, cached: true } };
    const r = await svc.requestCreative({ jobId: 'j2', auctionId: 'a1', lots: [] });
    expect(r.idempotent_replay).toBe(true);
    expect(svc.runEngine).not.toHaveBeenCalled();
  });
  test('engine unavailable → job status engine_unavailable (obligation never falsely completed)', async () => {
    svc.runEngine.mockResolvedValueOnce({ ok: false, error: 'engine_unavailable' });
    await svc.requestCreative({ jobId: 'j3', auctionId: 'a1', lots: [] });
    expect(store.jobs['j3'].status).toBe('engine_unavailable');
  });
});

// ── migration 143 additive ──
describe('migration 143', () => {
  const m = read('db', 'migrations', '143_marketing_creative_jobs.sql');
  test('additive; provenance keeps rgb_edited/generative false-by-default; no gate/DROP', () => {
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS marketing_creative_jobs/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS marketing_creative_provenance/);
    expect(m).toMatch(/rgb_edited      BOOLEAN NOT NULL DEFAULT false/);
    expect(m).not.toMatch(/\bDROP\b/);
  });
});
