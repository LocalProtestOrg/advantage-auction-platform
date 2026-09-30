'use strict';

/**
 * 4e: the Director baseline snapshot refreshes on a schedule (it was only ever captured by the manual
 *     Super Admin button, so it froze at 2026-09-07).
 * 4f: the marketing-agency buyer-inventory posture counts inventory with the CANONICAL public-visibility
 *     predicates (src/lib/marketplaceVisibility.js): past events and demo auctions never count.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../src/db', () => ({ query: jest.fn() }));

const baseline = require('../src/services/baselineReportService');
const execution = require('../src/services/paidGrowth/paidExecutionService');
const mv = require('../src/lib/marketplaceVisibility');

function runner(handler) {
  const calls = [];
  return { calls, query: jest.fn(async (sql, params) => { calls.push({ sql, params }); return handler(sql, params) || { rows: [] }; }) };
}

describe('4e: scheduled Director baseline snapshot', () => {
  test('a snapshot is taken when the newest one is older than 24 hours', async () => {
    const r = runner((sql) => {
      if (/max\(captured_at\)/.test(sql)) return { rows: [{ at: '2026-09-07T14:41:15Z' }] };
      if (/SELECT count/.test(sql) || /::numeric v/.test(sql)) return { rows: [{ v: 1 }] };
      return { rows: [] };
    });
    const out = await baseline.snapshotIfDue({ maxAgeHours: 24, runner: r });
    expect(out.taken).toBe(true);
    const inserts = r.calls.filter((c) => /INSERT INTO marketing_baselines/.test(c.sql));
    expect(inserts.length).toBe(baseline.metricDefs().length);
    expect(r.calls.some((c) => /UPDATE marketing_baselines|DELETE FROM marketing_baselines/.test(c.sql))).toBe(false);   // history immutable
  });

  test('no duplicate when a snapshot was taken within the window (restart-safe)', async () => {
    const r = runner((sql) => (/max\(captured_at\)/.test(sql) ? { rows: [{ at: new Date(Date.now() - 3600 * 1000).toISOString() }] } : { rows: [] }));
    const out = await baseline.snapshotIfDue({ maxAgeHours: 24, runner: r });
    expect(out.taken).toBe(false);
    expect(r.calls.some((c) => /INSERT INTO marketing_baselines/.test(c.sql))).toBe(false);
  });

  test('the first-ever snapshot is taken when none exists', async () => {
    const r = runner((sql) => (/max\(captured_at\)/.test(sql) ? { rows: [{ at: null }] } : { rows: [{ v: 0 }] }));
    expect((await baseline.snapshotIfDue({ runner: r })).taken).toBe(true);
  });

  test('the production marketing refresh worker schedules the baseline pass', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'marketingRefreshWorker.js'), 'utf8');
    expect(src).toMatch(/async function baselinePass/);
    expect(src).toMatch(/snapshotIfDue\(\{ maxAgeHours: 24 \}\)/);
    expect(src).toMatch(/setInterval\(baselinePass,/);
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(server).toMatch(/spawnWorker\(path\.join\(__dirname, 'src\/workers\/marketingRefreshWorker\.js'\)\)/);
  });
});

describe('4f: buyer inventory uses the canonical marketplace visibility counts', () => {
  test('the query embeds the canonical predicates for auctions, lots and events', async () => {
    const r = runner(() => ({ rows: [{ live_auctions: 0, live_lots: 0, live_events: 49, live_estate_sales: 0 }] }));
    await execution.buyerInventory({ runner: r });
    const sql = r.calls[0].sql;
    expect(sql).toContain(mv.activeNativeAuctionSql('a'));   // includes is_demo exclusion
    expect(sql).toContain(mv.activeEventSql('e'));           // includes the end_at >= now() cut-off
    expect(sql).toContain(mv.eventKindSql('e'));
    expect(sql).not.toMatch(/COALESCE\(status,''\) = 'published'\) AS live_events/);   // the old, uncut count
  });

  test('posture and counts reflect only publicly visible inventory', async () => {
    const r = runner(() => ({ rows: [{ live_auctions: 0, live_lots: 0, live_events: 49, live_estate_sales: 0 }] }));
    const inv = await execution.buyerInventory({ runner: r });
    expect(inv).toMatchObject({ live_auctions: 0, live_events: 49, live_estate_sales: 0, counts_source: 'marketplaceVisibility', posture: 'DISCOVERY_ONLY' });
  });
});
