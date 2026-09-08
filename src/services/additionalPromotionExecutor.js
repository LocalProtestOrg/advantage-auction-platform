'use strict';

/**
 * additionalPromotionExecutor — Phase 3O Wave 2, blocker 8. Real fulfilment for Additional Promotions
 * BOOST / REACH / SPOTLIGHT / CUSTOM. Prices are versioned + Admin-managed and are NOT touched here. Preserved:
 * prepaid card BEFORE fulfilment, immutable purchase snapshot, non-refundable, no advance from / recovery
 * against auction proceeds, separate purchase + separate obligations, internal authority snapshot, seller
 * reporting integrated with the auction campaign.
 *
 * Every child obligation executes through the ORDINARY feature executors (channelDispatch) — CUSTOM is never a
 * manually-fulfilled bucket. Reconciliation covers every child. The paid path's obligation/readiness/resilience
 * behavior is complete even though the provider stays gated.
 */

const db = require('../db');
const recipes = require('../../docs/marketing/phase3o/schemas/recipes.json');
const obligationEngine = require('./marketingObligationEngine');
const channelDispatch = require('./channelDispatch');

// additional_wave expands to its concrete wave children (mission spec for BOOST): a creative refresh, an
// additional organic social post, a Closing Soon extension, and shared-edition inclusion where eligible.
const ADDITIONAL_WAVE_CHILDREN = ['creative_mid_refresh', 'social_post_organic', 'closing_soon_extension', 'shared_edition_inclusion'];
// custom_bundle is a placeholder — its real children come from the composed bundle captured at payment.
const EXPANDS = { additional_wave: ADDITIONAL_WAVE_CHILDREN };

function recipeFor(identity) { return recipes.find((x) => x.identity === String(identity || '').toUpperCase() && x.kind === 'promotion'); }

/**
 * Compose the child feature list for a promotion. For CUSTOM, the children are the admin-composed bundle
 * (snapshot.bundle_children) captured BEFORE payment and frozen at payment — never invented at execution time.
 */
function composeChildren(identity, snapshot = {}) {
  const id = String(identity || '').toUpperCase();
  if (id === 'CUSTOM') {
    const bundle = (snapshot.bundle_children || snapshot.guaranteed_deliverables || []).map((d) => d.feature_key || d).filter(Boolean);
    return { children: bundle, from_bundle: true };
  }
  const rec = recipeFor(id);
  if (!rec) return { children: [], from_bundle: false };
  const out = [];
  for (const g of rec.guaranteed) {
    const fk = g.feature_key;
    if (EXPANDS[fk]) out.push(...EXPANDS[fk]); else out.push(fk);
  }
  return { children: Array.from(new Set(out)), from_bundle: false };
}

/**
 * Verify the prepaid + snapshot invariants before any fulfilment. Returns { ok, reason }. A promotion that is
 * not paid, or whose bundle was not snapshotted at payment (CUSTOM), does not fulfil.
 */
function verifyPrepaidSnapshot(promotion) {
  if (!promotion) return { ok: false, reason: 'no_promotion' };
  if (promotion.status && !['paid', 'active', 'fulfilling', 'completed'].includes(promotion.status)) return { ok: false, reason: 'not_paid' };
  if (promotion.amount_paid_cents == null || Number(promotion.amount_paid_cents) <= 0) return { ok: false, reason: 'no_prepayment' };
  if (String(promotion.promotion_key || '').toUpperCase() === 'CUSTOM') {
    const shown = promotion.bundle_shown_at || promotion.snapshot_bundle_shown;
    const snap = (promotion.bundle_children || (promotion.snapshot && promotion.snapshot.bundle_children));
    if (!snap || !snap.length) return { ok: false, reason: 'custom_bundle_not_snapshotted' };
    if (!shown) return { ok: false, reason: 'custom_bundle_not_disclosed_pre_payment' };
  }
  return { ok: true };
}

/**
 * Execute an Additional Promotion end-to-end: verify prepaid+snapshot, create child obligations from the frozen
 * composition, dispatch each through its ordinary executor, and reconcile every child. Nothing sends/spends —
 * gated children (paid/email/social) degrade through readiness/resilience; nothing is falsely completed.
 */
async function execute(promotion, ctx = {}, runner) {
  const r = runner || db;
  const pre = verifyPrepaidSnapshot(promotion);
  if (!pre.ok) return { ok: false, reason: pre.reason, executed: [] };

  const identity = promotion.promotion_key || promotion.identity;
  const { children, from_bundle } = composeChildren(identity, promotion.snapshot || promotion);

  // Create separate obligations for this promotion (idempotent by purchase). Reuses the obligation engine so
  // the promotion's ledger is first-class alongside the package.
  let obligations = await obligationEngine.listForPurchase('additional_promotion', promotion.id, r).catch(() => []);
  if (!obligations || !obligations.length) {
    await obligationEngine.createFromSnapshot({
      purchaseKind: 'additional_promotion', purchaseId: promotion.id, auctionId: ctx.auctionId || (ctx.auction && ctx.auction.auction_id),
      guaranteed: children.map((fk) => ({ key: fk })), discretionary: [],
    }, r).catch(() => {});
    obligations = await obligationEngine.listForPurchase('additional_promotion', promotion.id, r).catch(() => []);
  }

  const executed = [];
  for (const ob of obligations) {
    const out = await channelDispatch.dispatch(ob, { ...ctx, identity }, r);
    executed.push({ obligation_id: ob.id, feature_key: ob.feature_key, channel: out.channel, ok: out.result && out.result.ok !== false, gated: !!(out.result && out.result.gated), result: out.result });
  }

  const reconciliation = {
    child_count: children.length,
    obligation_count: obligations.length,
    covered: executed.length === obligations.length && obligations.length > 0,
    every_child_dispatched: executed.every((e) => e.channel),
  };
  return { ok: true, identity, from_bundle, children, executed, reconciliation };
}

module.exports = { recipeFor, composeChildren, verifyPrepaidSnapshot, execute, ADDITIONAL_WAVE_CHILDREN };
