#!/usr/bin/env node
'use strict';
/*
 * refresh-estatesales-national.js — the recurring EstateSales.NET population routine.
 *
 * Designed to run on a schedule (Railway cron, ~2x/week). Idempotent and NEVER duplicates: it
 * re-crawls a fixed set of priority metros, and the framework's dedupe ladder (source_event_id via
 * event_sources) skips anything already imported — only genuinely NEW, active, image-bearing listings
 * are created. It reuses the governed engine (runImport: normalize → validate → dedupe → market-resolve
 * → writer/provenance) and the two-tier privacy geocoder. Physical estate sales get an offset pin;
 * ONLINE auctions get no pin. Newly created events are published so the marketplace stays populated.
 *
 *   railway run --service advantage-auction-platform node scripts/refresh-estatesales-national.js [--dry-run]
 *
 * Uses the prod env (DATABASE_URL + MAPBOX_GEOCODING_TOKEN). Genuine source data only; no fabrication.
 */
const https = require('https');
const db = require('../src/db');
const { withTransaction } = require('../src/utils/withTransaction');
const { runImport } = require('../src/services/eventImport');
const { evaluatePublication } = require('../src/services/eventImport/publicationGate');
const eventGeo = require('../src/services/eventGeocodingService');

const DRY = process.argv.includes('--dry-run');
const SOURCE_KEY = 'estatesales-national';
const OWNER_ORG = 'a9a2f8c6-5929-4335-a453-ffef96270e5c'; // Advantage Auction Company (established imported-events org)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'https://www.estatesales.net';
const METROS = ['NY/New-York','NY/Brooklyn','NJ/Newark','NJ/Jersey-City','CT/Hartford','CT/Stamford','PA/Philadelphia','PA/Pittsburgh',
  'MA/Boston','RI/Providence','VA/Richmond','VA/Arlington','MD/Baltimore','NC/Charlotte','NC/Raleigh','SC/Charleston','OH/Columbus','OH/Cleveland',
  'MI/Detroit','CO/Denver','AZ/Phoenix','AZ/Scottsdale','WA/Seattle','OR/Portland','FL/Orlando','FL/Miami','GA/Atlanta','TN/Nashville','MN/Minneapolis','CA/San-Diego'];
const PER_METRO = 4, GLOBAL_CAP = 90;
const TZ = { NY:'America/New_York',NJ:'America/New_York',CT:'America/New_York',PA:'America/New_York',MA:'America/New_York',RI:'America/New_York',NH:'America/New_York',
  VA:'America/New_York',MD:'America/New_York',NC:'America/New_York',SC:'America/New_York',OH:'America/New_York',MI:'America/New_York',FL:'America/New_York',GA:'America/New_York',KY:'America/New_York',
  TN:'America/Chicago',MN:'America/Chicago',TX:'America/Chicago',IL:'America/Chicago',WI:'America/Chicago',AL:'America/Chicago',
  CO:'America/Denver',AZ:'America/Phoenix',WA:'America/Los_Angeles',OR:'America/Los_Angeles',CA:'America/Los_Angeles',NV:'America/Los_Angeles' };

