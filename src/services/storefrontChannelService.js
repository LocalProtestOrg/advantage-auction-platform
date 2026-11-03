'use strict';

/**
 * storefrontChannelService — which sales channel a Professional Storefront order came through, and so its commission
 * (owner decision 2026-11-03, replaces the flat 11%):
 *
 *   seller_website  5% of the item price: the shopper began on the seller's own website, in the embedded storefront
 *   marketplace     9% of the item price: everything else (Advantage.Bid pages, search engines, shared or typed links)
 *
 * Both include card processing; no other fee applies. The rate is fixed on the order when it is created
 * (platform_fee_bps, database-protected) and every later step (receipt, payout, refund, reports) reads the order.
 *
 * HOW the website channel is proven (never by a URL parameter, cookie or anything the browser sends on its own):
 *   1. The embedded storefront page (/embed/storefront.html) is requested by the browser as a FRAME on another site.
 *      The browser itself says so with Fetch Metadata headers that page scripts cannot set:
 *      Sec-Fetch-Dest: iframe and Sec-Fetch-Site: cross-site (Advantage.Bid's own pages are same-site, so a widget
 *      shown on advantage.bid or www.advantage.bid never qualifies). A Referer naming an Advantage.Bid host is refused too.
 *   2. Only then the server signs a WEBSITE PASS for that seller (HMAC; seller, embedding site, issue and expiry times,
 *      a random id) and places it in the page. Nothing is stored for a page view.
 *   3. Buy Now hands the pass to the item page in the link's #fragment (never sent to a server, never in a Referer);
 *      the item page keeps it for that seller (24 hours) and sends it with the order.
 *   4. createOrder verifies it on the server: valid signature, not expired, the SAME seller as the item. Inside the order
 *      transaction the pass is bound to the first buyer who uses it (storefront_channel_passes); another buyer using a
 *      copied pass gets the marketplace rate. Anything missing, invalid, expired, for another seller or another buyer
 *      gives the marketplace rate (the order still goes through: the buyer's price never depends on the channel).
 *
 * Consistent treatment (documented in docs/operations/storefront-commerce-runbook.md):
 *   - direct product link, search result, shared link without a pass, Advantage.Bid pages  -> marketplace
 *   - Buy Now from the embedded storefront on the seller's website                           -> seller_website
 *   - returning shopper: the same browser within 24 hours of the website visit                 -> seller_website,
 *     later (or another browser) without a new website visit                                  -> marketplace
 *   - checkout recovery ("Try again", a new card): the same order, so the same channel; a new order in the same browser
 *     within 24 hours keeps the pass                                                            -> unchanged
 *   - a pass copied to another buyer                                                            -> marketplace
 */
const crypto = require('crypto');

const CHANNELS = { WEBSITE: 'seller_website', MARKETPLACE: 'marketplace' };
const FEE_BPS = { seller_website: 500, marketplace: 900 };   // 5% and 9% of the item price, card processing included
const FEE_SCHEDULE = 'storefront-2026-11';                    // recorded on each order with the rate
const PASS_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret() {
  const base = process.env.JWT_SECRET || '';
  if (!base) return null;
  return crypto.createHmac('sha256', base).update('advantage.bid storefront website pass v1').digest();
}
const b64 = (buf) => Buffer.from(buf).toString('base64url');
function sign(payloadB64, key) { return b64(crypto.createHmac('sha256', key).update('v1.' + payloadB64).digest()); }

// Advantage.Bid's own hosts (a widget shown on them is the marketplace).
function isAdvantageHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h) return false;
  if (h === 'advantage.bid' || h.endsWith('.advantage.bid')) return true;
  if (h.endsWith('.up.railway.app')) return true;
  for (const v of [process.env.APP_BASE_URL, process.env.PUBLIC_BASE_URL]) {
    try { if (v && new URL(v).hostname.toLowerCase() === h) return true; } catch (e) { /* not a URL */ }
  }
  return false;
}
function hostOf(url) { try { return new URL(String(url)).hostname.toLowerCase(); } catch (e) { return ''; } }

// Is this request the browser loading the embedded storefront inside a frame on someone else's website?
function framedByOutsideSite(req) {
  const h = (n) => String((req.get && req.get(n)) || (req.headers && req.headers[n.toLowerCase()]) || '').toLowerCase();
  if (h('Sec-Fetch-Dest') !== 'iframe') return false;
  if (h('Sec-Fetch-Site') !== 'cross-site') return false;
  const ref = h('Referer');
  if (ref && isAdvantageHost(hostOf(ref))) return false;
  return true;
}

