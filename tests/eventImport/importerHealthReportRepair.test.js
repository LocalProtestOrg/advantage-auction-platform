'use strict';

/**
 * Regression tests for the 2026-09-11 importer health audit:
 *   1. lastExpectedWindow must return the TOP of the scheduled hour. Walking back whole hours kept the
 *      caller's minutes, so a 03:04 ET run was compared against an 03:32 "window" and every later health
 *      check reported missed_window — which emailed the Owner a false "no successful import" alert daily.
 *   2. No emailable critical when the scheduled run succeeded inside its window (and still one when it did not).
 *   3. The run-summary email must distinguish a frozen manual CSV export from a healthy "nothing new" run,
 *      show the live inventory, and say WHY records were rejected.
 *   4. A failed source is reported concisely and never hides the healthy ones.
 */
const worker = require('../../src/workers/eventImportWorker');
const health = require('../../src/services/eventImport/health');
const reportEmail = require('../../src/services/eventImport/reportEmail');

const TW = { enabled: true, days: [1, 4], daily: false, weekday: 1, hour: 3 };   // Mon & Thu 03:00 ET

describe('scheduled window is the top of the hour (missed_window regression)', () => {
  test.each([
    ['2026-09-12T03:32:52Z', '2026-09-10T07:00:00.000Z'],   // Fri 23:32 ET → Thu 10 Sep 03:00 ET
    ['2026-09-12T03:00:00Z', '2026-09-10T07:00:00.000Z'],   // exact hour still works
    ['2026-09-14T07:59:59Z', '2026-09-14T07:00:00.000Z'],   // inside Monday's own window
  ])('from %s the last window is %s', (now, expected) => {
    const lw = worker.lastExpectedWindow(TW, new Date(now));
    expect(lw.iso).toBe(expected);
    expect(worker.etNow(lw.at)).toMatchObject({ hour: 3 });
    expect(lw.at.getUTCMinutes()).toBe(0);
    expect(lw.at.getUTCSeconds()).toBe(0);
  });

  test('a run that completed minutes after the window is NOT missed (no Owner email)', () => {
    const now = new Date('2026-09-12T03:32:52Z');
    const lw = worker.lastExpectedWindow(TW, now);
    const snap = { last_success_run: '2026-09-10T07:04:20.354Z', total_active_public: 51, active_auctions: 50, active_estate_sales: 1,
      auction_inventory: { external_active_auctions: 50, target: 100, low_threshold: 50, status: 'LOW' }, last_run: { status: 'completed' } };
    const alerts = health.evaluateAlerts(snap, health.thresholds(), { expectedWindow: lw.iso, expectedWindowLabel: lw.label, workerEnabled: true, now: now.getTime() });
    expect(alerts.map((a) => a.code)).not.toContain('missed_window');
    expect(reportEmail.emailableCriticals(alerts)).toEqual([]);
  });

  test('a genuinely missed window still alerts and still emails', () => {
    const now = new Date('2026-09-12T03:32:52Z');
    const lw = worker.lastExpectedWindow(TW, now);
    const snap = { last_success_run: '2026-09-07T07:04:00Z', total_active_public: 51, active_auctions: 50, active_estate_sales: 1, last_run: { status: 'completed' } };
    const alerts = health.evaluateAlerts(snap, health.thresholds(), { expectedWindow: lw.iso, expectedWindowLabel: lw.label, workerEnabled: true, now: now.getTime() });
    expect(alerts.map((a) => a.code)).toContain('missed_window');
    expect(reportEmail.emailableCriticals(alerts).map((a) => a.code)).toEqual(['missed_window']);
  });

  test('a failed last run and an inventory collapse remain emailable; below-target alone never emails', () => {
    const base = { last_success_run: new Date().toISOString(), total_active_public: 51, active_auctions: 50, active_estate_sales: 1,
      auction_inventory: { external_active_auctions: 50, target: 100, low_threshold: 50, status: 'LOW' } };
    const failed = health.evaluateAlerts(Object.assign({}, base, { last_run: { status: 'failed', started_at: 'x' } }), health.thresholds(), { workerEnabled: true });
    expect(reportEmail.emailableCriticals(failed).map((a) => a.code)).toContain('run_failed');
    const collapsed = health.evaluateAlerts(Object.assign({}, base, { total_active_public: 0, last_run: { status: 'completed' } }), health.thresholds(), { workerEnabled: true });
    expect(reportEmail.emailableCriticals(collapsed).map((a) => a.code)).toContain('low_total_inventory');
    const healthy = health.evaluateAlerts(Object.assign({}, base, { last_run: { status: 'completed' } }), health.thresholds(), { workerEnabled: true });
    expect(healthy.map((a) => a.code)).toContain('auctions_below_target');
    expect(reportEmail.emailableCriticals(healthy)).toEqual([]);
  });
});

