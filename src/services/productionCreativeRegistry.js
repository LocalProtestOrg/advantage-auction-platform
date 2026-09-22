'use strict';

/**
 * productionCreativeRegistry — the authority on which images may be paid for.
 *
 * THREE ROOTS THAT MUST NEVER BE COLLAPSED:
 *
 *   docs/marketing/production-creative       actual Owner-approved production advertisements
 *   docs/marketing/approved-creative-examples training / Owner calibration / Gold Standards
 *   docs/marketing/brand-assets/logos         official source brand assets
 *
 * The boundary between them is the DIRECTORY, never the filename. A file called
 * "...-gold-standard.png" sitting in production-creative is not disqualified by its name, and a
 * beautiful reference image in approved-creative-examples does not become an advertisement by
 * resembling one.
 *
 * TWO SEPARATE QUESTIONS, TWO SEPARATE COLUMNS:
 *
 *   owner_approved_for_production  — did the Owner approve this? (a decision, only the Owner makes it)
 *   production_eligible            — may the runtime spend money on it TODAY? (approval AND the facts hold)
 *
 * Keeping them apart is the whole point. An Owner approval is not permission to publish something
 * that has since become false, and it is not permission to publish something whose own provenance
 * says it was never meant to run.
 *
 * GRANDFATHERING, ONCE. The Owner populated the production library by hand before this registry
 * existed, so the initial inventory outside do-not-use is recorded as Owner-approved with
 * approval_source 'grandfathered_owner_placement'. That is a one-time reconciliation of a decision
 * the Owner already made — NOT a standing rule. After initialization,
 * `marketing.production_creative.filesystem_presence_implies_approval` stays false and a new file
 * on disk registers as UNAPPROVED. Generation succeeding, QA passing, resembling a Gold Standard,
 * or simply being saved to disk never makes an image paid-production eligible.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const configService = require('./configService');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PRODUCTION_ROOT = path.join(REPO_ROOT, 'docs', 'marketing', 'production-creative');
const TRAINING_ROOT = path.join(REPO_ROOT, 'docs', 'marketing', 'approved-creative-examples');
const BRAND_ROOT = path.join(REPO_ROOT, 'docs', 'marketing', 'brand-assets', 'logos');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.jfif', '.webp', '.gif']);
const SIDECAR_SUFFIX = '.reference.json';

/** Category semantics. The Director selects by PURPOSE, never because an image looks attractive. */
const CATEGORY_PURPOSE = Object.freeze({
  'buyer-acquisition':  { funnel: 'buyer',               purpose: 'acquire new buyers',                       event_specific: false },
  'buyer-growth':       { funnel: 'buyer',               purpose: 'grow / re-engage a qualified buyer audience', event_specific: false },
  'individual-seller':  { funnel: 'individual_seller',   purpose: 'acquire Individual Sellers',               event_specific: false },
  'professional-seller':{ funnel: 'professional_seller', purpose: 'acquire Professional Sellers',             event_specific: false },
  'geographic-event':   { funnel: 'buyer',               purpose: 'promote an authoritative event geographically', event_specific: true },
  'auction-event':      { funnel: 'buyer',               purpose: 'promote one authoritative auction',        event_specific: true },
  'estate-sale':        { funnel: 'buyer',               purpose: 'promote one authoritative estate sale',    event_specific: true },
  'notable-lot':        { funnel: 'buyer',               purpose: 'promote ONE authoritative specific auction lot', event_specific: true },
  'auction':            { funnel: 'buyer',               purpose: 'general auction promotion',                event_specific: false },
  'do-not-use':         { funnel: null,                  purpose: 'NEVER publish',                            event_specific: false },
});

/**
 * Owner logo review, recorded per asset by content hash (2026-09-22).
 *
 * The Owner's instruction: a finished advertisement is not rejected merely because a sidecar says
 * the logo DRAWN INSIDE a Gold Standard is not itself a reusable brand source. That restriction
 * means "do not extract this rendering and use it as a source asset" — it does not mean the
 * finished ad can never run. Each of the eight production assets was inspected individually
 * against docs/marketing/brand-assets/logos. Seven render the official mark correctly. One does
 * not, and only that one is blocked.
 */
