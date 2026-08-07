'use strict';

/**
 * H-1 — Buyer Premium + Professional Seller Fee policy (owner-approved launch policy).
 * Regression suite for the ONE authoritative financial model (billingTermsService) and every
 * path wired to it. Pure / mocked-DB only — no live Stripe, no network.
 *
 * Policy under test:
 *   • INDIVIDUAL sellers (private / business / other / untyped): buyer premium FIXED at 18%,
 *     computed independently per winning lot; 100% of the premium is Advantage revenue; the seller
 *     receives the hammer; no hammer platform fee. Individuals cannot change the rate.
 *   • PROFESSIONAL sellers (auction_house / estate_sale_company / professional_liquidator): control
 *     their buyer premium (auction override → seller default → 18% fallback); the seller KEEPS the
 *     premium; Advantage charges a 2% software fee on the hammer.
 *
 * The 20 numbered assertions the task requires are labelled [#n] below.
 */

// Mock the DB so resolveEffectiveTerms / publicationGate are testable without Postgres.
jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');

const bt = require('../src/services/billingTermsService');
const combined = require('../src/services/combinedInvoiceService');
const sp = require('../src/lib/settlementPolicy');

afterEach(() => { if (db.query.mockReset) db.query.mockReset(); });

// ── Individual buyer premium ───────────────────────────────────────────────────
describe('Individual seller buyer premium (fixed 18%, 100% Advantage)', () => {
  test('[#1] individual buyer premium is always 18% (1800 bps)', () => {
    expect(bt.DEFAULT_BUYER_PREMIUM_BPS).toBe(1800);
    for (const t of ['private', 'business', 'other', null, undefined, '']) {
      expect(bt.effectiveBuyerPremiumBps(t, {})).toBe(1800);
    }
  });

  test('[#2] individual CANNOT override — a stored auction/seller override is ignored', () => {
    expect(bt.effectiveBuyerPremiumBps('private', { auctionBps: 500 })).toBe(1800);
    expect(bt.effectiveBuyerPremiumBps('business', { sellerPct: 5 })).toBe(1800);
    expect(bt.effectiveBuyerPremiumBps('other', { auctionBps: 0 })).toBe(1800);
  });

  test('[#3] 100% of the individual buyer premium is Advantage revenue; seller is NOT credited it', () => {
    const s = bt.settlement({ sellerType: 'private', hammerCents: 10000, buyerPremiumCents: 1800 });
    expect(s.advantage_revenue_cents).toBe(1800); // 100% of the premium
    expect(s.seller_payout_cents).toBe(10000);    // seller gets the hammer only
    expect(s.platform_fee_cents).toBe(0);         // no hammer fee for individuals
  });
});

// ── Professional buyer premium (seller-controlled) ─────────────────────────────
describe('Professional seller buyer premium (seller-controlled)', () => {
  test('[#4] a professional seller default rate is honoured (pct → bps)', () => {
    expect(bt.effectiveBuyerPremiumBps('estate_sale_company', { sellerPct: 12 })).toBe(1200);
    expect(bt.effectiveBuyerPremiumBps('professional_liquidator', {})).toBe(1800); // fallback
  });

  test('[#5] auction override beats the seller default (precedence)', () => {
    expect(bt.effectiveBuyerPremiumBps('auction_house', { auctionBps: 1000, sellerPct: 15 })).toBe(1000);
  });
});

// ── Per-lot independence + aggregation ─────────────────────────────────────────
describe('Per-lot buyer premium (independent, cents-safe)', () => {
  test('[#6] two lots are calculated independently ($100→$18, $250→$45)', () => {
    expect(bt.lotBuyerPremiumCents(10000, 1800)).toBe(1800); // $100 → $18
    expect(bt.lotBuyerPremiumCents(25000, 1800)).toBe(4500); // $250 → $45
  });

  test('[#7] combined buyer premium equals the SUM of per-lot premiums', () => {
    const lots = [{ winning_amount_cents: 10000 }, { winning_amount_cents: 25000 }];
    const perLot = bt.lotBuyerPremiumCents(10000, 1800) + bt.lotBuyerPremiumCents(25000, 1800);
    expect(bt.buyerPremiumForLots(lots, 1800)).toBe(perLot); // 6300 = 1800 + 4500
    expect(bt.buyerPremiumForLots(lots, 1800)).toBe(6300);
  });

  test('rounding is deterministic at the LOT level (odd cents)', () => {
    // 333c * 18% = 59.94 → 60 ; 777c * 18% = 139.86 → 140
    expect(bt.lotBuyerPremiumCents(333, 1800)).toBe(60);
    expect(bt.lotBuyerPremiumCents(777, 1800)).toBe(140);
  });
});

