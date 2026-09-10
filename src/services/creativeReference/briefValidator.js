'use strict';

/**
 * creativeReference/briefValidator — Phase 3P cross-checks the focused schema validator cannot express:
 *   merchandise_mode ↔ objects / site_photographs / representative_assets; every object's auction_id equals the
 *   brief's; representative only in acquisition/brand classes; LOGISTICS needs a reason; dark_hero only for
 *   SINGLE_LOT; photograph ground only for ENVIRONMENTAL_PHOTO; at most one factual CTA whose fact_ref resolves;
 *   calibration block present; a library reference hash can never appear as an asset.
 */
const gates = require('./gates');

const FAMILIES = ['CENTERED_WHITE', 'LEFT_THIRD_WHITE', 'CATEGORY_GROUP', 'SINGLE_LOT', 'CLOSING_DAYS', 'COBRANDED', 'ENVIRONMENTAL_PHOTO', 'CATALOG_SCATTER', 'ACQUISITION',
  // Phase 3P.1 / 3P.2 families
  'EDITORIAL', 'EVENT_PHOTO', 'RESTRAINED_FACTUAL', 'HERO_SINGLE_LIGHT'];
const PROFILES = ['GENERAL', 'LOGISTICS', 'TEASER', 'FEED_FAST', 'ACQUISITION_RICH', 'EVENT', 'NOTABLE_LOT', 'RESTRAINED_FACTUAL'];
const MODES = ['lots', 'photograph', 'representative', 'none'];

function validateBrief(brief, { libraryHashes = new Set() } = {}) {
  const errors = [];
  if (!brief || typeof brief !== 'object') return { valid: false, errors: ['brief missing'] };
  if (!FAMILIES.includes(brief.family)) errors.push('family not in enum');
  if (!MODES.includes(brief.merchandise_mode)) errors.push('merchandise_mode required (lots|photograph|representative|none)');
  if (!brief.calibration || typeof brief.calibration !== 'object') errors.push('calibration block required');
  const prov = gates.provenanceGate(brief); errors.push(...prov.reasons);
  const tb = brief.text_budget || {};
  if (tb.profile && !PROFILES.includes(tb.profile)) errors.push('text_budget.profile invalid');
  if (tb.profile === 'LOGISTICS' && !tb.logistics_reason) errors.push('LOGISTICS profile requires logistics_reason');
  const fo = brief.family_options || {};
  if (fo.ground === 'dark_hero' && !['SINGLE_LOT', 'HERO_SINGLE_LIGHT'].includes(brief.family)) errors.push('dark_hero ground only for a single lit/translucent/reflective hero object');
  // Phase 3P.2 colour system: light is the default; dark is a documented exception with a reason + Owner review.
  if (fo.ground === 'dark_hero' && !fo.dark_reason) errors.push('dark_hero requires family_options.dark_reason (lit / translucent / reflective object)');
  const flags = {};
  if (fo.ground === 'dark_hero' && fo.dark_reason) flags.owner_review_required = 'dark_hero exception (first uses are Owner-reviewed)';
  // Phase 3P.2 Notable Lot: facts only from the lot/event records; representative objects never appear.
  if (brief.campaign_class === 'notable_lot') {
    if (!brief.lot_ref || !brief.lot_ref.lot_id || !brief.lot_ref.auction_id) errors.push('notable lot requires lot_ref {auction_id, lot_id} from production');
    if (brief.merchandise_mode === 'representative') errors.push('representative objects never appear in a notable-lot creative');
    for (const [k, v] of Object.entries(brief.lot_facts || {})) if (!v || !v.source || !/\./.test(v.source)) errors.push('lot fact ' + k + ' has no record-field source');
  }
  if (fo.ground === 'photograph' && brief.family !== 'ENVIRONMENTAL_PHOTO') errors.push('photograph ground only for ENVIRONMENTAL_PHOTO');
  if (brief.family === 'ENVIRONMENTAL_PHOTO' && brief.merchandise_mode !== 'photograph') errors.push('ENVIRONMENTAL_PHOTO requires merchandise_mode photograph');
  if (brief.family === 'ENVIRONMENTAL_PHOTO' && brief.event && brief.event.online_only === true) errors.push('ENVIRONMENTAL_PHOTO not eligible for an online-only event');
  if (brief.cta) {
    if (Array.isArray(brief.cta)) errors.push('at most one cta');
    else if (brief.cta.kind === 'factual') { const refs = new Set((brief.claim_manifest || []).map((c) => c.claim)); if (!brief.cta.fact_ref || !refs.has(brief.cta.fact_ref)) errors.push('cta.fact_ref must resolve in the claim manifest'); }
  }
  const assetIds = [].concat((brief.site_photographs || []).map((p) => p.asset_id), (brief.representative_assets || []).map((a) => a.asset_id), (brief.objects || []).map((o) => o.asset_id)).filter(Boolean);
  for (const id of assetIds) if (libraryHashes.has(String(id))) errors.push('asset ' + id + ' is a library reference hash — references never reach a generator');
  return { valid: errors.length === 0, errors, flags: typeof flags === 'undefined' ? {} : flags };
}

module.exports = { validateBrief, FAMILIES, MODES };
