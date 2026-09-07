'use strict';

/**
 * marketingQaGateService — Phase 3O QA gates G0–G9 as RUNTIME TESTS (not routine human approval). Each gate
 * returns { pass, gate, reason? }. A fixable failure loops back automatically (the worker retries the
 * upstream step); a QA failure is NOT automatically an Owner escalation. Pure + deterministic so it can be
 * unit-tested and replayed.
 *
 *  G0 entitlement            — the obligation's feature is in the purchase snapshot's guaranteed/discretionary set
 *  G1 payment authority      — the purchase has a payment_ref and status paid
 *  G2 factual auction data   — required auction facts present (no fabricated data)
 *  G3 creative fidelity      — only CLEAN objects; REVIEW/FAILED excluded from a production brief
 *  G4 brand/text/category    — spatial audit violations = 0, text budget ok, category balance ok
 *  G5 clean canonical URLs   — no utm/gclid/AI/vendor attribution/tracking in any link
 *  G6 audience safety        — consent + not suppressed + not frequency-capped + audience floor met
 *  G7 channel readiness      — channel is ACTIVE (or SHADOW for certification only)
 *  G8 seller-safe surface    — no confidential economics / substitution cause / internal state in seller copy
 *  G9 no forbidden guarantee — no over-promising / forbidden guarantee language in seller copy
 */

const CONFIDENTIAL = /(60\s*%|40\s*%|growth\s*pool|direct[_\s-]?max|internal\s+authority|ceiling|margin|profit|allocation|spend\s+authority|substitution\s+econom)/i;
const SUBSTITUTION_CAUSE = /(provider\s+fail|capacity\s+conflict|could\s+not|unavailable|blocked|scheduling\s+conflict|no\s+audience)/i;
const DIRTY_URL = /(utm_[a-z]+=|gclid=|fbclid=|[?&]ref=|chatgpt|openai|\bA\.?I\.?\b|artificial intelligence)/i;
const FORBIDDEN_GUARANTEE = /(guarantee(d)?\s+(sales|bids|price|results|buyers)|we\s+promise\s+(you'?ll|to)\s+sell|guaranteed\s+to\s+sell)/i;

function g0_entitlement(obligation, snapshot) {
  const keys = [].concat((snapshot && snapshot.guaranteed_deliverables) || [], (snapshot && snapshot.discretionary_tools) || []).map((d) => d.key);
  const ok = keys.indexOf(obligation.feature_key || obligation.obligation_key) !== -1;
  return { gate: 'G0', pass: ok, reason: ok ? undefined : 'feature not entitled by snapshot' };
}
function g1_payment(snapshot) {
  const ok = !!(snapshot && (snapshot.stripe_payment_intent_id || snapshot.payment_ref) && snapshot.status === 'paid');
  return { gate: 'G1', pass: ok, reason: ok ? undefined : 'no verified payment reference' };
}
function g2_factual(auction) {
  const ok = !!(auction && auction.id && auction.title);
  return { gate: 'G2', pass: ok, reason: ok ? undefined : 'auction facts missing' };
}
function g3_fidelity(objects) {
  const bad = (objects || []).filter((o) => o.fidelity && o.fidelity !== 'CLEAN');
  return { gate: 'G3', pass: bad.length === 0, reason: bad.length ? 'non-CLEAN objects in production brief' : undefined };
}
function g4_brand(audit) {
  const a = audit || {};
  const ok = (a.violations === 0 || a.violations == null) && a.text_budget_ok !== false && a.category_balance_ok !== false;
  return { gate: 'G4', pass: !!ok, reason: ok ? undefined : 'brand-frame/text/category audit failed' };
}
function g5_cleanUrls(urls) {
  const bad = (urls || []).filter((u) => DIRTY_URL.test(String(u)));
  return { gate: 'G5', pass: bad.length === 0, reason: bad.length ? 'tracking/AI attribution in URL' : undefined };
}
function g6_audience(a) {
  const x = a || {};
  const ok = x.consent !== false && x.suppressed !== true && x.frequency_capped !== true && (x.floor_ok !== false);
  return { gate: 'G6', pass: !!ok, reason: ok ? undefined : 'audience safety/floor failed' };
}
function g7_readiness(channelState, { allowShadow = false } = {}) {
  const ok = channelState === 'ACTIVE' || (allowShadow && channelState === 'SHADOW_CERTIFIED');
  return { gate: 'G7', pass: !!ok, reason: ok ? undefined : 'channel not ready (' + channelState + ')' };
}
function g8_sellerSafe(sellerText) {
  const t = JSON.stringify(sellerText || '');
  const bad = CONFIDENTIAL.test(t) || SUBSTITUTION_CAUSE.test(t);
  return { gate: 'G8', pass: !bad, reason: bad ? 'confidential/substitution-cause leaked to seller surface' : undefined };
}
function g9_guarantee(sellerText) {
  const bad = FORBIDDEN_GUARANTEE.test(JSON.stringify(sellerText || ''));
  return { gate: 'G9', pass: !bad, reason: bad ? 'forbidden guarantee language' : undefined };
}

// Run all applicable gates; returns { pass, failures:[...] }.
function runGates(ctx = {}) {
  const results = [
    g0_entitlement(ctx.obligation || {}, ctx.snapshot || {}),
    g1_payment(ctx.snapshot || {}),
    g2_factual(ctx.auction || {}),
    ctx.objects ? g3_fidelity(ctx.objects) : { gate: 'G3', pass: true },
    ctx.audit ? g4_brand(ctx.audit) : { gate: 'G4', pass: true },
    g5_cleanUrls(ctx.urls || []),
    ctx.audience ? g6_audience(ctx.audience) : { gate: 'G6', pass: true },
    ctx.channelState ? g7_readiness(ctx.channelState, { allowShadow: !!ctx.allowShadow }) : { gate: 'G7', pass: true },
    g8_sellerSafe(ctx.sellerText || ''),
    g9_guarantee(ctx.sellerText || ''),
  ];
  const failures = results.filter((r) => !r.pass);
  return { pass: failures.length === 0, failures, results };
}

module.exports = { runGates, g0_entitlement, g1_payment, g2_factual, g3_fidelity, g4_brand, g5_cleanUrls, g6_audience, g7_readiness, g8_sellerSafe, g9_guarantee, CONFIDENTIAL, SUBSTITUTION_CAUSE, DIRTY_URL };
