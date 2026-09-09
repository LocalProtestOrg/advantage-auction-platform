'use strict';

/**
 * creativeReference/familySelector — Deliverable 6 §6 family selection rules (before generation) + learning
 * boundaries #6/#7: collage is never the universal default, ENVIRONMENTAL_PHOTO requires event-bound photographs on an
 * on-site event, CATALOG_SCATTER is rationed (at most 1 in N creatives per seller per quarter; never fine estate /
 * closing waves) and needs breadth ≥ 6 families on a themed LAUNCH wave.
 */
const ACQUISITION = ['individual_seller_acquisition', 'professional_seller_acquisition', 'buyer_platform_growth', 'general_brand'];

/**
 * need: { campaign_class, event_mode, wave, merchandise_mode, requested_family, themed, fine_estate }
 * assets: { clean_objects (n), category_families (n), photographs (n) }
 * ration: { scatter_used_this_quarter, creatives_this_quarter, ration_n }
 */
function selectFamily(need, assets = {}, ration = {}) {
  const reasons = [];
  const clean = assets.clean_objects || 0; const fams = assets.category_families || 0; const photos = assets.photographs || 0;
  if (ACQUISITION.includes(need.campaign_class)) return { family: 'ACQUISITION', variants: ['message_cluster', 'product_forward', 'help_forward'], reasons: ['acquisition/brand → non-collage single message'] };
  if (need.campaign_class === 'closing_soon') return { family: 'CLOSING_DAYS', reasons: ['closing_soon → CLOSING_DAYS (FINAL-wave date treatment); Owner review (no class references)'], owner_review: true };
  if (need.merchandise_mode === 'photograph') {
    if (need.event_mode !== 'on_site') reasons.push('photographs present but the event is not on_site → ENVIRONMENTAL_PHOTO not eligible');
    else if (photos > 0) return { family: 'ENVIRONMENTAL_PHOTO', variants: ['banded', 'panel'], reasons: ['on-site event with event-bound site photographs'] };
  }
  if (need.requested_family === 'CATALOG_SCATTER' || need.themed) {
    const n = ration.ration_n || 5; const used = ration.scatter_used_this_quarter || 0; const total = ration.creatives_this_quarter || 0;
    const allowed = need.wave === 'LAUNCH' && fams >= 6 && !need.fine_estate && used < Math.max(1, Math.floor((total + 1) / n));
    if (allowed) return { family: 'CATALOG_SCATTER', reasons: ['themed/eclectic LAUNCH wave, breadth ≥ 6 families, within the 1-in-' + n + ' ration'] };
    reasons.push('CATALOG_SCATTER refused: ' + (need.wave !== 'LAUNCH' ? 'not a LAUNCH wave' : fams < 6 ? 'breadth < 6 families' : need.fine_estate ? 'fine estate' : 'ration exhausted (' + used + ' used of ' + Math.max(1, Math.floor((total + 1) / n)) + ' allowed)'));
  }
  if (clean === 1) return { family: 'SINGLE_LOT', reasons: reasons.concat(['one hero object']) };
  if (clean >= 3 && clean <= 7) return { family: 'LEFT_THIRD_WHITE', reasons: reasons.concat(['3–7 CLEAN objects → LEFT_THIRD_WHITE at large scale']) };
  if (clean >= 8 && fams >= 4) return { family: need.requested_family === 'LEFT_THIRD_WHITE' ? 'LEFT_THIRD_WHITE' : 'CENTERED_WHITE', reasons: reasons.concat(['≥ 8 CLEAN objects across ≥ 4 families → scene default']) };
  if (clean >= 3 && fams < 4) return { family: 'CATEGORY_GROUP', reasons: reasons.concat(['homogeneous category group']) };
  return { family: null, reasons: reasons.concat(['no eligible family for the available assets → creative obligation stays in review']) };
}

module.exports = { selectFamily, ACQUISITION };
