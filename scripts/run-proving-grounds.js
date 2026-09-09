#!/usr/bin/env node
/* run-proving-grounds.js — Phase 3P: the two NON-PUBLISHING proving grounds (Deliverables 10 + 11).
 *   railway run --environment production -- node scripts/run-proving-grounds.js <out-dir> <photos-dir> <screenshot.png> [--no-judge]
 * Reads production facts (event record, gates), uses only event-bound photographs / Advantage.Bid-owned representative
 * assets / a real production screenshot, renders through the Phase 3P family engines, runs the gates + scorer + judge,
 * persists calibrations, and writes the Owner review packet (review.html). Creates NO publishing or destination job. */
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const db = require(ROOT + '/src/db');
const cfg = require(ROOT + '/src/services/marketingConfigService');
const indexer = require(ROOT + '/src/services/creativeReference/indexer');
const pg = require(ROOT + '/src/services/creativeReference/provingGround');
const packet = require(ROOT + '/src/services/creativeReference/packet');
const contact = require(ROOT + '/src/lib/companyContact');

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'marketing', 'phase3p', 'proving-grounds', new Date().toISOString().slice(0, 10)));
const PHOTOS = path.resolve(process.argv[3] || '');
const SHOT = process.argv[4] ? path.resolve(process.argv[4]) : null;
const JUDGE = !process.argv.includes('--no-judge');
const EVENT_ID = '38aed25b-a94e-4cc6-a468-60b2461689d2';
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const BRAND = { logo_width_px: 250, kicker: 'ADVANTAGE.BID PRESENTS', footer_band_px: 120, footer_wordmark: 'Advantage.Bid', footer_wordmark_px: 64, ground: 'very_light', navy: '#182e45', red: '#d62828' };
const fmtLocal = (iso, tz, o) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, o)).format(new Date(iso));

