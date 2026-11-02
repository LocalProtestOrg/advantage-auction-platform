#!/usr/bin/env node
/* watchdog-browser.js — real-browser site watchdog (Chromium), NON-DESTRUCTIVE: it opens pages and reads them. It never
   submits a form, signs, bids, buys, registers, resets a password or changes anything. Third-party analytics and ad
   requests are blocked so the checks do not count as visits.

   Pages: homepage + navigation, sign in / registration (fields present, nothing submitted), password reset request page,
   search + a filter, marketplace items, an auction, a lot and an event (from the sitemap), and when published: a product
   page, a storefront and its embedded widget. Desktop and mobile viewports. Each page goes through
   src/services/watchdog/pageHealth.js (script errors, raw script text, failed same-site requests, missing content,
   placeholders, sideways scrolling on phones) plus SEO metadata and structured data checks.

   Usage:
     BASE_URL=https://bid.advantage.bid node scripts/watchdog-browser.js [--out results.json]
     node scripts/watchdog-browser.js --report-journeys jest-results.json [--out results.json]   (isolated journeys)
   Posting: when WATCHDOG_INGEST_URL and WATCHDOG_INGEST_KEY are set, results are POSTed (HMAC) to the ingest.
   Exit code 1 when any check has a critical problem (so the scheduled job shows red). */
const fs = require('fs');
const path = require('path');
const health = require('../src/services/watchdog/pageHealth');
const ingestAuth = require('../src/services/watchdog/ingestAuth');

const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i === -1 ? null : args[i + 1]; };
const BASE = String(process.env.BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const BLOCK = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net|facebook\.(com|net)|connect\.facebook\.net/i;
const VIEWPORTS = { desktop: { viewport: { width: 1366, height: 900 } }, mobile: null };   // mobile = iPhone 13 profile

async function seoFacts(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent);
    return { description: !!(q('meta[name="description"]') && q('meta[name="description"]').content.trim()), canonical: !!q('link[rel="canonical"]'),
      ogTitle: !!q('meta[property="og:title"]'), jsonld: blocks };
  });
}

