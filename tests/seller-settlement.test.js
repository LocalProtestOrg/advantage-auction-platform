// Seller Financial Center — pure view/security + static UI checks (Increment 7).
const fs = require('fs');
const vm = require('vm');
const v = require('../src/lib/sellerSettlementView');

describe('sellerSettlementView (pure)', () => {
  test('status label collapses admin workflow into seller-facing progress', () => {
    expect(v.sellerStatusLabel('paid')).toBe('Paid');
    expect(v.sellerStatusLabel('ready_for_payment')).toBe('Ready For Payment');
    ['pending_review', 'approved', 'on_hold'].forEach(s => expect(v.sellerStatusLabel(s)).toBe('Under Review'));
  });

  test('financial summary aggregates genuine values only', () => {
    const rows = [
      { settlement_status: 'paid', gross_revenue_cents: 100000, final_amount_paid_cents: 97000, paid_at: '2026-07-19' },
      { settlement_status: 'paid', gross_revenue_cents: 50000, final_amount_paid_cents: 48000, paid_at: '2026-08-01' },
      { settlement_status: 'pending_review', gross_revenue_cents: 30000 },
    ];
    const s = v.sellerFinancialSummary(rows, 'check');
    expect(s.lifetime_gross_cents).toBe(180000);
    expect(s.lifetime_net_payouts_cents).toBe(145000);
    expect(s.total_settled).toBe(2);
    expect(s.pending_settlements).toBe(1);
    expect(s.last_payment_date).toBe('2026-08-01');
    expect(s.preferred_payment_method).toBe('check');
    expect(v.sellerFinancialSummary([], null).lifetime_gross_cents).toBe(0);
  });

  test('list item: paid uses final amount, unpaid uses computed net payout', () => {
    expect(v.sellerSettlementListItem({ auction_id: 'a', settlement_status: 'paid', final_amount_paid_cents: 97000, seller_payout_cents: 99999 }).net_seller_payment_cents).toBe(97000);
    expect(v.sellerSettlementListItem({ auction_id: 'a', settlement_status: 'pending_review', seller_payout_cents: 40000 }).net_seller_payment_cents).toBe(40000);
  });

  test('detail view NEVER exposes admin/internal data', () => {
    const view = v.sellerSettlementDetailView({
      auctionId: 'a1', auction: { title: 'Estate Sale', end_time: '2026-07-18' },
      sp: { settlement_status: 'paid', final_amount_paid_cents: 97000, payment_method_used: 'check', payout_reference: 'CHK-1', paid_at: '2026-07-19', paid_by_user_id: 'ADMIN_SECRET_USER', approved_at: 'x', created_at: 'y' },
      totals: { buyer_payments_collected_cents: 100000, refunds_cents: 0, net_collected_cents: 100000, adjustments: { credit_cents: 2000, debit_cents: 5000, net_cents: -3000 }, marketing_deduction_cents: 0, credit_card_processing_fee_cents: 0, seller_platform_fee_cents: 0, net_seller_proceeds_cents: 97000 },
      marketing: null,
    });
    const json = JSON.stringify(view);
    ['ADMIN_SECRET_USER', 'paid_by_user_id', 'snapshot', 'stripe_balance', 'reason', 'notes', 'audit'].forEach(k => expect(json).not.toContain(k));
    expect(view.net_seller_payment_cents).toBe(97000);   // frozen paid amount
    expect(view.credits_cents).toBe(2000);
    expect(view.debits_cents).toBe(5000);
    expect(view.platform_fee_pct).toBe('0.00%');
    expect(view.payment.reference).toBe('CHK-1');
    expect(view.timeline.map(s => s.label)).toEqual(['Under Review', 'Ready For Payment', 'Paid']);
  });
});

describe('seller-settlements.html (static UI)', () => {
  const HTML = fs.readFileSync('public/seller-settlements.html', 'utf8');
  test('has the required sections + consumes the seller API', () => {
    ['Financial Summary', 'Settlement History', 'Settlement Calculation', 'Understanding Your Deductions', 'Marketing Results', 'Tax Documents']
      .forEach(s => expect(HTML).toContain(s));
    expect(HTML).toContain('/api/seller/settlements/me');
    expect(HTML).toContain('net_seller_payment_cents');   // renders API value
    expect(HTML).not.toMatch(/PLATFORM_FEE|\*\s*0\.1\b/);  // no fee math in the UI
  });
  test('payment explanations + attribution Not Available present', () => {
    expect(HTML).toContain('Only the actual payment processing costs charged by Stripe are recovered.');
    expect(HTML).toContain('Coming in a Future Update');
    expect(HTML).toContain('Not Available');
    expect(HTML).toContain('0.00%');
  });
  test('copy SOP: no AI, no em/en dashes; inline JS parses', () => {
    expect(HTML).not.toMatch(/\bAI\b/);
    expect(HTML).not.toMatch(/[—–]/);
    const scripts = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    scripts.forEach(s => { expect(() => new vm.Script(s)).not.toThrow(); });
  });
});
