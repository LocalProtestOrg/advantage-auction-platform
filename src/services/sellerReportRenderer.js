'use strict';

/**
 * sellerReportRenderer — the ALLOWLIST renderer that produces the seller-facing payload. It is
 * constructive (builds ONLY from an explicit allowlist), so a seller payload can never structurally contain
 * internal economics, direct-spend authority, Growth Pool, audience-source mechanics, provider failures,
 * substitution CAUSES, Director reasoning, seller-invisible states, recipient data, or internal
 * profitability. Substitutions render only as a neutral note. Metrics are classified DELIVERED / MEASURED /
 * INFLUENCED / UNAVAILABLE — never invented causality.
 */

const SUB_NOTE = 'Fulfilled with an alternative promotion of comparable or greater value.';
// Seller-visible states only. Internal states (blocked/needs_owner) render as a neutral service status.
function sellerStatus(state) {
  if (['completed', 'made_good'].indexOf(state) !== -1) return 'completed';
  if (state === 'substituted') return 'completed';       // rendered as completed + neutral note
  if (['live', 'scheduled'].indexOf(state) !== -1) return 'running';
  return 'planned';                                       // planned/creative_ready/blocked/needs_owner → "planned"
}

function money(cents) { return '$' + (Number(cents || 0) / 100).toFixed(Number(cents) % 100 === 0 ? 0 : 2); }

// Build the seller payload. `metrics` (optional) supplies measured values keyed by obligation_key.
function render(purchase, obligations, metrics) {
  const m = metrics || {};
  const guaranteedLabels = ((purchase.guaranteed_deliverables) || []).map((d) => d.label).filter(Boolean);
  const mayLabels = ((purchase.discretionary_tools) || []).map((d) => d.label).filter(Boolean);

  const plan = [], running_now = [], completed = [], performance = [];
  for (const o of (obligations || [])) {
    if (o.category === 'discretionary') continue;         // discretionary is not a seller entitlement line
    const st = sellerStatus(o.state);
    const service = o.label || o.feature_key || o.obligation_key;
    if (st === 'planned') plan.push({ service, dates: '' });
    else if (st === 'running') running_now.push({ service, where: 'Advantage.Bid', since: o.updated_at ? new Date(o.updated_at).toISOString().slice(0, 10) : '' });
    else if (st === 'completed') {
      const item = { service, where: 'Advantage.Bid', when: o.terminal_at ? new Date(o.terminal_at).toISOString().slice(0, 10) : '' };
      if (o.state === 'substituted') item.note = SUB_NOTE;   // neutral note ONLY — never the cause
      completed.push(item);
    }
    // Measured performance (only where real data exists; classification is explicit).
    const mm = m[o.obligation_key] || m[o.feature_key];
    if (mm) performance.push({ metric: service, classification: mm.classification || 'MEASURED', value: mm.value != null ? String(mm.value) : 'ATTRIBUTION_UNAVAILABLE' });
  }

  return {
    purchase: {
      identity: String(purchase.package_key || purchase.promotion_key || '').toUpperCase(),
      price_paid: money(purchase.amount_paid_cents),
      purchased_on: purchase.purchased_at ? new Date(purchase.purchased_at).toISOString().slice(0, 10) : '',
      guaranteed: guaranteedLabels,
      may_include: mayLabels,
      terms: 'Marketing packages and additional promotion are non-refundable.',
    },
    plan, running_now, completed, performance,
    creative_gallery: (m.creative_gallery || []),
  };
}

module.exports = { render, sellerStatus, SUB_NOTE };