async function discover() {
  const out = {};
  try {
    const xml = await (await fetch(BASE + '/sitemap.xml')).text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    const pick = (re) => { const u = locs.find((x) => re.test(x)); if (!u) return null; const p = new URL(u); return p.pathname + p.search; };
    out.auction = pick(/\/auction-view\.html\?/); out.lot = pick(/\/lot\.html\?/); out.event = pick(/\/event\.html\?/);
    out.storefront = pick(/\/pro\/[^/?#]+$/); out.product = pick(/\/shop\/item\//);
  } catch (_) { /* the server check reports a broken sitemap */ }
  if (out.storefront) {
    try { const d = (await (await fetch(BASE + '/api/public/storefront/' + out.storefront.split('/')[2])).json()).data || {}; const id = d.seller_id || (d.seller && d.seller.id); if (id) out.widget = '/embed/storefront.html?seller=' + encodeURIComponent(id); } catch (_) {}
  }
  return out;
}

function targets(d) {
  return [
    { id: 'browser-home', path: '/', expect: ['Advantage.Bid'], seo: true, nav: true },
    { id: 'browser-login', path: '/login.html', visible: ['#login-email', '#login-password'] },
    { id: 'browser-forgot-password', path: '/forgot-password.html', visible: ['#email'] },
    { id: 'browser-search', path: '/search.html?q=chair' },
    { id: 'browser-marketplace', path: '/items' },
    { id: 'browser-auction', path: d.auction, seo: true },
    { id: 'browser-lot', path: d.lot, seo: true },
    { id: 'browser-event', path: d.event, seo: true, jsonld: true },
    { id: 'browser-product', path: d.product, seo: true },
    { id: 'browser-storefront', path: d.storefront, seo: true },
    { id: 'browser-widget', path: d.widget },
  ];
}

async function checkOne(browser, t) {
  const started = Date.now();
  if (!t.path) return { check_id: t.id, status: 'skipped', issues: [], reproduce: 'nothing published to check yet', duration_ms: 0 };
  const { devices } = require('playwright');
  const issues = [];
  for (const [vp, opts] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext(opts || { ...devices['iPhone 13'] });
    await ctx.route('**/*', (route) => (BLOCK.test(route.request().url()) ? route.abort() : route.continue()));
    const page = await ctx.newPage();
    const probe = health.attach(page, { origin: BASE });
    const ev = (extra) => ({ viewport: vp, url: BASE + t.path, ...extra });
    try {
      const res = await page.goto(BASE + t.path, { waitUntil: 'networkidle', timeout: 45000 });
      if (!res || res.status() >= 400) issues.push({ code: 'HTTP_STATUS', severity: 'critical', detail: `${vp}: answered ${res ? res.status() : 'nothing'}`, evidence: ev() });
      for (const i of await health.inspect(page, probe, { expectText: t.expect || [], checkOverflow: vp === 'mobile', allowConsoleErrors: [/net::ERR_FAILED/] })) issues.push({ ...i, detail: `${vp}: ${i.detail}`, evidence: ev({ key: i.code === 'REQUEST_FAILED' ? i.detail.split(' ').pop() : '' }) });
      for (const sel of t.visible || []) if (!(await page.isVisible(sel))) issues.push({ code: 'MISSING_CONTENT', severity: 'critical', detail: `${vp}: ${sel} is not visible`, evidence: ev({ key: sel }) });
      if (t.nav) {
        const links = await page.$$eval('a[href]', (as) => as.filter((a) => a.offsetParent !== null).length);
        if (links < 5) issues.push({ code: 'MISSING_CONTENT', severity: 'critical', detail: `${vp}: navigation shows only ${links} visible links`, evidence: ev({ key: 'nav' }) });
      }
      if (t.seo || t.jsonld) {
        const s = await seoFacts(page);
        const missing = [!s.description && 'meta description', !s.canonical && 'canonical link', !s.ogTitle && 'og:title'].filter(Boolean);
        if (missing.length && vp === 'desktop') issues.push({ code: 'SEO_MISSING', severity: 'warning', detail: 'missing ' + missing.join(', '), evidence: ev({ key: 'seo' }) });
        for (const b of s.jsonld) { try { const v = JSON.parse(b); if (!v || !(v['@type'] || Array.isArray(v) || v['@graph'])) throw new Error('no @type'); } catch (e) { issues.push({ code: 'JSONLD_INVALID', severity: 'critical', detail: `${vp}: structured data invalid (${e.message})`, evidence: ev({ key: 'jsonld' }) }); } }
        if (t.jsonld && !s.jsonld.length && vp === 'desktop') issues.push({ code: 'JSONLD_MISSING', severity: 'warning', detail: 'no structured data', evidence: ev({ key: 'jsonld-missing' }) });
      }
    } catch (e) {
      issues.push({ code: 'PAGE_UNAVAILABLE', severity: 'critical', detail: `${vp}: ${e.message.split('\n')[0]}`, evidence: ev() });
    } finally { await ctx.close(); }
  }
  return { check_id: t.id, status: issues.some((i) => i.severity === 'critical') ? 'fail' : 'ok', issues, reproduce: `Open ${BASE}${t.path} in a desktop browser and on a phone (signed out).`, duration_ms: Date.now() - started };
}

/** One result for the isolated journeys (jest --json output): every failing test becomes a critical finding. */
function journeysResult(file) {
  let j;
  // No results at all (the test run never started, e.g. the browser could not be installed) is itself a finding.
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { check_id: 'browser-journeys', status: 'fail', issues: [{ code: 'JOURNEY_RUN_FAILED', severity: 'critical', detail: 'the isolated journeys produced no results: ' + e.message.slice(0, 200), evidence: { key: 'no-results' } }], reproduce: 'npx jest tests/browser --forceExit (isolated test environment)', duration_ms: 0 };
  }
  const issues = [];
  for (const s of j.testResults || []) {
    for (const a of s.assertionResults || []) {
      if (a.status === 'failed') issues.push({ code: 'JOURNEY_FAILED', severity: 'critical', detail: `${a.ancestorTitles.concat(a.title).join(' > ')}: ${String((a.failureMessages || [])[0] || '').split('\n')[0].slice(0, 300)}`, evidence: { key: path.basename(s.name) + ':' + a.title } });
    }
    if (s.status === 'failed' && !(s.assertionResults || []).some((a) => a.status === 'failed')) issues.push({ code: 'JOURNEY_SUITE_FAILED', severity: 'critical', detail: `${path.basename(s.name)}: ${String(s.message || '').split('\n')[0].slice(0, 300)}`, evidence: { key: path.basename(s.name) } });
  }
  return { check_id: 'browser-journeys', status: issues.length ? 'fail' : 'ok', issues, reproduce: 'npx jest tests/browser --forceExit (isolated test environment)', duration_ms: 0 };
}

async function post(results) {
  const url = process.env.WATCHDOG_INGEST_URL; const key = process.env.WATCHDOG_INGEST_KEY;
  if (!url || !key) { console.log('[watchdog-browser] not posting (WATCHDOG_INGEST_URL / WATCHDOG_INGEST_KEY not set)'); return; }
  const body = JSON.stringify({ results });
  const ts = String(Math.floor(Date.now() / 1000));
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Watchdog-Timestamp': ts, 'X-Watchdog-Signature': ingestAuth.sign(key, ts, body) }, body });
  console.log('[watchdog-browser] posted results:', r.status);
  if (!r.ok) process.exitCode = 1;
}

(async () => {
  let results;
  const journeys = argOf('--report-journeys');
  if (journeys) results = [journeysResult(journeys)];
  else {
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    try {
      const list = targets(await discover());
      results = [];
      // (blocked trackers log net::ERR_FAILED in the console; real same-site failures are caught as REQUEST_FAILED)
      for (const t of list) { const r = await checkOne(browser, t); results.push(r); console.log(`[watchdog-browser] ${t.id}: ${r.status}${r.issues.length ? ' (' + r.issues.map((i) => i.code).join(', ') + ')' : ''}`); }
    } finally { await browser.close(); }
  }
  const out = argOf('--out'); if (out) fs.writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
  await post(results);
  if (results.some((r) => r.issues.some((i) => i.severity === 'critical'))) process.exitCode = 1;
})().catch((e) => { console.error('[watchdog-browser] failed:', e); process.exit(1); });