/**
 * Owner content review (2026-09-22). Where a finished advertisement's MESSAGE differs from the
 * folder it sits in, the message is recorded here so the Director does not cross-use it.
 *
 * The Owner's rule is explicit: do not cross-use merely because an image looks attractive. An ad
 * whose call to action is "BROWSE & BID TODAY" is buyer creative wherever it is filed, and running
 * it against a seller landing page would buy seller traffic and then show it a buyer message.
 * The file is NOT moved — only what it says is recorded.
 */
const CONTENT_INTENT = Object.freeze({
  // "ESTATE SALE ONLINE AUCTION / BROWSE & BID TODAY / EXPLORE-BID-WIN" — buyer creative, filed
  // under individual-seller. Fully valid as a buyer advertisement.
  '57889b64ba61dc1fe3b1bb81c2c829b6abecb3a73ac3d1a2dcc5e13741bcbf70': 'buyer',
});

const LOGO_DEFECTS = Object.freeze({
  // Serif mixed-case "Advantage.Bid" wordmark with ".Bid" in RED, no gavel, and a trademark symbol.
  // The official mark is an all-caps sans-serif "ADVANTAGE.BID" with the silver gavel and ".BID" in
  // blue. Wrong typeface, wrong colour and a missing primary device is a materially incorrect
  // rendering of the brand, not a stylistic variation.
  '35ca7c7f593965530d32378d9f4285606fb9427c61a3a49a332818d2256a9b26':
    'materially incorrect logo: serif mixed-case wordmark with ".Bid" in red, no gavel device, and an unauthorised trademark symbol — the official mark is all-caps sans-serif "ADVANTAGE.BID" with the silver gavel and ".BID" in blue',
});

const CATEGORIES = Object.freeze(Object.keys(CATEGORY_PURPOSE));

/** Destination each funnel sends traffic to. Canonical Advantage.Bid URLs only. */
const DESTINATIONS = Object.freeze({
  individual_seller:   'https://bid.advantage.bid/become-seller.html?seller_type=private',
  professional_seller: 'https://bid.advantage.bid/become-professional-seller.html',
  buyer:               'https://bid.advantage.bid/',
});

// ── filesystem ────────────────────────────────────────────────────────────────────────────────

function walk(root) {
  const out = [];
  const visit = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) visit(full, r);
      else out.push({ full, rel: r, name: e.name });
    }
  };
  visit(root, '');
  return out;
}

const isImage = (name) => IMAGE_EXT.has(path.extname(name).toLowerCase());
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Hashes of every image in the TRAINING library, so a copy can be recognised as one. */
function trainingHashes() {
  const map = new Map();
  for (const f of walk(TRAINING_ROOT)) {
    if (!isImage(f.name)) continue;
    try { map.set(sha256(f.full), f.rel); } catch (_) { /* unreadable file is simply not indexed */ }
  }
  return map;
}

function readSidecar(imageFull) {
  try { return JSON.parse(fs.readFileSync(imageFull + SIDECAR_SUFFIX, 'utf8')); } catch (_) { return null; }
}

// ── the eligibility decision ──────────────────────────────────────────────────────────────────

/**
 * What must be true before this asset may run, and whether anything blocks it today.
 *
 * OWNER POLICY (2026-09-22), which this function encodes:
 *
 *   PROVENANCE IS NOT AUTHORIZATION. An advertisement may legitimately exist in BOTH libraries:
 *   as reference copy in approved-creative-examples, and as a production-authorized copy the Owner
 *   deliberately selected into production-creative. Byte-identical content across the two is
 *   recorded as provenance and is NOT a blocker. The reference copy stays reference-only; the
 *   production copy is governed by this registry.
 *
 *   REPRESENTATIVE MERCHANDISE is permitted in general evergreen acquisition advertising, where the
 *   ad makes no claim that the pictured items are a specific currently-available lot, seller,
 *   estate or event. It remains a hard blocker for the event- and inventory-specific categories,
 *   where substituting representative goods for the advertised thing would be a lie.
 *
 *   THE LOGO RESTRICTION on a Gold Standard sidecar means "do not extract this rendering and reuse
 *   it as a brand source asset". It does not condemn the finished advertisement. Each asset is
 *   reviewed individually (LOGO_DEFECTS); only a materially incorrect rendering blocks.
 *
 * `blocking` stops paid publication now. `deferred` must be revalidated against live data at
 * campaign build time, because an asset that is accurate today can advertise an expired sale
 * tomorrow.
 */