// Sign a pass for this seller. Returns null when the server has no signing key (never a pass anyone could forge).
function issuePass(sellerId, embeddingSite, now = Date.now()) {
  const key = secret();
  if (!key || !UUID_RE.test(String(sellerId || ''))) return null;
  const payload = { s: String(sellerId).toLowerCase(), o: String(embeddingSite || '').slice(0, 200), iat: now, exp: now + PASS_TTL_MS,
    n: crypto.randomBytes(16).toString('hex') };
  const p = b64(JSON.stringify(payload));
  return 'v1.' + p + '.' + sign(p, key);
}
function passForRequest(req, sellerId) {
  if (!framedByOutsideSite(req)) return null;
  return issuePass(sellerId, hostOf(req.get ? req.get('Referer') : ''));
}

// Verify a pass's signature and expiry. Returns { ok, reason, payload }.
function verifyPass(token, now = Date.now()) {
  const key = secret();
  if (!token) return { ok: false, reason: 'no_pass' };
  if (!key) return { ok: false, reason: 'no_signing_key' };
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || parts[1].length > 1000) return { ok: false, reason: 'pass_invalid' };
  const want = Buffer.from(sign(parts[1], key)); const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'pass_invalid' };
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return { ok: false, reason: 'pass_invalid' }; }
  if (!payload || !UUID_RE.test(String(payload.s || '')) || !/^[0-9a-f]{32}$/.test(String(payload.n || ''))) return { ok: false, reason: 'pass_invalid' };
  if (!(Number(payload.exp) > now)) return { ok: false, reason: 'pass_expired', payload };
  return { ok: true, payload };
}

const marketplace = (basis, extra = {}) => ({ channel: CHANNELS.MARKETPLACE, fee_bps: FEE_BPS.marketplace, basis, pass_id: null, embedding_site: null, ...extra });

// The channel for an order being created, INSIDE the order transaction (client). The browser may hold passes for several
// sellers; only a valid one signed for THIS seller counts. Binds that pass to the first buyer who orders with it.
async function resolveForOrder({ passes, sellerId, buyerUserId }, client) {
  const list = (Array.isArray(passes) ? passes : [passes]).filter(Boolean).slice(0, 10);
  if (!list.length) return marketplace('no_pass');
  const checked = list.map((p) => verifyPass(p));
  const v = checked.find((c) => c.ok && String(c.payload.s) === String(sellerId).toLowerCase());
  if (!v) {
    const reasons = checked.map((c) => (c.ok ? 'pass_other_seller' : c.reason));
    return marketplace(reasons.includes('pass_invalid') ? 'pass_invalid' : reasons.includes('pass_expired') ? 'pass_expired' : reasons[0]);
  }
  await client.query(
    `INSERT INTO storefront_channel_passes (pass_id, seller_profile_id, buyer_user_id, embedding_site, issued_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0)) ON CONFLICT (pass_id) DO NOTHING`,
    [v.payload.n, sellerId, buyerUserId, v.payload.o || null, Number(v.payload.iat)]);
  const row = (await client.query('SELECT seller_profile_id, buyer_user_id FROM storefront_channel_passes WHERE pass_id = $1', [v.payload.n])).rows[0];
  if (!row || String(row.seller_profile_id) !== String(sellerId)) return marketplace('pass_other_seller');
  if (String(row.buyer_user_id) !== String(buyerUserId)) return marketplace('pass_other_buyer');
  return { channel: CHANNELS.WEBSITE, fee_bps: FEE_BPS.seller_website, basis: 'website_pass', pass_id: v.payload.n, embedding_site: v.payload.o || null };
}

const pct = (bps) => (bps / 100) + '%';
// One sentence for every place that states the commission (customer service, sales scripts): rates from FEE_BPS.
function commissionSummary() {
  return `Professional Storefront fixed-price sales have a commission on the item selling price only: ${pct(FEE_BPS.seller_website)} when the sale comes through the seller's own website using the Advantage.Bid embedded storefront, and ${pct(FEE_BPS.marketplace)} when it comes through the Advantage.Bid marketplace. Both include card processing; shipping and sales tax are not part of the calculation. There is no monthly subscription and no listing fee.`;
}
const LABELS = { seller_website: 'Your website', marketplace: 'Advantage.Bid marketplace' };
function channelLabel(channel) { return LABELS[channel] || 'Storefront'; }

module.exports = { CHANNELS, FEE_BPS, FEE_SCHEDULE, PASS_TTL_MS, isAdvantageHost, framedByOutsideSite, issuePass, passForRequest,
  verifyPass, resolveForOrder, channelLabel, commissionSummary };
