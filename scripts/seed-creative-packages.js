#!/usr/bin/env node
/* seed-creative-packages.js — the governed deployable creative packages.
   Image + words + call to action + canonical destination, approved as a unit and fingerprinted.
   Idempotent: re-running updates copy in place, re-fingerprints, and bumps the version when the
   content actually changed.

   --approve-owner-additions  records the Owner's explicit approval (this mission) for the named
                              Professional Seller images. Presence on disk still never implies
                              approval; this is a deliberate, recorded Owner decision. */

const db = require('../src/db');
const delivery = require('../src/services/paidGrowth/metaDeliveryService');

const APPROVE = process.argv.includes('--approve-owner-additions');

/** Images the Owner explicitly approved for production in the 2026-09-22 reconciliation mission. */
const OWNER_APPROVED_ADDITIONS = [
  'estate-sale-company.png',
  'estate-sale-company-operator.png',
  'auction-house-operator.png',
];

/**
 * Meta copy COMPLEMENTS the image; it does not repeat every word printed on it.
 *
 * `audience_purpose` keeps the specialised operators distinct inside the one Professional Seller
 * funnel, so the Director can later compare an estate-sale-company ad against an auction-house ad
 * without the two messages being collapsed into something generic.
 */
const PACKAGES = [
  // ── Individual Seller ──
  {
    package_key: 'PKG-IS-HOU-V1',
    funnel: 'individual_seller',
    audience_purpose: 'individual_seller_acquisition',
    asset_filename: 'individual-seller-turn-items-into-cash-gold-standard.png',
    // "keep more of the proceeds" removed: it is comparative and invites a claim we do not quote.
    primary_text: 'Have items to sell? Turn them into cash with your own online auction. '
      + 'Set it up in minutes and reach real buyers. '
      + 'No auction experience needed — real people are here to help.',
    headline: 'The Smarter Way to Sell.',
    description: 'Create your auction in minutes. You can do this.',
    cta_type: 'LEARN_MORE',
    destination_url: 'https://bid.advantage.bid/become-seller.html?seller_type=private',
  },

  // ── Professional Seller: general ──
  {
    package_key: 'PKG-PS-HOU-V1',
    funnel: 'professional_seller',
    audience_purpose: 'professional_seller_acquisition_general',
    asset_filename: 'become-a-seller-advantage-bid-gold-standard.png',
    primary_text: 'Auction houses, estate sale companies and liquidators: run your sales on Advantage.Bid. '
      + 'Online auctions, storefronts and events in one place — reach more buyers and move more inventory, '
      + 'with tools built for professional sellers.',
    headline: 'Sell More with Advantage.Bid',
    description: 'Auction, storefront and event tools for professionals.',
    cta_type: 'LEARN_MORE',
    destination_url: 'https://bid.advantage.bid/become-professional-seller.html',
  },
  {
    package_key: 'PKG-PS-INVENTORY-V1',
    funnel: 'professional_seller',
    audience_purpose: 'professional_seller_acquisition_general',
    asset_filename: 'sell-with-advantage-bid-gold-standard.png',
    primary_text: 'Your inventory deserves a bigger audience. Advantage.Bid gives professional sellers '
      + 'online auctions, storefronts and events in one platform — so you can list faster, reach more buyers '
      + 'and move more of what you take in.',
    headline: 'From Inventory to Results.',
    description: 'Built for auction houses, estate sale companies and liquidators.',
    cta_type: 'LEARN_MORE',
    destination_url: 'https://bid.advantage.bid/become-professional-seller.html',
  },

  // ── Professional Seller: estate sale companies ──
  {
    package_key: 'PKG-PS-ESTATE-V1',
    funnel: 'professional_seller',
    audience_purpose: 'estate_sale_company_acquisition',
    asset_filename: 'estate-sale-company.png',
    // The 95–99% figure describes the CLEANOUT/service proposition the operator can offer their
    // client. It is deliberately not phrased as a financial or sell-through guarantee.
    primary_text: 'Estate sale professionals: turn every estate into a complete solution. '
      + 'Advantage.Bid helps you offer a 95–99% cleanout after the sale, so you can take on more estates '
      + 'and sell well beyond what shoppers find on site. Create a professional online auction in minutes, not days.',
    headline: 'Land More Contracts.',
    description: 'The auction platform built for estate sale professionals.',
    cta_type: 'SIGN_UP',
    destination_url: 'https://bid.advantage.bid/become-professional-seller.html',
  },
  {
    package_key: 'PKG-PS-ESTATE-OPERATOR-V1',
    funnel: 'professional_seller',
    audience_purpose: 'estate_sale_company_acquisition',
    asset_filename: 'estate-sale-company-operator.png',
    primary_text: 'A more powerful way to run your estate sales. Modern online auctions for estate sale '
      + 'professionals: reach buyers beyond local traffic, turn more items into sales, and streamline the '
      + 'work with simple tools built for your business.',
    headline: 'A More Powerful Way to Run Your Estate Sales',
    description: 'Online auctions made simple for estate sale companies.',
    cta_type: 'LEARN_MORE',
    destination_url: 'https://bid.advantage.bid/become-professional-seller.html',
  },

  // ── Professional Seller: auction houses ──
  {
    package_key: 'PKG-PS-AUCTIONHOUSE-V1',
    funnel: 'professional_seller',
    audience_purpose: 'auction_house_acquisition',
    asset_filename: 'auction-house-operator.png',
    primary_text: 'Auction professionals: create auctions in minutes, not days. Advantage.Bid turns your '
      + 'inventory into professional online auctions, helps you win more consignments and reach more buyers, '
      + 'and streamlines the operations behind every sale.',
    headline: 'Modern Auction Technology for Auction Professionals',
    description: 'Create auctions in minutes. Win more business.',
    cta_type: 'LEARN_MORE',
    destination_url: 'https://bid.advantage.bid/become-professional-seller.html',
  },
];

