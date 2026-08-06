'use strict';

// Commit 14 — scheduled Event Import Worker. Hermetic: the engine (runImport), db, audit, and
// runLog are mocked, so these exercise the worker's orchestration + governance guarantees:
// draft-only (never auto-publish), reuse of the engine, partial-failure isolation, weekly-cap
// passthrough, crash-recovery reaping, scheduled locking, idempotent ticks, and run summaries.

jest.mock('../../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../../src/services/eventImport', () => ({ runImport: jest.fn() }));
jest.mock('../../src/services/eventImport/runLog', () => ({ finishRun: jest.fn(async () => {}) }));
jest.mock('../../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => ({ id: 'AUD' })) }));

const db = require('../../src/db');
const { runImport } = require('../../src/services/eventImport');
const runLog = require('../../src/services/eventImport/runLog');
const { writeAuditLog } = require('../../src/lib/auditLog');
const worker = require('../../src/workers/eventImportWorker');

const SRC = (over) => Object.assign({ id: 'src-1', key: 'aac-csv', name: 'AAC CSV', kind: 'csv', weekly_cap: 75, auto_publish: false, status: 'active' }, over || {});
const okResult = (over) => Object.assign({ applied: true, claimed: true, runId: 'RUN1', status: 'completed', capped: false, remainingAvailable: 73, counters: { fetched: 3, eligible: 3, created: 2, updated: 1, skipped_duplicate: 0, skipped_quality: 0, skipped_ambiguous: 0, failed: 0 } }, over || {});

beforeEach(() => {
  db.query.mockReset(); runImport.mockReset(); runLog.finishRun.mockClear(); writeAuditLog.mockClear();
  worker._resetForTest();
});

// ── config / enable gate ─────────────────────────────────────────────────────
describe('cfg (idle by default; env-driven schedule)', () => {
  test('disabled unless EVENT_IMPORT_WORKER_ENABLED=true', () => {
    expect(worker.cfg({}).enabled).toBe(false);
    expect(worker.cfg({ EVENT_IMPORT_WORKER_ENABLED: 'true' }).enabled).toBe(true);
  });
  test('DISABLED overrides ENABLED', () => {
    expect(worker.cfg({ EVENT_IMPORT_WORKER_ENABLED: 'true', EVENT_IMPORT_WORKER_DISABLED: 'true' }).enabled).toBe(false);
  });
  test('weekday/hour default to Monday 03:00 ET and clamp', () => {
    const d = worker.cfg({});
    expect(d.weekday).toBe(1); expect(d.hour).toBe(3);
    const c = worker.cfg({ EVENT_IMPORT_SCHEDULE_WEEKDAY: '4', EVENT_IMPORT_SCHEDULE_HOUR: '22' });
    expect(c.weekday).toBe(4); expect(c.hour).toBe(22);
    expect(worker.cfg({ EVENT_IMPORT_SCHEDULE_HOUR: '99' }).hour).toBe(23); // clamped
  });
});

describe('due / etNow', () => {
  test('WEEKLY mode: due only on the configured weekday + hour', () => {
    const wk = { daily: false, weekday: 1, hour: 3 };
    expect(worker.due({ weekday: 1, hour: 3 }, wk)).toBe(true);
    expect(worker.due({ weekday: 2, hour: 3 }, wk)).toBe(false);
    expect(worker.due({ weekday: 1, hour: 4 }, wk)).toBe(false);
  });
  test('DAILY mode (default): due EVERY day at the configured hour', () => {
    const d = { daily: true, hour: 3 };
    expect(worker.due({ weekday: 1, hour: 3 }, d)).toBe(true);
    expect(worker.due({ weekday: 4, hour: 3 }, d)).toBe(true); // any weekday
    expect(worker.due({ weekday: 4, hour: 4 }, d)).toBe(false); // wrong hour
  });
  test('cfg defaults to DAILY with gated auto-publish OFF', () => {
    const c = worker.cfg({});
    expect(c.daily).toBe(true);
    expect(c.autoPublish).toBe(false);
    expect(worker.cfg({ EVENT_IMPORT_SCHEDULE_DAILY: 'false' }).daily).toBe(false);
    expect(worker.cfg({ EVENT_IMPORT_AUTOPUBLISH_ENABLED: 'true' }).autoPublish).toBe(true);
  });
  test('etNow returns ET wall-clock parts (Mon 2026-08-03 03:30 ET)', () => {
    const et = worker.etNow(new Date('2026-08-03T07:30:00Z')); // EDT (UTC-4) → 03:30 ET Monday
    expect(et).toMatchObject({ date: '2026-08-03', hour: 3, weekday: 1 });
  });
});

// ── TWICE-WEEKLY (multi-day) scheduling — Phase 5C ────────────────────────────
describe('multi-day scheduling (EVENT_IMPORT_SCHEDULE_DAYS)', () => {
  test('parseDays: "1,4" → [1,4]; dedups, sorts, drops out-of-range/garbage; empty → null', () => {
    expect(worker.parseDays('1,4')).toEqual([1, 4]);
    expect(worker.parseDays('4,1,1')).toEqual([1, 4]);
    expect(worker.parseDays('7,-1,x,3')).toEqual([3]);
    expect(worker.parseDays('')).toBeNull();
    expect(worker.parseDays(undefined)).toBeNull();
  });
  test('cfg: DAYS produces a multi-day schedule and wins over DAILY/WEEKDAY', () => {
    const c = worker.cfg({ EVENT_IMPORT_SCHEDULE_DAYS: '1,4', EVENT_IMPORT_SCHEDULE_DAILY: 'true', EVENT_IMPORT_SCHEDULE_WEEKDAY: '2' });
    expect(c.days).toEqual([1, 4]);
    expect(worker.describeSchedule(c)).toMatchObject({ mode: 'multi_day', days: [1, 4], day_labels: ['Monday', 'Thursday'], hour: 3, timezone: 'America/New_York' });
    expect(worker.scheduleDayset(c)).toEqual([1, 4]);
  });
  const TW = { days: [1, 4], daily: true, weekday: 1, hour: 3 }; // Mon & Thu 03:00
  test('Monday 03:00 ET is due', () => { expect(worker.due({ weekday: 1, hour: 3 }, TW)).toBe(true); });
  test('Thursday 03:00 ET is due', () => { expect(worker.due({ weekday: 4, hour: 3 }, TW)).toBe(true); });
  test('Tuesday 03:00 ET is NOT due', () => { expect(worker.due({ weekday: 2, hour: 3 }, TW)).toBe(false); });
  test('Monday 04:00 ET (right day, wrong hour) is NOT due', () => { expect(worker.due({ weekday: 1, hour: 4 }, TW)).toBe(false); });

  test('nextScheduledRun points to the next Mon/Thu at the configured hour (DST-aware)', () => {
    // Tue 2026-08-04 05:30 ET → next window is Thu 2026-08-06 03:00 ET
    const n1 = worker.nextScheduledRun(TW, new Date('2026-08-04T09:30:00Z'));
    expect(n1).toMatchObject({ et_date: '2026-08-06', weekday: 4, hour: 3 });
    // Thu 2026-08-06 05:30 ET (this window passed) → next is Mon 2026-08-10 03:00 ET
    const n2 = worker.nextScheduledRun(TW, new Date('2026-08-06T09:30:00Z'));
    expect(n2).toMatchObject({ et_date: '2026-08-10', weekday: 1, hour: 3 });
    // Mon 2026-08-03 01:00 ET (today's window not yet passed) → today
    const n3 = worker.nextScheduledRun(TW, new Date('2026-08-03T05:00:00Z'));
    expect(n3).toMatchObject({ et_date: '2026-08-03', weekday: 1, hour: 3 });
  });

  test('lastExpectedWindow returns the most recent passed Mon/Thu window as an instant', () => {
    // Fri 2026-08-07 12:00 ET → last window was Thu 2026-08-06 03:00 ET
    const lw = worker.lastExpectedWindow(TW, new Date('2026-08-07T16:00:00Z'));
    expect(lw.et_date).toBe('2026-08-06');
    expect(worker.etNow(lw.at)).toMatchObject({ date: '2026-08-06', hour: 3, weekday: 4 });
  });

  test('DST: 03:00 ET holds across the fall-back boundary (Nov 2026)', () => {
    // Mon 2026-11-02 is EST (UTC-5): 03:00 ET = 08:00Z
    expect(worker.due(worker.etNow(new Date('2026-11-02T08:00:00Z')), TW)).toBe(true);
    // and the summer side EDT (UTC-4): 03:00 ET = 07:00Z
    expect(worker.due(worker.etNow(new Date('2026-08-06T07:00:00Z')), TW)).toBe(true);
  });

  test('tick: Monday and Thursday each run once in the same week (distinct ET dates)', async () => {
    process.env.EVENT_IMPORT_WORKER_ENABLED = 'true';
    process.env.EVENT_IMPORT_SCHEDULE_DAYS = '1,4';
    const HEALTH_ROW = { rows: [{ t: null, n: 0, status: 'completed', started_at: null }] };
    db.query.mockImplementation((sql) => (/import_sources WHERE status = 'active'/.test(sql) ? { rows: [] } : HEALTH_ROW));
    const cycles = () => db.query.mock.calls.filter((c) => /import_sources WHERE status = 'active'/.test(c[0])).length;
    await worker.tick(new Date('2026-08-03T07:30:00Z')); // Mon 03:30 ET
    expect(cycles()).toBe(1);
    await worker.tick(new Date('2026-08-03T07:31:00Z')); // same Mon date → no re-run
    expect(cycles()).toBe(1);
    await worker.tick(new Date('2026-08-06T07:30:00Z')); // Thu 03:30 ET → a second run
    expect(cycles()).toBe(2);
    await worker.tick(new Date('2026-08-04T07:30:00Z')); // Tue → not a scheduled day
    expect(cycles()).toBe(2);
    delete process.env.EVENT_IMPORT_WORKER_ENABLED;
    delete process.env.EVENT_IMPORT_SCHEDULE_DAYS;
  });
});

// ── active sources ───────────────────────────────────────────────────────────
describe('activeSources', () => {
  test('selects only active sources', async () => {
    db.query.mockResolvedValueOnce({ rows: [SRC()] });
    const rows = await worker.activeSources();
    expect(rows.length).toBe(1);
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE status = 'active'/);
  });
});

