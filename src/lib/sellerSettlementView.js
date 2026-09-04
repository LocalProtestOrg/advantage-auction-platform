'use strict';

/**
 * sellerSettlementView — PURE seller-facing serializers (Increment 7). No DB, no calc.
 *
 * These build the ONLY shapes returned to a seller. They deliberately allowlist
 * seller-appropriate fields and NEVER include admin notes, audit events, adjustment
 * reasons/notes, internal snapshot ids, banking data, Stripe identifiers, admin users,
 * or internal workflow states. The seller-facing status collapses admin workflow into a
 * simple progress ("Under Review" / "Ready For Payment" / "Paid").
 */

function sellerStatusLabel(s) {
  if (s === 'paid') return 'Paid';
  if (s === 'ready_for_payment') return 'Ready For Payment';
  return 'Under Review'; // pending_review / approved / on_hold — do not expose admin workflow
}

function sellerTimeline(sp) {
  const status = sp ? sp.settlement_status : 'pending_review';
  const steps = [{ key: 'review', label: 'Under Review', at: (sp && sp.created_at) || null }];
  if (status === 'ready_for_payment' || status === 'paid') steps.push({ key: 'ready', label: 'Ready For Payment', at: (sp && sp.approved_at) || null });
  if (status === 'paid') steps.push({ key: 'paid', label: 'Paid', at: (sp && sp.paid_at) || null });
  return steps;
}

const nonNeg = (v) => Math.max(0, Number(v) || 0); // seller never sees a negative amount to be paid

// One history-table row from the stored payout figures (authoritative snapshot). Seller-safe. Platform and
// processing are kept SEPARATE (never a combined "commission"). Net payout is clamped to >= 0.
function sellerSettlementListItem(row) {
  const paid = row.settlement_status === 'paid';
  return {
    auction_id: row.auction_id,
    auction_title: row.title || 'Auction',
    close_date: row.end_time || null,
    status: row.settlement_status,
    status_label: sellerStatusLabel(row.settlement_status),
    gross_sales_cents: row.gross_revenue_cents || 0,
    platform_fee_cents: row.platform_fee_cents || 0,             // Advantage.Bid Platform/Software Fee
    payment_processing_cents: row.processing_fee_cents || 0,     // Payment Processing (separate)
    marketing_package_cents: row.marketing_charge_cents || 0,    // Marketing Package (separate)
    net_seller_payment_cents: nonNeg(paid ? row.final_amount_paid_cents : row.seller_payout_cents),
    payment_method: row.payment_method_used || null,
    payment_reference: row.payout_reference || null,
    paid_date: row.paid_at || null,
  };
}

// Lifetime financial summary — genuine aggregates only; never fabricated.
function sellerFinancialSummary(rows, prefMethod) {
  const list = Array.isArray(rows) ? rows : [];
  const paid = list.filter(r => r.settlement_status === 'paid');
  const sum = (arr, f) => arr.reduce((s, r) => s + (Number(f(r)) || 0), 0);
  const lastPaid = paid.map(r => r.paid_at).filter(Boolean).sort().slice(-1)[0] || null;
  return {
    lifetime_gross_cents: sum(list, r => r.gross_revenue_cents),
    lifetime_net_payouts_cents: sum(paid, r => r.final_amount_paid_cents),
    total_settled: paid.length,
    pending_settlements: list.length - paid.length,
    last_payment_date: lastPaid,
    preferred_payment_method: prefMethod || null,
  };
}

// Full seller-facing settlement statement. Financial fields come from the authoritative
// totals (final snapshot when paid, else engine); NO admin-only fields are included.
function sellerSettlementDetailView({ auctionId, auction, sp, totals, marketing }) {
  const t = totals || {};
  const adj = t.adjustments || {};
  const paid = sp && sp.settlement_status === 'paid';
  return {
    auction: { id: auctionId, title: (auction && auction.title) || 'Auction', close_date: (auction && auction.end_time) || null },
    status: sp ? sp.settlement_status : 'pending_review',
    status_label: sellerStatusLabel(sp ? sp.settlement_status : 'pending_review'),
    buyer_payments: {
      collected_cents: t.buyer_payments_collected_cents || 0,
      refunds_cents: t.refunds_cents || 0,
      net_collected_cents: t.net_collected_cents || 0,
    },
    credits_cents: adj.credit_cents || 0,
    debits_cents: adj.debit_cents || 0,
    // SEPARATE, itemized deductions (never collapsed into a "commission"):
    marketing_package_cents: t.marketing_deduction_cents || 0,           // Marketing Package
    payment_processing_cents: t.credit_card_processing_fee_cents || 0,   // Payment Processing (policy amount deducted)
    payment_processing_label: 'Payment Processing',
    platform_fee_cents: t.seller_platform_fee_cents || 0,                // Advantage.Bid Platform/Software Fee
    platform_fee_label: 'Advantage.Bid Platform/Software Fee',
    // Rates derived from the ACTUAL applied fee vs gross hammer (individual → 0.00% platform; professional →
    // their frozen/configured rate). Truthful per seller; NOT recomputed from today's global config.
    platform_fee_pct: (() => {
      const gross = Number(t.gross_sales_cents) || 0; const fee = Number(t.seller_platform_fee_cents) || 0;
      return (gross > 0 ? (fee / gross * 100) : 0).toFixed(2) + '%';
    })(),
    payment_processing_pct: (() => {
      const gross = Number(t.gross_sales_cents) || 0; const proc = Number(t.credit_card_processing_fee_cents) || 0;
      return (gross > 0 ? (proc / gross * 100) : 0).toFixed(2) + '%';
    })(),
    // Net payout is clamped to >= 0 — a seller never sees a negative amount. Any unrecovered remainder is
    // Advantage.Bid's internal shortfall (NOT shown here). Uses final_payout_cents (max(0,net)) when available.
    net_seller_payment_cents: nonNeg(paid ? sp.final_amount_paid_cents
      : (t.final_payout_cents != null ? t.final_payout_cents : t.net_seller_proceeds_cents)),
    proceeds_insufficient: !paid && (t.final_payout_cents != null ? t.final_payout_cents : t.net_seller_proceeds_cents) <= 0
      && ((t.seller_platform_fee_cents || 0) + (t.credit_card_processing_fee_cents || 0) + (t.marketing_deduction_cents || 0)) > 0,
    payment: sp ? { method: sp.payment_method_used || null, reference: sp.payout_reference || null, paid_date: sp.paid_at || null } : null,
    timeline: sellerTimeline(sp),
    marketing: marketing || null,
  };
}

module.exports = { sellerStatusLabel, sellerTimeline, sellerSettlementListItem, sellerFinancialSummary, sellerSettlementDetailView };
