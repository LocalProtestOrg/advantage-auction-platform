#!/usr/bin/env node
'use strict';
/**
 * Phase 3P.1 + 3P.2 proving grounds — PRIVATE / OWNER REVIEW ONLY. No publishing, no social post, no paid ad, no spend.
 * Run against production data (read facts, write only creative calibration / review rows):
 *   railway run --environment production -- node scripts/run-proving-grounds-3p2.js [--no-judge]
 * Order: gates asserted OFF → Owner feedback records ingested (negative signatures) → reference index upserted →
 * regression (the six 2026-09-09 renders under v2; REF-14…23 scored as candidates) → media decisions (real Houston
 * events) → class proving grounds → review page. Output: docs/marketing/phase3p1/proving-grounds/2026-09-11/.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/db');
const cfg = require('../src/services/marketingConfigService');
const indexer = require('../src/services/creativeReference/indexer');
const feedbackRecords = require('../src/services/creativeReference/feedbackRecords');
const mediaDirector = require('../src/services/creativeReference/mediaDirector');
const pg2 = require('../src/services/creativeReference/provingGround2');
const packet2 = require('../src/services/creativeReference/packet2');
const bridge = require('../src/services/creativeReference/engineBridge');
const variation = require('../src/services/creativeReference/variation');
const contact = require('../src/lib/companyContact');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'marketing', 'phase3p1', 'proving-grounds', '2026-09-11');
const PG0 = path.join(ROOT, 'docs', 'marketing', 'phase3p', 'proving-grounds', '2026-09-09');
const A = path.join(ROOT, 'creative-engine', 'runtime', 'assets');
const JUDGE = !process.argv.includes('--no-judge');
const WU_ID = '38aed25b-a94e-4cc6-a468-60b2461689d2';
const MC_ID = '5eb00c47-b4ba-43e2-b969-d0279507ac7e';
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const FORMATS = ['portrait_1080x1350', 'square_1080x1080'];
const DISC = 'Representative items shown — not auction lots';
const obj = (id, lot, title, extra) => Object.assign({ id, asset: path.join(A, `lot${lot}.webp`), title, representative: true }, extra || {});
const REP = {
  chairs: obj('chairs', '31', 'Pair of red wingback chairs'), torchiere: obj('torchiere', '46', 'French bronze torchiere'), table: obj('table', '36', 'Mahogany pie crust table'),
  vases: obj('vases', '53', 'Pair of Chinese porcelain vases'), bowl: obj('bowl', '63', 'Sterling silver bowl', { role_hint: 'accent' }), oil: obj('oil', '73', 'Nierman abstract oil'),
  mirror: obj('mirror', '3', 'Cathedral three panel mirror'), litho: obj('litho', '74', 'Chagall lithograph'), etching: obj('etching', '44e', 'Knox Martin etching'),
  pheasant: obj('pheasant', '25', 'Boehm pheasant figurine'), sphere: obj('sphere', '11d', 'Rose quartz sphere'), pitcher: obj('pitcher', '13', 'Silver chocolate pitcher'),
  plates: obj('plates', '30', 'Three Japanese Imari plates'), bust: obj('bust', '78', 'Female marble bust'),
};
const repAssets = (ids) => ids.map((k) => ({ asset_id: path.basename(REP[k].asset), rights: 'Advantage.Bid-owned demo auction asset (extracted, CLEAN)', representative_not_lots: true }));
const repBrief = (cls, ids) => ({ brief_id: 'p3p2-' + cls + '-' + Date.now(), obligation_id: 'proving-ground', auction_id: 'none', family: 'EDITORIAL', merchandise_mode: 'representative', representative_assets: repAssets(ids),
  claim_manifest: [{ claim: 'help_phone', value: contact.PHONE_DISPLAY, source: 'companyContact.PHONE_DISPLAY' }], cta: { kind: 'destination' } });

function fmtLocal(d, tz, o) { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, o)).format(d); }

(async () => {
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  // 0. Owner inputs first: feedback records (negative signatures) and the reference index (DB mirror).
  const fb = await feedbackRecords.ingest({ db });
  console.log('FEEDBACK ' + JSON.stringify({ records: fb.records, inserted: fb.inserted, invalid: fb.invalid.length, unknown: fb.unknown.length, negatives: fb.negatives }));
  const prevIdx = indexer.loadIndex();
  const built = await indexer.buildIndex({ db, appliedHashes: prevIdx.applied_decisions || [] });
  console.log('INDEX ' + JSON.stringify({ version: built.index.index_version, references: built.index.counts.references, by_status: built.index.counts.by_status, empty: built.index.empty_classes, problems: built.problems.length }));

  // 1. Regression: the six 2026-09-09 renders under v2 (pixel-identical reproduction) + references as candidates.
  const reg = await bridge.call({ op: 'regression_analyse', out_dir: path.join(ROOT, 'creative-engine', 'runtime', 'cache', 'regression') }, { timeoutMs: 1800000 });
  const negSigsAll = (await db.query(`SELECT subject_id AS id, signature, campaign_class FROM marketing_creative_layout_signatures WHERE polarity='negative'`)).rows;
  const regression = [];
  for (const a of (reg.anchors || [])) {
    const blocking = []; const regen = [];
    if (a.physical && a.physical.violations.length) blocking.push('physics: ' + [...new Set(a.physical.violations.map((v) => v.kind))].join(', '));
    if (!a.coverage_gate.pass_) blocking.push('coverage/void/panel: ' + a.coverage_gate.hard_failures.map((h) => h.split(' (')[0]).join(' | '));
    if (a.family === 'ENVIRONMENTAL_PHOTO' && a.hierarchy_ratio != null && a.hierarchy_ratio < 1.65) blocking.push('hierarchy floor (' + a.hierarchy_ratio + ' < 1.65)');
    if (a.screenshot_hero) blocking.push('screenshot-as-hero (acquisition family rule)');
    const png = path.join(PG0, `${a.job}-${a.candidate}-${a.format}.png`);
    const sig = await bridge.signatures([png]); const s = sig.ok ? Object.values(sig.signatures)[0] : null;
    const neg = s ? negSigsAll.map((n) => ({ id: n.id, d: bridge.distance(s, n.signature) })).sort((x, y) => x.d - y.d)[0] : null;
    if (neg && neg.d < 0.15) blocking.push('negative signature (' + neg.id + ' at ' + neg.d + ')');
    if (a.prominence.violations.length) regen.push('identity prominence: ' + a.prominence.violations.map((v) => v.check).join(', '));
    if (a.event_type.violations.length) regen.push('event type: ' + a.event_type.violations.map((v) => v.check).join(', '));
    const caps = (a.drawn || []).filter((d) => d.role === 'headline' || d.role === 'title').map((d) => d.text).filter((t) => /^[A-Z][a-z']+ [a-z]/.test(t));
    if (caps.length) regen.push('capitalization: sentence-case headline "' + caps[0] + '"');
    const outcome = blocking.length ? 'HARD_FAIL' : (regen.length ? 'REGENERATE' : 'PASS');
    regression.push({ key: a.key, format: a.format, identical: a.render_identical_to_stored, outcome, why: blocking.concat(regen).join(' · ') });
  }
  console.log('REGRESSION ' + JSON.stringify(regression.map((r) => [r.key, r.format.slice(0, 8), r.identical, r.outcome])));
  const refRows = [];
  const idxRefs = built.index.references.filter((r) => /^REF-(1[4-9]|2[0-3])$/.test(r.reference_id));
  const refSigs = await bridge.signatures(idxRefs.map((r) => path.join(ROOT, 'docs/marketing/approved-creative-examples', r.path)));
  const ocrRes = await bridge.call({ op: 'ocr', paths: idxRefs.map((r) => path.join(ROOT, 'docs/marketing/approved-creative-examples', r.path)) }, { timeoutMs: 600000 });
  for (const r of idxRefs) {
    const p = path.join(ROOT, 'docs/marketing/approved-creative-examples', r.path);
    const own = refSigs.ok ? refSigs.signatures[p] : null;
    const oc = ocrRes.ok ? ocrRes.results[p] : { items: [] };
    const brand = (oc.items || []).filter((i) => /ADVANTAGE\s*\.?\s*BID/i.test(i.text.replace(/\s+/g, '')));
    const text = [].concat(r.do_not_generalize || [], r.transferable_lessons || []).join(' ').toLowerCase();
    const props = variation.PROP_RULES.filter((pr) => ({ 'bronze horse': /bronze (rearing )?horse|horse/, 'blue-and-white vase': /blue-and-white|blue and white/, 'category-spine books': /spine|books/, 'laptop with logo': /laptop/, 'script mug/board/box': /mug|chalkboard|script box|board/ })[pr.prop].test(text)).map((pr) => pr.prop);
    refRows.push({ reference_id: r.reference_id, g11: own ? 'HARD FAIL — distance to itself 0 < τ_ref 0.35' : 'signature unavailable', logo: brand.length ? 'rendered logo present (' + brand.length + ' OCR hit) → logo_source FAIL' : 'no OCR hit', echo: props.length >= 3 ? 'FLAGGED (' + props.join(', ') + ')' : (props.length ? 'not flagged (' + props.join(', ') + ')' : 'none') });
  }

  // 2. West University — media ladder (tier walk with the vision judge) + revised candidates R1/R2/R3.
  const ev = (await db.query(`SELECT id, title, start_at, end_at, timezone, venue_name, city, state, organizer_name, external_url FROM events WHERE id=$1 AND status='published'`, [WU_ID])).rows[0];
  if (!ev) throw new Error('West University event not published');
  const wuAssets = path.join(PG0, 'assets'); const prov = JSON.parse(fs.readFileSync(path.join(wuAssets, 'provenance.json'), 'utf8'));
  const wuPhotos = prov.photographs.map((p) => ({ name: p.name, path: path.join(wuAssets, p.name), asset_sha256: p.sha256, provenance: p }));
  const wuCover = { name: 'event cover (seller-published graphic)', path: path.join(wuAssets, 'published-anchor.png'), asset_sha256: prov.anchor.sha256, provenance: { event_id: WU_ID, source_page: prov.anchor.source_url, retrieved_at: '2026-09-09', rights: 'seller-published event cover', sha256: prov.anchor.sha256 } };
  const wuMedia = await mediaDirector.decide({ id: WU_ID }, { cover: wuCover, site_photographs: wuPhotos, videos: [], clean_objects: 0 }, { judge: JUDGE, requiredAspect: 2.3 });
  console.log('WU MEDIA ' + JSON.stringify({ tier: wuMedia.tier_selected, selected: wuMedia.selected_asset, tier4: wuMedia.tier4_available }));
  const sel = wuPhotos.find((p) => p.asset_sha256 === wuMedia.selected_asset_sha256) || wuPhotos[1];
  const tz = ev.timezone || 'America/Chicago';
  const wuCopy = { presenter: ev.organizer_name, relationship: 'In Conjunction with', modifier: 'Exclusive On-Site', event_type: 'Estate Sale', event_title: ev.venue_name.replace(/ Area$/i, ''),
    date: fmtLocal(ev.start_at, tz, { weekday: 'long', month: 'long', day: 'numeric' }), time: `${fmtLocal(ev.start_at, tz, { hour: 'numeric', minute: '2-digit' })} – ${fmtLocal(ev.end_at, tz, { hour: 'numeric', minute: '2-digit' })} · One day only`,
    place_plate: `${ev.venue_name} · ${ev.city}, ${ev.state}` };
  const wuManifest = [{ claim: 'title', value: ev.title, source: 'events.title' }, { claim: 'venue_name', value: ev.venue_name, source: 'events.venue_name' }, { claim: 'start_at', value: ev.start_at, source: 'events.start_at' },
    { claim: 'end_at', value: ev.end_at, source: 'events.end_at' }, { claim: 'city_state', value: `${ev.city}, ${ev.state}`, source: 'events.city/state' }, { claim: 'organizer_name', value: ev.organizer_name, source: 'events.organizer_name' },
    { claim: 'event_type', value: 'Estate Sale', source: 'events.title (event-type vocabulary match: "Estate Sale")' }];
  const wuBrief = { brief_id: 'p3p1-wu-' + Date.now(), obligation_id: 'proving-ground', auction_id: ev.id, event_id: ev.id, family: 'EVENT_PHOTO', merchandise_mode: 'photograph',
    site_photographs: [{ asset_id: sel.asset_sha256, event_id: ev.id, provenance: sel.provenance }], claim_manifest: wuManifest, cobrand: { seller_name: ev.organizer_name, seller_logo_asset_id: null } };
  const wuSpec = (pattern, red, opt) => ({ pattern, red, photo_path: sel.path, photo_asset_id: sel.asset_sha256, copy: wuCopy, options: opt || {}, context: 'seller_led_cobranded' });
  const wuExpect = { event_type: 'Estate Sale', who: 'Lewis', when: 'September' };
  const wu = await pg2.run({ jobId: 'p3p1-west-university', title: 'West University — revised (authentic photograph · Estate Sale leads · Advantage.Bid mark in the relationship line)', campaignClass: 'estate_sale',
    need: { campaign_class: 'estate_sale', seller_hierarchy: 'seller_led_cobranded', event_mode: 'on_site', merchandise_mode: 'photograph', merchandise_breadth: 'broad', format_class: 'portrait', family: 'ENVIRONMENTAL_PHOTO', requested_family: 'ENVIRONMENTAL_PHOTO', families_allowed: ['ENVIRONMENTAL_PHOTO'], text_profile: 'GENERAL' },
    brief: wuBrief, mediaDecision: wuMedia, formats: FORMATS, cobrandSeller: ev.organizer_name, anchorPath: wuCover.path, db, cfg, judge: JUDGE, outDir: OUT,
    previous: [{ label: 'Previous A (GOOD — event type + identity too small)', png: path.join(PG0, 'p3p-west-university-A-portrait_1080x1350.png') }, { label: 'Previous C (best of three — same fixes)', png: path.join(PG0, 'p3p-west-university-C-portrait_1080x1350.png') }],
    omissions: ['street address (not published by the seller — omitted, not invented)', 'seller logo (no seller logo asset in production — the seller is set in type)'],
    candidates: [
      { key: 'R1', family: 'EVENT_PHOTO', structure: 'ENVIRONMENTAL_FULL_BLEED', profile: 'EVENT', spec: wuSpec('TYPE_LED', 'event_type'), expect: wuExpect, notes: 'TYPE_LED: "Estate Sale" leads in red; West University second; the photograph the Director selected' },
      { key: 'R2', family: 'EVENT_PHOTO', structure: 'ENVIRONMENTAL_FULL_BLEED', profile: 'EVENT', spec: wuSpec('TWO_LINE_UNIT', 'date'), expect: wuExpect, notes: 'TWO_LINE_UNIT: place / type; the red moves to the date' },
      { key: 'R3', family: 'EVENT_PHOTO', structure: 'ENVIRONMENTAL_FULL_BLEED', profile: 'EVENT', extreme: true, spec: wuSpec('TYPE_LED', 'event_type', { identity_scale: 1.3, type_scale: 1.3 }), expect: wuExpect, notes: 'Calibration extreme: identity and event type at 1.3×, nothing else enlarged — say "come back X%"' },
    ] });

  // 3. Individual Seller acquisition (Gold-calibrated; "You Can Do This." approved; physically planned scenes).
  const room = ['chairs', 'torchiere', 'table', 'vases', 'bowl', 'oil', 'mirror', 'litho', 'etching'];
  const objs = (ids) => ids.map((k) => REP[k]);
  const isCta = 'Start Your Auction Today';
  const is = await pg2.run({ jobId: 'p3p1-individual-seller', title: 'Individual Seller acquisition — "You Can Do This." with physically planned scenes', campaignClass: 'individual_seller_acquisition',
    need: { campaign_class: 'individual_seller_acquisition', seller_hierarchy: 'advantage_bid_only', event_mode: 'not_an_event', merchandise_mode: 'representative', merchandise_breadth: 'representative_non_lot', format_class: 'portrait', family: 'ACQUISITION', families_allowed: ['ACQUISITION'], text_profile: 'GENERAL' },
    brief: repBrief('is', room.concat(['pheasant', 'plates'])), formats: FORMATS, db, cfg, judge: JUDGE, outDir: OUT,
    previous: [{ label: 'Previous A (needs work — table through chair)', png: path.join(PG0, 'p3p-individual-seller-A-portrait_1080x1350.png') }, { label: 'Previous C (needs work — white space)', png: path.join(PG0, 'p3p-individual-seller-C-portrait_1080x1350.png') }],
    omissions: ['representative person (no approved representative-person asset exists; people are never generated or taken from stock)', 'fee / reach / speed claims (no production fact briefed — omitted)', 'assisted-service pricing (custom after evaluation — never stated)'],
    candidates: [
      { key: 'P1', family: 'EDITORIAL', structure: 'LEFT_COPY', profile: 'FEED_FAST', generic: true, objects: objs(room),
        spec: { structure: 'LEFT_COPY', profile: 'FEED_FAST', headline_px: 88, coverage_family: 'ACQUISITION', copy: { headline: 'You Can Do This.', headline_red_words: ['This.'], support: 'Create your own online auction on Advantage.Bid.', cta: isCta, disclosure: DISC },
                scene: { kind: 'planned', objects: objs(room) }, options: { logo_width_pct: 0.40, copy_col_frac: 0.44 } }, notes: 'Owner-approved message; room vignette planned and physically audited; CTA → bid.advantage.bid/become-seller.html' },
      { key: 'P2', family: 'EDITORIAL', structure: 'RIGHT_COPY', profile: 'FEED_FAST', generic: true, objects: objs(['chairs', 'table', 'vases', 'bowl', 'mirror', 'oil', 'etching']),
        spec: { structure: 'RIGHT_COPY', profile: 'FEED_FAST', headline_px: 88, coverage_family: 'ACQUISITION', copy: { headline: 'You Can Do This.', headline_red_words: ['This.'], support: 'Create your own online auction on Advantage.Bid.', cta: isCta, disclosure: DISC },
                scene: { kind: 'planned', objects: objs(['chairs', 'table', 'vases', 'bowl', 'mirror', 'oil', 'etching']) }, options: { logo_width_pct: 0.40, copy_col_frac: 0.44 } }, notes: 'Mirrored structure and a different gallery — the planner is not a template' },
      { key: 'A2', family: 'EDITORIAL', structure: 'CENTERED', profile: 'ACQUISITION_RICH', generic: true, objects: objs(['chairs', 'table', 'vases', 'bowl']),
        spec: { structure: 'CENTERED', profile: 'ACQUISITION_RICH', headline_px: 96, coverage_family: 'ACQUISITION', band_script: 'You Can Do This.',
                copy: { headline: 'Have Items to Sell?', headline_red_words: ['Sell?'], subheadline: 'Turn Your Items Into Cash.', support: 'List them in your own online auction on Advantage.Bid.', benefits: ['You Set It Up', 'Buyers Bid Online', 'Help When You Need It'], cta: isCta, disclosure: DISC },
                scene: { kind: 'planned', objects: objs(['chairs', 'table', 'vases', 'bowl']) }, options: { logo_width_pct: 0.36 } }, notes: 'Owner-approved concept "Have Items to Sell? / Turn Your Items Into Cash."; ACQUISITION_RICH ceiling 9 blocks' },
      { key: 'A4', family: 'EDITORIAL', structure: 'LEFT_COPY', profile: 'FEED_FAST', generic: true, market: 'Houston Metro', objects: objs(room),
        spec: { structure: 'LEFT_COPY', profile: 'FEED_FAST', headline_px: 88, coverage_family: 'ACQUISITION', copy: { headline: 'Have Items to Sell?', headline_red_words: ['Sell?'], availability: 'Prefer us to run the sale? Ask about assisted service.', cta: isCta, disclosure: DISC },
                scene: { kind: 'planned', objects: objs(room) }, options: { logo_width_pct: 0.40, copy_col_frac: 0.44 } }, notes: 'Houston / NYC variant: the approved availability line, no price or percentage' },
      { key: 'P3', family: 'EDITORIAL', structure: 'LEFT_COPY', profile: 'FEED_FAST', generic: true, extreme: true, objects: objs(room),
        spec: { structure: 'LEFT_COPY', profile: 'FEED_FAST', headline_px: 88, coverage_family: 'ACQUISITION', copy: { headline: 'You Can Do This.', headline_red_words: ['This.'], support: 'Create your own online auction on Advantage.Bid.', cta: isCta, disclosure: DISC },
                scene: { kind: 'planned', objects: objs(room) }, options: { logo_width_pct: 0.44, copy_col_frac: 0.44 } }, notes: 'Calibration extreme: logo at 44% of width' },
    ] });

  // 4. Buyer growth (Gold-calibrated: "Bid Today. Discover Tomorrow." / "Amazing Finds Delivered to Your Inbox."; discovery language only).
  const tabletop = ['table', 'vases', 'bowl', 'pheasant', 'sphere', 'chairs', 'oil'];
  const buyer = await pg2.run({ jobId: 'p3p2-buyer-growth', title: 'Buyer growth — discovery language, one idea per ad', campaignClass: 'buyer_platform_growth',
    need: { campaign_class: 'buyer_platform_growth', seller_hierarchy: 'advantage_bid_only', event_mode: 'not_an_event', merchandise_mode: 'representative', merchandise_breadth: 'representative_non_lot', format_class: 'portrait', family: 'ACQUISITION', families_allowed: ['ACQUISITION'], text_profile: 'GENERAL' },
    brief: repBrief('buyer', tabletop), formats: FORMATS, db, cfg, judge: JUDGE, outDir: OUT,
    omissions: ['product screen / laptop (a screen may be one supporting prop, never the hero — none used)', '"Join for Free" / lot counts (claims — omitted)'],
    candidates: [
      { key: 'B1', family: 'EDITORIAL', structure: 'CENTERED', profile: 'FEED_FAST', generic: true, objects: objs(tabletop),
        spec: { structure: 'CENTERED', profile: 'FEED_FAST', headline_px: 92, coverage_family: 'ACQUISITION', copy: { headline: 'Bid Today. Discover Tomorrow.', headline_red_words: ['Discover'], support: 'Unique finds from local estate sales and auctions.', cta: 'Browse Auctions', disclosure: DISC },
                scene: { kind: 'planned', objects: objs(tabletop) }, options: { logo_width_pct: 0.36 } }, notes: 'Owner-approved headline (REF-19 Gold); CTA → bid.advantage.bid' },
      { key: 'B2', family: 'EDITORIAL', structure: 'LEFT_COPY', profile: 'ACQUISITION_RICH', generic: true, objects: objs(tabletop),
        spec: { structure: 'LEFT_COPY', profile: 'ACQUISITION_RICH', headline_px: 84, coverage_family: 'ACQUISITION', copy: { headline: 'Amazing Finds Delivered to Your Inbox.', headline_red_words: ['Finds'], support: 'New auctions and estate sales near you, once a week.', benefits: ['Local Estate Sales', 'Online Auctions', 'Unsubscribe Anytime'], cta: 'Sign Up', slogan: 'The Smarter Way to Shop.', disclosure: DISC },
                scene: { kind: 'planned', objects: objs(tabletop) }, options: { logo_width_pct: 0.40, copy_col_frac: 0.44 } }, notes: 'Real signup destination exists (bid.advantage.bid homepage subscriber signup); REF-18 Gold headline' },
      { key: 'B4', family: 'EDITORIAL', structure: 'CENTERED', profile: 'FEED_FAST', generic: true, extreme: true, objects: objs(tabletop),
        spec: { structure: 'CENTERED', profile: 'FEED_FAST', headline_px: 80, coverage_family: 'ACQUISITION', copy: { eyebrow: 'For Collectors and Bargain Hunters', headline: 'Bid Today. Discover Tomorrow.', subheadline: 'Estate Sales, Auctions and More', support: 'Unique finds from local estate sales and auctions, every week.', help: 'New sales are added every day across the country.', cta: 'Browse Auctions', disclosure: DISC },
                scene: { kind: 'planned', objects: objs(tabletop) }, options: { logo_width_pct: 0.34 } }, notes: 'WORDY CONTROL — NOT FOR PUBLICATION: deliberately over the FEED_FAST budget so you can confirm the density line' },
    ] });

  // 5. Professional Seller acquisition (REF-20 / REF-21 now Gold; variety required).
  const shop = ['chairs', 'table', 'vases', 'bowl', 'oil', 'mirror', 'litho', 'etching', 'torchiere'];
  const pro = await pg2.run({ jobId: 'p3p2-professional-seller', title: 'Professional Seller acquisition — capability and ease, three structures', campaignClass: 'professional_seller_acquisition',
    need: { campaign_class: 'professional_seller_acquisition', seller_hierarchy: 'advantage_bid_only', event_mode: 'not_an_event', merchandise_mode: 'representative', merchandise_breadth: 'representative_non_lot', format_class: 'portrait', family: 'ACQUISITION', families_allowed: ['ACQUISITION'], text_profile: 'GENERAL' },
    brief: repBrief('pro', shop), formats: FORMATS, db, cfg, judge: JUDGE, outDir: OUT,
    omissions: ['software screens as hero (never)', 'shop-interior photograph for C4 (no generic shop photograph exists; none generated) — C4 not produced', 'fee / commission claims (omitted)'],
    candidates: [
      { key: 'C1', family: 'EDITORIAL', structure: 'CENTERED', profile: 'FEED_FAST', generic: true, objects: objs(shop),
        spec: { structure: 'CENTERED', profile: 'FEED_FAST', headline_px: 92, coverage_family: 'ACQUISITION', copy: { headline: 'Sell More With Advantage.Bid', headline_red_words: ['Sell', 'More'], support: 'Your auctions, in front of more buyers.', cta: 'Become a Seller', disclosure: DISC },
                scene: { kind: 'planned', objects: objs(shop) }, options: { logo_width_pct: 0.36 } }, notes: 'REF-20 structure (centered), different everything else; CTA → professional-sellers.html' },
      { key: 'C2', family: 'EDITORIAL', structure: 'LEFT_COPY', profile: 'FEED_FAST', generic: true, objects: objs(shop),
        spec: { structure: 'LEFT_COPY', profile: 'FEED_FAST', headline_px: 88, coverage_family: 'ACQUISITION', copy: { headline: 'From Inventory to Results.', headline_red_words: ['Results.'], slogan: 'The Smarter Way to Sell.', cta: 'Become a Seller', disclosure: DISC },
                scene: { kind: 'planned', objects: objs(shop) }, options: { logo_width_pct: 0.40, copy_col_frac: 0.44 } }, notes: 'REF-21 structure (left copy, serif); the seller slogan as a separate element, never in the logo' },
      { key: 'C3', family: 'EDITORIAL', structure: 'ASYMMETRIC', profile: 'FEED_FAST', generic: true, objects: objs(['chairs', 'table', 'vases', 'bowl', 'oil', 'mirror']),
        spec: { structure: 'ASYMMETRIC', profile: 'FEED_FAST', headline_px: 88, coverage_family: 'ACQUISITION', copy: { headline: 'Sell More With Advantage.Bid', headline_red_words: ['More'], support: 'Your auctions, in front of more buyers.', cta: 'Become a Seller', disclosure: DISC },
                scene: { kind: 'planned', objects: objs(['chairs', 'table', 'vases', 'bowl', 'oil', 'mirror']) }, options: { logo_width_pct: 0.36 } }, notes: 'ASYMMETRIC: headline low-left, merchandise high-right, CTA on the band (a structure no reference shows)' },
    ] });

  // 6. Geographic event — a real upcoming Houston event (ManCave). The ladder decides; nothing is generated for a real event.
  const mc = (await db.query(`SELECT id, title, start_at, end_at, timezone, city, state, organizer_name, external_url FROM events WHERE id=$1 AND status='published'`, [MC_ID])).rows[0];
  let geo = null;
  if (mc) {
    const im = (await db.query(`SELECT url, source_url FROM event_images WHERE event_id=$1 ORDER BY position LIMIT 1`, [MC_ID])).rows[0];
    let coverPath = null, coverSha = null;
    if (im) { const r = await fetch(im.url); coverPath = path.join(OUT, 'assets', 'mancave-event-image.jpg'); fs.writeFileSync(coverPath, Buffer.from(await r.arrayBuffer())); coverSha = sha(coverPath);
      fs.writeFileSync(coverPath + '.provenance.json', JSON.stringify({ kind: 'event_image', event_id: MC_ID, source_url: im.source_url, stored_url: im.url, retrieved_at: new Date().toISOString(), sha256: coverSha, rights: 'seller-published public event image of this sale; used only for this event' }, null, 1)); }
    const cover = coverPath ? { name: 'event image (seller-published)', path: coverPath, asset_sha256: coverSha, provenance: { event_id: MC_ID, source_page: mc.external_url, retrieved_at: new Date().toISOString(), rights: 'seller-published event image', sha256: coverSha } } : null;
    const mcMedia = await mediaDirector.decide({ id: MC_ID }, { cover, site_photographs: [], videos: [], clean_objects: 0 }, { judge: JUDGE, requiredAspect: 2.3 });
    console.log('MC MEDIA ' + JSON.stringify({ tier: mcMedia.tier_selected, candidates: mcMedia.candidates.map((c) => [c.asset, c.ready, JSON.stringify(c.gates)]) }));
    const mtz = mc.timezone || 'America/Chicago';
    const mcCopy = { presenter: mc.organizer_name, relationship: 'In Conjunction with', event_title: 'ManCave Auction',
      date: fmtLocal(mc.start_at, mtz, { weekday: 'long', month: 'long', day: 'numeric' }), time: `${fmtLocal(mc.start_at, mtz, { hour: 'numeric', minute: '2-digit' })} – ${fmtLocal(mc.end_at, mtz, { hour: 'numeric', minute: '2-digit' })} CT`, place_plate: `${mc.city}, ${mc.state}` };
    const mcBrief = { brief_id: 'p3p2-geo-' + Date.now(), obligation_id: 'proving-ground', auction_id: mc.id, event_id: mc.id, family: 'EVENT_PHOTO', merchandise_mode: coverPath ? 'photograph' : 'none',
      site_photographs: coverPath ? [{ asset_id: coverSha, event_id: mc.id, provenance: { event_id: mc.id, source_page: mc.external_url, sha256: coverSha } }] : [],
      claim_manifest: [{ claim: 'title', value: mc.title, source: 'events.title' }, { claim: 'start_at', value: mc.start_at, source: 'events.start_at' }, { claim: 'end_at', value: mc.end_at, source: 'events.end_at' }, { claim: 'city_state', value: `${mc.city}, ${mc.state}`, source: 'events.city/state' }, { claim: 'organizer_name', value: mc.organizer_name, source: 'events.organizer_name' }],
      event_type_missing: true };
    const spec = (inset) => ({ copy: mcCopy, inset_path: inset ? coverPath : null, inset_asset_id: inset ? coverSha : null, context: 'seller_led_cobranded' });
    geo = await pg2.run({ jobId: 'p3p2-geographic-event', title: 'Geographic event — L&M ManCave Auction, Houston (real upcoming event; media ladder → tier ' + mcMedia.tier_selected + ')', campaignClass: 'geographic_event_promotion',
      need: { campaign_class: 'geographic_event_promotion', seller_hierarchy: 'seller_led_cobranded', event_mode: 'online', merchandise_mode: 'none', format_class: 'portrait', family: 'RESTRAINED_FACTUAL', families_allowed: ['RESTRAINED_FACTUAL'], text_profile: 'GENERAL' },
      brief: mcBrief, mediaDecision: mcMedia, formats: FORMATS, cobrandSeller: mc.organizer_name, db, cfg, judge: JUDGE, outDir: OUT,
      omissions: ['event type (the record carries no recognised type — the record title leads; flagged event_type_missing, nothing guessed)', "the seller's tagline in the record title (\"Houston's Premiere Choice\" — a claim, omitted)", 'landmark imagery (D3 — no approved landmark asset and nothing is generated for a real event)', 'venue / address (not in the record)'],
      candidates: [
        { key: 'D1', family: 'EVENT_PHOTO', structure: 'CENTERED', profile: 'RESTRAINED_FACTUAL', spec: spec(true), expect: { who: 'Lewis', when: 'September' }, notes: 'Tier 6 restrained factual co-brand with the event\'s own lot photograph as one small inset' },
        { key: 'D2', family: 'EVENT_PHOTO', structure: 'CENTERED', profile: 'RESTRAINED_FACTUAL', spec: spec(false), expect: { who: 'Lewis', when: 'September' }, notes: 'Tier 6 typographic co-brand (no image)' },
      ] });
  }

  // 7. Notable Lot — deferred honestly (no real, non-demo live auction with lot records in production).
  const live = (await db.query(`SELECT id, title, is_demo FROM auctions WHERE state IN ('published','active')`)).rows;
  const notable = { job_id: 'p3p2-notable-lot', campaign_class: 'notable_lot', title: 'Notable Lot — DEFERRED', results: [], retrieval: {}, bar: 70,
    deferred: 'Deferred, not simulated: production has no real, non-demo live auction with lot records (' + live.map((a) => a.title + (a.is_demo ? ' [demo]' : ' [test]')).join(', ') + '). Imported partner events carry no lot records. The Notable Lot contract, fact manifest and reject list for the fictional REF-23 facts are implemented and tested; this proving ground runs the day a real auction with lots is live.' };

  const review = packet2.writeReview(OUT, [wu, is, buyer, pro].concat(geo ? [geo] : []).concat([notable]), { regression, references: refRows });
  const gates = {}; for (const k of pg2.GATE_KEYS.concat(['marketing.social.insights_enabled', 'marketing.social.reply_draft_enabled'])) gates[k] = await cfg.getBool(k, false);
  const pending = (await db.query(`SELECT count(*)::int n FROM marketing_job_queue WHERE job_type='social_dispatch' AND state IN ('queued','processing')`)).rows[0].n;
  const summary = [wu, is, buyer, pro, geo].filter(Boolean).flatMap((pk) => pk.results.map((r) => ({ job: pk.job_id, key: r.key, format: r.format && r.format.slice(0, 8), ok: r.ok, score: r.score, decision: r.decision, hard: (r.hard_failures || []).map((h) => h.gate), regen: (r.regenerate_violations || []).map((h) => h.gate), error: r.error })));
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ review, gates, social_jobs_pending: pending, regression, references: refRows, summary, blocked: [wu, is, buyer, pro, geo].filter(Boolean).flatMap((pk) => pk.blocked) }, null, 1));
  console.log('SUMMARY ' + JSON.stringify(summary));
  console.log('DONE ' + JSON.stringify({ review, gates, social_jobs_pending: pending }));
  process.exit(0);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