// ── runOneSource: reuse engine, draft-only, recover from failures ─────────────
describe('runOneSource', () => {
  test('draft-only by DEFAULT (noAutoPublish:true when autoPublish not opted in)', async () => {
    db.query.mockResolvedValue({ rows: [] });   // reapStaleRun query
    runImport.mockResolvedValueOnce(okResult());
    const r = await worker.runOneSource(SRC(), { trigger: 'scheduled', scheduledFor: '2026-08-03', apply: true });
    expect(r.ok).toBe(true);
    expect(r.counters).toMatchObject({ created: 2, updated: 1 });
    const arg = runImport.mock.calls[0][0];
    expect(arg).toMatchObject({ sourceKey: 'aac-csv', apply: true, trigger: 'scheduled', scheduledFor: '2026-08-03', noAutoPublish: true });
    expect(typeof arg.withTransaction).toBe('function'); // transactional writer wired
  });

  test('GATED auto-publish: autoPublish:true → noAutoPublish:false (engine + publicationGate still gate each event)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    runImport.mockResolvedValueOnce(okResult());
    await worker.runOneSource(SRC(), { trigger: 'scheduled', scheduledFor: '2026-08-03', apply: true, autoPublish: true });
    expect(runImport.mock.calls[0][0]).toMatchObject({ noAutoPublish: false });
  });

  test('a connector/source failure is caught (does not throw) and reported', async () => {
    db.query.mockResolvedValue({ rows: [] });
    runImport.mockRejectedValueOnce(new Error('connector unreachable'));
    const r = await worker.runOneSource(SRC(), { trigger: 'scheduled', scheduledFor: '2026-08-03', apply: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/connector unreachable/);
  });

  test('a lost scheduled claim (another replica owns it) is surfaced, not an error', async () => {
    db.query.mockResolvedValue({ rows: [] });
    runImport.mockResolvedValueOnce({ claimed: false, reason: 'run_claim_lost' });
    const r = await worker.runOneSource(SRC(), { trigger: 'scheduled', scheduledFor: '2026-08-03', apply: true });
    expect(r.ok).toBe(true);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('run_claim_lost');
  });

  test('weekly cap result is passed through (capped surfaced)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    runImport.mockResolvedValueOnce(okResult({ capped: true, remainingAvailable: 0, counters: { created: 2, updated: 0, skipped_duplicate: 0, skipped_quality: 0, skipped_ambiguous: 0, failed: 0 } }));
    const r = await worker.runOneSource(SRC({ weekly_cap: 2 }), { trigger: 'scheduled', scheduledFor: '2026-08-03', apply: true });
    expect(r.capped).toBe(true);
    expect(r.counters.created).toBe(2);
  });

  test('manual/dry runs skip the stale-run reaper', async () => {
    runImport.mockResolvedValueOnce(okResult({ applied: false, claimed: undefined }));
    await worker.runOneSource(SRC(), { trigger: 'manual', apply: false });
    // no reap query issued (db.query only used inside reapStaleRun for scheduled+apply)
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ── crash recovery: reap stale running runs ──────────────────────────────────
describe('reapStaleRun', () => {
  test('marks a stale running scheduled run as failed (visibility) and counts it', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'STALE1' }] });
    const n = await worker.reapStaleRun('src-1', '2026-08-03');
    expect(n).toBe(1);
    expect(db.query.mock.calls[0][0]).toMatch(/status = 'running'[\s\S]*make_interval/);
    expect(runLog.finishRun).toHaveBeenCalledTimes(1);
    expect(runLog.finishRun.mock.calls[0][2]).toMatchObject({ status: 'failed' });
  });
  test('no stale runs → nothing reaped', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await worker.reapStaleRun('src-1', '2026-08-03')).toBe(0);
    expect(runLog.finishRun).not.toHaveBeenCalled();
  });
});

