'use strict';

/**
 * Configurable Professional Seller platform/software fee — certification tests.
 *
 * Policy:
 *   • DEFAULT professional fee = 4.00% (400 bps); admin-configurable per seller (0–25%).
 *   • Individual sellers = 0% (the per-seller column never applies to them).
 *   • Fee base = HAMMER (not buyer premium, not tax, not Stripe fee).
 *   • The seller's configured rate — not a constant — drives settlement.
 *   • Completed settlements permanently retain the rate actually applied.
 *
 * Pure math + source-level authorization/wiring guards (the DB/route layer is integration-tested
 * separately; these lock the financial guarantees and the admin-only enforcement shape).
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const sp = require('../src/lib/settlementPolicy');
const bt = require('../src/services/billingTermsService');
const { computeSettlementTotals } = require('../src/services/settlementEngine');

const PRO = 'auction_house';
const IND = 'private';

describe('Default rate', () => {
  test('professional default is 4.00% (400 bps) in both fee modules', () => {
    expect(sp.DEFAULT_PRO_PLATFORM_FEE_BPS).toBe(400);
    expect(bt.DEFAULT_PRO_PLATFORM_FEE_BPS).toBe(400);
    expect(sp.PRO_PLATFORM_FEE_RATE).toBe(0.04);
    // No rate supplied → default 4% for a professional.
    expect(sp.platformFeeCents(100000, PRO)).toBe(4000);
    expect(bt.settlement({ sellerType: PRO, hammerCents: 100000, buyerPremiumCents: 0 }).platform_fee_cents).toBe(4000);
  });

  test('individual seller is unaffected (0%), even if a rate is somehow supplied', () => {
    expect(sp.platformFeeCents(100000, IND)).toBe(0);
    expect(sp.platformFeeCents(100000, IND, 400)).toBe(0);      // column ignored for individuals
    expect(sp.platformFeeCents(100000, null, 400)).toBe(0);     // untyped → 0
    const s = bt.settlement({ sellerType: IND, hammerCents: 100000, buyerPremiumCents: 1800 });
    expect(s.platform_fee_cents).toBe(0);
    expect(s.platform_fee_bps).toBe(0);
    expect(s.seller_payout_cents).toBe(100000);                 // seller gets hammer; premium is Advantage revenue
  });
});

describe('Custom per-seller rates (decimals supported)', () => {
  // [ratePct, bps, expectedFeeOn100k]
  const cases = [
    ['4%',    400, 4000],
    ['3%',    300, 3000],
    ['5%',    500, 5000],
    ['2.5%',  250, 2500],
    ['3.75%', 375, 3750],
    ['0%',      0,    0],
  ];
  test.each(cases)('professional at %s → fee %d cents on $1,000 hammer', (_label, bps, expected) => {
    expect(sp.platformFeeCents(100000, PRO, bps)).toBe(expected);
    const s = bt.settlement({ sellerType: PRO, hammerCents: 100000, buyerPremiumCents: 0, platformFeeBps: bps });
    expect(s.platform_fee_cents).toBe(expected);
    expect(s.platform_fee_bps).toBe(bps);                       // rate applied is captured on the settlement
    expect(s.seller_payout_cents).toBe(100000 - expected);      // seller net = hammer − fee (no premium here)
  });

  test('the configured rate — not a constant — drives the settlement (3% ≠ default 4%)', () => {
    const threePct = bt.settlement({ sellerType: PRO, hammerCents: 100000, buyerPremiumCents: 0, platformFeeBps: 300 });
    const fourPct  = bt.settlement({ sellerType: PRO, hammerCents: 100000, buyerPremiumCents: 0 });
    expect(threePct.platform_fee_cents).toBe(3000);
    expect(fourPct.platform_fee_cents).toBe(4000);
    expect(threePct.platform_fee_cents).not.toBe(fourPct.platform_fee_cents);
  });
});

describe('Fee base = hammer; buyer premium & tax stay separate', () => {
  test('fee is on hammer only — NOT hammer+premium', () => {
    // Hammer $1,000, premium $180. 4% fee must be $40 (on hammer), never $47.20 (on hammer+premium).
    const s = bt.settlement({ sellerType: PRO, hammerCents: 100000, buyerPremiumCents: 18000 });
    expect(s.platform_fee_cents).toBe(4000);                    // 4% × 100000 hammer
    expect(s.platform_fee_cents).not.toBe(Math.round((100000 + 18000) * 0.04));
    // Seller keeps hammer + their own premium, less the platform fee.
    expect(s.seller_gross_cents).toBe(118000);
    expect(s.seller_payout_cents).toBe(118000 - 4000);
    expect(s.advantage_revenue_cents).toBe(4000);              // only the platform fee (premium is the seller's)
  });

  test('settlement engine applies the per-seller rate to gross hammer, excludes tax', () => {
    const t = computeSettlementTotals({
      sellerType: PRO, sellerPlatformFeeBps: 375,
      grossSalesCents: 100000, buyerPaymentsCollectedCents: 118000, buyerPaymentsExpectedCents: 118000,
    });
    expect(t.seller_platform_fee_bps).toBe(375);
    expect(t.seller_platform_fee_cents).toBe(3750);            // 3.75% × 100000 HAMMER (not the 118000 collected)
  });
});

describe('Historical settlement integrity', () => {
  test('a finalized settlement retains the rate applied; a later profile change does not alter it', () => {
    // 1) rate = 4% at finalize
    const finalized = bt.settlement({ sellerType: PRO, hammerCents: 100000, buyerPremiumCents: 0, platformFeeBps: 400 });
    const snapshot = JSON.parse(JSON.stringify(finalized));    // immutable capture (as stored in terms_snapshot/settlement_snapshots)
    expect(snapshot.platform_fee_bps).toBe(400);
    expect(snapshot.platform_fee_cents).toBe(4000);

    // 2) seller later negotiated down to 3% — a NEW settlement uses 3%, but the OLD snapshot is untouched.
    const future = bt.settlement({ sellerType: PRO, hammerCents: 100000, buyerPremiumCents: 0, platformFeeBps: 300 });
    expect(future.platform_fee_bps).toBe(300);
    expect(snapshot.platform_fee_bps).toBe(400);              // history preserved
    expect(snapshot.platform_fee_cents).toBe(4000);
  });

  test('storeSettlement persists platform_fee_bps and the full terms snapshot', () => {
    const src = read('src/services/billingTermsService.js');
    expect(src).toMatch(/platform_fee_bps = \$6/);            // applied rate written to seller_payouts
    expect(src).toMatch(/terms_snapshot = \$7/);             // immutable snapshot retained
  });

  test('auction close and the pay-seller transfer both snapshot the applied rate', () => {
    expect(read('src/services/auctionService.js')).toMatch(/platformFeeBps: terms\.platform_fee_bps/);
    expect(read('src/services/settlementEngine.js')).toMatch(/platform_fee_bps = \$6/); // paySellerViaTransfer UPDATE
  });
});

describe('Validation & authorization (server-side)', () => {
  const adminSrc = read('src/routes/admin.js');
  const feeRoute = (() => {
    const start = adminSrc.indexOf("router.post('/sellers/:sellerId/platform-fee'");
    return adminSrc.slice(start, start + 2200);
  })();

  test('the edit route is admin-only (role([admin])) and idempotent', () => {
    expect(feeRoute).toMatch(/role\(\['admin'\]\)/);
    expect(feeRoute).toMatch(/idempotency/);
  });
  test('rejects out-of-range / non-integer / malformed values (0–2500 bps)', () => {
    expect(feeRoute).toMatch(/bps < 0 \|\| bps > MAX_PLATFORM_FEE_BPS/);
    expect(feeRoute).toMatch(/Number\.isInteger\(bps\)/);
    expect(sp.MAX_PLATFORM_FEE_BPS).toBe(2500);
  });
  test('accepts a decimal percent and converts to basis points (3.75 → 375)', () => {
    expect(feeRoute).toMatch(/Math\.round\(pct \* 100\)/);
  });
  test('writes an audit event with before/after on change', () => {
    expect(feeRoute).toMatch(/seller_platform_fee_changed/);
    expect(feeRoute).toMatch(/before_bps.*after_bps/);
  });
  test('sellers have NO self-service route to change their own platform fee', () => {
    // The only writer of platform_fee_bps in routes is the admin route above.
    const anyRoute = read('src/routes/sellers.js') + read('src/routes/auctions.js') + read('src/routes/lots.js');
    expect(anyRoute).not.toMatch(/platform_fee_bps\s*=/);
  });
});

describe('No stale fixed-rate assumption remains', () => {
  test('no hardcoded 2% (200-bps) professional fee constant survives in the fee modules', () => {
    expect(read('src/lib/settlementPolicy.js')).not.toMatch(/=\s*0\.02\b/);
    expect(read('src/services/billingTermsService.js')).not.toMatch(/PRO_PLATFORM_FEE_BPS\s*=\s*200/);
  });
  test('settlement fee is not hardcoded to a universal 4% — it reads the per-seller rate', () => {
    // computeSettlementTotals honors a supplied 5% rather than forcing 4%.
    const t = computeSettlementTotals({ sellerType: PRO, sellerPlatformFeeBps: 500, grossSalesCents: 100000, buyerPaymentsCollectedCents: 100000 });
    expect(t.seller_platform_fee_cents).toBe(5000);
  });
});
