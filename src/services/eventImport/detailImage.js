'use strict';

/**
 * detailImage — PURE extraction of representative event image candidates from an original event
 * detail page's HTML. No network here (caller fetches the HTML); no auth is ever defeated.
 *
 * Discovery order (section 5): JSON-LD `image` → og:image → twitter:image → hero/primary <img> →
 * first legitimate content <img>. Rejects logos, icons, sprites, favicons, avatars, ad/tracking
 * pixels, and tiny/known-non-content images so a card never shows a logo when a real photo exists.
 *
 * Returns an ordered, de-duplicated list of absolute candidate URLs (best first). The caller
 * validates (HTTP 200 + image/* + size + not login-gated) and re-hosts the first that passes.
 */

// URL substrings that indicate a non-representative image (logo/icon/chrome/ad/tracking).
const REJECT_URL = /(logo|sprite|favicon|icon(?!ic)|avatar|placeholder|banner-ad|\/ads?\/|doubleclick|googlesyndication|pixel|1x1|spacer|tracking|beacon|\.svg(\?|$))/i;
// Obvious non-photo asset extensions we never want as a cover.
const REJECT_EXT = /\.(gif)(\?|$)/i;

function absolutize(u, baseUrl) {
  if (!u || typeof u !== 'string') return null;
  u = u.trim();
  if (!u) return null;
  try { return new URL(u, baseUrl || undefined).href; } catch (_) { return /^https?:\/\//i.test(u) ? u : null; }
}

function acceptable(u) {
  if (!u || !/^https?:\/\//i.test(u)) return false;
  if (REJECT_URL.test(u)) return false;
  if (REJECT_EXT.test(u)) return false;
  return true;
}

// Pull image URLs out of a JSON-LD `image` value (string | {url} | array of either), any nesting.
function fromJsonLdImage(val, out) {
  if (!val) return;
  if (typeof val === 'string') { out.push(val); return; }
  if (Array.isArray(val)) { val.forEach((v) => fromJsonLdImage(v, out)); return; }
  if (typeof val === 'object') {
    if (val.url) out.push(val.url);
    else if (val.contentUrl) out.push(val.contentUrl);
  }
}

// Walk any JSON-LD node graph collecting Event/Product image values.
function walkJsonLd(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walkJsonLd(n, out)); return; }
  if (node.image) fromJsonLdImage(node.image, out);
  for (const k of ['@graph', 'itemListElement', 'item', 'mainEntity', 'subjectOf']) {
    if (node[k]) walkJsonLd(node[k], out);
  }
}

/**
 * extractImageCandidates(html, baseUrl) → ordered absolute candidate URLs (best first, de-duped).
 */
function extractImageCandidates(html, baseUrl) {
  const raw = [];
  if (!html || typeof html !== 'string') return [];

  // 1. JSON-LD image (highest confidence — publisher-declared representative image).
  const ld = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ld) {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try { const parsed = JSON.parse(json); const imgs = []; walkJsonLd(parsed, imgs); imgs.forEach((u) => raw.push(u)); }
    catch (_) { /* malformed JSON-LD block — ignore */ }
  }

  // 2. og:image / twitter:image (either attribute order).
  const metaRe = /<meta[^>]+(?:property|name)=["'](og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
  let m; while ((m = metaRe.exec(html))) raw.push(m[2]);
  const metaRe2 = /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi;
  while ((m = metaRe2.exec(html))) raw.push(m[1]);

  // 3/4/5. Content <img> in priority: those hinted as hero/primary/gallery first, then any <img>.
  const imgs = [];
  const imgRe = /<img\b[^>]*>/gi; let tag;
  while ((tag = imgRe.exec(html))) {
    const src = (tag[0].match(/\bsrc=["']([^"']+)["']/i) || [])[1]
      || (tag[0].match(/\bdata-src=["']([^"']+)["']/i) || [])[1];
    if (!src) continue;
    const hint = /hero|primary|featured|main|gallery|photo|cover|lot|item/i.test(tag[0]) ? 0 : 1;
    // Drop obviously tiny images by width/height attrs when present.
    const w = parseInt((tag[0].match(/\bwidth=["']?(\d+)/i) || [])[1], 10);
    const h = parseInt((tag[0].match(/\bheight=["']?(\d+)/i) || [])[1], 10);
    if ((Number.isFinite(w) && w > 0 && w < 200) || (Number.isFinite(h) && h > 0 && h < 200)) continue;
    imgs.push({ src, hint });
  }
  imgs.sort((a, b) => a.hint - b.hint);
  imgs.forEach((i) => raw.push(i.src));

  // Absolutize, filter, de-dupe (stable order).
  const seen = new Set(); const out = [];
  for (const u of raw) {
    const abs = absolutize(u, baseUrl);
    if (!abs || !acceptable(abs) || seen.has(abs)) continue;
    seen.add(abs); out.push(abs);
  }
  return out;
}

module.exports = { extractImageCandidates, acceptable, absolutize };
