'use strict';

// Event-inventory health: pure alert evaluation + the snapshot query shape. Hermetic (db mocked).

jest.mock('../../src/db', () => ({ query: jest.fn() }));
const db = require('../../src/db');
const health = require('../../src/services/eventImport/health');

const NOW = new Date('2026-08-06T12:00:00Z').getTime();
const HRS = (h) => new Date(NOW - h * 3.6e6).toISOString();

describe('thresholds — conservative + env-overridable', () => {
  test('defaults are low (derived from actual recovered inventory), overridable via env', () => {
    const d = health.thresholds({});
    expect(d.minTotalActive).toBe(3);
    expect(d.staleRunHours).toBe(36);
    expect(health.thresholds({ EVENT_MIN_TOTAL_ACTIVE: '10', EVENT_IMPORT_STALE_HOURS: '24' }))
      .toMatchObject({ minTotalActive: 10, staleRunHours: 24 });
  });
});

describe('evaluateAlerts — fail conditions', () => {
  const healthy = { active_auctions: 5, active_estate_sales: 5, total_active_public: 10, last_success_run: HRS(2), last_run: { status: 'completed' } };
  test('healthy inventory → no alerts', () => {
    expect(health.evaluateAlerts(healthy, health.thresholds({}), { now: NOW })).toEqual([]);
  });
  test('stale import (>36h since last success) → critical', () => {
    const a = health.evaluateAlerts(Object.assign({}, healthy, { last_success_run: HRS(40) }), health.thresholds({}), { now: NOW });
    expect(a.find((x) => x.code === 'stale_import' && x.level === 'critical')).toBeTruthy();
  });
  test('never-succeeded import → critical stale', () => {
    const a = health.evaluateAlerts(Object.assign({}, healthy, { last_success_run: null }), health.thresholds({}), { now: NOW });
    expect(a.some((x) => x.code === 'stale_import')).toBe(true);
  });
  test('last run FAILED → critical', () => {
    const a = health.evaluateAlerts(Object.assign({}, healthy, { last_run: { status: 'failed', started_at: HRS(1) } }), health.thresholds({}), { now: NOW });
    expect(a.find((x) => x.code === 'run_failed' && x.level === 'critical')).toBeTruthy();
  });
  test('total active below threshold → critical low_total_inventory', () => {
    const a = health.evaluateAlerts(Object.assign({}, healthy, { total_active_public: 2 }), health.thresholds({}), { now: NOW });
    expect(a.find((x) => x.code === 'low_total_inventory' && x.level === 'critical')).toBeTruthy();
  });
  test('zero auctions / estate sales → warn', () => {
    const a = health.evaluateAlerts(Object.assign({}, healthy, { active_auctions: 0, active_estate_sales: 0 }), health.thresholds({}), { now: NOW });
    expect(a.some((x) => x.code === 'low_auctions')).toBe(true);
    expect(a.some((x) => x.code === 'low_estate_sales')).toBe(true);
  });
  test('sharp day-over-day drop → warn', () => {
    const a = health.evaluateAlerts(Object.assign({}, healthy, { total_active_public: 3 }), health.thresholds({}), { now: NOW, prior: { total_active_public: 100 } });
    expect(a.find((x) => x.code === 'sharp_drop')).toBeTruthy();
  });
});

describe('schedule-aware freshness (twice-weekly) — missed_window replaces fixed staleRunHours', () => {
  const healthy = { active_auctions: 5, active_estate_sales: 5, total_active_public: 10, last_success_run: HRS(2), last_run: { status: 'completed' } };
  // Twice-weekly gaps are 3–4 days; a fixed 36h stale check must NOT fire when a scheduled window is supplied.
  test('60h since last success but BEFORE the last expected window → no missed_window (healthy gap)', () => {
    const window = HRS(1); // most recent Mon/Thu window was 1h ago
    const a = health.evaluateAlerts(Object.assign({}, healthy, { last_success_run: HRS(60) }), health.thresholds({}), { now: NOW, expectedWindow: window, expectedWindowLabel: 'Thursday' });
    expect(a.some((x) => x.code === 'stale_import')).toBe(false); // fixed check is bypassed when a window is given
    expect(a.some((x) => x.code === 'missed_window')).toBe(false); // within grace of the just-passed window
  });
  test('a scheduled window passed (+grace) with no successful run since → critical missed_window', () => {
    const window = HRS(12); // window was 12h ago, > 6h grace
    const a = health.evaluateAlerts(Object.assign({}, healthy, { last_success_run: HRS(80) }), health.thresholds({}), { now: NOW, expectedWindow: window, expectedWindowLabel: 'Monday' });
    expect(a.find((x) => x.code === 'missed_window' && x.level === 'critical')).toBeTruthy();
  });
  test('within grace after the window → no missed_window yet', () => {
    const window = HRS(3); // 3h ago, < 6h grace
    const a = health.evaluateAlerts(Object.assign({}, healthy, { last_success_run: HRS(80) }), health.thresholds({}), { now: NOW, expectedWindow: window });
    expect(a.some((x) => x.code === 'missed_window')).toBe(false);
  });
  test('worker disabled → warn worker_disabled (surfaced, not emailed)', () => {
    const a = health.evaluateAlerts(healthy, health.thresholds({}), { now: NOW, workerEnabled: false });
    const wd = a.find((x) => x.code === 'worker_disabled');
    expect(wd).toBeTruthy();
    expect(wd.level).toBe('warn');
  });
  test('zero-created / duplicate-only run is NOT a failure (status completed → no run_failed)', () => {
    const a = health.evaluateAlerts(Object.assign({}, healthy, { last_run: { status: 'completed', created: 0 } }), health.thresholds({}), { now: NOW, expectedWindow: HRS(1) });
    expect(a.some((x) => x.code === 'run_failed')).toBe(false);
  });
});

describe('inventorySnapshot — computes active counts + run health', () => {
  test('counts active by type and reads last run', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ sale_type: 'auction', n: 2 }, { sale_type: 'estate_sale', n: 3 }] }) // active by type
      .mockResolvedValueOnce({ rows: [{ n: 4 }] })         // native active auctions
      .mockResolvedValueOnce({ rows: [{ t: HRS(5) }] })   // last success
      .mockResolvedValueOnce({ rows: [{ t: HRS(1) }] })   // last attempt
      .mockResolvedValueOnce({ rows: [{ trigger: 'scheduled', status: 'completed', created: 4 }] }); // last run
    const snap = await health.inventorySnapshot(db);
    expect(snap).toMatchObject({ active_auctions: 2, active_estate_sales: 3, total_active_public: 5 });
    // separated auction inventory: external (events) + native (auctions), with target status
    expect(snap).toMatchObject({ external_auctions: 2, native_auctions: 4, total_public_auctions: 6 });
    expect(snap.auction_inventory).toMatchObject({ status: 'CRITICAL', target: 100 }); // 2 external < 50
    expect(snap.last_run).toMatchObject({ trigger: 'scheduled', status: 'completed' });
    // the active-inventory query respects the canonical public visibility predicate (alias-agnostic)
    expect(db.query.mock.calls[0][0]).toMatch(/\.status = 'published' AND \([\w.]*end_at IS NULL OR [\w.]*end_at >= now\(\)\)/);
  });
});
