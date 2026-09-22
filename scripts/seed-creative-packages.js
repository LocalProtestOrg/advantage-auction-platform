#!/usr/bin/env node
/* seed-creative-packages.js — the first governed deployable creative packages.
   Image + words + call to action + destination, approved as a unit and fingerprinted.
   Idempotent: re-running updates copy in place and re-fingerprints. */

const db = require('../src/db');
const delivery = require('../src/services/paidGrowth/metaDeliveryService');

/**
 * Copy written to the Owner's positioning.
 *   Individual Seller — approachable, no auction experience required, ease and opportunity.
 *     No income claims, no implied knowledge of anyone's circumstances.
 *   Professional Seller — the platform capability, no fixed buyer premium implied, no pricing.
 */
const PACKAGES = [
  {
    package_key: 'PKG-IS-HOU-V1',
    funnel: 'individual_seller',
    audience_purpose: 'acquire Individual Sellers',
    asset_filename: 'individual-seller-turn-items-into-cash-gold-standard.png',
    primary_text: 'Have items to sell? Turn them into cash with your own online auction. '
      + 'Set it up in minutes, reach real buyers, and keep more of the proceeds. '
      + 'No auction experience needed — real people are here to help.',
    headline: 'The Smarter Way to Sell.',
    description: 'Create your auction in minutes. You can do this.',
    cta_type: 'LEARN_MORE',
    destination_url: 'https://bid.advantage.bid/become-seller.html?seller_type=private',
  },
  {
    package_key: 'PKG-PS-HOU-V1',
    funnel: 'professional_seller',
    audience_purpose: 'acquire Professional Sellers',
    asset_filename: 'become-a-seller-advantage-bid-gold-standard.png',
    primary_text: 'Auction houses, estate sale companies and liquidators: run your sales on Advantage.Bid. '
      + 'Online auctions, storefronts and events in one place — reach more buyers and move more inventory, '
      + 'with tools built for professional sellers.',
    headline: 'Sell More with Advantage.Bid',
    description: 'Auction, storefront and event tools for professionals.',
    cta_type: 'LEARN_MORE',
    destination_url: 'https://bid.advantage.bid/become-professional-seller.html',
  },
];

/** Claims we will not make in paid copy, whatever the temptation. */
const FORBIDDEN = [
  { re: /\b\d+\s*%/, why: 'a specific percentage implies a fee or commission we do not quote in ads' },
  { re: /buyer'?s? premium/i, why: 'implies a fixed buyer premium' },
  { re: /\bguarantee|\bguaranteed\b/i, why: 'unsupported guarantee' },
  { re: /\bearn \$|\bmake \$|\bup to \$/i, why: 'unsupported income claim' },
  { re: /\bfree\b(?!.*listing)/i, why: 'unqualified free claim' },
  { re: /divorc|widow|bereave|foreclos|bankrupt|deceased/i, why: 'implies knowledge of sensitive circumstances' },
];

(async () => {
  let failures = 0;
  for (const p of PACKAGES) {
    const asset = (await db.query(
      `SELECT id, sha256, filename, production_eligible, ineligible_reason
         FROM marketing_production_creative WHERE filename = $1 AND production_eligible = true LIMIT 1`,
      [p.asset_filename])).rows[0];
    if (!asset) { console.error('SKIP ' + p.package_key + ': no production-eligible asset ' + p.asset_filename); failures += 1; continue; }

    const text = [p.primary_text, p.headline, p.description].filter(Boolean).join(' ');
    const violations = FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.why);
    const policy = violations.length ? 'BLOCKED' : 'OK';

    const fingerprint = delivery.packageFingerprint({
      asset_sha256: asset.sha256, primary_text: p.primary_text, headline: p.headline,
      description: p.description, cta_type: p.cta_type, destination_url: p.destination_url });

    const attribution = { utm_source: 'meta', utm_medium: 'paid_social',
      dimensions: ['utm_campaign', 'utm_content', 'utm_term', 'adv_funnel', 'adv_experiment', 'adv_arm', 'adv_provider'] };

    const row = (await db.query(
      `INSERT INTO marketing_creative_packages
         (package_key, production_creative_id, funnel, audience_purpose, primary_text, headline,
          description, cta_type, destination_url, attribution_template, fingerprint,
          approval_state, policy_status, policy_detail, provenance, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (package_key) DO UPDATE SET
         primary_text=EXCLUDED.primary_text, headline=EXCLUDED.headline, description=EXCLUDED.description,
         cta_type=EXCLUDED.cta_type, destination_url=EXCLUDED.destination_url,
         attribution_template=EXCLUDED.attribution_template,
         policy_status=EXCLUDED.policy_status, policy_detail=EXCLUDED.policy_detail,
         version = CASE WHEN marketing_creative_packages.fingerprint <> EXCLUDED.fingerprint
                        THEN marketing_creative_packages.version + 1 ELSE marketing_creative_packages.version END,
         fingerprint=EXCLUDED.fingerprint,
         active = CASE WHEN EXCLUDED.policy_status='OK' THEN marketing_creative_packages.active ELSE false END,
         updated_at=now()
       RETURNING package_key, version, fingerprint, approval_state, policy_status, active`,
      [p.package_key, asset.id, p.funnel, p.audience_purpose, p.primary_text, p.headline, p.description,
       p.cta_type, p.destination_url, JSON.stringify(attribution), fingerprint,
       // The Owner approved these images and this positioning; the package is recorded approved and
       // is still unusable unless policy is clean and the provider accepts it.
       'OWNER_APPROVED', policy, violations.join('; ') || null, 'owner_first_launch_copy', policy === 'OK'])).rows[0];

    console.log(row.package_key + '  v' + row.version + '  ' + row.approval_state
      + '  policy=' + row.policy_status + '  active=' + row.active
      + '  fp=' + row.fingerprint.slice(0, 12) + '…');
    if (violations.length) { console.log('   BLOCKED: ' + violations.join('; ')); failures += 1; }
  }
  console.log(failures ? 'RESULT: ' + failures + ' package(s) need attention' : 'RESULT: PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
