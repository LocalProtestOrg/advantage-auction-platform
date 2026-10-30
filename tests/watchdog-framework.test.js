'use strict';

/**
 * Site watchdog framework (migration 210): de-duplicated findings and their open → resolved → re-opened lifecycle,
 * severity → alert rules (one alert per new or re-opened critical/high problem), the HMAC-authenticated ingest, the
 * served-HTML check against the real 2026-10-30 seller agreement defect, and proof that production checks only ever
 * issue GET requests. Real Postgres (PGlite) with the real migration.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

jest.mock('../src/db', () => require('./eventDiscovery/harness').adapter());
jest.mock('../src/db/index', () => require('./eventDiscovery/harness').adapter());
jest.setTimeout(60000);

const H = require('./eventDiscovery/harness');
const db = require('../src/db');
const store = require('../src/services/watchdog/findingsStore');
const runner = require('../src/services/watchdog/runner');
const registry = require('../src/services/watchdog/registry');
const ingestAuth = require('../src/services/watchdog/ingestAuth');
const servedHtml = require('../src/services/watchdog/servedHtml');
const httpChecks = require('../src/services/watchdog/httpChecks');
const { analyzeHtml } = require('../src/services/watchdog/htmlAnalysis');

const ROOT = path.join(__dirname, '..');
const CHECK = { id: 'home', feature: 'Homepage and navigation', tier: 'critical' };
const bad = (extra = {}) => ({ status: 'fail', issues: [{ code: 'SCRIPT_SYNTAX', severity: 'critical', detail: 'inline script 1 does not parse', evidence: { page: '/x.html', ...extra } }], reproduce: 'GET /x.html' });
const good = { status: 'ok', issues: [], reproduce: 'GET /x.html' };
const finding = async () => (await db.query(`SELECT * FROM watchdog_findings WHERE check_id = 'home'`)).rows;

beforeAll(async () => {
  global.__PG = H.startPg();
  await global.__PG.exec(fs.readFileSync(path.join(ROOT, 'db', 'migrations', '210_site_watchdog.sql'), 'utf8'));
});
afterAll(async () => { await global.__PG.close(); });
beforeEach(async () => { await global.__PG.exec('DELETE FROM watchdog_findings; DELETE FROM watchdog_check_state; DELETE FROM watchdog_runs;'); delete process.env.WATCHDOG_ALERTS_ENABLED; });

describe('findings: de-duplicated, with an open → resolved → re-opened lifecycle', () => {
  test('a lasting problem is ONE finding (occurrences grow), flagged for alert once', async () => {
    await store.recordCheck(db, { check: CHECK, outcome: bad() });
    await db.query('UPDATE watchdog_findings SET needs_alert = false, alerted_at = now()');   // alert sent
    await store.recordCheck(db, { check: CHECK, outcome: { ...bad(), issues: [{ ...bad().issues[0], detail: 'different wording, same problem' }] } });
    const rows = await finding();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'open', occurrences: 2, needs_alert: false, severity: 'critical' });
  });

  test('passing again resolves it; failing again re-opens it and alerts again', async () => {
    await store.recordCheck(db, { check: CHECK, outcome: bad() });
    await db.query('UPDATE watchdog_findings SET needs_alert = false');
    expect((await store.recordCheck(db, { check: CHECK, outcome: good })).resolved).toBe(1);
    expect((await finding())[0]).toMatchObject({ status: 'resolved' });
    const s = await store.recordCheck(db, { check: CHECK, outcome: bad() });
    expect(s).toMatchObject({ reopened: 1, alerting: 1 });
    expect((await finding())[0]).toMatchObject({ status: 'open', reopened_count: 1, needs_alert: true });
  });

  test('a skipped check (nothing to check yet) changes no finding', async () => {
    await store.recordCheck(db, { check: CHECK, outcome: bad() });
    await store.recordCheck(db, { check: CHECK, outcome: { status: 'skipped', issues: [] } });
    expect((await finding())[0].status).toBe('open');
  });

  test('different pages are different findings; one recovering does not close the other', async () => {
    await store.recordCheck(db, { check: CHECK, outcome: { status: 'fail', issues: [bad({ page: '/a.html' }).issues[0], bad({ page: '/b.html' }).issues[0]] } });
    await store.recordCheck(db, { check: CHECK, outcome: { status: 'fail', issues: [bad({ page: '/b.html' }).issues[0]] } });
    const rows = await finding();
    expect(rows.map((r) => [r.evidence.page, r.status]).sort()).toEqual([['/a.html', 'resolved'], ['/b.html', 'open']]);
  });
});

describe('severity and alert rules', () => {
  test.each([['critical', 'critical', 'critical', true], ['high', 'critical', 'high', true], ['normal', 'critical', 'normal', false], ['critical', 'warning', 'warning', false]])(
    'tier %s + problem %s → %s (alerts: %s)', (tier, sev, expected, alerts) => {
      expect(registry.severityFor(tier, sev)).toBe(expected);
      expect(registry.alertable(registry.severityFor(tier, sev))).toBe(alerts);
    });

  test('alerts off: nothing is sent and no backlog is kept for later', async () => {
    await store.recordCheck(db, { check: CHECK, outcome: bad() });
    const send = jest.fn();
    expect(await runner.sendAlerts({ db, send })).toMatchObject({ sent: false, reason: 'alerts_disabled' });
    expect(send).not.toHaveBeenCalled();
    expect((await finding())[0].needs_alert).toBe(false);
  });

  test('alerts on: one email for new critical/high problems, never repeated; email not configured keeps it pending', async () => {
    process.env.WATCHDOG_ALERTS_ENABLED = 'true';
    await store.recordCheck(db, { check: CHECK, outcome: bad() });
    await store.recordCheck(db, { check: { id: 'page-faq', feature: 'Info page', tier: 'normal' }, outcome: bad() });   // normal: dashboard only
    const unconfigured = jest.fn(async () => ({ skipped: true }));
    expect(await runner.sendAlerts({ db, send: unconfigured })).toMatchObject({ sent: false, reason: 'email_not_configured' });
    const send = jest.fn(async () => ({ messageId: 'm1' }));
    expect(await runner.sendAlerts({ db, send })).toMatchObject({ sent: true, findings: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toBe('info@advantage.bid');
    expect(mail.subject).toMatch(/1 critical problem/);
    expect(mail.text).toMatch(/Reproduce: GET \/x\.html/);
    expect(mail.text).not.toMatch(/—/);   // no em dashes in the alert copy
    expect(await runner.sendAlerts({ db, send })).toMatchObject({ sent: false, findings: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('the served-HTML check catches the 2026-10-30 seller agreement defect', () => {
  const BEFORE_FIX = fs.readFileSync(path.join(__dirname, 'fixtures', 'sign-agreement-before-fix-2026-10-29.html'), 'utf8');
  const OLD = {   // the injection as it was: Sasha loader before the FIRST </body>
    sasha: (h) => { const at = h.search(/<\/body>/i); return h.slice(0, at) + '\n<script src="/widgets/sasha-loader.js" async></script>\n' + h.slice(at); },
    analytics: (h) => h,
  };
  test('old injection on the pre-fix page → critical SCRIPT_SYNTAX', () => {
    const issues = servedHtml.checkPage(BEFORE_FIX, { inject: OLD });
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(['SCRIPT_SYNTAX']));
    expect(issues.every((i) => i.severity === 'critical')).toBe(true);
  });
  test('the current injection on the same page is clean, and every page in public/ is clean', () => {
    expect(servedHtml.checkPage(BEFORE_FIX)).toEqual([]);
    const all = servedHtml.checkAll();
    expect(all.pages).toBeGreaterThan(100);
    expect(all.issues).toEqual([]);
  });
  test('raw script text, unfilled placeholders and invalid structured data are detected in served HTML', () => {
    const codes = analyzeHtml('<html><head><title>t</title><script type="application/ld+json">{bad</script></head><body><p>document.getElementById("x"); function () { var a = 1; }</p><p>{{legal_name}}</p></body></html>').map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['RAW_SCRIPT_TEXT', 'TEMPLATE_MARKERS', 'JSONLD_INVALID']));
  });
});

describe('production checks never change anything', () => {
  test('every server check, run end to end, issues GET requests only', async () => {
    const methods = new Set(); const seen = [];
    const page = '<!doctype html><html><head><title>Advantage.Bid</title><meta name="description" content="d"><link rel="canonical" href="/"><meta property="og:title" content="t"><script type="application/ld+json">{"@type":"Event"}</script></head><body>Advantage.Bid login-email login-password reg-email id="email"</body></html>';
    const fake = async (url, opts) => {
      methods.add(opts.method); seen.push(url);
      const u = new URL(url);
      const json = (o) => ({ status: 200, headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) }, text: async () => JSON.stringify(o) });
      if (u.pathname === '/sitemap.xml') return { status: 200, headers: { get: () => 'application/xml' }, text: async () => '<urlset><url><loc>https://s.test/event.html?slug=a</loc></url><url><loc>https://s.test/pro/shop-a</loc></url></urlset>' };
      if (u.pathname === '/api/health') return json({ status: 'ok', db_reachable: true });
      if (u.pathname.startsWith('/api/')) return json({ success: true, data: [], families: {}, seller_id: '11111111-1111-4111-8111-111111111111' });
      if (['/sign-agreement.html', '/seller-inventory.html', '/admin/'].includes(u.pathname)) return { status: 302, headers: { get: (k) => (k === 'location' ? '/login.html?next=x' : null) }, text: async () => '' };
      return { status: 200, headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) }, text: async () => page };
    };
    const out = await runner.runServerChecks({ db, baseUrl: 'https://s.test', force: true, fetchImpl: fake });
    expect(out.ran).toBe(registry.SERVER_CHECKS.length);
    expect([...methods]).toEqual(['GET']);
    expect(seen.length).toBeGreaterThan(20);
  });
  test('the check code has no other way to make a request', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'watchdog', 'httpChecks.js'), 'utf8');
    expect(src.match(/method:\s*'[A-Z]+'/g)).toEqual(["method: 'GET'"]);
    expect((src.match(/\bfetchImpl\(/g) || []).length).toBe(1);   // only inside readOnlyGet
    expect(src).not.toMatch(/\b(axios|https?\.request|net\.connect)\b/);
  });
});

describe('browser results ingest (HMAC)', () => {
  const KEY = 'k'.repeat(48);
  let server; let base;
  beforeAll(async () => {
    const app = express();
    app.use('/api/watchdog', require('../src/routes/watchdogIngest'));
    server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  afterEach(() => { delete process.env.WATCHDOG_INGEST_KEY; });
  const post = (body, headers) => fetch(base + '/api/watchdog/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const signed = (body, key = KEY, ts = Math.floor(Date.now() / 1000)) => ({ 'X-Watchdog-Timestamp': String(ts), 'X-Watchdog-Signature': ingestAuth.sign(key, String(ts), body) });
  const BODY = JSON.stringify({ results: [{ check_id: 'browser-home', status: 'fail', issues: [{ code: 'RAW_SCRIPT_TEXT', severity: 'critical', detail: 'script text visible', evidence: { viewport: 'mobile', nested: { x: 1 } } }], reproduce: 'open / on a phone' }] });

  test('refused entirely while WATCHDOG_INGEST_KEY is not set', async () => {
    expect((await post(BODY, signed(BODY))).status).toBe(503);
  });
  test('refused without a signature, with a wrong one, or with an old timestamp', async () => {
    process.env.WATCHDOG_INGEST_KEY = KEY;
    expect((await post(BODY, {})).status).toBe(401);
    expect((await post(BODY, signed(BODY, 'x'.repeat(48)))).status).toBe(401);
    expect((await post(BODY, signed(BODY, KEY, Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
    const tampered = BODY.replace('fail', 'ok');
    expect((await post(tampered, signed(BODY))).status).toBe(401);
    expect((await db.query('SELECT count(*)::int n FROM watchdog_findings')).rows[0].n).toBe(0);
  });
  test('a signed result is recorded into the same findings (nested evidence dropped); unknown checks are refused', async () => {
    process.env.WATCHDOG_INGEST_KEY = KEY;
    const r = await post(BODY, signed(BODY));
    expect(r.status).toBe(200);
    const f = (await db.query(`SELECT * FROM watchdog_findings WHERE check_id = 'browser-home'`)).rows;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'critical', source: 'browser', status: 'open' });
    expect(f[0].evidence).toEqual({ viewport: 'mobile' });
    const unknown = JSON.stringify({ results: [{ check_id: 'drop-table', status: 'fail', issues: [] }] });
    expect((await post(unknown, signed(unknown))).status).toBe(422);
  });
});

test('a signed submission is accepted once; a replay inside the time window is refused (security review 2026-10-30)', () => {
  const auth = require('../src/services/watchdog/ingestAuth');
  const key = 'k'.repeat(40); const ts = String(Math.floor(Date.now() / 1000)); const body = '{"results":[]}';
  const signature = auth.sign(key, ts, body);
  expect(auth.verify({ key, timestamp: ts, signature, rawBody: body }).ok).toBe(true);
  expect(auth.verify({ key, timestamp: ts, signature, rawBody: body })).toEqual(expect.objectContaining({ ok: false, code: 'REPLAYED' }));
});
