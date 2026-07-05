#!/usr/bin/env node
/* Phase 2 — Partner Foundation Tier-2 staging validation (HTTP). STAGING only. */
'use strict';
const BASE = process.env.BASE_URL || 'https://advantage-staging-production.up.railway.app';
if (!/staging/.test(BASE)) { console.error('REFUSE: BASE_URL must target staging.'); process.exit(2); }
const ADMIN = { email: 'validation-admin@advantage.bid', password: 'ValidationAdmin2025!' };
const ORG = { email: 'pilot-buyer1@advantage.bid', password: 'PilotTest2026!' };
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; fails.push(n + (x ? ' — ' + x : '')); console.log('  ✗ ' + n + (x ? ' — ' + x : '')); } };
async function api(method, path, { token, body } = {}) {
  const opt = { method, headers: {} };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt); let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const login = async (c) => (await api('POST', '/api/auth/login', { body: c })).j.token;

(async () => {
  console.log('Partner Foundation Tier-2 → ' + BASE + '\n[Auth]');
  const tAdmin = await login(ADMIN), tOrg = await login(ORG);
  ok('admin + organizer login', !!tAdmin && !!tOrg);

  console.log('[Config / branding]');
  const br = await api('GET', '/api/config/branding');
  ok('GET /api/config/branding (public)', br.status === 200 && br.j.branding && br.j.branding['branding.site_name'] === 'Advantage.Bid', 'status ' + br.status);
  ok('admin GET /api/config/platform', (await api('GET', '/api/config/platform', { token: tAdmin })).status === 200);
  ok('non-admin platform config → 403', (await api('GET', '/api/config/platform', { token: tOrg })).status === 403);

  console.log('[Legal framework]');
  const doc = await api('POST', '/api/legal/documents', { token: tAdmin, body: { docType: 'buyer_terms', title: 'Platform Buyer Terms' } });
  ok('admin create legal document', doc.status === 201 && doc.j.document, 'status ' + doc.status);
  const ver = doc.j.document && await api('POST', '/api/legal/documents/' + doc.j.document.id + '/versions', { token: tAdmin, body: { content: 'Terms content v1 ' + Date.now() } });
  ok('admin add version', ver && ver.status === 201);
  const publ = ver && await api('POST', '/api/legal/versions/' + ver.j.version.id + '/publish', { token: tAdmin });
  ok('admin publish version', publ && publ.status === 200);
  const pubGet = await api('GET', '/api/legal/buyer_terms');
  ok('public GET published buyer_terms', pubGet.status === 200 && pubGet.j.document && pubGet.j.document.content, 'status ' + pubGet.status);
  const acc = ver && await api('POST', '/api/legal/accept', { token: tOrg, body: { versionId: ver.j.version.id } });
  ok('organizer records acceptance', acc && acc.status === 201);

  console.log('[Capability enforcement]');
  const ev1 = await api('POST', '/api/org/events', { token: tOrg, body: { organization: { name: 'P2 Org', contactEmail: 'p2@x.com' }, title: 'Cap Ev1', marketSlug: 'houston', startAt: '2026-10-01T10:00' } });
  ok('organizer create event (auto-onboard)', ev1.status === 201, 'status ' + ev1.status);
  const orgCfg = await api('GET', '/api/config/org', { token: tOrg });
  const orgId = orgCfg.j && orgCfg.j.organization && orgCfg.j.organization.id;
  ok('organizer has an organization', !!orgId);
  ok('submit succeeds with events capability', ev1.j && (await api('POST', '/api/org/events/' + ev1.j.event.id + '/submit', { token: tOrg })).status === 200);
  const caps = orgId && await api('GET', '/api/admin/partners/' + orgId + '/capabilities', { token: tAdmin });
  ok('admin sees org capabilities incl. events', caps && (caps.j.capabilities || []).includes('events'));
  // revoke events → submit blocked
  orgId && await api('POST', '/api/admin/partners/' + orgId + '/capabilities', { token: tAdmin, body: { capability: 'events', enabled: false } });
  const ev2 = await api('POST', '/api/org/events', { token: tOrg, body: { title: 'Cap Ev2', marketSlug: 'houston', startAt: '2026-10-02T10:00' } });
  const blocked = ev2.j && ev2.j.event && await api('POST', '/api/org/events/' + ev2.j.event.id + '/submit', { token: tOrg });
  ok('submit BLOCKED after capability revoked (403 CAPABILITY_REQUIRED)', blocked && blocked.status === 403 && blocked.j.code === 'CAPABILITY_REQUIRED', blocked && ('status ' + blocked.status));
  // re-grant → submit works again
  orgId && await api('POST', '/api/admin/partners/' + orgId + '/capabilities', { token: tAdmin, body: { capability: 'events', enabled: true } });
  ok('submit works again after re-grant', ev2.j && ev2.j.event && (await api('POST', '/api/org/events/' + ev2.j.event.id + '/submit', { token: tOrg })).status === 200);

  console.log('[Marketplace syndication]');
  const list1 = await api('GET', '/api/public/auctions');
  const auction = (list1.j.data || [])[0];
  if (!auction) { console.log('  (no auctions on staging — skipping visibility asserts)'); }
  else {
    ok('admin hide auction', (await api('POST', '/api/admin/marketplace/' + auction.id + '/hide', { token: tAdmin, body: { reason: 't' } })).status === 200);
    const listHidden = await api('GET', '/api/public/auctions');
    ok('hidden auction removed from public marketplace', !(listHidden.j.data || []).some((a) => a.id === auction.id));
    ok('admin restore auction', (await api('POST', '/api/admin/marketplace/' + auction.id + '/restore', { token: tAdmin })).status === 200);
    const listBack = await api('GET', '/api/public/auctions');
    ok('restored auction back on marketplace', (listBack.j.data || []).some((a) => a.id === auction.id));
    ok('admin feature auction', (await api('POST', '/api/admin/marketplace/' + auction.id + '/feature', { token: tAdmin })).status === 200);
    ok('organizer CANNOT control marketplace (403)', (await api('POST', '/api/admin/marketplace/' + auction.id + '/hide', { token: tOrg })).status === 403);
  }

  console.log('[Authz]');
  ok('no-token /api/config/org → 401', (await api('GET', '/api/config/org')).status === 401);

  console.log('\n════════════════════════════════════\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  if (fails.length) { console.log('FAILURES:'); fails.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
