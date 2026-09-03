'use strict';

/**
 * Marketing package lifecycle (48h cutoff + clothing >50% rule) + settlement shortfall/loss policy.
 * Pure-rule + settlement-math coverage + source/schema guards. No collection mechanism is introduced.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const elig = require('../src/lib/marketingEligibility');
const engine = require('../src/services/settlementEngine');

// ── 48-hour purchase window ─────────────────────────────────────────────────────
describe('marketing purchase window (48h before authoritative close)', () => {
  const H = 3600 * 1000;
  const close = Date.UTC(2026, 8, 20, 12, 0, 0);
  test('available when >48h from close', () => {
    expect(elig.isWithinPurchaseWindow(close - 72 * H, close)).toBe(true);
  });
  test('UNAVAILABLE at exactly T-48h (boundary)', () => {
    expect(elig.isWithinPurchaseWindow(close - 48 * H, close)).toBe(false);
  });
  test('unavailable inside final 48h', () => {
    expect(elig.isWithinPurchaseWindow(close - 24 * H, close)).toBe(false);
    expect(elig.isWithinPurchaseWindow(close + H, close)).toBe(false); // after close
  });
  test('no authoritative close time → not purchasable', () => {
    expect(elig.isWithinPurchaseWindow(Date.now(), NaN)).toBe(false);
  });
});

// ── Clothing/apparel >50% rule (integer-exact) ──────────────────────────────────
describe('clothing/apparel eligibility (>50% ineligible; exactly 50% eligible)', () => {
  test('14/30 = 46.67% → eligible', () => { expect(elig.isClothingEligible(30, 14)).toBe(true); });
  test('15/30 = 50.00% → eligible (exactly half)', () => { expect(elig.isClothingEligible(30, 15)).toBe(true); });
  test('16/30 = 53.33% → ineligible', () => { expect(elig.isClothingEligible(30, 16)).toBe(false); });
  test('ratio bps snapshot is accurate', () => {
    expect(elig.clothingRatioBps(30, 14)).toBe(4667);
    expect(elig.clothingRatioBps(30, 15)).toBe(5000);
    expect(elig.clothingRatioBps(30, 16)).toBe(5333);
  });
  test('classification uses taxonomy, not photos: clothing/apparel match; jewelry/watch/handbag do NOT', () => {
    ['clothing', 'Clothing & Accessories', 'apparel', "Men's Apparel", 'clothes'].forEach((c) => expect(elig.isClothingCategory(c)).toBe(true));
    ['jewelry', 'Jewelry & Watches', 'watches', 'handbags', 'decorative textiles', 'home linens', 'collectibles', 'furniture', null, ''].forEach((c) => expect(elig.isClothingCategory(c)).toBe(false));
  });
});

// ── Eligibility service: SQL clothing predicate mirrors the matcher; valid-lot denominator ──
describe('marketingEligibilityService — server-side, valid-lot denominator', () => {
  const svc = read('src', 'services', 'marketingEligibilityService.js');
  test('valid lots exclude withdrawn (existing semantics)', () => {
    expect(svc).toMatch(/state <> 'withdrawn'/);
  });
  test('uses the authoritative auction close time (end_time), not a marketing-only date', () => {
    expect(svc).toMatch(/end_time/);
    expect(svc).not.toMatch(/marketing_close|marketing_date|marketing_deadline/);
  });
  test('clothing SQL predicate matches clothing/apparel only', () => {
    expect(svc).toMatch(/LIKE 'clothing%'/);
    expect(svc).toMatch(/LIKE '%apparel%'/);
    expect(svc).not.toMatch(/jewelry|watch|handbag/i);
  });
});

// ── Server-side enforcement (cannot be bypassed by stale UI) ────────────────────
describe('server-side enforcement at listing + purchase', () => {
  test('package listing endpoint evaluates eligibility and hides packages when unavailable', () => {
    const r = read('src', 'routes', 'marketing.js');
    expect(r).toMatch(/evaluateAuction/);
    expect(r).toMatch(/available: false/);
    expect(r).toMatch(/48 hours before the auction closes/);
    expect(r).toMatch(/more than half of the catalog is clothing\/apparel/);
  });
  test('purchase (createMarketingJob) re-checks eligibility server-side and records the snapshot', () => {
    const s = read('src', 'services', 'marketingService.js');
    expect(s).toMatch(/evaluateAuction/);
    expect(s).toMatch(/MARKETING_UNAVAILABLE/);
    expect(s).toMatch(/elig_total_lots|elig_clothing_lots|elig_rule_version/);
  });
  test('already-purchased packages are NOT retroactively voided (gate blocks NEW purchases only)', () => {
    // The gate lives only in createMarketingJob / the listing endpoint; no code cancels an existing job on
    // catalog change or entering the final 48h.
    const s = read('src', 'services', 'marketingService.js');
    expect(s).not.toMatch(/cancel.*job|void.*marketing_job|DELETE FROM marketing_jobs/i);
  });
});

// ── Settlement shortfall math (payout clamps to >=0; shortfall = unrecovered) ────
describe('settlement shortfall/loss (no negative payout; accurate loss)', () => {
  const T = (over) => engine.computeSettlementTotals({
    grossSalesCents: 10000, buyerPaymentsExpectedCents: 10000, buyerPaymentsCollectedCents: 10000,
    refundsCents: 0, marketingDeductionCents: over, adjustments: [], sellerType: 'private',
    pricingModel: 'v2_separated', processingFeeBps: 300,
  });
  test('sufficient proceeds → normal positive payout, no shortfall', () => {
    const t = T(1000); // hammer 10000, processing 300, marketing 1000 → net 8700
    expect(t.net_seller_proceeds_cents).toBe(8700);
    expect(t.final_payout_cents).toBe(8700);
    expect(t.shortfall_cents).toBe(0);
  });
  test('exactly $0 net → $0 payout, no shortfall', () => {
    // net = 10000 collected - 300 processing - 9700 marketing = 0
    const t = T(9700);
    expect(t.net_seller_proceeds_cents).toBe(0);
    expect(t.final_payout_cents).toBe(0);
    expect(t.shortfall_cents).toBe(0);
  });
  test('deductions exceed proceeds → payout clamps to $0; shortfall = unrecovered (never negative payout)', () => {
    const t = T(12000); // net = 10000 - 300 - 12000 = -2300
    expect(t.net_seller_proceeds_cents).toBe(-2300);   // accurate (may be negative)
    expect(t.final_payout_cents).toBe(0);              // never a negative/zero-fake transfer
    expect(t.shortfall_cents).toBe(2300);              // internal unrecovered loss
  });
});

// ── Settlement engine wiring: marketing charge + idempotent loss record ─────────
describe('settlement engine wiring', () => {
  const e = read('src', 'services', 'settlementEngine.js');
  test('marketing package is a Concept-A deduction from the authoritative snapshot', () => {
    expect(e).toMatch(/marketing_jobs[\s\S]*package_price_cents/);
    expect(e).toMatch(/deduction_cents: cents/);
  });
  test('recordSettlementShortfall upserts EXACTLY ONE loss row (idempotent) + stamps seller_payouts', () => {
    expect(e).toMatch(/ON CONFLICT \(auction_id\) DO UPDATE/);
    expect(e).toMatch(/UPDATE seller_payouts SET marketing_charge_cents = \$2, shortfall_cents = \$3/);
  });
  test('no seller chargeable payment / receivable / clawback introduced', () => {
    expect(e).not.toMatch(/SetupIntent|paymentMethods\.attach|receivable|clawback|carry_forward|invoice.*seller/i);
  });
});

// ── Settlement email: zero-payout explanation, no internal economics leak ────────
describe('seller settlement email', () => {
  const c = read('src', 'services', 'sellerCloseoutService.js');
  test('itemizes platform + processing separately and shows $0 payout with an explanation', () => {
    expect(c).toMatch(/Advantage\.Bid Platform Fee/);
    expect(c).toMatch(/Payment Processing Fee/);
    expect(c).toMatch(/No payout is due for this auction/);
    expect(c).toMatch(/final_payout_cents/);
  });
  test('never exposes internal 60/40 direct-spend or Growth Pool, or a negative amount', () => {
    // Check actual code/output (strip comments — a comment may describe the guarantee).
    const code = c.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
    expect(code).not.toMatch(/direct_max|direct_spent|growth_pool|60\/40|Growth Pool/i);
  });
});

// ── Migration 127: additive shortfall + eligibility snapshot ─────────────────────
describe('migration 127', () => {
  const mig = read('db', 'migrations', '127_marketing_lifecycle_shortfall.sql');
  test('adds eligibility snapshot columns + seller_payouts shortfall columns', () => {
    expect(mig).toMatch(/elig_clothing_pct_bps/);
    expect(mig).toMatch(/ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS marketing_charge_cents/);
    expect(mig).toMatch(/ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS shortfall_cents/);
  });
  test('settlement_shortfalls is ONE row per auction (PK) — loss recorded exactly once; not a ledger', () => {
    expect(mig).toMatch(/auction_id\s+UUID PRIMARY KEY REFERENCES auctions/);
    expect(mig).toMatch(/unrecovered_shortfall_cents INTEGER NOT NULL CHECK \(unrecovered_shortfall_cents >= 0\)/);
  });
  test('no seller chargeable-payment / receivable / carry-forward structures', () => {
    // Check actual DDL (strip SQL comments — the header comment documents these absences).
    const ddl = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(ddl).not.toMatch(/setup_intent|payment_method|receivable|carry_forward|carryforward/i);
  });
});