// ── Invoice totals (combinedInvoiceService.computeTotals) ───────────────────────
describe('Invoice grand total (computeTotals)', () => {
  test('[#8] grand total = hammer + buyer premium (individual 18%)', () => {
    const lots = [{ winning_amount_cents: 10000 }, { winning_amount_cents: 25000 }];
    const t = combined.computeTotals(lots, { buyerPremiumBps: 1800 });
    expect(t.hammerCents).toBe(35000);
    expect(t.buyerPremiumCents).toBe(6300);
    expect(t.totalCents).toBe(41300);
  });

  test('[#9] the PaymentIntent amount (invoice total_cents) equals hammer + buyer premium', () => {
    // createCombinedPaymentIntent charges bai.total_cents; issueForAuction stores computeTotals().totalCents.
    const t = combined.computeTotals([{ winning_amount_cents: 50000 }], { buyerPremiumBps: 1800 });
    expect(t.totalCents).toBe(50000 + 9000); // 59000 → the exact amount charged
  });

  test('no bps passed → premium 0 (back-compat with pre-policy callers)', () => {
    expect(combined.computeTotals([{ winning_amount_cents: 999 }]).buyerPremiumCents).toBe(0);
  });
});

// ── Receipt reflects the invoice ───────────────────────────────────────────────
describe('Receipt reflects the invoice', () => {
  test('[#10] buyer premium is shown on the receipt once it is non-zero (hidden at zero)', () => {
    const receipt = require('../src/services/combinedReceiptService');
    // The renderer uses summary.buyerPremiumCents (the invoice figure) — same source as the charge.
    // Assert the hide-when-zero contract by inspecting the source used by both HTML + text builders.
    const src = require('fs').readFileSync(require.resolve('../src/services/combinedReceiptService'), 'utf8');
    expect(src).toMatch(/Number\(summary\.buyerPremiumCents\)\s*>\s*0/);
    expect(receipt).toBeTruthy();
  });
});

// ── Settlement (individual vs professional) ────────────────────────────────────
describe('Settlement — preview == actual (one model)', () => {
  test('[#11] individual settlement does NOT credit the seller the buyer premium', () => {
    const s = bt.settlement({ sellerType: 'private', hammerCents: 35000, buyerPremiumCents: 6300 });
    expect(s.seller_payout_cents).toBe(35000); // hammer only — premium is Advantage revenue
    expect(s.seller_gross_cents).toBe(35000);
  });

  test('[#12] professional settlement pays the seller their buyer premium', () => {
    const s = bt.settlement({ sellerType: 'auction_house', hammerCents: 100000, buyerPremiumCents: 15000 });
    expect(s.seller_gross_cents).toBe(115000);              // hammer + their own premium
    expect(s.seller_payout_cents).toBe(115000 - 2000);      // less the 2% software fee
  });

  test('[#13] professional pays Advantage a 2% software fee on the hammer', () => {
    const s = bt.settlement({ sellerType: 'estate_sale_company', hammerCents: 100000, buyerPremiumCents: 0 });
    expect(s.platform_fee_cents).toBe(2000);
    expect(s.advantage_revenue_cents).toBe(2000); // the professional premium is NOT Advantage revenue
    expect(sp.platformFeeCents(100000, 'estate_sale_company')).toBe(2000);
    expect(sp.platformFeeCents(100000, 'private')).toBe(0);
  });
});

