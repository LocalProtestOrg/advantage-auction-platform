'use strict';

/**
 * creativeReference/copyDensity — Phase 3P.2 copy-density profiles (config: docs/marketing/phase3p2/config/copy-density.json)
 * FEED_FAST 5 (default for feed/mobile/awareness) · ACQUISITION_RICH 9 (ceiling with conditions) · EVENT 7 · NOTABLE_LOT 7 ·
 * RESTRAINED_FACTUAL 4. Hard fails: blocks over the ceiling; two headline-class elements; a benefit list inside the
 * headline (campaignMessages). ACQUISITION_RICH conditions: one headline ≥ 2.2× any other text, merchandise ≥ 45% of the
 * field, at most one script accent. Soft: text-region share over the profile band.
 */
const CD = require('../../../docs/marketing/phase3p2/config/copy-density.json');

const PROFILES = Object.fromEntries(Object.entries(CD.profiles).map(([k, v]) => [k, { blocks: v.blocks }]));
const SOFT_TEXT_MAX = { FEED_FAST: 14, ACQUISITION_RICH: 30, EVENT: 22, NOTABLE_LOT: 26, RESTRAINED_FACTUAL: 18 };

function defaultProfile({ placement = 'feed', campaignClass }) {
  if (['estate_sale', 'auction', 'geographic_event_promotion', 'closing_soon'].includes(campaignClass)) return 'EVENT';
  if (campaignClass === 'notable_lot') return 'NOTABLE_LOT';
  return placement === 'feed' || placement === 'mobile' ? 'FEED_FAST' : 'ACQUISITION_RICH';
}

/** density: engine output {blocks, headline_class_roles, headline_dominance}; metrics: text_region_pct, coverage.coverage_pct */
function gate(profile, density, metrics = {}, { scriptAccents = 0 } = {}) {
  const P = PROFILES[profile]; const hard = []; const soft = [];
  if (!P) return { pass: false, hard: ['unknown copy profile ' + profile], soft };
  if (density.blocks > P.blocks) hard.push(`${density.blocks} blocks > ${profile} ceiling ${P.blocks}`);
  if ((density.headline_class_roles || []).length > 1) hard.push('two headline-class elements: ' + density.headline_class_roles.join(' + '));
  if (profile === 'ACQUISITION_RICH') {
    if (!(density.headline_dominance >= 2.2)) hard.push('ACQUISITION_RICH requires exactly one headline ≥ 2.2× any other text (measured ' + density.headline_dominance + '×)');
    const cov = metrics.coverage && metrics.coverage.coverage_pct;
    if (cov != null && cov < 45) hard.push('ACQUISITION_RICH requires merchandise ≥ 45% of the field (measured ' + cov + '%)');
    if (scriptAccents > 1) hard.push('more than one script accent');
  }
  const tmax = SOFT_TEXT_MAX[profile];
  if (tmax && metrics.text_region_pct > tmax) soft.push(`text region ${metrics.text_region_pct}% > ${tmax}% (${profile})`);
  return { pass: hard.length === 0, hard, soft, ceiling: P.blocks, blocks: density.blocks, profile };
}

module.exports = { PROFILES, gate, defaultProfile, SOFT_TEXT_MAX, CD };