function assessFacts({ category, sidecar, isTrainingCopy, trainingPath, sha256: hash = null }) {
  const blocking = [];
  const deferred = [];
  const provenance = [];
  let conflict = null;

  if (category === 'do-not-use') blocking.push('category is do-not-use: never publish');

  const meta = CATEGORY_PURPOSE[category] || {};
  const rights = sidecar && sidecar.source && typeof sidecar.source.rights === 'string' ? sidecar.source.rights : '';
  const ownerStatus = sidecar ? sidecar.owner_status : null;

  // Provenance, preserved rather than used as a veto.
  if (isTrainingCopy) {
    provenance.push('also present in the training / calibration library at ' + trainingPath
      + ' (reference copy stays reference-only; this production copy is Owner-authorized separately)');
  }
  if (ownerStatus === 'OWNER_GOLD_STANDARD') {
    provenance.push('originated as an Owner Gold Standard — preserved as provenance, not a restriction on this authorized production copy');
  }
  if (/calibration evidence only/i.test(rights)) {
    provenance.push('reference-library sidecar describes the REFERENCE copy as calibration evidence; it does not govern this production copy');
  }

  // The logo: per-asset review, not a blanket rule.
  if (hash && LOGO_DEFECTS[hash]) blocking.push(LOGO_DEFECTS[hash]);

  // Where the reviewed message differs from the folder, the message wins for SELECTION purposes.
  // The asset stays eligible — it is a good advertisement — it is simply not offered to the wrong
  // funnel. The file itself is never moved or renamed.
  const intent = hash ? CONTENT_INTENT[hash] : null;
  if (intent && meta.funnel && intent !== meta.funnel) {
    provenance.push('reviewed message is ' + intent + ' creative although it is filed under '
      + category + ' — eligible for ' + intent + ' campaigns, withheld from ' + meta.funnel + ' campaigns');
  }

  // Representative merchandise: allowed for general evergreen acquisition, never for the
  // categories that advertise a specific thing.
  if (/merchandise is representative, not lots/i.test(rights)) {
    if (meta.event_specific) {
      blocking.push('depicted merchandise is representative, not real inventory — it can never stand in for a specific advertised lot, estate or event');
    } else {
      provenance.push('representative merchandise, permitted in general evergreen acquisition because the ad claims no specific available lot');
      deferred.push('the advertisement must not claim or imply that the pictured merchandise is a specific currently available lot, seller, estate or event');
    }
  }

  if (meta.event_specific) {
    deferred.push('verify the referenced ' + category.replace('-', ' ')
      + ' is currently authoritative: identity, seller, date, status, location, destination and availability');
    deferred.push('never advertise an expired event as current; never substitute another lot; never invent merchandise');
  }
  return { blocking, deferred, provenance, conflict };
}

// ── scan ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Read the library exactly as it exists. Pure: touches no database and changes no file.
 * Non-image files (sidecars and anything else) are inventoried but are never production assets.
 */
