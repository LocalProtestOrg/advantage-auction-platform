'use strict';

/**
 * storefrontReadinessService — what still stands between a Professional Seller's inventory and being publicly
 * purchasable, in plain words, for the seller's own dashboard. READ-ONLY: it reports the existing gates and never
 * changes, bypasses or duplicates them:
 *   - the seller agreement            agreementService.dashboardAccess (signed / waived / grandfathered)
 *   - business verification           verificationService.publicationGate (the one publication gate)
 *   - the storefront pickup location  seller_profiles.default_pickup_confirmed_at
 *   - the public storefront           seller_profiles.storefront_published + slug (the website widget shows it)
 *   - payouts                         settlementEngine.connectPayoutReady (the seller's payout account)
 *   - online checkout                 Advantage.Bid's own switch (launchGuards); off until Advantage.Bid opens it
 * plus, per item: missing Sale Price, nothing in stock, no photo, category still being assigned.
 *
 * Wording is neutral: it names no payment provider and exposes no internal setting names.
 */

const db = require('../db');
const items = require('./marketplaceItemService');

function step(key, label, done, detail, action) { return { key, label, done: !!done, detail: detail || null, action: action || null }; }

async function forSeller(actor) {
  const seller = await items.sellerForUser(actor);
  if (!seller) return null;
  const sp = (await db.query(
    `SELECT id, user_id, seller_type, storefront_slug, storefront_published, default_pickup_confirmed_at FROM seller_profiles WHERE id = $1`, [seller.id])).rows[0];
  const agreement = await require('./agreementService').dashboardAccess(sp.id).catch(() => ({ access: false, reason: 'unknown' }));
  const gate = await require('./verificationService').publicationGate(sp.id).catch(() => ({ blocked: true, reason: 'unknown' }));
  const pref = (await db.query('SELECT stripe_account_id, connect_transfers_active, connect_payouts_enabled FROM seller_payout_preferences WHERE seller_user_id = $1', [sp.user_id])).rows[0] || null;
  const payoutsReady = require('./settlementEngine').connectPayoutReady ? require('./settlementEngine').connectPayoutReady(pref)
    : !!(pref && pref.stripe_account_id && pref.connect_transfers_active && pref.connect_payouts_enabled);
  let checkoutOpen = false;
  try { checkoutOpen = !!require('../lib/launchGuards').marketplaceCheckoutEnabled(); } catch (_) { checkoutOpen = false; }

  const counts = (await db.query(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS published,
            count(*) FILTER (WHERE status = 'draft')::int AS drafts,
            count(*) FILTER (WHERE status IN ('draft','active','paused') AND (price_cents IS NULL OR price_cents <= 0))::int AS missing_price,
            count(*) FILTER (WHERE status IN ('draft','active','paused') AND quantity = 0)::int AS out_of_stock,
            count(*) FILTER (WHERE status IN ('draft','active','paused') AND quantity > 1)::int AS multi_quantity,
            count(*) FILTER (WHERE status IN ('draft','active','paused') AND jsonb_array_length(COALESCE(images, '[]'::jsonb)) = 0)::int AS no_photo,
            count(*) FILTER (WHERE status IN ('draft','active','paused') AND category_status = 'pending')::int AS category_pending
       FROM marketplace_items WHERE seller_id = $1`, [sp.id])).rows[0];

  const company = [
    step('agreement', 'Seller agreement signed', agreement.access,
      agreement.access ? null : 'Review and sign your seller agreement.', agreement.access ? null : { label: 'Review and sign', href: '/sign-agreement.html?onboarding=1' }),
    step('verification', 'Business verified by Advantage.Bid', !gate.blocked,
      gate.blocked ? 'Advantage.Bid verifies your business before your first sale goes live. You can keep preparing your inventory.' : null,
      gate.blocked ? { label: 'Business verification', href: '/verify-documents.html' } : null),
    step('pickup_location', 'Storefront pickup location confirmed', !!sp.default_pickup_confirmed_at,
      sp.default_pickup_confirmed_at ? null : 'Confirm where buyers collect items. Every item uses it unless you choose another location.',
      sp.default_pickup_confirmed_at ? null : { label: 'Confirm location', href: '/seller-storefront.html?tab=market' }),
    step('storefront', 'Storefront page published', !!(sp.storefront_published && sp.storefront_slug),
      sp.storefront_published && sp.storefront_slug ? null : 'Publish your storefront page so your website widget and storefront link show your items.',
      sp.storefront_published && sp.storefront_slug ? null : { label: 'Storefront settings', href: '/seller-storefront.html?tab=store' }),
    step('payouts', 'Payout account ready', payoutsReady,
      payoutsReady ? null : 'Set up the account that receives your sale proceeds.', payoutsReady ? null : { label: 'Set up payouts', href: '/payout-profile.html' }),
    step('checkout', 'Online checkout open on Advantage.Bid', checkoutOpen,
      checkoutOpen ? null : 'Advantage.Bid has not opened online checkout for storefront items yet. Until then, your published items are visible and buyers can contact you.', null),
  ];
  const itemNotes = [];
  if (counts.missing_price) itemNotes.push({ key: 'missing_price', count: counts.missing_price, message: `${counts.missing_price} item(s) need a Sale Price before they can be published.` });
  if (counts.out_of_stock) itemNotes.push({ key: 'out_of_stock', count: counts.out_of_stock, message: `${counts.out_of_stock} item(s) have a quantity of 0.` });
  if (counts.multi_quantity) itemNotes.push({ key: 'multi_quantity', count: counts.multi_quantity, message: `${counts.multi_quantity} item(s) have more than one in stock. Buying more than one at a time online is not available yet; buyers can contact you.` });
  if (counts.no_photo) itemNotes.push({ key: 'no_photo', count: counts.no_photo, message: `${counts.no_photo} item(s) have no photo. Photos are strongly recommended.` });
  if (counts.category_pending) itemNotes.push({ key: 'category_pending', count: counts.category_pending, message: `${counts.category_pending} item(s) are still being categorized. You can choose a category yourself at any time.` });
  return {
    purchasable: company.every((s) => s.done),
    visible_now: counts.published,
    company,
    items: itemNotes,
    counts,
  };
}

module.exports = { forSeller };
