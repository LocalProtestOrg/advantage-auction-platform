'use strict';

/**
 * Member-neutral import architecture (Owner correction, 2026-09-24).
 *
 * No member company has a dedicated connector, crawler exception, default role or health dependency.
 * Every Professional Seller uses the same paths: its member account, or the generic consent-gated
 * Member Feed Sync. Generic regressions preserved from the retired company-specific suite: fixture
 * clocks must be pinned, and a refused page must be recorded (never mistaken for an empty listing).
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

jest.mock('../src/services/eventImport/http', () => ({ fetchText: jest.fn(), fetchJson: jest.fn() }));
const http = require('../src/services/eventImport/http');
const registry = require('../src/services/eventImport/connectors');
const feed = require('../src/services/eventImport/connectors/feedConnector');
const memberFeeds = require('../src/services/eventImport/memberFeedService');
const sourceHealth = require('../src/services/eventImport/sourceHealth');
const diagnostics = require('../src/services/eventImport/diagnostics');
const pipeline = require('../src/services/eventImport/pipeline');
const { IDENTITY_FIELD_MAP } = require('../src/services/eventImport/normalize/identityFieldMap');

const ICAL = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:evt-1', 'SUMMARY:Estate Contents Auction', 'DTSTART:20261010T150000Z',
  'DTEND:20261010T220000Z', 'LOCATION:Montclair, NJ', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const MEMBER = { organization_id: '11111111-1111-4111-8111-111111111111', organizer_name: 'Example Member Auctions',
  organizer_website_url: 'https://member.example.com',
  consent: { granted_by: 'Owner of Example Member Auctions', granted_at: '2026-09-24T00:00:00Z', evidence: 'signed feed authorization' } };
const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };

beforeEach(() => { http.fetchText.mockReset(); });

// ── 1. No dedicated member connector anywhere ─────────────────────────────────────────────────

describe('no member company has a dedicated or privileged integration', () => {
  test('the retired member connector is gone from code and registry', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/services/eventImport/connectors/lmauctionConnector.js'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'scripts/register-lmauction-source.js'))).toBe(false);
    expect(Object.keys(registry.REGISTRY).sort()).toEqual(['csv', 'feed', 'gsa', 'json', 'rest', 'rss', 'txauction', 'xml']);
  });
  test('a source naming an unknown / retired connector fails closed — never silently becomes another source', () => {
    expect(() => registry.getConnector('rest', 'lmauction')).toThrow(/No connector registered for: lmauction/);
    expect(registry.getConnector('rest', 'gsa').key).toBe('gsa');
    expect(registry.getConnector('csv').key).toBe('csv');
  });
  test('no importer, worker, health or admin code names a member company or its source key', () => {
    const files = ['src/services/eventImport/index.js', 'src/services/eventImport/health.js', 'src/services/eventImport/inventoryHealthService.js',
      'src/services/eventImport/sourceHealth.js', 'src/services/eventImport/connectors/index.js', 'src/workers/eventImportWorker.js',
      'src/routes/adminEventImports.js', 'public/admin/imported-events.html', 'scripts/refresh-external-auctions.js'];
    for (const f of files) expect(code(f)).not.toMatch(/lmauction|lewis|maese|'gsa-auctions'|'txauction-gov'/i);
  });
  test('the refresh tool selects sources from the database, not a hardcoded company list', () => {
    const r = code('scripts/refresh-external-auctions.js');
    expect(r).toMatch(/FROM import_sources\s+WHERE status = 'active'/);
    expect(r).not.toMatch(/AUCTION_SOURCES = \[/);
  });
  test('the professional provisioning tool has no default member', () => {
    const p = code('scripts/provision-bd-professionals.js');
    expect(p).not.toMatch(/arg\('bd-user', '\d+'\)|arg\('bd-listing', '\d+'\)|arg\('name', '[a-z]+'\)/);
    expect(p).toMatch(/--bd-user, --bd-listing and --name are required/);
  });
});

// ── 2. The generic Member Feed Sync is consent-gated and per-member ───────────────────────────

describe('Member Feed Sync — the same path for every Professional Seller', () => {
  test('a feed without the member\'s consent is never fetched', async () => {
    http.fetchText.mockResolvedValue({ ok: true, status: 200, text: ICAL, contentType: 'text/calendar' });
    const out = await collect(feed.fetch({ config: { feeds: [{ url: 'https://member.example.com/cal.ics' }] } }));
    expect(out).toEqual([]);
    expect(http.fetchText).not.toHaveBeenCalled();
  });
  test('a revoked feed is never fetched', async () => {
    http.fetchText.mockResolvedValue({ ok: true, status: 200, text: ICAL, contentType: 'text/calendar' });
    await collect(feed.fetch({ config: { feeds: [{ url: 'https://member.example.com/cal.ics', ...MEMBER, revoked_at: '2026-09-25' }] } }));
    expect(http.fetchText).not.toHaveBeenCalled();
  });
  test('a consented feed syncs, attributed to its own member, and records what it saw', async () => {
    http.fetchText.mockResolvedValue({ ok: true, status: 200, text: ICAL, contentType: 'text/calendar' });
    const diag = diagnostics.createDiagnostics();
    const out = await collect(feed.fetch({ config: { feeds: [{ url: 'https://member.example.com/cal.ics', ...MEMBER }] }, diag }));
    expect(out).toHaveLength(1);
    expect(out[0].memberOrganizationId).toBe(MEMBER.organization_id);
    expect(out[0].payload.organizer_name).toBe('Example Member Auctions');
    expect(diag.summary().ok).toBe(1);
  });
  test('feeds discovered on a member\'s site inherit THAT member\'s consent; there is no anonymous discovery', async () => {
    http.fetchText.mockImplementation(async (url) => (url.endsWith('/events')
      ? { ok: true, status: 200, text: '<link rel="alternate" type="text/calendar" href="/cal.ics">', url }
      : { ok: true, status: 200, text: ICAL, contentType: 'text/calendar' }));
    const out = await collect(feed.fetch({ config: { feeds: [{ site: 'https://member.example.com/events', ...MEMBER }] } }));
    expect(out).toHaveLength(1);
    expect(out[0].memberOrganizationId).toBe(MEMBER.organization_id);
    http.fetchText.mockClear();
    await collect(feed.fetch({ config: { site: 'https://anyone.example.com/events', feeds: [] } }));
    expect(http.fetchText).not.toHaveBeenCalled();
  });
  test('onboarding requires the owning member and complete consent', () => {
    expect(memberFeeds.buildFeed({ url: 'https://m.example.com/cal.ics', organizationId: 'o' }).reason).toMatch(/consent is required/);
    expect(memberFeeds.buildFeed({ url: 'http://m.example.com/cal.ics', organizationId: 'o', consent: MEMBER.consent }).reason).toMatch(/https/);
    expect(memberFeeds.buildFeed({ url: 'https://m.example.com/cal.ics', consent: MEMBER.consent }).reason).toMatch(/member organization/);
    const ok = memberFeeds.buildFeed({ url: 'https://m.example.com/cal.ics', organizationId: 'o', organizerName: 'M', consent: MEMBER.consent });
    expect(ok.ok).toBe(true);
    expect(feed.hasMemberConsent(ok.feed)).toBe(true);
  });
  test('onboarding and revocation are audited, admin-only endpoints', () => {
    const s = code('src/services/eventImport/memberFeedService.js');
    expect(s).toMatch(/'member_feed\.registered'/);
    expect(s).toMatch(/'member_feed\.revoked'/);
    const r = code('src/routes/adminEventImports.js');
    expect(r).toMatch(/router\.use\(authMiddleware, roleMiddleware\(\['admin'\]\)\)/);
    expect(r).toMatch(/router\.post\('\/member-feeds'/);
    expect(r).toMatch(/router\.post\('\/member-feeds\/revoke'/);
  });
  test('an event from a member\'s own feed is hosted by that member (proven association, never overwritten)', () => {
    const w = code('src/services/eventImport/writer.js');
    expect(w).toMatch(/host_attribution_method = 'authorized_source'[\s\S]*WHERE id = \$1 AND host_organization_id IS NULL/);
    expect(code('src/services/eventImport/index.js')).toMatch(/memberOrganizationId: \(raw && raw\.memberOrganizationId\) \|\| null/);
  });
});

// ── 3. Health never depends on a member ───────────────────────────────────────────────────────

describe('inventory health is member-neutral', () => {
  test('a retired source is RETIRED: not live, not an action item', () => {
    expect(sourceHealth.classify({ status: 'disabled', config: { retired_reason: 'retired' } }, {}, { zero_reason: 'blocked_by_source' }).state).toBe('RETIRED');
    const h = code('src/services/eventImport/inventoryHealthService.js');
    expect(h).toMatch(/live: r\.status === 'active' && r\.kind !== 'csv' && cls\.state !== 'RETIRED'/);
    expect(h).toMatch(/\['BLOCKED_BY_SOURCE', 'BROKEN', 'NEEDS_REVIEW'\]/);   // RETIRED is not in the review list
  });
  test('image policy is a source property, not a source name', () => {
    const h = code('src/services/eventImport/inventoryHealthService.js');
    expect(h).toMatch(/config->>'placeholder_images'/);
    expect(h).not.toMatch(/gsa-auctions/);
  });
  test('removing a blocked source does not make the system HEALTHY on its own — the supply shortfall still reports', () => {
    const health = require('../src/services/eventImport/health');
    const h = health.overallHealth({
      snap: { total_active_public: 35, external_auctions: 35, active_estate_sales: 0, last_success_run: '2026-09-24T16:51:00Z',
        auction_inventory: { external_active_auctions: 35, target: 100 }, upcoming_by_source: [] },
      sources: [{ key: 'a', live: true, health_state: 'HEALTHY' }, { key: 'b', live: true, health_state: 'HEALTHY' }] });
    expect(h.state).toBe('DEGRADED');
    expect(h.diagnosis).toBe('SUPPLY_LULL');
    expect(h.reasons.join(' ')).toMatch(/operating target 100/);
    expect(h.reasons.join(' ')).toMatch(/no upcoming estate sales/);
  });
});

// ── 4. Generic regressions preserved from the retired company-specific suite ──────────────────

describe('generic regressions', () => {
  const raw = { sourceEventId: 'x', payload: { title: 'Estate Contents Auction', start_at: '2026-09-19T14:00:00Z', end_at: '2026-09-19T20:00:00Z', city: 'Houston', state: 'TX' } };
  test('whether an event has ended is judged against an INJECTED clock, so fixtures never silently expire', () => {
    const before = pipeline.normalizeItem(raw, { fieldMap: IDENTITY_FIELD_MAP, now: Date.parse('2026-09-10T12:00:00Z') });
    const after = pipeline.normalizeItem(raw, { fieldMap: IDENTITY_FIELD_MAP, now: Date.parse('2026-09-20T12:00:00Z') });
    expect(before.outcome).toBe('eligible');
    expect(after.reason).toBe('already_ended');
  });
  test('a refused feed page is recorded as blocked, never mistaken for an empty listing', async () => {
    http.fetchText.mockResolvedValue({ ok: false, status: 403, text: '<title>Access Denied</title>' });
    const diag = diagnostics.createDiagnostics();
    const out = await collect(feed.fetch({ config: { feeds: [{ url: 'https://member.example.com/cal.ics', ...MEMBER }] }, diag }));
    expect(out).toEqual([]);
    expect(diagnostics.zeroReason(0, diag.summary())).toBe('blocked_by_source');
  });
});

// ── 5. Migration 168 preserves every business record ──────────────────────────────────────────

describe('migration 168', () => {
  const sql = read('db/migrations/168_member_neutral_import.sql');
  const body = sql.replace(/--.*$/gm, '');
  test('retires only the dedicated source row; deletes nothing', () => {
    expect(body).toMatch(/SET status = 'disabled'/);
    expect(body).toMatch(/WHERE key = 'lmauction-lewis-maese' AND status <> 'disabled'/);
    expect(body).not.toMatch(/DELETE|DROP TABLE|TRUNCATE/i);
  });
  test('never touches events, organizations, members, sellers, agreements, orders or pricing', () => {
    expect(body).not.toMatch(/UPDATE (events|organizations|organization_members|users|seller_profiles|professional_pricing_agreements|invoices|orders)/i);
    expect(body).not.toMatch(/platform_fee|pricing/i);
  });
});