function scan({ productionRoot = PRODUCTION_ROOT } = {}) {
  const training = trainingHashes();
  const assets = [];
  const nonImages = [];
  const foreign = [];

  for (const f of walk(productionRoot)) {
    const segments = f.rel.split('/');
    const category = segments[0];
    if (!isImage(f.name)) { nonImages.push(f.rel); continue; }
    if (!CATEGORY_PURPOSE[category]) { foreign.push({ rel: f.rel, reason: 'not inside a known category folder' }); continue; }

    let hash;
    try { hash = sha256(f.full); } catch (e) { foreign.push({ rel: f.rel, reason: 'unreadable: ' + e.message }); continue; }
    const sidecar = readSidecar(f.full);
    const trainingPath = training.get(hash) || null;
    const facts = assessFacts({ category, sidecar, isTrainingCopy: !!trainingPath, trainingPath, sha256: hash });
    const meta = CATEGORY_PURPOSE[category];
    const id = sidecar && sidecar.identity ? sidecar.identity : {};

    assets.push({
      asset_key: 'PC-' + hash.slice(0, 12),
      sha256: hash,
      filename: f.name,
      relative_path: f.rel,
      category,
      funnel: meta.funnel,
      campaign_purpose: meta.purpose,
      // Audience is a real decision, not something to infer from pixels or a filename.
      audience: 'UNKNOWN',
      destination_type: meta.funnel ? meta.funnel + '_landing' : null,
      evergreen: meta.event_specific === true ? false : (meta.event_specific === false ? true : null),
      width: Number.isFinite(id.width) ? id.width : null,
      height: Number.isFinite(id.height) ? id.height : null,
      // In-folder subdirectory (e.g. 'gold-standard/') is recorded, never used as the category.
      subfolder: segments.length > 2 ? segments.slice(1, -1).join('/') : null,
      sidecar_present: !!sidecar,
      training_copy_of: trainingPath,
      provenance_conflict: facts.conflict,
      content_intent: CONTENT_INTENT[hash] || meta.funnel,
      factual_requirements: { blocking: facts.blocking, deferred: facts.deferred, provenance: facts.provenance,
        content_intent: CONTENT_INTENT[hash] || meta.funnel || null },
    });
  }
  return { productionRoot, assets, nonImages, foreign, categories: CATEGORIES };
}

// ── registration ──────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile the filesystem into the registry.
 *
 * @param {object} opts
 *   grandfather  — one-time: record the Owner's existing hand-placement as approval. Refused once
 *                  `marketing.production_creative.grandfathered_at` is set, so it cannot silently
 *                  become a standing "presence = approval" rule.
 */
async function sync({ grandfather = false, productionRoot = PRODUCTION_ROOT, runner = db } = {}) {
  const result = scan({ productionRoot });
  const already = await configService.get(null, 'marketing.production_creative.grandfathered_at');
  const firstRun = !already || already === 'null' || already === null;
  const applyGrandfather = grandfather && firstRun;

  const registered = [];
  for (const a of result.assets) {
    const isDoNotUse = a.category === 'do-not-use';
    const blocked = a.factual_requirements.blocking;

    // Owner approval: grandfathered for the initial inventory outside do-not-use, otherwise only
    // what is already recorded. A NEW file never self-approves.
    const existing = (await runner.query(
      'SELECT owner_approved_for_production, approval_source FROM marketing_production_creative WHERE sha256 = $1 AND relative_path = $2',
      [a.sha256, a.relative_path])).rows[0] || null;

    let approved = existing ? existing.owner_approved_for_production : false;
    let approvalSource = existing ? existing.approval_source : null;
    if (!existing && applyGrandfather && !isDoNotUse) { approved = true; approvalSource = 'grandfathered_owner_placement'; }
    if (isDoNotUse) { approved = false; approvalSource = 'do_not_use'; }

    // Eligibility: approval is necessary and not sufficient.
    const eligible = approved && blocked.length === 0;
    const reason = !approved
      ? (isDoNotUse ? 'do-not-use: never publish' : 'awaiting explicit Owner approval for production')
      : (blocked.length ? blocked.join('; ') : null);

    await runner.query(
      `INSERT INTO marketing_production_creative
         (asset_key, sha256, filename, relative_path, category, campaign_purpose, audience,
          destination_type, evergreen, owner_approved_for_production, approval_source,
          approval_recorded_at, production_eligible, ineligible_reason, provenance,
          provenance_conflict, factual_requirements, width, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)
       ON CONFLICT (relative_path) DO UPDATE SET
         sha256 = EXCLUDED.sha256, filename = EXCLUDED.filename, category = EXCLUDED.category,
         campaign_purpose = EXCLUDED.campaign_purpose, destination_type = EXCLUDED.destination_type,
         evergreen = EXCLUDED.evergreen, production_eligible = EXCLUDED.production_eligible,
         ineligible_reason = EXCLUDED.ineligible_reason, provenance_conflict = EXCLUDED.provenance_conflict,
         factual_requirements = EXCLUDED.factual_requirements, updated_at = now()`,
      [a.asset_key, a.sha256, a.filename, a.relative_path, a.category, a.campaign_purpose, a.audience,
       a.destination_type, a.evergreen, approved, approvalSource,
       approved ? new Date() : null, eligible, reason,
       approved ? 'OWNER_APPROVED_PRODUCTION' : 'REGISTERED_UNAPPROVED',
       a.provenance_conflict, JSON.stringify(a.factual_requirements), a.width, a.height]);
    registered.push({ asset_key: a.asset_key, category: a.category, approved, eligible, reason });
  }

  if (applyGrandfather) {
    await configService.setPlatformConfig('marketing.production_creative.grandfathered_at', new Date().toISOString());
  }
  return { ...result, registered, grandfathered: applyGrandfather, already_grandfathered: !firstRun };
}

