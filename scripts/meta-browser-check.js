#!/usr/bin/env node
/* meta-browser-check.js — real-browser evidence for the consent-gated Meta Pixel on bid.advantage.bid (read-only).
   1. Consent GRANTED (advertising): the Pixel loads and fires PageView for the configured dataset. The page URL carries
      utm_source=verification so the visit is labelled. A conversion event is triggered only to prove the shared
      eventID; that request is intercepted and ABORTED, so no conversion reaches Meta.
   2. Consent DENIED: zero requests to Meta.
   Writes a JSON evidence file consumed by `meta-measurement-connect.js verify --browser-evidence=<file>`.
   Usage: node scripts/meta-browser-check.js --dataset=<id> --out=<file> [--base=https://bid.advantage.bid] */
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));
const arg = (n, d = null) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const DATASET = arg('dataset'); const OUT = arg('out'); const BASE = arg('base', 'https://bid.advantage.bid');
if (!/^\d{8,20}$/.test(DATASET || '') || !OUT) { console.error('usage: --dataset=<id> --out=<file>'); process.exit(2); }
const PAGE = BASE + '/assisted-service.html?utm_source=verification&utm_medium=internal_check&utm_campaign=meta_measurement_check';
const isMeta = (u) => /(^https:\/\/([a-z0-9-]+\.)?facebook\.(com|net)\/)|connect\.facebook\.net/.test(u);

async function run(consented) {
  const browser = await chromium.launch();
  // Meta's pixel suppresses events for the default "HeadlessChrome" user agent; use a standard desktop Chrome UA.
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });
  const consent = { analytics: true, personalization: false, advertising: consented, policy_version: 'v1' };
  await ctx.addInitScript((c) => { try { localStorage.setItem('aap_consent', JSON.stringify(c)); sessionStorage.removeItem('aap_measurement_cfg'); } catch (e) {} }, consent);
  const seen = []; const aborted = [];
  await ctx.route(/facebook\.com\/tr/, (route) => {
    const u = new URL(route.request().url()); const ev = u.searchParams.get('ev');
    const rec = { ev, id: u.searchParams.get('id'), eid: u.searchParams.get('eid') };
    if (ev && ev !== 'PageView') { aborted.push(rec); return route.abort(); }   // conversions never leave the test browser
    seen.push(rec); return route.continue();
  });
  const page = await ctx.newPage();
  const metaRequests = [];
  page.on('request', (r) => { if (isMeta(r.url())) metaRequests.push(r.url().split('?')[0]); });
  await page.goto(PAGE, { waitUntil: 'load', timeout: 60000 });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && consented && !seen.some((s) => s.ev === 'PageView')) await page.waitForTimeout(500);
  let dedup = null;
  if (consented) {
    const eid = 'ev-browsercheck-' + Date.now().toString(36);
    const tracked = await page.evaluate((id) => !!(window.AdvMeasurement && window.AdvMeasurement.track('assisted_service_inquiry', id)), eid);
    await page.waitForTimeout(2500);
    const hit = aborted.find((a) => a.eid === eid);
    dedup = { tracked, event: hit ? hit.ev : null, event_id_matches: !!hit, sent_to_meta: false };
  } else {
    await page.waitForTimeout(8000);
  }
  await browser.close();
  return { consent, pageview: seen.some((s) => s.ev === 'PageView'), dataset_matches: seen.some((s) => s.ev === 'PageView' && s.id === DATASET), requests: metaRequests.length, dedup };
}

(async () => {
  const consentedRun = await run(true);
  const deniedRun = await run(false);
  const evidence = { at: new Date().toISOString(), page: PAGE, consented: consentedRun, denied: deniedRun, dedup: consentedRun.dedup };
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 1));
  console.log('BROWSER ' + JSON.stringify(evidence));
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