/**
 * Claims we will not make in paid copy.
 *
 * A bare percentage is NOT forbidden — the estate-sale cleanout proposition legitimately uses one.
 * What is forbidden is a percentage attached to FEES or PRICING, and any guarantee or income claim.
 */
const FORBIDDEN = [
  // Pricing terminology only. Bare verbs like "take" are deliberately NOT listed: "take on more
  // estates" is a workload statement, not a fee, and blocking it would be a false positive.
  { re: /\d+\s*%[^.]{0,40}\b(fee|fees|commission|premium|rate|pricing)\b/i, why: 'a percentage attached to fees or commission' },
  { re: /\b(fee|fees|commission|premium|rate|pricing)\b[^.]{0,40}\d+\s*%/i, why: 'a percentage attached to fees or commission' },
  { re: /\b(our cut|we take|our take|we keep)\b/i, why: 'states what Advantage.Bid retains' },
  { re: /buyer'?s? premium/i, why: 'implies a fixed buyer premium' },
  { re: /\bguarantee|\bguaranteed\b/i, why: 'unsupported guarantee' },
  { re: /\bearn \$|\bmake \$|\bup to \$|\b\d+\s*%\s*(more|increase|return|roi)/i, why: 'unsupported financial result claim' },
  { re: /divorc|widow|bereave|foreclos|bankrupt|deceased/i, why: 'implies knowledge of sensitive circumstances' },
];

(async () => {
  let failures = 0;

  if (APPROVE) {
    for (const filename of OWNER_APPROVED_ADDITIONS) {
      const r = await db.query(
        `UPDATE marketing_production_creative
            SET owner_approved_for_production = true,
                approval_source = 'owner_review',
                approval_recorded_at = now(),
                production_eligible = (jsonb_array_length(COALESCE(factual_requirements->'blocking','[]'::jsonb)) = 0),
                ineligible_reason = CASE
                  WHEN jsonb_array_length(COALESCE(factual_requirements->'blocking','[]'::jsonb)) = 0 THEN NULL
                  ELSE factual_requirements->>'blocking' END,
                provenance = 'OWNER_APPROVED_PRODUCTION',
                updated_at = now()
          WHERE filename = $1 AND category <> 'do-not-use'
          RETURNING filename, production_eligible`, [filename]);
      if (!r.rows[0]) { console.error('APPROVAL SKIPPED (not registered): ' + filename); failures += 1; continue; }
      console.log('Owner approval recorded: ' + r.rows[0].filename + '  eligible=' + r.rows[0].production_eligible);
    }
    console.log('');
  }

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
         production_creative_id=EXCLUDED.production_creative_id,
         audience_purpose=EXCLUDED.audience_purpose,
         primary_text=EXCLUDED.primary_text, headline=EXCLUDED.headline, description=EXCLUDED.description,
         cta_type=EXCLUDED.cta_type, destination_url=EXCLUDED.destination_url,
         attribution_template=EXCLUDED.attribution_template,
         policy_status=EXCLUDED.policy_status, policy_detail=EXCLUDED.policy_detail,
         version = CASE WHEN marketing_creative_packages.fingerprint <> EXCLUDED.fingerprint
                        THEN marketing_creative_packages.version + 1 ELSE marketing_creative_packages.version END,
         fingerprint=EXCLUDED.fingerprint,
         -- This script is the governed source for these packages, so it declares intent: a package
         -- is active when the Owner approved it and policy is clean, and inactive the moment policy
         -- blocks it. (Without this, a package blocked by an earlier policy bug would stay inactive
         -- even after the block was lifted.)
         active = (EXCLUDED.policy_status='OK' AND EXCLUDED.approval_state='OWNER_APPROVED'),
         updated_at=now()
       RETURNING package_key, version, fingerprint, approval_state, policy_status, active, audience_purpose`,
      [p.package_key, asset.id, p.funnel, p.audience_purpose, p.primary_text, p.headline, p.description,
       p.cta_type, p.destination_url, JSON.stringify(attribution), fingerprint,
       'OWNER_APPROVED', policy, violations.join('; ') || null, 'owner_approved_production_copy', policy === 'OK'])).rows[0];

    console.log(row.package_key.padEnd(28) + 'v' + row.version + '  ' + row.approval_state
      + '  policy=' + row.policy_status + '  active=' + String(row.active).padEnd(6)
      + row.audience_purpose);
    if (violations.length) { console.log('   BLOCKED: ' + violations.join('; ')); failures += 1; }
  }
  console.log(failures ? '\nRESULT: ' + failures + ' item(s) need attention' : '\nRESULT: PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
