'use strict';

/**
 * Business discovery + estate-sale event model (the three owner decisions):
 *   #1 native Free Business Listings are eligible for the professionals directory (source-agnostic,
 *      moderation-gated: published + admin-granted professional capability) — not excluded by origin;
 *   #2 a professional org may post its own estate_sale events on the free plan (no $39) within the cap;
 *   #3/#6 the $39 Estate Sale Promotion stays a private-individual product AND its published event is
 *      discoverable in the normal public estate-sale/event feeds, with private identity preserved.
 * Source-level assertions (repo style) + focused pure checks. No DB/network.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ── Decision #1: professionals eligibility is origin-agnostic + moderation-gated ──
describe('professionals directory eligibility (canonical helper)', () => {
  const mv = require('../src/lib/marketplaceVisibility');
  const src = read('src', 'lib', 'marketplaceVisibility.js');
  test('eligibility includes bd_import OR a published, professionally-typed native org', () => {
    const sql = mv.activeMarketplaceCompanySql('o');
    expect(sql).toMatch(/o\.source = 'bd_import'/);              // BD still eligible
    expect(sql).toMatch(/o\.source <> 'bd_import'/);            // native now eligible too
    expect(sql).toMatch(/profile_data->>'published'\) = 'true'/); // admin publication required
    expect(sql).toMatch(/organization_capabilities/);           // professional capability required
    expect(sql).toMatch(/lifecycle_state IN \('active_partner','verified'\)/);
  });
  test('native eligibility is NOT self-serve: published is admin-only, capability is admin-granted', () => {
    // published flag is dropped from user input by the profile schema (admin/moderation only)
    expect(read('src', 'lib', 'professionalProfileSchema.js')).toMatch(/`published` is never accepted|k === 'published'/);
  });
  test('classification buckets natives by capability with a profession_id fallback (total stays consistent)', () => {
    expect(src).toMatch(/WHEN '3' THEN 'auction_houses'/);
    expect(src).toMatch(/bool_or\(capability = 'estate_sale_company'\)/);
    expect(src).toMatch(/professionals\[r\.cat\] !== undefined/);
  });
  test('the public /marketplace feed uses the shared helper (no divergent inline source filter)', () => {
    const pub = read('src', 'routes', 'public.js');
    expect(pub).toMatch(/activeMarketplaceCompanySql\('o'\)/);
    // the directory feed must not re-implement a bd_import-only company filter
    expect(pub).not.toMatch(/WHERE o\.source = 'bd_import'/);
  });
});

// ── Decision #2: professional org may post estate_sale on the free plan ──────────
describe('professional free-plan estate-sale rights', () => {
  const ev = read('src', 'services', 'eventsService.js');
  test('estate_sale via the org portal is allowed for professional org types, blocked otherwise', () => {
    expect(ev).toMatch(/ev\.sale_type === 'estate_sale' && !AUTO_PUBLISH_ORG_TYPES\.has\(orgType\)/);
    expect(ev).toMatch(/ESTATE_SALE_PROMOTION_REQUIRED/);
    expect(ev).toMatch(/AUTO_PUBLISH_ORG_TYPES = new Set\(\[/);
  });
  test('the free-plan active-event cap still applies to estate sales (consumes a slot)', () => {
    expect(ev).toMatch(/active >= plan\.max_active_events/);
    expect(ev).toMatch(/ACTIVE_EVENT_LIMIT/);
  });
  test('createDraft accepts an explicit estate_sale sale_type', () => {
    expect(ev).toMatch(/input\.saleType === 'estate_sale' \? 'estate_sale'/);
  });
  test('the org event form lets a professional choose Estate Sale or Auction and sends saleType', () => {
    const form = read('public', 'org', 'event-new.html');
    expect(form).toMatch(/id="saleType"/);
    expect(form).toMatch(/value="estate_sale"/);
    expect(form).toMatch(/value="auction"/);
    expect(form).toMatch(/saleType: \$\('saleType'\)\.value/);
  });
});

// ── Decision #3/#6: $39 product preserved + event discoverable, seller stays private ──
describe('$39 Estate Sale Promotion (private individual) preserved', () => {
  const svc = read('src', 'services', 'estateSalePromotionService.js');
  test('price stays $39 one-time payment; product type + idempotent webhook unchanged', () => {
    expect(svc).toMatch(/3900/);
    expect(svc).toMatch(/mode: 'payment'/);
    expect(svc).toMatch(/PRODUCT_TYPE = 'estate_sale_promotion'/);
    expect(svc).toMatch(/payment_status === 'paid' \|\| session\.status === 'complete'/);
  });
  test('buying the promotion does NOT make the individual a Professional Seller or change their role', () => {
    // the promotion service never promotes role or creates a seller_profile
    expect(svc).not.toMatch(/UPDATE users SET role/);
    expect(svc).not.toMatch(/INSERT INTO seller_profiles/);
  });
});

describe('$39 published event is publicly discoverable; identity/type is not a proxy', () => {
  const mv = require('../src/lib/marketplaceVisibility');
  test('event public-visibility is source/seller agnostic (published + not-past only)', () => {
    const s = mv.activeEventSql('e');
    expect(s).toMatch(/status = 'published'/);
    expect(s).toMatch(/end_at IS NULL OR e\.end_at >= now\(\)/);
    expect(s).not.toMatch(/source|seller/i); // no origin/seller filter on public events
  });
  test('a null / non-auction sale_type classifies as estate_sale (so $39 + org estate sales both show)', () => {
    expect(mv.eventKindSql('e')).toMatch(/WHEN e\.sale_type = 'auction' THEN 'auction' ELSE 'estate_sale' END/);
  });
  test('promote-estate-sale page frames it as a private individual product, not a pro membership', () => {
    const page = read('public', 'promote-estate-sale.html');
    expect(page).toMatch(/\$39/);
    expect(page).toMatch(/No subscription\. No membership\./); // preserved (existing test relies on this)
    expect(page).toMatch(/individuals promoting their own/i);
    expect(page).toMatch(/not a professional seller membership/i);
  });
});

// ── Regressions: limits/economics/privacy unchanged ─────────────────────────────
describe('regression guards', () => {
  test('free plan limits unchanged (3 active events, 10 images, no featured)', () => {
    expect(read('db', 'migrations', '076_organizations_and_events.sql')).toMatch(/\('free',\s*10,\s*3,\s*FALSE\)/);
  });
  test('the marketplace company feed exposes no seller/contact PII', () => {
    const pub = read('src', 'routes', 'public.js');
    // the directory feed selects public company fields + approved imagery only — never seller email/phone
    const feed = pub.slice(pub.indexOf("router.get('/marketplace'"), pub.indexOf("router.get('/marketplace/:orgId/auctions'"));
    expect(feed).not.toMatch(/seller.*email|contact_email|contact_phone|u\.email/i);
  });
});
