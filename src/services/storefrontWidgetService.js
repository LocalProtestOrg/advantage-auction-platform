'use strict';

/**
 * storefrontWidgetService — "My Website Widget": every Professional Seller's storefront inventory, embeddable on the
 * seller's own website (roadmap §7.5, basic release). ONE widget system for every seller; nothing is created by staff.
 *
 * - Identity: the seller's stable seller_profiles UUID (never the slug, which the seller can change; never a name).
 *   The public endpoint maps that id to exactly one seller server-side; nothing from the browser selects another.
 * - Eligibility: the SAME rule as the public storefront page (storefrontService.isPublicStorefront: published +
 *   Professional). An unpublished or non-Professional seller's widget shows nothing.
 * - Inventory: the SAME data path as the storefront page (marketplaceItemService.listPublicForSeller: active items
 *   only), so the widget, the storefront page and the marketplace always agree, and a sold, pending, draft, removed or
 *   taken-down item never appears (so a sold item's price can never be shown). No session is read: the widget is the
 *   same for everyone (never a member-only realized price).
 * - Output is an ALLOW-LIST: no seller ids beyond the one requested, no addresses, no order or buyer data.
 * - Every item links to its canonical Advantage.Bid product page; checkout only ever happens there.
 */

const db = require('../db');
const storefront = require('./storefrontService');
const items = require('./marketplaceItemService');
const productData = require('../lib/productData');
const { publicBaseUrl } = require('../lib/publicUrls');
const { isProfessional } = require('./sellerTypeRules');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 100;   // the storefront page shows the same 100

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = () => storefront.APP_BASE;   // the storefront host (same host as the /pro/:slug canonical tag)

function storefrontUrl(sp) { return sp && sp.storefront_slug ? `${base()}/pro/${sp.storefront_slug}` : null; }
function embedUrl(sellerId) { return `${base()}/embed/storefront.html?seller=${encodeURIComponent(sellerId)}`; }

// The snippet a seller pastes into a "custom HTML" / "embed code" block. A plain iframe (no script), so it survives
// site builders that strip scripts, plus an ordinary link to the canonical storefront (attribution, and a crawlable
// link for sites where the frame cannot load).
function embedCode(sp) {
  const name = storefront.sellerName(sp);
  const link = storefrontUrl(sp);
  return `<iframe src="${esc(embedUrl(sp.id))}" title="${esc(name)} shop on Advantage.Bid" width="100%" height="900" `
    + `style="border:0;width:100%;max-width:100%" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>\n`
    + `<p style="font:14px/1.4 sans-serif;margin:8px 0"><a href="${esc(link)}">Shop ${esc(name)} on Advantage.Bid</a></p>`;
}

async function sellerById(sellerId, runner = db) {
  if (!UUID_RE.test(String(sellerId || ''))) return null;
  return (await runner.query('SELECT * FROM seller_profiles WHERE id = $1', [sellerId])).rows[0] || null;
}

// The seller's listed items: none when the seller hid the Shop section of their storefront (the storefront page and its
// crawlable item list honour the same setting); demo-flagged items only on a demo seller's own widget.
function shopHidden(sp) { const v = sp && sp.storefront && sp.storefront.section_visibility; return !!(v && v.marketplace === false); }
async function widgetItems(sp, runner = db) {
  if (shopHidden(sp)) return [];
  return items.listPublicForSeller(sp.id, MAX_ITEMS, runner, { excludeDemoItems: !sp.is_demo });
}

// Public widget data for one seller, or null (unknown id, unpublished, not Professional).
async function publicFeed(sellerId, runner = db) {
  const sp = await sellerById(sellerId, runner);
  if (!storefront.isPublicStorefront(sp)) return null;
  const rows = await widgetItems(sp, runner);
  const pub = publicBaseUrl();
  return {
    seller: { name: storefront.sellerName(sp), storefront_url: storefrontUrl(sp) },
    items: rows.map((r) => {
      const imgs = productData.imagesOf(r);
      return {
        id: r.id, title: r.title,
        price_cents: r.status === 'active' ? r.price_cents : null,   // only active items are listed; belt and braces
        image: imgs[0] || null, image_alt: productData.altTexts(r)[0] || r.title,
        city: r.city || null, state: r.state || null, shippable: !!r.shippable,
        url: productData.canonicalUrl(pub, r),
      };
    }),
    count: rows.length,
    attribution: { label: 'Shop securely on Advantage.Bid', url: storefrontUrl(sp) },
  };
}

// The seller's own "My Website Widget" panel (ctx from requireSellerPermission; the company comes from the session).
async function forOwner(ctx, runner = db) {
  const sp = await sellerById(ctx && ctx.sellerId, runner);
  if (!sp) { const e = new Error('No seller profile.'); e.status = 403; e.code = 'NOT_A_SELLER'; throw e; }
  const eligible = isProfessional(sp.seller_type);
  const active = storefront.isPublicStorefront(sp);
  return {
    eligible, active, published: !!sp.storefront_published, is_demo: !!sp.is_demo, shop_hidden: shopHidden(sp),
    seller_id: sp.id, name: storefront.sellerName(sp),
    storefront_url: storefrontUrl(sp), embed_url: embedUrl(sp.id),
    embed_code: eligible && sp.storefront_slug ? embedCode(sp) : null,
    item_count: active ? (await widgetItems(sp, runner)).length : 0,
  };
}

module.exports = { publicFeed, forOwner, embedCode, embedUrl, storefrontUrl, MAX_ITEMS };