(async () => {
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  // 0. Index (durable; DB upsert) — the retriever reads the built index.
  const built = await indexer.buildIndex({ db });
  console.log('INDEX ' + JSON.stringify({ version: built.index.index_version, references: built.index.counts.references, empty: built.index.empty_classes, problems: built.problems.length }));

  // ── West University: production facts ──
  const ev = (await db.query(`SELECT id, slug, title, status, start_at, end_at, timezone, venue_name, address, city, state, organizer_name, external_url FROM events WHERE id=$1 AND status='published'`, [EVENT_ID])).rows[0];
  if (!ev) throw new Error('event not published');
  const cover = (await db.query(`SELECT url, source_url FROM event_images WHERE event_id=$1 ORDER BY position LIMIT 1`, [EVENT_ID])).rows[0];
  // Published anchor = the currently published graphic (the event's cover, which is the seller's own composed ad).
  const anchorPath = path.join(OUT, 'assets', 'published-anchor.png');
  if (cover) { const r = await fetch(cover.url); fs.writeFileSync(anchorPath, Buffer.from(await r.arrayBuffer())); }
  // Site photographs: raw room photographs from the event's source page (provenance recorded). The seller's composed
  // advertisement (the cover) is deliberately NOT a photograph candidate.
  const rawPhotos = fs.existsSync(PHOTOS) ? fs.readdirSync(PHOTOS).filter((f) => /^IMG_0(520|522|526-1|529|546|549|550|552)/.test(f)) : [];
  const photos = rawPhotos.map((f) => { const src = path.join(PHOTOS, f); const dst = path.join(OUT, 'assets', f); fs.copyFileSync(src, dst); const h = sha(dst); return { asset_id: h, file: dst, name: f, provenance: { kind: 'event_site_photograph', event_id: ev.id, source_page: ev.external_url, source_url: 'https://image.invaluable.com/privatelabel/connectwp/wp-content/uploads/sites/223/2026/09/' + f, retrieved_at: new Date().toISOString(), sha256: h, rights: 'seller-published public event photograph of this sale; used only for this event (original-host source approved by the Owner)' } }; });
  fs.writeFileSync(path.join(OUT, 'assets', 'provenance.json'), JSON.stringify({ photographs: photos.map((p) => Object.assign({ name: p.name }, p.provenance)), anchor: cover ? { public_url: cover.url, source_url: cover.source_url, sha256: fs.existsSync(anchorPath) ? sha(anchorPath) : null } : null }, null, 1));
  if (photos.length < 2) throw new Error('need at least two site photographs');
  const tz = ev.timezone || 'America/Chicago';
  const copy = { presenter: ev.organizer_name, relationship: 'in conjunction with Advantage.Bid', title: ev.venue_name.replace(/ Area$/i, ''), subtitle: ev.title.replace(new RegExp(ev.venue_name.replace(/ Area$/i, '') + '\\s*', 'i'), '').trim(),
    date: fmtLocal(ev.start_at, tz, { weekday: 'long', month: 'long', day: 'numeric' }), time: `${fmtLocal(ev.start_at, tz, { hour: 'numeric', minute: '2-digit' })} – ${fmtLocal(ev.end_at, tz, { hour: 'numeric', minute: '2-digit' })} · One day only`, place_plate: `${ev.venue_name} · ${ev.city}, ${ev.state}` };
  const claim = (k, v, src) => ({ claim: k, value: v, source: src });
  const claims = [claim('title', ev.title, 'events.title'), claim('venue_name', ev.venue_name, 'events.venue_name'), claim('start_at', ev.start_at, 'events.start_at'), claim('end_at', ev.end_at, 'events.end_at'), claim('city_state', `${ev.city}, ${ev.state}`, 'events.city/state'), claim('organizer_name', ev.organizer_name, 'events.organizer_name')];
  const wuBrief = { brief_id: 'p3p-wu-' + Date.now(), obligation_id: 'proving-ground', auction_id: ev.id, event_id: ev.id, family: 'ENVIRONMENTAL_PHOTO', formats: ['portrait_1080x1350', 'square_1080x1080'], objects: [],
    event: { title: ev.title, city_state: `${ev.city}, ${ev.state}`, date: copy.date, start_time: copy.time, place_name: ev.venue_name, neighbourhood: ev.venue_name, online_only: false, sessions: [{ day_label: copy.date, date: ev.start_at.toISOString().slice(0, 10), start: ev.start_at, end: ev.end_at }], typography_treatment: null },
    brand_frame: BRAND, text_budget: { profile: 'GENERAL' }, rule_engine: '3M.3', merchandise_mode: 'photograph', site_photographs: photos.map((p) => ({ asset_id: p.asset_id, event_id: ev.id, provenance: p.provenance })), claim_manifest: claims, cta: { kind: 'none' },
    cobrand: { seller_name: ev.organizer_name, seller_logo_asset_id: null, relationship_line: 'in conjunction with Advantage.Bid' }, family_options: { title_position: 'top', ground: 'photograph' } };
  const pick = (n) => photos[n % photos.length];
  const wu = await pg.run({ jobId: 'p3p-west-university', title: 'WEST UNIVERSITY — Exclusive West University On-Site Estate Sale (Lewis & Maese)', campaignClass: 'estate_sale',
    need: { campaign_class: 'estate_sale', seller_hierarchy: 'seller_led_cobranded', event_mode: 'on_site', wave: 'MID', merchandise_mode: 'photograph', merchandise_breadth: 'broad', format_class: 'portrait', requested_family: 'ENVIRONMENTAL_PHOTO', families_allowed: ['ENVIRONMENTAL_PHOTO', 'LEFT_THIRD_WHITE'], tags: ['environmental', 'room-photo', 'place-plate', 'portrait', 'bands', 'left-panel'], text_profile: 'GENERAL' },
    brief: wuBrief, formats: ['portrait_1080x1350', 'square_1080x1080'], cobrandSeller: ev.organizer_name, provingGround: true, judge: JUDGE, anchorPath: fs.existsSync(anchorPath) ? anchorPath : null, outDir: OUT, db, cfg,
    omissions: ['street address (not yet published by the seller — omitted, not invented)', 'seller logo (no seller logo asset in production — the presenter is set in type, no crest)', 'category line (kept within the 5-block GENERAL budget)'],
    candidates: [
      { key: 'A', family: 'ENVIRONMENTAL_PHOTO', textProfile: 'GENERAL', assets: [pick(0).name + ' (' + pick(0).asset_id.slice(0, 12) + '…)'], renderSpec: { variant: 'banded', photo_path: pick(0).file, copy, options: {} } },
      { key: 'B', family: 'ENVIRONMENTAL_PHOTO', textProfile: 'GENERAL', assets: [pick(2).name + ' (' + pick(2).asset_id.slice(0, 12) + '…)'], renderSpec: { variant: 'panel', photo_path: pick(2).file, copy, options: { panel_side: 'right' } } },
      { key: 'C', family: 'ENVIRONMENTAL_PHOTO', textProfile: 'GENERAL', extreme: true, assets: [pick(1).name + ' (' + pick(1).asset_id.slice(0, 12) + '…)'], renderSpec: { variant: 'banded', photo_path: pick(1).file, copy, options: { title_scale: 1.15, photo_share: 1.15, extreme_label: true } } },
    ] });
  if (cover) wu.anchor = Object.assign(wu.anchor || {}, { public_url: cover.url });
  console.log('WU ' + JSON.stringify(wu.results.map((r) => ({ key: r.key, format: r.format, ok: r.ok, score: r.score, decision: r.decision, sim: r.similarity && r.similarity.pass, leak: r.leak && r.leak.pass, anchor_d: r.similarity && r.similarity.published_anchor_distance, error: r.error }))));

  // ── Individual Seller Acquisition (empty class) ──
  const A = path.join(ROOT, 'creative-engine', 'runtime', 'assets');
  const rep = (lot, w, cx, z, role) => ({ path: path.join(A, `lot${lot}.webp`), w, cx, z, role, shadow: 0.22 });
  const repAssets = ['31', '46', '36', '53', '63', '3', '87'].map((l) => ({ asset_id: `lot${l}.webp`, rights: 'Advantage.Bid-owned demo auction asset (extracted, CLEAN)', representative_not_lots: true }));
  const isBrief = { brief_id: 'p3p-is-' + Date.now(), obligation_id: 'proving-ground', auction_id: 'none', family: 'ACQUISITION', formats: ['portrait_1080x1350', 'square_1080x1080'], objects: [],
    event: { title: 'Individual seller acquisition', city_state: 'online', date: '', start_time: '', online_only: true }, brand_frame: Object.assign({}, BRAND, { ground: 'white' }), text_budget: { profile: 'GENERAL' }, rule_engine: '3M.3',
    merchandise_mode: 'representative', representative_assets: repAssets, screenshot: SHOT && fs.existsSync(SHOT) ? { asset_id: sha(SHOT), provenance: JSON.parse(fs.readFileSync(SHOT + '.provenance.json', 'utf8')) } : null,
    claim_manifest: [claim('create_own_auction', 'sellers create and manage their own online auction on Advantage.Bid', 'product: /seller-create.html'), claim('help_phone', contact.PHONE_DISPLAY, 'companyContact.PHONE_DISPLAY'), claim('help_email', contact.SUPPORT_EMAIL, 'companyContact.SUPPORT_EMAIL')], cta: { kind: 'none' } };
  const disclosure = 'Representative items shown — not auction lots';
  const help = `Real people help along the way. Call ${contact.PHONE_DISPLAY}.`;
  const cluster = [rep('31', 860, 0.60, 40, 'anchor'), rep('46', 270, 0.09, 30, 'tall'), rep('36', 470, 0.27, 45, 'surface'), rep('53', 260, 0.90, 60, 'foreground'), rep('63', 300, 0.44, 70, 'foreground')];
  const shotPath = SHOT && fs.existsSync(SHOT) ? (() => { const d = path.join(OUT, 'assets', 'create-auction-screenshot.png'); fs.copyFileSync(SHOT, d); if (fs.existsSync(SHOT + '.provenance.json')) fs.copyFileSync(SHOT + '.provenance.json', d + '.provenance.json'); return d; })() : null;
  const is = await pg.run({ jobId: 'p3p-individual-seller', title: 'INDIVIDUAL SELLER ACQUISITION — empty reference class (Owner review mandatory)', campaignClass: 'individual_seller_acquisition',
    need: { campaign_class: 'individual_seller_acquisition', seller_hierarchy: 'advantage_bid_only', event_mode: 'not_an_event', wave: 'ANY', merchandise_mode: 'representative', merchandise_breadth: 'representative_non_lot', format_class: 'portrait', families_allowed: ['ACQUISITION'], tags: ['breadth', 'light-ground', 'minimal-copy', 'warm-light', 'factual-cta'], text_profile: 'GENERAL' },
    brief: isBrief, formats: ['portrait_1080x1350', 'square_1080x1080'], cobrandSeller: null, provingGround: true, judge: JUDGE, anchorPath: null, outDir: OUT, db, cfg,
    omissions: ['team photograph (no approved real Advantage.Bid team photograph exists — help is copy + the real phone number, never stock or generated people)', 'fees / reach / speed claims (no production fact briefed — omitted)'],
    candidates: [
      { key: 'A', family: 'ACQUISITION', textProfile: 'TEASER', assets: ['lot31 chairs', 'lot46 torchiere', 'lot36 table', 'lot53 vases', 'lot63 bowl (all representative, Advantage.Bid-owned)'], renderSpec: { concept: 'A', copy: { primary: "It's built to be easy.", support: 'Create your own online auction on Advantage.Bid.', help, disclosure }, objects: cluster, screenshot_path: null } },
      { key: 'B', family: 'ACQUISITION', textProfile: 'TEASER', assets: ['production screenshot /seller-create.html (' + (isBrief.screenshot ? isBrief.screenshot.asset_id.slice(0, 12) + '…' : 'absent') + ')', 'lot63 bowl', 'lot53 vases (representative)'], renderSpec: { concept: 'B', copy: { primary: 'You can do this.', support: 'Describe your sale, then add your items — one screen at a time.', help, disclosure }, objects: [rep('36', 430, 0.15, 45, 'surface'), rep('63', 260, 0.32, 70, 'foreground')], screenshot_path: shotPath } },
      { key: 'C', family: 'ACQUISITION', textProfile: 'GENERAL', assets: ['lot46 torchiere', 'lot31 chairs', 'lot87 dinnerware (representative)'], renderSpec: { concept: 'C', copy: { primary: 'Help is here.', support: 'Real people help you create and run your own online auction.', help: "It's built to be easy — and you are never on your own.", contact: `${contact.PHONE_DISPLAY} · ${contact.SUPPORT_EMAIL}`, disclosure }, objects: [rep('31', 1100, 0.55, 40, 'anchor'), rep('46', 360, 0.12, 30, 'tall'), rep('87', 560, 0.40, 60, 'foreground')], screenshot_path: null } },
    ] });
  console.log('IS ' + JSON.stringify(is.results.map((r) => ({ key: r.key, format: r.format, ok: r.ok, score: r.score, decision: r.decision, sim: r.similarity && r.similarity.pass, leak: r.leak && r.leak.pass, error: r.error }))));

  const review = packet.writeReview(OUT, [wu, is]);
  const gates = {}; for (const k of ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled', 'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled', 'marketing.social.insights_enabled', 'marketing.social.reply_draft_enabled']) gates[k] = await cfg.getBool(k, false);
  const pending = (await db.query(`SELECT count(*)::int n FROM marketing_job_queue WHERE job_type='social_dispatch' AND state IN ('queued','processing')`)).rows[0].n;
  console.log('DONE ' + JSON.stringify({ review, gates, social_jobs_pending: pending }));
  process.exit(0);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
