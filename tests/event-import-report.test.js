'use strict';

/**
 * Event-import owner reporting — classification + email criteria. The whole point of this fix:
 * "zero new events" is NOT a failure, and inventory-below-an-aspirational-target does not generate a
 * daily "importer failing" email — while genuine pipeline failures still alert.
 */
const rpt = require('../src/services/eventImport/reportEmail');

// Helper: build a summary like eventImportWorker.summarize() produces.
function summary(sources) {
  const agg = { imported: 0, updated: 0, skipped: 0, duplicates: 0, errors: 0 };
  for (const r of sources) {
    const c = r.counters || {};
    agg.imported += c.created || 0; agg.updated += c.updated || 0;
    agg.skipped += (c.skipped_quality || 0) + (c.skipped_ambiguous || 0);
    agg.duplicates += c.skipped_duplicate || 0; agg.errors += c.failed || 0;
    if (r.ok === false) agg.errors += 1;
  }
  return {
    started_at: '2026-08-30T07:00:00Z', finished_at: '2026-08-30T07:02:00Z', duration_ms: 120000,
    sources_total: sources.length, sources_ok: sources.filter((r) => r.ok !== false).length,
    sources_failed: sources.filter((r) => r.ok === false).length, counts: agg, sources,
  };
}
const src = (key, c, ok = true, error = null) => ({ source: key, ok, error, counters: c || {} });

describe('classifyRun', () => {
  test('SUCCESSFUL NEW IMPORT (discovered>0, new>0) → SUCCESS', () => {
    expect(rpt.classifyRun(summary([src('gsa', { fetched: 36, created: 11, skipped_duplicate: 25 })]))).toBe('SUCCESS');
  });
  test('UPDATE-ONLY run (new=0, updated>0) → SUCCESS (not failure)', () => {
    expect(rpt.classifyRun(summary([src('tx', { fetched: 14, created: 0, updated: 2, skipped_duplicate: 12 })]))).toBe('SUCCESS');
  });
  test('NO-CHANGE run (new=0, updated=0, unchanged>0) → NO NEW EVENTS (not failure)', () => {
    expect(rpt.classifyRun(summary([src('es', { fetched: 58, created: 0, updated: 0, skipped_duplicate: 58 })]))).toBe('NO NEW EVENTS');
  });
  test('SOURCE RETURNS ZERO → NO NEW EVENTS (healthy, clearly not a software failure)', () => {
    expect(rpt.classifyRun(summary([src('es', { fetched: 0 })]))).toBe('NO NEW EVENTS');
  });
  test('ONE SOURCE FAILS / ANOTHER SUCCEEDS → PARTIAL FAILURE', () => {
    const s = summary([src('gsa', { fetched: 10, created: 3 }), src('tx', {}, false, 'HTTP 403')]);
    expect(rpt.classifyRun(s)).toBe('PARTIAL FAILURE');
    expect(s.sources_ok).toBe(1); // the healthy source is still counted/processed
  });
  test('ALL SOURCES FAIL → FAILED', () => {
    expect(rpt.classifyRun(summary([src('gsa', {}, false, 'timeout'), src('tx', {}, false, 'HTTP 429')]))).toBe('FAILED');
  });
});

describe('emailableCriticals — only genuine pipeline failures email (below-target does NOT)', () => {
  const A = (level, code) => ({ level, code, message: code });
  test('inventory below aspirational target is NOT emailed', () => {
    expect(rpt.emailableCriticals([A('critical', 'auctions_critical')])).toEqual([]);
    expect(rpt.emailableCriticals([A('warn', 'auctions_below_target')])).toEqual([]);
    expect(rpt.emailableCriticals([A('warn', 'low_estate_sales')])).toEqual([]);
  });
  test('genuine pipeline failures ARE emailed', () => {
    const codes = rpt.emailableCriticals([
      A('critical', 'missed_window'), A('critical', 'run_failed'),
      A('critical', 'low_total_inventory'), A('critical', 'auctions_critical'), A('warn', 'low_auctions'),
    ]).map((a) => a.code);
    expect(codes).toEqual(['missed_window', 'run_failed', 'low_total_inventory']); // auctions_critical + warns excluded
  });
});

describe('buildRunSummaryEmail', () => {
  test('subject states the outcome; body carries the breakdown + per-source lines', () => {
    const s = summary([
      src('gsa-auctions', { fetched: 36, created: 11, updated: 1, skipped_duplicate: 24 }),
      src('estatesales-national', { fetched: 58, created: 0, updated: 0, skipped_duplicate: 58 }),
    ]);
    const { subject, text } = rpt.buildRunSummaryEmail(s);
    expect(subject).toBe('Advantage.Bid Event Import — SUCCESS');
    expect(text).toContain('New imported:      11');
    expect(text).toContain('Existing updated:  1');
    expect(text).toContain('gsa-auctions: fetched 36, new 11');
    expect(text).toContain('estatesales-national: fetched 58, new 0');
  });
  test('a NO-NEW-EVENTS run reassures instead of alarming', () => {
    const { subject, text } = rpt.buildRunSummaryEmail(summary([src('es', { fetched: 58, skipped_duplicate: 58 })]));
    expect(subject).toBe('Advantage.Bid Event Import — NO NEW EVENTS');
    expect(text).toContain('healthy run');
    expect(text).toContain('No action needed');
  });
  test('a failed source shows a concise reason (never a stack trace)', () => {
    const { subject, text } = rpt.buildRunSummaryEmail(summary([src('tx', {}, false, 'Error: connect ETIMEDOUT 1.2.3.4:443 at TCPConnectWrap')]));
    expect(subject).toBe('Advantage.Bid Event Import — FAILED');
    expect(text).toContain('tx: FAILED — timeout');
    expect(text).not.toContain('TCPConnectWrap');
  });
});
