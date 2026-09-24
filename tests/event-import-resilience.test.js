'use strict';

/**
 * Event importer resilience (2026-09-24 audit).
 *
 * Proves: a refused / unreachable / unreadable source is never recorded as a quiet "0 fetched" success;
 * per-source health and bounded retries; the overall health model keeps a supply lull apart from an
 * ingestion failure; the validator rejects a host's own test listings and placeholder date ranges; no
 * connector or image fetch presents a false identity; and the unrelated close-loop log flood is throttled.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const diagnostics = require('../src/services/eventImport/diagnostics');
const sourceHealth = require('../src/services/eventImport/sourceHealth');
const health = require('../src/services/eventImport/health');
const { validate } = require('../src/services/eventImport/validate');

// ── 1. Diagnostics: why did a run produce nothing? ─────────────────────────────────────────────

describe('zero-result diagnosis', () => {
  const run = (statuses) => { const d = diagnostics.createDiagnostics(); statuses.forEach((s, i) => d.record('https://x/' + i, s)); return d.summary(); };

  test('a refused source is blocked_by_source, not an empty listing', () => {
    expect(diagnostics.zeroReason(0, run([403, 403]))).toBe('blocked_by_source');
    expect(diagnostics.zeroReason(0, run([401]))).toBe('blocked_by_source');
  });
  test('rate limiting and outages are transient; a readable page listing nothing is a lull', () => {
    expect(diagnostics.zeroReason(0, run([429]))).toBe('rate_limited');
    expect(diagnostics.zeroReason(0, run([503, 'network']))).toBe('source_unreachable');
    expect(diagnostics.zeroReason(0, run([200, 200]))).toBe('source_listed_nothing_current');
    expect(diagnostics.zeroReason(0, run([]))).toBe('no_records');
    expect(diagnostics.TRANSIENT_ZERO_REASONS).toEqual(['rate_limited', 'source_unreachable']);
  });
  test('a pattern of unreadable pages is a parse failure; one odd page among many is not', () => {
    expect(diagnostics.zeroReason(0, run([200, 200, 'parse', 'parse']))).toBe('parse_failure');
    expect(diagnostics.zeroReason(0, run([200, 200, 200, 200, 200, 'parse']))).toBe('source_listed_nothing_current');
  });
  test('a run that produced records has no zero reason', () => {
    expect(diagnostics.zeroReason(3, run([403]))).toBeNull();
  });
  test('thrown connector errors map to the same vocabulary', () => {
    expect(diagnostics.classifyError('HTTP 403')).toEqual({ zero_reason: 'blocked_by_source', transient: false });
    expect(diagnostics.classifyError('HTTP 429')).toEqual({ zero_reason: 'rate_limited', transient: true });
    expect(diagnostics.classifyError('fetch failed: ECONNRESET')).toEqual({ zero_reason: 'source_unreachable', transient: true });
    expect(diagnostics.classifyError('Unexpected token < in JSON')).toEqual({ zero_reason: 'parse_failure', transient: false });
  });
});

// ── 2. The engine fails a refused run instead of calling it a success ──────────────────────────

describe('engine: a refused source FAILS the run', () => {
  const { runImport } = require('../src/services/eventImport');
  const fakeDb = { query: async (sql) => (/FROM import_sources WHERE key/.test(sql)
    ? { rows: [{ id: 's1', key: 'x', kind: 'rest', config: {}, weekly_cap: 10, auto_publish: false }] } : { rows: [] }) };
  const connector = (statuses) => ({ fieldMap: {}, async *fetch({ diag }) { statuses.forEach((s, i) => diag.record('https://src/' + i, s)); } });

  test('403 on every entry page → status failed, zero_reason blocked_by_source, not transient', async () => {
    const r = await runImport({ sourceKey: 'x', db: fakeDb, connector: connector([403, 403]) });
    expect(r.status).toBe('failed');
    expect(r.zero_reason).toBe('blocked_by_source');
    expect(r.transient).toBe(false);
    expect(r.lastError).toMatch(/blocked_by_source: HTTP 403 at https:\/\/src\/0/);
  });
  test('429 → failed and transient (eligible for bounded retry)', async () => {
    const r = await runImport({ sourceKey: 'x', db: fakeDb, connector: connector([429]) });
    expect(r.status).toBe('failed');
    expect(r.transient).toBe(true);
  });
  test('pages load but list nothing current → completed (a lull is not a failure)', async () => {
    const r = await runImport({ sourceKey: 'x', db: fakeDb, connector: connector([200]) });
    expect(r.status).toBe('completed');
    expect(r.zero_reason).toBe('source_listed_nothing_current');
  });
  test('every connector receives the diagnostics channel', () => {
    for (const f of ['lmauctionConnector', 'txauctionConnector', 'gsaConnector']) {
      expect(code('src/services/eventImport/connectors/' + f + '.js')).toMatch(/async \*fetch\(\{ config, limit, signal, diag \} = \{\}\)/);
    }
    expect(code('src/services/eventImport/index.js')).toMatch(/connector\.fetch\(\{ config, limit: opts\.limit, signal: opts\.signal, diag \}\)/);
  });
  test('GSA records its read WITHOUT the api key', () => {
    const g = code('src/services/eventImport/connectors/gsaConnector.js');
    expect(g).toMatch(/diag\.record\(base, 200/);
    expect(g).not.toMatch(/diag\.record\(url/);
  });
});

// ── 3. Per-source health and bounded retry ────────────────────────────────────────────────────

describe('per-source health state', () => {
  const now = new Date('2026-09-24T07:00:00Z');

  test('a transient failure schedules retries at 1h, 2h, 4h — then stops', () => {
    let st = sourceHealth.nextState({}, { ok: false, status: 'failed', transient: true, trigger: 'scheduled', error: 'rate_limited' }, now);
    expect(st.next_retry_at).toBe('2026-09-24T08:00:00.000Z');
    st = sourceHealth.nextState(st, { ok: false, status: 'failed', transient: true, trigger: 'retry' }, new Date('2026-09-24T08:00:00Z'));
    expect(st.next_retry_at).toBe('2026-09-24T10:00:00.000Z');
    st = sourceHealth.nextState(st, { ok: false, status: 'failed', transient: true, trigger: 'retry' }, new Date('2026-09-24T10:00:00Z'));
    expect(st.next_retry_at).toBe('2026-09-24T14:00:00.000Z');
    st = sourceHealth.nextState(st, { ok: false, status: 'failed', transient: true, trigger: 'retry' }, new Date('2026-09-24T14:00:00Z'));
    expect(st.next_retry_at).toBeNull();                                // budget exhausted: wait for the next window
    expect(st.consecutive_failures).toBe(4);
  });
  test('a structural failure (blocked) is never retried automatically', () => {
    const st = sourceHealth.nextState({}, { ok: false, status: 'failed', transient: false, zero_reason: 'blocked_by_source', trigger: 'scheduled' }, now);
    expect(st.next_retry_at).toBeNull();
  });
  test('success clears the failure streak and the retry slot', () => {
    const st = sourceHealth.nextState({ consecutive_failures: 2, next_retry_at: 'x' }, { ok: true, status: 'completed', fetched: 5 }, now);
    expect(st.consecutive_failures).toBe(0);
    expect(st.next_retry_at).toBeNull();
    expect(st.last_success_at).toBe(now.toISOString());
  });
  test.each([
    [{ status: 'active' }, { consecutive_failures: 0 }, { zero_reason: 'blocked_by_source' }, 'BLOCKED_BY_SOURCE'],
    [{ status: 'active' }, { consecutive_failures: 3, last_error: 'x' }, {}, 'BROKEN'],
    [{ status: 'active' }, { consecutive_failures: 0 }, { zero_reason: 'parse_failure' }, 'BROKEN'],
    [{ status: 'active' }, { consecutive_failures: 1, last_error: 'rate_limited' }, {}, 'DEGRADED'],
    [{ status: 'active' }, { consecutive_zero_runs: 3, last_nonzero_at: '2026-09-10' }, {}, 'DEGRADED'],
    [{ status: 'active' }, {}, { fetched: 10, eligible: 2, rejected: 8 }, 'DEGRADED'],
    [{ status: 'active' }, {}, { fetched: 18, eligible: 18 }, 'HEALTHY'],
    [{ status: 'paused', kind: 'csv', config: { frozen_reason: 'frozen paste' } }, {}, {}, 'NO_LONGER_USEFUL'],
    [{ status: 'paused', kind: 'rss', config: {} }, {}, {}, 'NEEDS_REVIEW'],
  ])('classify %#', (src, st, last, want) => {
    expect(sourceHealth.classify(src, st, last).state).toBe(want);
  });
  test('retry claims are conditional, so two processes can never both retry one failure', () => {
    const w = code('src/workers/eventImportWorker.js');
    expect(w).toMatch(/UPDATE import_sources SET next_retry_at = NULL WHERE id = \$1 AND next_retry_at = \$2 RETURNING id/);
    expect(w).toMatch(/runDueRetries\(/);
  });
});

// ── 4. Overall health: lull vs failure ────────────────────────────────────────────────────────

describe('overall inventory health', () => {
  const snap = (over = {}) => Object.assign({ total_active_public: 32, external_auctions: 32, active_estate_sales: 0,
    auction_inventory: { external_active_auctions: 32, target: 100 }, last_success_run: '2026-09-24T07:03:00Z',
    upcoming_by_source: [{ key: 'gsa', n: 18 }, { key: 'tx', n: 13 }, { key: 'lm', n: 1 }] }, over);
  const live = (states) => states.map((s, i) => ({ key: 'src' + i, live: true, health_state: s }));

  test('working pipeline + thin market = DEGRADED supply lull, not an ingestion failure', () => {
    const h = health.overallHealth({ snap: snap(), sources: live(['HEALTHY', 'HEALTHY']) });
    expect(h.state).toBe('DEGRADED');
    expect(h.diagnosis).toBe('SUPPLY_LULL');
    expect(h.pipeline).toBe('OK');
  });
  test('no working live source = CRITICAL ingestion failure', () => {
    const h = health.overallHealth({ snap: snap(), sources: live(['BROKEN', 'BLOCKED_BY_SOURCE']) });
    expect(h.state).toBe('CRITICAL');
    expect(h.diagnosis).toBe('INGESTION_FAILURE');
  });
  test('a missed scheduled window = CRITICAL', () => {
    expect(health.overallHealth({ snap: snap(), alerts: [{ code: 'missed_window' }], sources: live(['HEALTHY']) }).state).toBe('CRITICAL');
  });
  test('one blocked source among working ones = DEGRADED source problem', () => {
    const h = health.overallHealth({ snap: snap({ auction_inventory: { external_active_auctions: 120, target: 100 }, active_estate_sales: 3 }),
      sources: live(['HEALTHY', 'BLOCKED_BY_SOURCE']) });
    expect(h.state).toBe('DEGRADED');
    expect(h.diagnosis).toBe('SOURCE_PROBLEM');
  });
  test('everything at target with spread = HEALTHY', () => {
    const h = health.overallHealth({ snap: snap({ auction_inventory: { external_active_auctions: 120, target: 100 }, active_estate_sales: 4,
      upcoming_by_source: [{ key: 'a', n: 60 }, { key: 'b', n: 60 }] }), sources: live(['HEALTHY', 'HEALTHY']), images: { eligible: 10, real: 9 } });
    expect(h.state).toBe('HEALTHY');
  });
  test('near-empty public inventory = CRITICAL whatever the pipeline says', () => {
    expect(health.overallHealth({ snap: snap({ total_active_public: 1 }), sources: live(['HEALTHY']) }).state).toBe('CRITICAL');
  });
  test('no snapshot = UNKNOWN', () => {
    expect(health.overallHealth({ snap: null }).state).toBe('UNKNOWN');
  });
  test('source concentration is surfaced', () => {
    const h = health.overallHealth({ snap: snap({ upcoming_by_source: [{ key: 'gsa', n: 90 }, { key: 'tx', n: 10 }] }), sources: live(['HEALTHY']) });
    expect(h.reasons.join(' ')).toMatch(/gsa supplies 90%/);
  });
  test('"importer failed" means every source failed, not whichever ran last', () => {
    const base = { total_active_public: 30, active_auctions: 30, active_estate_sales: 1, auction_inventory: { status: 'HEALTHY' } };
    const one = health.evaluateAlerts({ ...base, latest_by_source: [{ key: 'a', status: 'completed' }, { key: 'lm', status: 'failed', last_error: 'blocked_by_source' }] });
    expect(one.find((a) => a.code === 'run_failed')).toBeUndefined();
    expect(one.find((a) => a.code === 'sources_failing').level).toBe('warn');
    const all = health.evaluateAlerts({ ...base, latest_by_source: [{ key: 'a', status: 'failed' }, { key: 'b', status: 'failed' }] });
    expect(all.find((a) => a.code === 'run_failed').level).toBe('critical');
  });
});

// ── 5. Content integrity ──────────────────────────────────────────────────────────────────────

describe('only legitimate real events are imported', () => {
  const ok = { start_at: '2026-09-25T15:00:00Z', end_at: '2026-10-02T03:59:00Z', city: 'Houston', state: 'TX' };
  test("a host's own practice listing is rejected", () => {
    expect(validate({ ...ok, title: 'TEST AUCTION FOR BIDDERS' }).reason).toBe('not_a_real_event:test_listing');
    expect(validate({ ...ok, title: 'Vehicle Auction', description: 'There are no actual items for sale in this auction.' }).reason).toBe('not_a_real_event:test_listing');
  });
  test('a placeholder multi-year date range is rejected', () => {
    expect(validate({ ...ok, title: 'Surplus Auction', start_at: '2022-01-01T06:00:00Z', end_at: '2031-01-01T05:59:00Z' }).reason).toBe('implausible_duration');
  });
  test('ordinary auctions (including words like "contest") are unaffected', () => {
    expect(validate({ ...ok, title: 'Contest Winners Estate Auction' }).ok).toBe(true);
    expect(validate({ ...ok, title: 'GSA Federal Surplus Auction', start_at: '2026-09-20T04:00:00Z', end_at: '2026-10-19T03:59:00Z' }).ok).toBe(true);
  });
  test('the published practice listing is rejected (kept, reason recorded) by migration 167', () => {
    const sql = read('db/migrations/167_event_import_resilience.sql');
    expect(sql).toMatch(/SET status = 'rejected',\s*review_reason = 'not_a_real_event:test_listing/);
    expect(sql).not.toMatch(/DELETE FROM/);
  });
});

// ── 6. No false identity, anywhere ────────────────────────────────────────────────────────────

describe('source access controls are respected, never evaded', () => {
  test('image re-hosting never retries as a browser; a 403 is recorded', async () => {
    const img = require('../src/services/eventImport/imageEnrichment');
    const seen = [];
    const requestImpl = (url, opts, cb) => { seen.push(opts.headers['User-Agent']);
      const { EventEmitter } = require('events'); const resp = new EventEmitter(); resp.statusCode = 403; resp.headers = {};
      const req = new EventEmitter(); req.end = () => { cb(resp); resp.emit('end'); }; req.destroy = () => {}; return req; };
    const r = await img.fetchImage('https://cdn.example/x.jpg', { requestImpl });
    expect(r.status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^AdvantageBid-ImageEnrichment/);
    expect(img.isUsableImageResponse(r).reason).toBe('blocked_403');
    expect(code('src/services/eventImport/imageEnrichment.js')).not.toMatch(/BROWSER_UA/);
  });
  test('Lewis & Maese uses a browser identity only with the site owner\'s documented permission', () => {
    const lm = code('src/services/eventImport/connectors/lmauctionConnector.js');
    expect(lm).toMatch(/const headers = permittedBrowserIdentity\(ctx\.config\) \? \{ 'User-Agent': BROWSER_UA \} : \{\};/);
  });
  test('no other connector presents a browser identity', () => {
    for (const f of ['txauctionConnector', 'gsaConnector', 'feedConnector', 'csvConnector']) {
      expect(code('src/services/eventImport/connectors/' + f + '.js')).not.toMatch(/Mozilla\/5\.0/);
    }
  });
});

// ── 7. Observability ─────────────────────────────────────────────────────────────────────────

describe('importer diagnostics stay readable', () => {
  test('every cycle logs failed sources, zero-result reasons and image results', () => {
    const w = code('src/workers/eventImportWorker.js');
    expect(w).toMatch(/failed_sources:/);
    expect(w).toMatch(/zero_result_sources:/);
    expect(w).toMatch(/evt: 'image_enrichment'/);
    expect(w).toMatch(/evt: 'health', afterCycle: !!o\.afterCycle, overall/);
  });
  test('scheduled image re-hosting covers only mirror-policy sources, bounded', () => {
    const w = code('src/workers/eventImportWorker.js');
    const fn = w.slice(w.indexOf('async function enrichImportedImages'), w.indexOf('// Aggregate per-source results'));
    expect(fn).toMatch(/s\.media_policy = 'mirror'/);
    expect(fn).toMatch(/limit = 40/);
    expect(w).toMatch(/const images = apply \? await enrichImportedImages\(\) : null;/);
  });
  test('the unrelated auction close loop reports a repeating failure at most hourly', () => {
    const n = code('src/workers/notificationWorker.js');
    expect(n).toMatch(/shouldReportCloseFailure\(row\.id, err\.message\)/);
    expect(n).toMatch(/CLOSE_FAILURE_REPORT_MS = 60 \* 60 \* 1000/);
    // Close behaviour itself is untouched.
    expect(n).toMatch(/await auctionService\.closeAuction\(row\.id, null/);
  });
  test('the admin health view is admin-only and read-only', () => {
    const r = code('src/routes/adminEventImports.js');
    expect(r).toMatch(/router\.use\(authMiddleware, roleMiddleware\(\['admin'\]\)\)/);
    expect(r).toMatch(/router\.get\('\/health'/);
    const page = read('public/admin/imported-events.html');
    expect(page).toMatch(/id="tabHealth"/);
    expect(page).toMatch(/\/api\/admin\/event-imports\/health/);
  });
});

// ── 8. Migration 167 ─────────────────────────────────────────────────────────────────────────

describe('migration 167', () => {
  const sql = read('db/migrations/167_event_import_resilience.sql');
  test('frozen CSV sources are paused only when nothing of theirs is current, and nothing is deleted', () => {
    expect(sql).toMatch(/SET status = 'paused'/);
    expect(sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM event_sources es JOIN events e ON e\.id = es\.event_id\s+WHERE es\.source_id = s\.id AND e\.end_at >= now\(\)\)/);
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/DELETE|DROP TABLE|TRUNCATE/i);
  });
  test('retry is a permitted run trigger', () => {
    expect(sql).toMatch(/CHECK \(trigger IN \('scheduled','manual','backfill','retry'\)\)/);
  });
  test('no Lewis & Maese commercial data is touched', () => {
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/pricing|platform_fee|seller_profiles|lmauction/i);
  });
});