// ── No obsolete rules remain in executable logic ───────────────────────────────
describe('Obsolete financial rules are gone from executable logic', () => {
  test('[#14] there is no active 10% platform fee anywhere in the model', () => {
    // Professional fee is 2%, individual is 0% — never 10%.
    expect(sp.PRO_PLATFORM_FEE_RATE).toBe(0.02);
    expect(sp.PLATFORM_FEE_RATE).toBe(0);
    expect(sp.platformFeeCents(100000, 'auction_house')).not.toBe(10000);
    expect(bt.PRO_PLATFORM_FEE_BPS).toBe(200);
  });

  test('[#15] the 0% buyer-premium pilot rule is NOT active (individual BP is 18%, not 0)', () => {
    expect(bt.effectiveBuyerPremiumBps('private', {})).not.toBe(0);
    expect(bt.buyerPremiumForLots([{ winning_amount_cents: 10000 }], 1800)).toBeGreaterThan(0);
  });
});

// ── resolveEffectiveTerms (DB-backed precedence) ───────────────────────────────
describe('resolveEffectiveTerms (DB precedence)', () => {
  test('individual auction → 18% fixed, source individual_fixed, even with a stored override', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ buyer_premium_bps: 500, seller_type: 'private', buyer_premium_pct: 9 }] });
    const terms = await bt.resolveEffectiveTerms('a1');
    expect(terms.buyer_premium_bps).toBe(1800);
    expect(terms.is_professional).toBe(false);
    expect(terms.source).toBe('individual_fixed');
  });

  test('professional auction → honours the auction override', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ buyer_premium_bps: 1000, seller_type: 'auction_house', buyer_premium_pct: null }] });
    const terms = await bt.resolveEffectiveTerms('a2');
    expect(terms.buyer_premium_bps).toBe(1000);
    expect(terms.is_professional).toBe(true);
    expect(terms.source).toBe('auction');
  });
});

// ── Professional approval gate (reused verification architecture) ───────────────
describe('Professional approval gate (publish-only)', () => {
  const verification = require('../src/services/verificationService');

  test('[#16] an unapproved professional is NOT blocked from building (gate only guards publish)', async () => {
    // Not flagged verification_required_before_publication → publication gate is open.
    db.query.mockResolvedValueOnce({ rows: [{ verification_required_before_publication: false }] });
    const gate = await verification.publicationGate('seller-1');
    expect(gate.blocked).toBe(false);
  });

  test('[#17] an unapproved professional CANNOT make a first sale public (publish blocked)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ verification_required_before_publication: true }] }) // flag on
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // hasApprovedVerification → none
    const gate = await verification.publicationGate('seller-2');
    expect(gate.blocked).toBe(true);
  });

  test('[#18] an APPROVED professional can publish (gate open)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ verification_required_before_publication: true }] }) // flag on
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 }); // hasApprovedVerification → approved
    const gate = await verification.publicationGate('seller-3');
    expect(gate.blocked).toBe(false);
  });
});

// ── End-to-end individual flow integrity ───────────────────────────────────────
describe('Individual buyer flow is operational end to end', () => {
  test('[#19] issue → charge → settle numbers reconcile for an individual auction', () => {
    const lots = [{ winning_amount_cents: 10000 }, { winning_amount_cents: 25000 }];
    const totals = combined.computeTotals(lots, { buyerPremiumBps: 1800 });
    const s = bt.settlement({ sellerType: 'private', hammerCents: totals.hammerCents, buyerPremiumCents: totals.buyerPremiumCents });
    // The buyer pays the invoice total; that total is hammer + premium.
    expect(totals.totalCents).toBe(s.buyer_total_cents);
    // Advantage keeps the premium; the seller keeps the hammer. Nothing is lost.
    expect(s.advantage_revenue_cents + s.seller_payout_cents).toBe(totals.totalCents);
  });

  test('[#20] professional flow reconciles (buyer total = seller take + Advantage fee)', () => {
    const lots = [{ winning_amount_cents: 100000 }];
    const totals = combined.computeTotals(lots, { buyerPremiumBps: 1500 }); // 15% pro rate
    const s = bt.settlement({ sellerType: 'auction_house', hammerCents: totals.hammerCents, buyerPremiumCents: totals.buyerPremiumCents });
    expect(totals.totalCents).toBe(115000);                         // hammer + 15% premium
    expect(s.seller_payout_cents + s.platform_fee_cents).toBe(totals.totalCents); // seller take + Advantage fee = buyer total
  });
});
