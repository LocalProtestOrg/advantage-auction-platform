'use strict';

/**
 * marketingConfigService — reads the runtime-tunable marketing.* values from platform_config with safe
 * fallbacks to the code-owned defaults in marketingPolicy. Thin, like pricingConfigService.
 */
const configService = require('./configService');
const policy = require('../lib/marketingPolicy');

async function raw(key, fallback) {
  try { const v = await configService.get(null, key); if (v !== null && v !== undefined && v !== '') return v; }
  catch (_) { /* fall through */ }
  return fallback;
}
async function getInt(key, fallback) {
  const v = await raw(key, fallback);       // raw returns the fallback when the key is unset
  const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
async function getBool(key, fallback) {
  const v = await raw(key, null);
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return fallback;
}

const directSpendMaxBps = () => getInt('marketing.direct_spend_max_bps', policy.DEFAULT_DIRECT_SPEND_MAX_BPS);
const eventLocalRadiusMiles = () => getInt('marketing.event_local_radius_miles', policy.DEFAULT_EVENT_LOCAL_RADIUS_MILES);
const growthMonthlyAdditionalAuthorityCents = () => getInt('marketing.growth_monthly_additional_authority_cents', policy.DEFAULT_GROWTH_MONTHLY_ADDITIONAL_AUTHORITY_CENTS);
const qaMaxCycles = () => getInt('marketing.qa_max_cycles', policy.DEFAULT_QA_MAX_CYCLES);
const qaRequiredBeforeRelease = () => getBool('marketing.qa_required_before_release', true);
const factualSourceRequired = () => getBool('marketing.factual_source_required', true);
const fullCircleRequired = () => getBool('marketing.full_circle_required', true);

module.exports = {
  directSpendMaxBps, eventLocalRadiusMiles, growthMonthlyAdditionalAuthorityCents, qaMaxCycles,
  qaRequiredBeforeRelease, factualSourceRequired, fullCircleRequired,
};