describe('run-summary email tells the Owner what actually happened', () => {
  const csvSource = { source: 'estatesales-national', ok: true, kind: 'csv', counters: { fetched: 58, created: 0, updated: 0, skipped_duplicate: 58 } };
  const liveSource = { source: 'gsa-auctions', ok: true, kind: 'rest', counters: { fetched: 43, created: 9, updated: 0, skipped_duplicate: 34 } };
  const rejecting = { source: 'txauction-gov', ok: true, kind: 'rest', counters: { fetched: 9, created: 1, skipped_duplicate: 7, skipped_quality: 1 }, reasons: { 'rejected_quality:missing:location': 1 } };
  const inventory = { active_auctions: 50, active_estate_sales: 1, total_active_public: 51, auction_inventory: { status: 'LOW', target: 100 }, last_success_run: '2026-09-14T07:04:00Z' };

  test('a frozen manual CSV export is called out, not reported as a healthy nothing-new source', () => {
    expect(reportEmail.isStaleManualCsv(csvSource)).toBe(true);
    expect(reportEmail.isStaleManualCsv(liveSource)).toBe(false);
    expect(reportEmail.isStaleManualCsv(Object.assign({}, csvSource, { counters: { fetched: 58, created: 3, updated: 0 } }))).toBe(false);
    expect(reportEmail.isStaleManualCsv(Object.assign({}, csvSource, { ok: false, error: 'boom' }))).toBe(false);
    const msg = reportEmail.buildRunSummaryEmail({ counts: { imported: 9 }, sources_total: 2, sources_failed: 0, sources: [liveSource, csvSource], inventory });
    expect(msg.text).toMatch(/MANUAL EXPORT/);
    expect(msg.text).toMatch(/cannot add new events until a fresh export/);
  });

  test('the live inventory the Owner judges the feed by is included', () => {
    const msg = reportEmail.buildRunSummaryEmail({ counts: { imported: 9 }, sources_total: 1, sources_failed: 0, sources: [liveSource], inventory });
    expect(msg.text).toMatch(/Live public inventory/);
    expect(msg.text).toMatch(/Auction events:\s+50 \(LOW vs target 100\)/);
    expect(msg.text).toMatch(/Total active:\s+51/);
    expect(reportEmail.inventoryLines(null)).toEqual([]);
  });

  test('rejections say why, per source', () => {
    expect(reportEmail.reasonSummary({ 'rejected_quality:missing:location': 3, 'ambiguous:fingerprint_multi': 1 })).toBe('3 quality:missing:location, 1 ambiguous:fingerprint multi');
    expect(reportEmail.reasonSummary({})).toBe('');
    const msg = reportEmail.buildRunSummaryEmail({ counts: { imported: 1 }, sources_total: 1, sources_failed: 0, sources: [rejecting], inventory });
    expect(msg.text).toMatch(/why: 1 quality:missing:location/);
  });

  test('states stay correct: SUCCESS / NO NEW EVENTS / PARTIAL FAILURE / FAILED', () => {
    expect(reportEmail.classifyRun({ counts: { imported: 1 }, sources_total: 2, sources_failed: 0 })).toBe('SUCCESS');
    expect(reportEmail.classifyRun({ counts: { imported: 0, updated: 0 }, sources_total: 2, sources_failed: 0 })).toBe('NO NEW EVENTS');
    expect(reportEmail.classifyRun({ counts: { imported: 5 }, sources_total: 3, sources_failed: 1 })).toBe('PARTIAL FAILURE');
    expect(reportEmail.classifyRun({ counts: {}, sources_total: 2, sources_failed: 2 })).toBe('FAILED');
  });

  test('a failed source shows a concise reason and never a stack trace', () => {
    const msg = reportEmail.buildRunSummaryEmail({ counts: {}, sources_total: 2, sources_failed: 1, inventory,
      sources: [liveSource, { source: 'dead-source', ok: false, kind: 'rest', error: 'Error: request failed with status 403\n  at fetch (x)' }] });
    expect(msg.subject).toBe('Advantage.Bid Event Import — PARTIAL FAILURE');
    expect(msg.text).toMatch(/dead-source: FAILED — HTTP 403 \(blocked\)/);
    expect(msg.text).not.toMatch(/at fetch/);
    expect(msg.text).toMatch(/gsa-auctions: fetched 43, new 9/);   // the healthy source is still reported
  });
});
