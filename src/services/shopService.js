'use strict';

/**
 * shopService — the Advantage.Bid fixed-price marketplace: every Professional Seller's items for sale, in one crawlable
 * collection (/shop, server-rendered by shopPageService; data at GET /api/public/shop/items). Owner request 2026-11-04:
 * products must be discoverable and indexable from one marketplace page, not only from each seller's storefront.
 *
 * One rule for what is listed (Marketplace Integrity Standard): marketplaceVisibility.activeMarketplaceItemSql (active,
 * not demo), sold by a Professional Seller that is not a demo account. Each item links to its canonical product page
 * (/shop/item/<id>/<slug>); the seller name links to the seller's published storefront (/pro/<slug>). Public fields only:
 * no address, no sold price, no buyer data. Prices are the listed Sale Price; checkout availability is decided on the
 * product page, as everywhere else.
 */

const db = require('../db');
const { activeMarketplaceItemSql } = require('../lib/marketplaceVisibility');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');
const { CATEGORIES } = require('../constants/lotCategories');
const productData = require('../lib/productData');
const { publicBaseUrl } = require('../lib/publicUrls');
const { brandingVisible } = require('../lib/sellerBranding');

const PER_PAGE = 24;
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
const LISTED = `${activeMarketplaceItemSql('mi')} AND sp.seller_type = ANY($1::text[]) AND COALESCE(sp.is_demo, false) = false`;

// The seller's name and storefront link follow the buyer-facing branding rule (src/lib/sellerBranding.js), as on the
// product page; otherwise the item shows a neutral label.
function sellerOf(r, base) {
  if (!brandingVisible(r.seller_type, r.show_branding_to_buyers)) return { name: 'Professional Seller', storefront_url: null };
  return { name: r.display_name || 'Professional Seller', storefront_url: r.storefront_published && r.storefront_slug ? `${base}/pro/${r.storefront_slug}` : null };
}

/** One page of the marketplace. opts: { page (1-based), category (a lotCategories key; items carry it in category_key) }. */
async function listItems({ page = 1, category = null } = {}, runner = db) {
  const cat = category && CATEGORY_LABEL[category] ? category : null;
  const params = [PROFESSIONAL_SELLER_TYPES];
  let where = LISTED;
  if (cat) { params.push(cat); where += ` AND mi.category_key = $${params.length}`; }
  const total = Number((await runner.query(
    `SELECT count(*)::int AS n FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id WHERE ${where}`, params)).rows[0].n);
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const p = Math.min(Math.max(parseInt(page, 10) || 1, 1), totalPages);
  const rows = (await runner.query(
    `SELECT mi.id, mi.title, mi.price_cents, mi.thumbnail_url, mi.images, mi.image_alt, mi.city, mi.state, mi.category_key,
            mi.condition, mi.created_at, sp.storefront_slug, sp.storefront_published, sp.seller_type, sp.show_branding_to_buyers,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS display_name
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE ${where}
      ORDER BY mi.created_at DESC, mi.id
      LIMIT ${PER_PAGE} OFFSET ${(p - 1) * PER_PAGE}`, params)).rows;
  const base = publicBaseUrl().replace(/\/+$/, '');
  const items = rows.map((r) => {
    const imgs = productData.imagesOf(r);
    return {
      id: r.id, title: r.title, price_cents: r.price_cents == null ? null : Number(r.price_cents),
      image: imgs[0] || null, image_alt: productData.altTexts(r)[0] || r.title,
      city: r.city || null, state: r.state || null,
      category: r.category_key && CATEGORY_LABEL[r.category_key] ? { key: r.category_key, label: CATEGORY_LABEL[r.category_key] } : null,
      condition: r.condition || null,
      url: productData.canonicalUrl(base, r),
      seller: sellerOf(r, base),
    };
  });
  return { items, category: cat ? { key: cat, label: CATEGORY_LABEL[cat] } : null,
    pagination: { page: p, per_page: PER_PAGE, total, total_pages: totalPages, has_previous: p > 1, has_next: p < totalPages } };
}

/** The categories that currently have items, with counts (for the filter links). */
async function categoryCounts(runner = db) {
  const rows = (await runner.query(
    `SELECT mi.category_key AS key, count(*)::int AS n FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE ${LISTED} AND mi.category_key IS NOT NULL GROUP BY 1`, [PROFESSIONAL_SELLER_TYPES])).rows;
  return rows.filter((r) => CATEGORY_LABEL[r.key]).map((r) => ({ key: r.key, label: CATEGORY_LABEL[r.key], count: r.n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

module.exports = { listItems, categoryCounts, PER_PAGE, CATEGORY_LABEL };
