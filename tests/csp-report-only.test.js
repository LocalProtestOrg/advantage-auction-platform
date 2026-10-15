'use strict';

/** Content Security Policy in REPORT-ONLY mode (owner-approved 2026-10-15): reports, never blocks. */
const http = require('http');
const express = require('express');
const csp = require('../src/middleware/cspReportOnly');

function app() {
  const a = express();
  a.post('/api/csp-report', csp.reportParser, csp.receiveReport);
  a.use(csp.cspReportOnly);
  a.get('/page', (req, res) => res.send('ok'));
  return a;
}
let server, base;
beforeAll(async () => { server = http.createServer(app()).listen(0); await new Promise((r) => server.once('listening', r)); base = 'http://127.0.0.1:' + server.address().port; });
afterAll(() => server.close());
beforeEach(() => { csp._reset(); delete process.env.CSP_REPORT_ONLY; });

test('every response carries the REPORT-ONLY header (never the enforcing one)', async () => {
  const r = await fetch(base + '/page');
  expect(r.headers.get('content-security-policy-report-only')).toBe(csp.POLICY);
  expect(r.headers.get('content-security-policy')).toBeNull();
  expect(csp.POLICY).toMatch(/report-uri \/api\/csp-report/);
  for (const host of ['https://js.stripe.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://connect.facebook.net', 'https://www.googletagmanager.com', 'https://unpkg.com']) expect(csp.POLICY).toContain(host);
  expect(csp.POLICY).toMatch(/object-src 'none'/);
});

test('the kill switch removes the header', async () => {
  process.env.CSP_REPORT_ONLY = 'off';
  expect((await fetch(base + '/page')).headers.get('content-security-policy-report-only')).toBeNull();
});

test('reports in both browser formats are accepted (204) and summarised without query strings; repeats are not re-logged', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const legacy = { 'csp-report': { 'document-uri': 'https://bid.advantage.bid/lot.html?lotId=secret-123&email=a@b.co', 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/x.js?token=abc' } };
  for (let i = 0; i < 3; i++) {
    const r = await fetch(base + '/api/csp-report', { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify(legacy) });
    expect(r.status).toBe(204);
  }
  const modern = [{ type: 'csp-violation', body: { documentURL: 'https://bid.advantage.bid/index.html', effectiveDirective: 'img-src', blockedURL: 'inline' } }];
  expect((await fetch(base + '/api/csp-report', { method: 'POST', headers: { 'content-type': 'application/reports+json' }, body: JSON.stringify(modern) })).status).toBe(204);
  const logged = warn.mock.calls.map((c) => c.join(' '));
  warn.mockRestore();
  expect(logged).toHaveLength(2);
  expect(logged[0]).toContain('"directive":"script-src-elem"'); expect(logged[0]).toContain('"blocked":"evil.example"'); expect(logged[0]).toContain('"page":"/lot.html"');
  expect(logged.join(' ')).not.toMatch(/secret-123|token=abc|a@b\.co/);
  expect(csp.stats()).toMatchObject({ received: 4, logged: 2 });
});

test('a malformed report is ignored with 204', async () => {
  const r = await fetch(base + '/api/csp-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '"nonsense"' });
  expect(r.status).toBe(204);
});

test('server.js mounts the report-only middleware (and keeps helmet\'s enforcing CSP off)', () => {
  const src = require('fs').readFileSync('server.js', 'utf8');
  expect(src).toMatch(/app\.use\(helmet\(\{ contentSecurityPolicy: false \}\)\);/);
  expect(src).toMatch(/app\.post\('\/api\/csp-report', cspLimiter,/);
  expect(src).toMatch(/app\.use\(csp\.cspReportOnly\);/);
});
