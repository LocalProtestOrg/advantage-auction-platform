'use strict';

/**
 * Seller permission model — server-side enforcement (Final Seller Permission Certification).
 * Guards the fixes for three verified bypasses so they cannot silently regress:
 *   D1: individual lots must start at $1 — the POST /api/auctions/:id/lots path must gate
 *       starting price to professionals (parity with POST /api/lots).
 *   D2: no catalog edits after submission — that same path must apply the canMutateAuction lock.
 *   D3: bid increment is professional-only — both lot routes must gate bid_increment_cents.
 * Source-level assertions (the repo's pattern for route authorization) + the pure gate logic.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const auctionsRoute = read('src/routes/auctions.js');
const lotsRoute = read('src/routes/lots.js');
const { isProfessional } = require('../src/services/sellerTypeRules');
const { PROFESSIONAL_SELLER_TYPES, NON_PROFESSIONAL_SELLER_TYPES } = require('../src/constants/sellerTypes');

// Isolate the POST /:auctionId/lots handler in auctions.js.
const addLotHandler = (() => {
  const start = auctionsRoute.indexOf("router.post('/:auctionId/lots'");
  const end = auctionsRoute.indexOf('router.', start + 10);
  return auctionsRoute.slice(start, end > start ? end : start + 2000);
})();

describe('seller-class classification (pure)', () => {
  test('professional types are exactly the three pro classes', () => {
    expect(PROFESSIONAL_SELLER_TYPES.sort()).toEqual(['auction_house', 'estate_sale_company', 'professional_liquidator']);
    PROFESSIONAL_SELLER_TYPES.forEach((t) => expect(isProfessional(t)).toBe(true));
  });
  test('individual/non-professional (and untyped) are NOT professional', () => {
    [...NON_PROFESSIONAL_SELLER_TYPES, null, undefined, 'unknown'].forEach((t) => expect(isProfessional(t)).toBe(false));
  });
});

describe('D1/D2: POST /api/auctions/:id/lots is gated (no bypass)', () => {
  test('applies the canMutateAuction submission lock', () => {
    expect(addLotHandler).toMatch(/canMutateAuction\(req\.user\.id, req\.user\.role, auctionId\)/);
    expect(addLotHandler).toMatch(/if \(!gate\.allowed\)/);
    expect(addLotHandler).toMatch(/lockErrorMessage\(gate\.reason\)/);
  });
  test('starting price is professional-only (non-pro → $1 default)', () => {
    expect(addLotHandler).toMatch(/isProfessional\(st\.rows\[0\]\.seller_type\)/);
    expect(addLotHandler).toMatch(/effStartingPrice = undefined/);           // stripped for non-pro
    expect(addLotHandler).toMatch(/startingPrice: effStartingPrice/);        // gated value is what's passed to createLot
  });
  test('auctions.js imports the professional gate', () => {
    expect(auctionsRoute).toMatch(/const \{ isProfessional \}\s*=\s*require\('\.\.\/services\/sellerTypeRules'\)/);
  });
});

describe('D3: bid increment is professional-only on both lot routes', () => {
  test('POST /api/lots gates bid_increment_cents', () => {
    expect(lotsRoute).toMatch(/const effBidIncrement\s*=\s*proAllowed \? \(bid_increment_cents \|\| null\) : null/);
    // the gated value (not the raw body) is inserted
    expect(lotsRoute).toMatch(/effBidIncrement, effStartingBid, effReserveCents/);
  });
  test('PUT /api/lots/:lotId gates bid_increment_cents', () => {
    // both the derivation and its use in the UPDATE params
    expect((lotsRoute.match(/const effBidIncrement\s*=\s*proAllowed/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(lotsRoute).toMatch(/effBidIncrement,\s*\/\/ Phase C\.2: null \(platform default\)/);
  });
});

describe('regression guard: the gated POST /api/lots path still gates starting bid + reserve', () => {
  test('starting bid + reserve remain professional-only', () => {
    expect(lotsRoute).toMatch(/const effStartingBid\s*=\s*proAllowed \? \(starting_bid_cents \|\| null\) : null/);
    expect(lotsRoute).toMatch(/proSettingsAllowedForAuction\(req\.user\.role, auctionId\)/);
  });
});

describe('catalog-edit lock follows the PROFESSIONAL classification (owner policy)', () => {
  // Isolate canMutateAuction.
  const gateFn = (() => {
    const start = lotsRoute.indexOf('async function canMutateAuction');
    const end = lotsRoute.indexOf('async function canMutateLot');
    return lotsRoute.slice(start, end > start ? end : start + 900);
  })();
  test('post-submission edits are allowed for professionals (not the legacy business bypass)', () => {
    expect(gateFn).toMatch(/if \(isProfessional\(seller_type\)\)\s*return \{ allowed: true,\s*reason: 'professional_seller' \}/);
  });
  test('the legacy business_seller_bypass is gone from the gate logic', () => {
    expect(gateFn).not.toMatch(/seller_type\s*===\s*'business'/);
    expect(gateFn).not.toMatch(/business_seller_bypass/);
  });
  test('admin still overrides; draft still open; everyone else locked after submission', () => {
    expect(gateFn).toMatch(/if \(userRole === 'admin'\) return \{ allowed: true, reason: 'admin' \}/);
    expect(gateFn).toMatch(/if \(state === 'draft'\)\s*return \{ allowed: true,\s*reason: 'draft' \}/);
    expect(gateFn).toMatch(/return \{ allowed: false, reason: 'auction_locked_after_submission' \}/);
  });
  test('no residual business bypass anywhere in the two route files', () => {
    expect(lotsRoute).not.toMatch(/seller_type\s*===\s*'business'/);
    expect(auctionsRoute).not.toMatch(/seller_type\s*===\s*'business'/);
  });
});

// ── V1.0 Professional self-service (owner-approved) ──────────────────────────
// Professionals may customize their auctions themselves: (1) manage the catalog after
// submission/publication, (2) set custom starting prices [already covered above],
// (3) set the auction Buyer Premium, (4) set the per-lot Bid Increment. Individuals must
// never gain these. Server stays authoritative; UI mirrors the server rule.
const auctionServiceSrc = read('src/services/auctionService.js');
const lotsStudioHtml    = read('public/dashboard/lots.html');
const sellerDashHtml    = read('public/seller-dashboard.html');
const sellerCreateHtml  = read('public/seller-create.html');

describe('Professional Buyer Premium self-service (updateAuction, auction-level)', () => {
  test('a professional-OWNER gate is derived from the auction seller_type', () => {
    expect(auctionServiceSrc).toMatch(/const isProAuthor = actorRole !== 'admin' && isProfessional\(sellerTypeForAuth\)/);
    expect(auctionServiceSrc).toMatch(/SELECT sp\.seller_type FROM auctions a JOIN seller_profiles sp/);
  });
  test('buyer_premium_bps is writable ONLY for a professional owner (individuals keep the plain allow-list)', () => {
    expect(auctionServiceSrc).toMatch(/professionalSelfService = \['buyer_premium_bps'\]/);
    expect(auctionServiceSrc).toMatch(/isProAuthor \? \[\.\.\.allowed, \.\.\.professionalSelfService\] : allowed/);
  });
  test('buyer_premium_bps stays in adminOnly so a non-admin non-pro seller can never write it', () => {
    const adminOnlyBlock = auctionServiceSrc.slice(auctionServiceSrc.indexOf('const adminOnly'), auctionServiceSrc.indexOf('const adminOnly') + 400);
    expect(adminOnlyBlock).toMatch(/'buyer_premium_bps'/);
  });
  test('professional buyer premium is range-validated (0–2500 bps = 0–25%)', () => {
    expect(auctionServiceSrc).toMatch(/if \(isProAuthor && updates\.buyer_premium_bps/);
    expect(auctionServiceSrc).toMatch(/bp < 0 \|\| bp > 2500/);
  });
  test('price fields incl. buyer_premium_bps remain locked once the auction is ACTIVE', () => {
    const activeLocked = auctionServiceSrc.slice(auctionServiceSrc.indexOf('ACTIVE_LOCKED'), auctionServiceSrc.indexOf('ACTIVE_LOCKED') + 200);
    expect(activeLocked).toMatch(/'buyer_premium_bps'/);
  });
  test('the professional Buyer Premium control is a percent input surfaced in the auction editor', () => {
    expect(sellerCreateHtml).toMatch(/id="buyer-premium-row"/);
    expect(sellerCreateHtml).toMatch(/id="buyer-premium-pct"/);
    expect(sellerCreateHtml).toMatch(/patch\.buyer_premium_bps = Math\.round\(bpPct \* 100\)/);
  });
});

describe('Professional catalog editing UI mirrors the server rule (no legacy business bypass)', () => {
  test('lot studio lock no longer bypasses on the legacy business seller_type', () => {
    expect(lotsStudioHtml).not.toMatch(/if \(sellerType === 'business'\) return/);
  });
  test('lot studio lock bypasses only for the three professional seller types', () => {
    expect(lotsStudioHtml).toMatch(/PRO_TYPES_LOCK = \['auction_house', 'estate_sale_company', 'professional_liquidator'\]/);
  });
  test('seller dashboard exposes catalog controls to professionals after submission (not individuals)', () => {
    expect(sellerDashHtml).toMatch(/proCanManageNow = isProfessionalSeller\(\)/);
    expect(sellerDashHtml).toMatch(/canManageCatalog = isEditable \|\| proCanManageNow/);
    // Submit-for-review stays draft-only (one-shot), not gated on canManageCatalog.
    expect(sellerDashHtml).toMatch(/\$\{isEditable \? `<button class="btn btn-secondary btn-sm" data-submit-auction/);
  });
});

describe('Professional Bid Increment self-service is surfaced in the lot studio (server already gates it)', () => {
  test('the lot studio has a bid-increment control revealed with the pro-only group', () => {
    expect(lotsStudioHtml).toMatch(/id="bid-increment-form-group"/);
    expect(lotsStudioHtml).toMatch(/'starting-bid-form-group', 'bid-increment-form-group', 'reserve-form-group'/);
  });
  test('the lot studio sends bid_increment_cents (server ignores it for non-pros)', () => {
    expect(lotsStudioHtml).toMatch(/bid_increment_cents: bidIncrementRaw > 0 \? Math\.round\(bidIncrementRaw \* 100\) : null/);
  });
});
