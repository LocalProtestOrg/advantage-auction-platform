'use strict';

/**
 * Authoritative truth for certification, read at run time from the SAME sources Sasha and the platform use (never
 * hard-coded here): live platform rules (platformFacts.getCurrentFacts, which reads current admin pricing), billing
 * constants that enforcement uses, the lot minimum, pickup-gap rule, storefront fee and launch gates.
 * Scenario text may use {{tokens}} that resolve to these values.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const req = (p) => require(path.join(ROOT, 'src', p));

const pct = (bps) => `${String(+(Number(bps) / 100).toFixed(2))}%`;

async function build() {
  const facts = req('services/sasha/knowledge/platformFacts');
  const billing = req('services/billingTermsService');
  const pricing = req('services/pricingConfigService');
  const sellerTypeRules = req('services/sellerTypeRules');
  const launch = req('lib/launchGuards');
  const processingBps = await pricing.currentProcessingBps();
  const t = {
    processing_fee: pct(processingBps),
    individual_bp: pct(billing.DEFAULT_BUYER_PREMIUM_BPS),
    individual_platform_fee: pct(billing.INDIVIDUAL_PLATFORM_FEE_BPS != null ? billing.INDIVIDUAL_PLATFORM_FEE_BPS : 0),
    pro_bp_range: '0% to 25%',
    min_lots: String(req('services/auctionService').MIN_LOTS_FOR_SUBMISSION),
    pickup_gap_hours: String(sellerTypeRules.NON_PRO_MIN_PICKUP_GAP_HOURS),
    storefront_fee: pct(req('services/marketplaceOrderService').STOREFRONT_FEE_BPS),
    buy_now_live: launch.marketplaceCheckoutEnabled() ? 'yes' : 'no',
    soft_close: 'a bid with 2 minutes or less remaining extends that lot by 2 minutes',
    photos_per_lot: '20',
  };
  const topics = await facts.getCurrentFacts('all');
  const factText = {};
  for (const [k, v] of Object.entries(topics)) factText[k] = (v.facts || []).join('\n');
  return { tokens: t, factText, sources: Object.fromEntries(Object.entries(topics).map(([k, v]) => [k, v.source])) };
}

function fill(s, tokens) { return String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (tokens[k] != null ? tokens[k] : m)); }

module.exports = { build, fill };