// ── selection ─────────────────────────────────────────────────────────────────────────────────

/**
 * The creative the Director may run for a campaign, or null with a reason.
 * Fails closed: no eligible asset means CREATIVE_BLOCKED, never a substitution from the training
 * library and never a "close enough" asset from a different category.
 */
async function selectForCampaign({ category, funnel, runner = db } = {}) {
  if (category === 'do-not-use') return { asset: null, reason: 'do-not-use is never publishable' };
  const where = [];
  const params = [];
  if (category) { params.push(category); where.push('category = $' + params.length); }
  else if (funnel) {
    const cats = CATEGORIES.filter((c) => CATEGORY_PURPOSE[c].funnel === funnel && c !== 'do-not-use');
    params.push(cats); where.push('category = ANY($' + params.length + ')');
  }
  // The reviewed message governs which funnel an asset may serve. Assets with no recorded intent
  // fall back to their category's funnel, so this narrows nothing that was not explicitly reviewed.
  const whereParams = params.slice();
  const wantFunnel = funnel || (category && CATEGORY_PURPOSE[category] ? CATEGORY_PURPOSE[category].funnel : null);
  let intentClause = '';
  if (wantFunnel) {
    params.push(wantFunnel);
    intentClause = ` AND COALESCE(factual_requirements->>'content_intent', $${params.length}) = $${params.length}`;
  }
  const { rows } = await runner.query(
    `SELECT id, asset_key, filename, relative_path, category, campaign_purpose, ineligible_reason
       FROM marketing_production_creative
      WHERE production_eligible = true AND status = 'REGISTERED'
        ${where.length ? 'AND ' + where.join(' AND ') : ''}${intentClause}
      ORDER BY registered_at ASC LIMIT 1`, params);
  if (rows[0]) return { asset: rows[0], reason: null };

  const near = await runner.query(
    `SELECT count(*)::int n, min(ineligible_reason) reason FROM marketing_production_creative
      WHERE status='REGISTERED' ${where.length ? 'AND ' + where.join(' AND ') : ''}`, whereParams);
  const n = near.rows[0] ? near.rows[0].n : 0;
  return {
    asset: null,
    reason: n === 0
      ? 'no production creative registered for ' + (category || funnel)
      : n + ' registered but none eligible: ' + (near.rows[0].reason || 'not approved for production'),
  };
}

module.exports = {
  PRODUCTION_ROOT, TRAINING_ROOT, BRAND_ROOT, CATEGORIES, CATEGORY_PURPOSE, DESTINATIONS,
  IMAGE_EXT, SIDECAR_SUFFIX, LOGO_DEFECTS, CONTENT_INTENT, scan, sync, selectForCampaign, assessFacts, walk, isImage,
};
