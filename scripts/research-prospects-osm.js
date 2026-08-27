#!/usr/bin/env node
/*
 * research-prospects-osm.js — LEGITIMATE nationwide prospect research from OpenStreetMap via the
 * Overpass API. OSM data is open (ODbL); the Overpass API permits automated queries under fair-use
 * rate limits (we query one state at a time with a crawl delay). We collect ONLY publicly-tagged
 * business contact info (name, phone, email, website, city/state) for AUCTION businesses — never
 * personal data — and record a per-record source_url (the OSM element page) for rep verification.
 *
 * We NEVER fabricate or guess: a prospect is imported as ACTIONABLE only if OSM carries a real public
 * phone or email tag. Absence of a website tag is NOT asserted as "no website" (section 4).
 *
 * Usage:
 *   node scripts/research-prospects-osm.js --dry [--states=US-TX,US-PA]   # print, no DB write
 *   railway run node scripts/research-prospects-osm.js --apply            # import into prod CRM
 */
const { fetchText } = require('../src/services/eventImport/http');
const svc = require('../src/services/salesProspectService');
const profileSchema = require('../src/lib/professionalProfileSchema');

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const UA = 'AdvantageBidBot/1.0 (+https://bid.advantage.bid; lawful B2B prospect research; info@advantage.bid)';
const CRAWL_DELAY_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DRY = process.argv.includes('--dry');
const APPLY = process.argv.includes('--apply');
const statesArg = (process.argv.find((a) => a.startsWith('--states=')) || '').split('=')[1];
const STATES = statesArg ? statesArg.split(',') : profileSchema.US_STATES.map((s) => 'US-' + s);

function overpassQuery(iso) {
  // On-target businesses: auction houses/auctioneers (shop=auction or name contains "auction"), and
  // estate-sale / liquidation companies (name contains "estate sale" or "liquidat"). Real-estate
  // brokers are excluded in mapping. Personal data is never collected — only public business tags.
  return `[out:json][timeout:150];
area["ISO3166-2"="${iso}"][admin_level=4]->.a;
(
  nwr["shop"="auction"](area.a);
  nwr["name"~"[Aa]uction"](area.a);
  nwr["name"~"[Ee]state [Ss]ale"](area.a);
  nwr["name"~"[Ll]iquidat"](area.a);
);
out center tags;`;
}

function fmtPhone(raw) {
  const d = String(raw || '').replace(/[^0-9]/g, '').replace(/^1(?=\d{10}$)/, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return String(raw || '').trim();
}
function cleanWebsite(w) {
  const s = String(w || '').trim();
  return /^https?:\/\//i.test(s) ? s : (s ? 'http://' + s : null);
}

// Map one OSM element → a prospect record, or null if not a usable actionable auction business.
function mapElement(el, stateAbbr) {
  const t = el.tags || {};
  const name = (t.name || '').trim();
  if (!name) return null;
  if (t.highway || t.railway || t.natural || t.waterway) return null;   // not a business POI
  const isAuction = t.shop === 'auction' || /auction/i.test(name);
  const isEstate = /estate\s+sale|liquidat/i.test(name);
  if (!isAuction && !isEstate) return null;
  if (/real\s?estate|realty|realtor/i.test(name) && !isAuction && !isEstate) return null; // exclude realtors
  const phoneRaw = t.phone || t['contact:phone'] || t['contact:mobile'];
  const emailRaw = t.email || t['contact:email'];
  if (!phoneRaw && !emailRaw) return null;                              // ACTIONABLE only
  const website = cleanWebsite(t.website || t['contact:website']);
  const osmType = el.type; const osmId = el.id;
  // Name-based classification (never asserted beyond what the name states):
  const businessType = isEstate ? 'estate_sale_company' : 'auction_house';
  return {
    company_name: name,
    city: (t['addr:city'] || '').trim() || null,
    state: stateAbbr,
    zip: (t['addr:postcode'] || '').trim() || null,
    business_phone: phoneRaw ? fmtPhone(phoneRaw) : null,
    business_email: emailRaw ? String(emailRaw).trim() : null,
    website: website,
    // Do NOT assert website quality or "no website" from OSM absence (section 4).
    website_status: 'unknown',
    independent_website: website ? 'yes' : 'unknown',
    // Only a name that literally says "estate sale"/"liquidation" supports estate_sales_offered='yes'.
    estate_sales_offered: isEstate ? 'yes' : 'unknown',
    online_auctions_offered: 'unknown',
    business_type: businessType,
    source: 'osm_overpass',
    source_url: `https://www.openstreetmap.org/${osmType}/${osmId}`,
    contact_source: 'OpenStreetMap (Overpass API, public business tags)',
  };
}

async function fetchState(iso) {
  const url = ENDPOINT + '?data=' + encodeURIComponent(overpassQuery(iso));
  const r = await fetchText(url, { timeoutMs: 120000, maxBytes: 24 * 1024 * 1024, retries: 2, headers: { 'User-Agent': UA } });
  if (!r || !r.ok) throw new Error('overpass ' + (r && r.status));
  let j; try { j = JSON.parse(r.text); } catch (e) { throw new Error('parse'); }
  return j.elements || [];
}

(async () => {
  if (!DRY && !APPLY) { console.log('Pass --dry or --apply.'); process.exit(2); }
  const all = [];
  const perState = {};
  for (const iso of STATES) {
    const abbr = iso.replace('US-', '');
    try {
      const els = await fetchState(iso);
      const mapped = els.map((e) => mapElement(e, abbr)).filter(Boolean);
      perState[abbr] = mapped.length;
      all.push(...mapped);
      console.log(`${abbr}: ${els.length} elements → ${mapped.length} actionable auction prospects`);
    } catch (e) {
      perState[abbr] = 'ERR';
      console.log(`${abbr}: ERROR ${e.message}`);
    }
    await sleep(CRAWL_DELAY_MS);
  }

  // In-batch dedup by domain → phone → name+city+state (DB dedup also runs in importProspects).
  const seen = new Set(); const deduped = [];
  for (const rec of all) {
    const k = svc.dedupKeys(rec);
    const key = k.website_domain || k.normalized_phone || `${k.normalized_name}|${rec.city}|${rec.state}`;
    if (seen.has(key)) continue;
    seen.add(key); deduped.push(rec);
  }
  console.log(`\nCollected ${all.length} actionable auction prospects; ${deduped.length} after in-batch dedup.`);
  const withPhone = deduped.filter((r) => r.business_phone).length;
  const withEmail = deduped.filter((r) => r.business_email).length;
  console.log(`With phone: ${withPhone} | with email: ${withEmail} | with website: ${deduped.filter((r) => r.website).length}`);
  const states = Object.keys(perState).filter((s) => typeof perState[s] === 'number' && perState[s] > 0);
  console.log(`State coverage (nonzero): ${states.length} states`);

  if (DRY) {
    console.log('\nDRY RUN — no DB writes. Sample:');
    deduped.slice(0, 5).forEach((r) => console.log('  ', JSON.stringify({ name: r.company_name, city: r.city, state: r.state, phone: r.business_phone, web: r.website, src: r.source_url })));
    return;
  }

  const summary = await svc.importProspects(deduped, { source: 'osm_overpass', requireContact: true });
  console.log('\nIMPORT=' + JSON.stringify(summary));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
