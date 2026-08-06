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

describe('inventorySnapshot — computes active counts + run health', () => {
  test('counts active by type and reads last run', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ sale_type: 'auction', n: 2 }, { sale_type: 'estate_sale', n: 3 }] }) // active by type
      .mockResolvedValueOnce({ rows: [{ t: HRS(5) }] })   // last success
      .mockResolvedValueOnce({ rows: [{ t: HRS(1) }] })   // last attempt
      .mockResolvedValueOnce({ rows: [{ trigger: 'scheduled', status: 'completed', created: 4 }] }); // last run
    const snap = await health.inventorySnapshot(db);
    expect(snap).toMatchObject({ active_auctions: 2, active_estate_sales: 3, total_active_public: 5 });
    expect(snap.last_run).toMatchObject({ trigger: 'scheduled', status: 'completed' });
    // the active-inventory query respects the public date gate
    expect(db.query.mock.calls[0][0]).toMatch(/status = 'published' AND \(end_at IS NULL OR end_at >= now\(\)\)/);
  });
});