function get(url) { return new Promise((resolve) => {
  const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, timeout: 25000 }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(get(new URL(res.headers.location, url).href)); }
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  req.on('error', () => resolve({ status: 0, body: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); }); }); }
function ld(html) { const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html)) !== null) { try { const j = JSON.parse(m[1]); for (const o of (Array.isArray(j) ? j : [j])) if (o && (o['@type'] === 'SaleEvent' || o['@type'] === 'Event' || o.startDate)) return o; } catch (e) {} } return null; }
function imgs(o) { let a = (o && o.image) || []; if (typeof a === 'string') a = [a];
  return [...new Set(a.filter((u) => typeof u === 'string' && /picturescdn\.estatesales\.net\//.test(u)))].slice(0, 8); }
function classify(o, name, org) {
  const online = (o.location && o.location['@type'] === 'VirtualLocation') || /online/.test(String(o.eventAttendanceMode || '').toLowerCase());
  const auction = online || /\bauction\b|bidding/i.test(name || '');
  return { sale_type: auction ? 'auction' : 'estate_sale', event_format: online ? 'online' : 'live' };
}
const esc = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

async function crawl() {
  const now = Date.now(); const out = []; const seen = new Set(); let fetches = 0;
  for (const metro of METROS) { if (fetches >= GLOBAL_CAP) break;
    const mp = await get(`${BASE}/${metro}`); await sleep(450);
    const urls = [...new Set((mp.body.match(/\/[A-Z]{2}\/[A-Za-z.'-]+\/[0-9]{5}\/[0-9]{6,8}/g) || []))].slice(0, PER_METRO);
    for (const path of urls) { if (fetches >= GLOBAL_CAP) break; const id = path.split('/').pop();
      if (seen.has(id)) continue; seen.add(id);
      const d = await get(`${BASE}${path}`); fetches++; await sleep(420);
      if (d.status !== 200) continue; const o = ld(d.body);
      if (!o || !o.name || !o.startDate || !o.endDate) continue;
      if (new Date(o.endDate).getTime() < now) continue;
      const images = imgs(o); if (!images.length) continue;
      const org = (o.organizer && (o.organizer.name || o.organizer)) || ''; const p = path.split('/'); const st = p[1];
      const a = (o.location && o.location.address) || {}; const cls = classify(o, o.name, org);
      out.push({ id, title: o.name, start: o.startDate, end: o.endDate,
        city: a.addressLocality || decodeURIComponent(p[2] || '').replace(/-/g, ' '), state: a.addressRegion || st, zip: a.postalCode || p[3] || '',
        address: cls.event_format === 'online' ? '' : (a.streetAddress || ''), organizer: org, organizer_url: (o.organizer && o.organizer.url) || '',
        url: `${BASE}${path}`, event_format: cls.event_format, sale_type: cls.sale_type, timezone: TZ[st] || 'America/New_York', images: images.join('|') }); } }
  return { rows: out, fetches };
}

async function main() {
  const { rows, fetches } = await crawl();
  const cols = ['id','title','start','end','city','state','zip','address','organizer','organizer_url','url','event_format','sale_type','timezone','images'];
  const csvText = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
  const byType = rows.reduce((a, r) => ((a[r.sale_type] = (a[r.sale_type] || 0) + 1), a), {});
  console.log(`[refresh] crawled ${fetches} listings → ${rows.length} candidate active events`, JSON.stringify(byType), DRY ? '(DRY RUN)' : '');
  if (!rows.length) { console.log('[refresh] nothing to import.'); return; }

  const config = { field_map: { title:'title', start_at:'start', end_at:'end', city:'city', state:'state', zip:'zip', address:'address',
    timezone:'timezone', sale_type:'sale_type', event_format:'event_format', external_url:'url', organizer_name:'organizer', organizer_website_url:'organizer_url' },
    idColumn: 'id', urlColumn: 'url', imageColumn: 'images', imageDelimiter: '|', csvText };
  await db.query(
    `INSERT INTO import_sources (key, kind, name, status, config, owner_organization_id, weekly_cap, auto_publish)
     VALUES ($1,'csv','EstateSales.NET','active',$2,$3,75,false)
     ON CONFLICT (key) DO UPDATE SET config = EXCLUDED.config, status='active', updated_at = now()`,
    [SOURCE_KEY, JSON.stringify(config), OWNER_ORG]);

  // Defer geocoding (online-aware geocode runs after publish); dedupe skips already-imported events.
  const res = await runImport({ sourceKey: SOURCE_KEY, apply: !DRY, withTransaction, geocodeFn: async () => ({ ok: false, status: 'deferred' }) });
  console.log('[refresh] import:', JSON.stringify(res.counters));

  if (!DRY) {
    const createdIds = res.items.filter((i) => i.outcome === 'created' && i.eventId).map((i) => i.eventId);
    // GOVERNED self-healing publish (recovers drafts from any prior interrupted/partial run). Every
    // imported draft is checked against the SHARED publication gate (evaluatePublication) — an event
    // becomes public ONLY with a verified host company + a company-controlled destination + valid
    // quality/privacy/date/image. Held events stay draft with their reasons logged. No bulk UPDATE may
    // bypass the gate, and skipGate is never used here. An event that has lost its verified destination
    // is simply not re-published (held), consistent with lifecycle policy.
    const drafts = (await db.query(
      `SELECT e.id, e.source, e.title, e.start_at, e.end_at, e.event_format, e.city, e.state, e.lat, e.lng,
              e.organizer_name, e.organizer_website_url, e.registration_url, e.bidding_url,
              (SELECT count(*)::int FROM event_images ei WHERE ei.event_id = e.id) AS image_count
         FROM events e
        WHERE e.source = 'imported' AND e.status = 'draft' AND (e.end_at IS NULL OR e.end_at >= now())`)).rows;
    let published = 0, held = 0; const heldReasons = {};
    for (const d of drafts) {
      const g = evaluatePublication(d);
      if (!g.ready) { held++; g.reasons.forEach((x) => { heldReasons[x] = (heldReasons[x] || 0) + 1; }); continue; }
      const up = await db.query(
        `UPDATE events SET status='published', published_at=now(), updated_at=now()
          WHERE id=$1 AND source='imported' AND status='draft' RETURNING id`, [d.id]);
      if (up.rowCount) published++;
    }
    // Online-aware two-tier geocoding of the newly published PHYSICAL events (online → no pin).
    let geocoded = 0; const targets = await eventGeo.findMissingEventCoordinates(200);
    for (const e of targets) { const r = await eventGeo.geocodeEvent(e.id); if (r.ok && !r.skipped) geocoded++; }
    console.log(`[refresh] created ${createdIds.length}, published ${published}, held ${held} ${JSON.stringify(heldReasons)}, geocoded ${geocoded} (new physical events).`);
  }
}
main().catch((e) => { console.error('[refresh] FAILED:', e && e.message); process.exitCode = 1; }).finally(() => db.pool.end());
