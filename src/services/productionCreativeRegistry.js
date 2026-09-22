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
 * `blocking` entries stop paid publication now. `deferred` entries must be revalidated at campaign
 * build time against live data (an event's date, status and location), because an asset that is
 * fine today can advertise an expired sale tomorrow.
 */
function assessFacts({ category, sidecar, isTrainingCopy, trainingPath }) {
  const blocking = [];
  const deferred = [];
  let conflict = null;

  if (category === 'do-not-use') blocking.push('category is do-not-use: never publish');

  // The asset's own Owner-recorded provenance is evidence about the asset, and it outranks the
  // folder it was copied into. A file whose sidecar says "calibration evidence only" is saying it
  // was never built to be an advertisement.
  const rights = sidecar && sidecar.source && typeof sidecar.source.rights === 'string' ? sidecar.source.rights : '';
  const ownerStatus = sidecar ? sidecar.owner_status : null;

  if (isTrainingCopy) {
    conflict = 'byte-identical to the training/calibration library at ' + trainingPath
      + ' — the Gold Standard and the production advertisement are the same file';
    blocking.push('this image is a copy of a training / Gold Standard reference, not an advertisement produced for publication');
  }
  if (/calibration evidence only/i.test(rights)) {
    blocking.push('own provenance records it as calibration evidence only');
  }
  if (/is NOT an approved logo asset/i.test(rights)) {
    blocking.push('contains a rendered logo that is not an official brand asset (brand-assets/logos is the only approved source)');
  }
  if (/merchandise is representative, not lots/i.test(rights)) {
    blocking.push('depicted merchandise is representative, not real inventory — it cannot advertise lots');
  }
  if (ownerStatus === 'OWNER_GOLD_STANDARD' && !conflict) {
    conflict = 'sidecar records owner_status OWNER_GOLD_STANDARD (a calibration status) while the file sits in production-creative';
  }

  const meta = CATEGORY_PURPOSE[category];
  if (meta && meta.event_specific) {
    deferred.push('verify the referenced ' + category.replace('-', ' ')
      + ' is currently authoritative: identity, seller, date, status, location, destination and availability');
    deferred.push('never advertise an expired event as current; never substitute another lot; never invent merchandise');
  }
  return { blocking, deferred, conflict };
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
    const facts = assessFacts({ category, sidecar, isTrainingCopy: !!trainingPath, trainingPath });
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
      factual_requirements: { blocking: facts.blocking, deferred: facts.deferred },
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
  const { rows } = await runner.query(
    `SELECT id, asset_key, filename, relative_path, category, campaign_purpose, ineligible_reason
       FROM marketing_production_creative
      WHERE production_eligible = true AND status = 'REGISTERED'
        ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY registered_at ASC LIMIT 1`, params);
  if (rows[0]) return { asset: rows[0], reason: null };

  const near = await runner.query(
    `SELECT count(*)::int n, min(ineligible_reason) reason FROM marketing_production_creative
      WHERE status='REGISTERED' ${where.length ? 'AND ' + where.join(' AND ') : ''}`, params);
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
  IMAGE_EXT, SIDECAR_SUFFIX, scan, sync, selectForCampaign, assessFacts, walk, isImage,
};
