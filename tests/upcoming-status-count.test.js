'use strict';

/**
 * "Upcoming" legend count is cross-family: all public UPCOMING events (native auctions + partner/imported
 * events), computed authoritatively in canonicalCounts with the SAME public-visibility predicate, deduped
 * by design (separate tables), and never counting draft/hidden/demo/expired records. Live Now / Ending Soon
 * semantics are preserved (native map beacons).
 */
const fs = require('fs');
const path = require('path');
const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// A regex-routed mock db so canonicalCounts runs offline. Order matters (most specific first).
function mockDb(counts) {
  const rec = [];
  return {
    _sql: rec,
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim(); rec.push(s);
      if (/FROM events.*start_at > now\(\)/.test(s)) return { rows: [{ n: counts.eventUpcoming }] };
      if (/FROM events.*GROUP BY/.test(s)) return { rows: counts.eventKinds || [] };
      if (/FROM auctions.*state = 'published'/.test(s)) return { rows: [{ n: counts.nativeUpcoming }] };
      if (/FROM auctions /.test(s)) return { rows: [{ n: counts.nativeTotal || 0 }] };
      if (/profession_id/.test(s)) return { rows: counts.prof || [] };
      if (/FROM marketplace_items/.test(s)) return { rows: [{ n: counts.mktItems || 0 }] };
      return { rows: [{ n: 0 }] };
    },
  };
}
const { canonicalCounts, activeEventSql, activeNativeAuctionSql } = require('../src/lib/marketplaceVisibility');

describe('canonicalCounts.statuses.upcoming (cross-family)', () => {
  test('CASE 1 — 0 native upcoming + 10 partner upcoming → Upcoming = 10', async () => {
    const c = await canonicalCounts(mockDb({ nativeUpcoming: 0, eventUpcoming: 10 }));
    expect(c.statuses.upcoming).toBe(10);
  });
  test('CASE 2 — 5 native + 10 partner upcoming → Upcoming = 15 (summed once, distinct tables)', async () => {
    const c = await canonicalCounts(mockDb({ nativeUpcoming: 5, eventUpcoming: 10 }));
    expect(c.statuses).toEqual({ upcoming: 15, native_upcoming: 5, event_upcoming: 10 });
  });
  test('CASE 3 — 5 native + (10 partner, only 4 future) → Upcoming = 9 (SQL start_at>now filters)', async () => {
    // The DB returns only the FUTURE-start rows for the upcoming query (4), never all 10.
    const c = await canonicalCounts(mockDb({ nativeUpcoming: 5, eventUpcoming: 4 }));
    expect(c.statuses.upcoming).toBe(9);
  });
  test('CASE 4 — draft/hidden/demo/expired excluded by the visibility predicate (returns 0)', async () => {
    const db = mockDb({ nativeUpcoming: 0, eventUpcoming: 0 });
    const c = await canonicalCounts(db);
    expect(c.statuses.upcoming).toBe(0);
    // The upcoming EVENT query carries the public predicate AND the not-yet-started rule.
    const upSql = db._sql.find((s) => /FROM events.*start_at > now\(\)/.test(s));
    expect(upSql).toContain("status = 'published'");   // no draft
    expect(upSql).toContain('end_at >= now()');        // not expired
    // The upcoming NATIVE query carries the syndicated + non-demo + published predicate.
    const nSql = db._sql.find((s) => /FROM auctions.*state = 'published'/.test(s));
    expect(nSql).toContain("marketplace_status = 'syndicated'");
    expect(nSql).toContain('is_demo IS NOT TRUE');
  });
  test('CASE 5 — no double counting: native + partner come from separate tables/queries', async () => {
    const db = mockDb({ nativeUpcoming: 3, eventUpcoming: 7 });
    const c = await canonicalCounts(db);
    expect(c.statuses.upcoming).toBe(10); // 3 + 7, each queried once from its own table
    expect(db._sql.some((s) => /FROM auctions.*state = 'published'/.test(s))).toBe(true);
    expect(db._sql.some((s) => /FROM events.*start_at > now\(\)/.test(s))).toBe(true);
  });
  test('the upcoming rule reuses the shared public-visibility predicates (not a parallel definition)', () => {
    expect(activeEventSql('e')).toContain("e.status = 'published'");
    expect(activeNativeAuctionSql('a')).toContain("a.marketplace_status = 'syndicated'");
  });
});

describe('homepage wiring (CASE 6/7/8)', () => {
  test('CASE 7 — Live Now / Ending Soon still use the native map-beacon count', () => {
    expect(index).toMatch(/key === 'coming' \? \(st\.upcoming \|\| 0\) : mpAuctionCount\(key\)/);
  });
  test('CASE 6 — zero-count Upcoming still hides (shared LegendVisibility rule, unchanged)', () => {
    expect(index).toMatch(/LegendVisibility\.visibleItems/);
  });
  test('CASE 8 — the Upcoming FILTER uses the same not-yet-started rule as the count', () => {
    expect(index).toMatch(/_upcoming:\(r\.start_at\?new Date\(r\.start_at\)\.getTime\(\)>Date\.now\(\)/); // marker eligibility
    expect(index).toMatch(/r\._upcoming && MP\.statusHidden && MP\.statusHidden\.coming/);                // mpFC honors it
    expect(index).toMatch(/key==='coming' && typeof mpApplyFilter==='function'\) mpApplyFilter\(\)/);     // toggle re-filters events
  });
  test('Upcoming count is sourced from the canonical statuses endpoint, not native-only', () => {
    expect(index).toMatch(/statuses:cc\.statuses/);
    expect(index).toMatch(/st\.upcoming \|\| 0/);
  });
});
