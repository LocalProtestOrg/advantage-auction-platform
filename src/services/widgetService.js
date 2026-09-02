'use strict';

/**
 * widgetService — the Professional Seller WHITE-LABEL auction widget: a company embeds an opaque,
 * server-issued key on its own website; the server resolves that key to exactly one organization and
 * returns ONLY that company's PUBLIC, eligible auctions. Tenant isolation is authoritative and
 * server-side:
 *   • the seller-facing CONFIG (get/rotate the key) is derived from req.user's OWNED org — never from a
 *     client-supplied id, so Seller A can never fetch/manage Seller B's widget;
 *   • the PUBLIC feed is keyed by the opaque token → one org → that org's linked seller_profile → that
 *     seller's public auctions only. The key carries no privileges and exposes only already-public data,
 *     so it is safe to publish in embed code on any website.
 *
 * Reuses the canonical public-auction visibility predicate (marketplaceVisibility.activeNativeAuctionSql)
 * so the widget can never leak an unpublished/private/demo/non-syndicated auction. No private seller PII.
 */

const crypto = require('crypto');
const db = require('../db');
const { activeNativeAuctionSql } = require('../lib/marketplaceVisibility');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');

const KEY_PREFIX = 'wgt_';
const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

function generateKey() { return KEY_PREFIX + crypto.randomBytes(18).toString('hex'); }
function isValidKeyShape(k) { return typeof k === 'string' && /^wgt_[a-f0-9]{36}$/.test(k); }

// Resolve an opaque public widget key → its organization (the ONLY tenant mapping; no client id trusted).
async function resolveKeyToOrg(key, runner = db) {
  if (!isValidKeyShape(key)) return null;
  const { rows } = await runner.query(
    `SELECT id, name, linked_seller_profile_id FROM organizations WHERE profile_data->>'widget_key' = $1 LIMIT 1`, [key]);
  return rows[0] || null;
}

// The user's OWN org, gated to an eligible Professional Seller (org linked to a professional seller_profile
// that the user owns). Returns { eligible, reason, org, sellerProfileId }.
async function eligibilityForUser(userId, runner = db) {
  const org = (await runner.query(
    `SELECT o.id, o.name, o.slug, o.linked_seller_profile_id, o.profile_data
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE m.user_id = $1 AND m.role = 'owner' AND m.status = 'active'
      ORDER BY o.created_at ASC LIMIT 1`, [userId])).rows[0];
  if (!org) return { eligible: false, reason: 'no_org', org: null, sellerProfileId: null };
  if (!org.linked_seller_profile_id) return { eligible: false, reason: 'not_linked_seller', org, sellerProfileId: null };
  const sp = (await runner.query('SELECT id, seller_type, user_id FROM seller_profiles WHERE id = $1', [org.linked_seller_profile_id])).rows[0];
  if (!sp || sp.user_id !== userId) return { eligible: false, reason: 'not_owned_seller', org, sellerProfileId: null };
  if (!PROFESSIONAL_SELLER_TYPES.includes(sp.seller_type)) return { eligible: false, reason: 'not_professional', org, sellerProfileId: sp.id };
  return { eligible: true, reason: 'ok', org, sellerProfileId: sp.id };
}

// Idempotently ensure the org has a widget key (server-side write into profile_data; merge-safe so a later
// profile save never wipes it). Returns the key.
async function ensureWidgetKey(orgId, runner = db) {
  const cur = (await runner.query('SELECT profile_data FROM organizations WHERE id = $1', [orgId])).rows[0];
  const pd = (cur && cur.profile_data && typeof cur.profile_data === 'object') ? cur.profile_data : {};
  if (pd.widget_key && isValidKeyShape(pd.widget_key)) return pd.widget_key;
  const key = generateKey();
  pd.widget_key = key;
  await runner.query('UPDATE organizations SET profile_data = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(pd), orgId]);
  return key;
}

async function rotateWidgetKey(orgId, runner = db) {
  const cur = (await runner.query('SELECT profile_data FROM organizations WHERE id = $1', [orgId])).rows[0];
  const pd = (cur && cur.profile_data && typeof cur.profile_data === 'object') ? cur.profile_data : {};
  pd.widget_key = generateKey();
  await runner.query('UPDATE organizations SET profile_data = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(pd), orgId]);
  return pd.widget_key;
}

// A company's PUBLIC eligible auctions for the widget — same visibility gate as every public surface.
// Never returns private/unpublished/demo/non-syndicated auctions; only public-safe fields + a canonical
// bid.advantage.bid link (bidding/auth/checkout happen there, on the identified platform).
async function listPublicAuctions(sellerProfileId, runner = db) {
  if (!sellerProfileId) return { current: [], upcoming: [] };
  const { rows } = await runner.query(
    `SELECT a.id, a.title, a.state, a.start_time, a.end_time, a.cover_image_url, a.city, a.address_state,
            (SELECT COUNT(*)::int FROM lots l WHERE l.auction_id = a.id AND l.state <> 'withdrawn') AS lot_count
       FROM auctions a
      WHERE a.seller_id = $1 AND ${activeNativeAuctionSql('a')}
      ORDER BY a.end_time ASC NULLS LAST LIMIT 60`, [sellerProfileId]);
  const shape = (a) => ({
    id: a.id, title: a.title, state: a.state, lots: a.lot_count || 0,
    start_time: a.start_time, end_time: a.end_time,
    cover_image_url: a.cover_image_url || null,
    city: a.city || null, state: a.address_state || null,   // general area only (public); never full address
    href: APP_BASE + '/auction-view.html?auctionId=' + encodeURIComponent(a.id),
  });
  return {
    current: rows.filter((a) => a.state === 'active').map(shape),
    upcoming: rows.filter((a) => a.state === 'published').map(shape),
  };
}

// Pure — the single embed snippet a seller copies. The key is a public opaque token (no secret). The
// loader creates the iframe; auto-resize is handled with a validated postMessage handshake.
function buildEmbedCode(key, base = APP_BASE) {
  return '<div data-advantage-auctions data-key="' + key + '"></div>\n'
    + '<script src="' + base + '/widgets/company-auctions.js" async></script>';
}

module.exports = {
  KEY_PREFIX, APP_BASE, generateKey, isValidKeyShape,
  resolveKeyToOrg, eligibilityForUser, ensureWidgetKey, rotateWidgetKey, listPublicAuctions, buildEmbedCode,
};