// ── full cycle: partial failure isolation + audit ────────────────────────────
describe('runScheduledCycle', () => {
  test('continues after one source fails; audits a PARTIAL cycle', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [SRC({ key: 'a' }), SRC({ id: 'src-2', key: 'b' })] }) // activeSources
      .mockResolvedValue({ rows: [] }); // subsequent reapStaleRun queries
    runImport
      .mockResolvedValueOnce(okResult({ counters: { created: 2, updated: 0, skipped_duplicate: 1, skipped_quality: 0, skipped_ambiguous: 0, failed: 0 } }))
      .mockRejectedValueOnce(new Error('source b down'));
    const summary = await worker.runScheduledCycle('2026-08-03', { apply: true });
    expect(summary.sources_total).toBe(2);
    expect(summary.sources_failed).toBe(1);
    expect(summary.counts).toMatchObject({ imported: 2, duplicates: 1, errors: 1 });
    expect(runImport).toHaveBeenCalledTimes(2); // second source still attempted
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0].event_type).toBe('event_import_cycle_partial');
  });

  test('all sources succeed → audits a COMPLETED cycle with aggregate counts', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [SRC({ key: 'a' }), SRC({ id: 'src-2', key: 'b' })] })
      .mockResolvedValue({ rows: [] });
    runImport
      .mockResolvedValueOnce(okResult({ counters: { created: 2, updated: 1, skipped_duplicate: 0, skipped_quality: 1, skipped_ambiguous: 0, failed: 0 } }))
      .mockResolvedValueOnce(okResult({ counters: { created: 3, updated: 0, skipped_duplicate: 2, skipped_quality: 0, skipped_ambiguous: 1, failed: 0 } }));
    const summary = await worker.runScheduledCycle('2026-08-03', { apply: true });
    expect(summary.counts).toEqual({ imported: 5, updated: 1, skipped: 2, duplicates: 2, errors: 0 });
    expect(summary.sources_failed).toBe(0);
    expect(writeAuditLog.mock.calls[0][0].event_type).toBe('event_import_cycle_completed');
    expect(writeAuditLog.mock.calls[0][0].entity_type).toBe('event_import_scheduler');
  });

  test('a dry-run cycle writes no scheduler audit row', async () => {
    db.query.mockResolvedValueOnce({ rows: [SRC()] }).mockResolvedValue({ rows: [] });
    runImport.mockResolvedValueOnce(okResult({ applied: false }));
    await worker.runScheduledCycle(null, { apply: false, trigger: 'manual' });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

// ── summaries ────────────────────────────────────────────────────────────────
describe('summarize', () => {
  test('aggregates imported/updated/skipped/duplicates/errors and per-source detail', () => {
    const s = worker.summarize('2026-08-03', Date.now() - 10, [
      { source: 'a', ok: true, status: 'completed', runId: 'R1', counters: { created: 4, updated: 2, skipped_duplicate: 3, skipped_quality: 1, skipped_ambiguous: 1, failed: 1 } },
      { source: 'b', ok: false, error: 'boom', counters: {} },
    ]);
    expect(s.counts).toEqual({ imported: 4, updated: 2, skipped: 2, duplicates: 3, errors: 2 }); // failed(1)+source-failure(1)
    expect(s.sources_total).toBe(2);
    expect(s.sources_failed).toBe(1);
    expect(typeof s.duration_ms).toBe('number');
    expect(s.sources[1]).toMatchObject({ source: 'b', ok: false, error: 'boom' });
  });
});

// ── scheduled execution + idempotency (tick) ─────────────────────────────────
describe('tick — scheduled execution + duplicate prevention', () => {
  const MON_0330_ET = new Date('2026-08-03T07:30:00Z'); // Monday 03:30 ET → hour 3 (daily default: DUE)
  const TUE_0530_ET = new Date('2026-08-04T09:30:00Z'); // Tuesday 05:30 ET → hour 5 (NOT the scheduled hour)
  // Safe rows so the always-on health check completes cleanly in these hermetic mocks.
  const HEALTH_ROW = { rows: [{ t: null, n: 0, status: 'completed', started_at: null }] };

  test('does not IMPORT when disabled (health monitoring may still run)', async () => {
    delete process.env.EVENT_IMPORT_WORKER_ENABLED;
    db.query.mockResolvedValue(HEALTH_ROW);
    await worker.tick(MON_0330_ET);
    expect(runImport).not.toHaveBeenCalled(); // the import cycle is gated off
  });

  test('does not IMPORT when enabled but not due (wrong hour)', async () => {
    process.env.EVENT_IMPORT_WORKER_ENABLED = 'true';
    db.query.mockResolvedValue(HEALTH_ROW);
    await worker.tick(TUE_0530_ET);
    expect(runImport).not.toHaveBeenCalled();
    delete process.env.EVENT_IMPORT_WORKER_ENABLED;
  });

  test('runs the cycle when enabled + due (daily), and NOT again for the same date (idempotent)', async () => {
    process.env.EVENT_IMPORT_WORKER_ENABLED = 'true';
    db.query.mockImplementation((sql) => (/FROM import_sources WHERE status = 'active'/.test(sql) ? { rows: [] } : HEALTH_ROW));
    await worker.tick(MON_0330_ET);
    const sourceCalls = db.query.mock.calls.filter((c) => /import_sources WHERE status = 'active'/.test(c[0])).length;
    expect(sourceCalls).toBe(1);                   // the cycle queried active sources once
    await worker.tick(MON_0330_ET);                // same ET date → guarded, no second cycle
    const sourceCalls2 = db.query.mock.calls.filter((c) => /import_sources WHERE status = 'active'/.test(c[0])).length;
    expect(sourceCalls2).toBe(1);                  // still 1 — no second cycle
    delete process.env.EVENT_IMPORT_WORKER_ENABLED;
  });
});

// ── manual / dry-run service API ─────────────────────────────────────────────
describe('runNow / runAllNow', () => {
  test('runNow defaults to a DRY RUN (apply=false) for one source', async () => {
    db.query.mockResolvedValueOnce({ rows: [SRC()] }); // source lookup
    runImport.mockResolvedValueOnce(okResult({ applied: false, claimed: undefined }));
    const r = await worker.runNow({ sourceKey: 'aac-csv' });
    expect(r.ok).toBe(true);
    expect(runImport.mock.calls[0][0]).toMatchObject({ apply: false, trigger: 'manual', noAutoPublish: true });
  });
  test('runNow throws on an unknown source', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(worker.runNow({ sourceKey: 'nope' })).rejects.toThrow(/Unknown import source/);
  });
});
