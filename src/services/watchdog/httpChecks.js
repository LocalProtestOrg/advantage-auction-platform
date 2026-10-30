'use strict';

/**
 * httpChecks — the server-side watchdog checks that run in production. NON-DESTRUCTIVE BY CONSTRUCTION: every request
 * goes through readOnlyGet(), which issues GET only (tests prove no other method is ever used). Nothing is submitted,
 * signed, bought, bid, written or emailed by a check. Pages are fetched as HTML only (no JavaScript runs), so no
 * analytics or tracking is triggered either.
 *
 * Each check: { id, feature, tier, kind: 'http'|'served_html', run(ctx) → { status, issues, reproduce } }
 *   status: 'ok' | 'fail' | 'skipped' (nothing to check yet, e.g. no published storefront exists)
 *   issues: [{ code, severity: 'critical'|'warning', detail, evidence? }]
 */

const { analyzeHtml } = require('./htmlAnalysis');
const servedHtml = require('./servedHtml');

const USER_AGENT = 'AdvantageBidWatchdog/1.0 (+https://bid.advantage.bid; site health check)';
const TIMEOUT_MS = 20000;
const SLOW_MS = 8000;

/** The ONLY network primitive checks may use. GET, no body, no credentials, bounded time and size. */
async function readOnlyGet(baseUrl, path, { fetchImpl = fetch, redirect = 'follow' } = {}) {
  const url = new URL(path, baseUrl).toString();
  const t = Date.now();
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect, signal: ctl.signal, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } });
    const text = (await res.text()).slice(0, 3 * 1024 * 1024);
    return { url, status: res.status, location: res.headers.get('location'), contentType: res.headers.get('content-type') || '', text, ms: Date.now() - t };
  } catch (e) {
    return { url, status: 0, error: e.name === 'AbortError' ? `no answer within ${TIMEOUT_MS / 1000}s` : e.message, text: '', ms: Date.now() - t };
  } finally { clearTimeout(timer); }
}

const reproduceGet = (r) => `GET ${r.url} (as a signed-out visitor)`;

/** A page check: HTTP 200, HTML that parses and survives, expected content, optional SEO / structured data. */
function pageCheck(id, feature, tier, path, opts = {}) {
  return {
    id, feature, tier, kind: 'http',
    async run(ctx) {
      const p = typeof path === 'function' ? await path(ctx) : path;
      if (!p) return { status: 'skipped', issues: [], reproduce: opts.skipReason || 'nothing to check yet' };
      const r = await ctx.get(p);
      const issues = [];
      if (r.status !== 200) {
        issues.push({ code: 'HTTP_STATUS', severity: 'critical', detail: r.status ? `answered HTTP ${r.status}` : `did not answer: ${r.error}`, evidence: { status: r.status, ms: r.ms } });
        return { status: 'fail', issues, reproduce: reproduceGet(r) };
      }
      if (!/html/i.test(r.contentType)) issues.push({ code: 'CONTENT_TYPE', severity: 'critical', detail: `served as ${r.contentType || 'no type'}, not HTML` });
      issues.push(...analyzeHtml(r.text, { expectText: opts.expect || [], requireSeo: !!opts.seo, requireJsonLd: !!opts.jsonld }));
      if (r.ms > SLOW_MS) issues.push({ code: 'SLOW', severity: 'warning', detail: `took ${(r.ms / 1000).toFixed(1)}s` });
      return { status: issues.some((i) => i.severity === 'critical') ? 'fail' : 'ok', issues, reproduce: reproduceGet(r) };
    },
  };
}

/** An API check: HTTP 200 and a JSON body that passes `valid(json)` (returns an error string or null). */
function apiCheck(id, feature, tier, path, valid) {
  return {
    id, feature, tier, kind: 'http',
    async run(ctx) {
      const p = typeof path === 'function' ? await path(ctx) : path;
      if (!p) return { status: 'skipped', issues: [], reproduce: 'nothing to check yet' };
      const r = await ctx.get(p);
      const issues = [];
      let json = null;
      if (r.status !== 200) issues.push({ code: 'HTTP_STATUS', severity: 'critical', detail: r.status ? `answered HTTP ${r.status}` : `did not answer: ${r.error}` });
      else {
        try { json = JSON.parse(r.text); } catch (_) { issues.push({ code: 'API_NOT_JSON', severity: 'critical', detail: 'the response is not JSON' }); }
        const why = json != null ? valid(json) : null;
        if (why) issues.push({ code: 'API_SHAPE', severity: 'critical', detail: why });
      }
      return { status: issues.length ? 'fail' : 'ok', issues, reproduce: reproduceGet(r) };
    },
  };
}

// ── Discovery of real pages to check (from the public sitemap and feed; cached per run) ───────────────────────────
async function sitemapUrls(ctx) {
  if (!ctx.cache.sitemap) {
    const r = await ctx.get('/sitemap.xml');
    ctx.cache.sitemap = r.status === 200 ? [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]) : [];
  }
  return ctx.cache.sitemap;
}
const firstPath = async (ctx, re) => {
  const u = (await sitemapUrls(ctx)).find((x) => re.test(x));
  if (!u) return null;
  try { const p = new URL(u); return p.pathname + p.search; } catch (_) { return null; }
};
async function feedItems(ctx) {
  if (!ctx.cache.feed) {
    const r = await ctx.get('/api/public/marketplace/feed?limit=60');
    try { ctx.cache.feed = (JSON.parse(r.text).data || []); } catch (_) { ctx.cache.feed = []; }
  }
  return ctx.cache.feed;
}
async function productPath(ctx) {
  const it = (await feedItems(ctx)).find((x) => /\/shop\/item\/|\/item\.html\?/.test(String(x.url || '')));
  return it ? it.url : await firstPath(ctx, /\/shop\/item\//);
}
async function storefrontInfo(ctx) {
  if (ctx.cache.storefront !== undefined) return ctx.cache.storefront;
  ctx.cache.storefront = null;
  const fromSitemap = await firstPath(ctx, /\/pro\/[^/?#]+$/);
  const slug = fromSitemap ? decodeURIComponent(fromSitemap.split('/')[2]) : null;
  if (slug) {
    const r = await ctx.get('/api/public/storefront/' + encodeURIComponent(slug));
    try { const d = JSON.parse(r.text).data || {}; ctx.cache.storefront = { slug, sellerId: d.seller_id || (d.seller && d.seller.id) || d.id || null }; } catch (_) { ctx.cache.storefront = { slug, sellerId: null }; }
  }
  return ctx.cache.storefront;
}

const isArr = (x) => Array.isArray(x);
const CHECKS = [
  // ── critical: the front door, sign-in, the data path, and every page as served ──
  {
    id: 'served-pages', feature: 'Every page as served (incl. signed-in pages: seller agreement, dashboards)', tier: 'critical', kind: 'served_html',
    async run() {
      const r = servedHtml.checkAll();
      return { status: r.issues.length ? 'fail' : 'ok', issues: r.issues.map((i) => ({ code: i.code, severity: i.severity, detail: `${i.page}: ${i.detail}`, evidence: { page: i.page } })),
        reproduce: `Serve each of the ${r.pages} pages under public/ through the server's tag injection and parse every inline script (src/services/watchdog/servedHtml.js).` };
    },
  },
  apiCheck('health', 'Platform health', 'critical', '/api/health', (j) => (j.status !== 'ok' ? 'health status is ' + j.status : (j.db_reachable === false ? 'the database is not reachable' : null))),
  pageCheck('home', 'Homepage and navigation', 'critical', '/', { expect: ['Advantage.Bid'], seo: true }),
  pageCheck('login', 'Sign in and registration page', 'critical', '/login.html', { expect: ['login-email', 'login-password', 'reg-email'] }),
  apiCheck('marketplace-feed', 'Marketplace feed', 'critical', '/api/public/marketplace/feed?limit=5', (j) => (j.success !== true || !isArr(j.data) ? 'feed is not { success: true, data: [] }' : null)),
  {
    id: 'private-pages-gated', feature: 'Signed-in pages require sign-in (seller agreement, dashboard)', tier: 'critical', kind: 'http',
    async run(ctx) {
      const issues = [];
      for (const p of ['/sign-agreement.html', '/seller-inventory.html', '/admin/']) {
        const r = await ctx.get(p, { redirect: 'manual' });
        if (!(r.status === 302 && /\/login\.html/.test(String(r.location || '')))) issues.push({ code: 'GATE', severity: 'critical', detail: `${p} answered ${r.status || r.error} instead of a sign-in redirect` });
      }
      return { status: issues.length ? 'fail' : 'ok', issues, reproduce: 'GET /sign-agreement.html, /seller-inventory.html and /admin/ without signing in; each must redirect to /login.html' };
    },
  },
  // ── high: buying and selling surfaces ──
  pageCheck('forgot-password', 'Password reset (request page)', 'high', '/forgot-password.html', { expect: ['id="email"'] }),
  pageCheck('reset-password', 'Password reset (new password page)', 'high', '/reset-password.html', {}),
  pageCheck('search', 'Search and filtering', 'high', '/search.html', {}),
  pageCheck('items', 'Marketplace items page', 'high', '/items', {}),
  pageCheck('become-pro', 'Professional Seller onboarding page', 'high', '/become-professional-seller.html', {}),
  pageCheck('auction-page', 'Auction page', 'high', (ctx) => firstPath(ctx, /\/auction-view\.html\?/), { seo: true }),
  pageCheck('lot-page', 'Lot page', 'high', (ctx) => firstPath(ctx, /\/lot\.html\?/), { seo: true }),
  pageCheck('event-page', 'Event page (SEO + structured data)', 'high', (ctx) => firstPath(ctx, /\/event\.html\?/), { seo: true, jsonld: true }),
  pageCheck('product-page', 'Marketplace product page', 'high', productPath, { seo: true, skipReason: 'no published marketplace item yet' }),
  pageCheck('storefront-page', 'Professional Seller storefront page', 'high', async (ctx) => { const s = await storefrontInfo(ctx); return s ? '/pro/' + encodeURIComponent(s.slug) : null; }, { seo: true, skipReason: 'no published storefront yet' }),
  pageCheck('storefront-widget', 'Embedded storefront widget', 'high', async (ctx) => { const s = await storefrontInfo(ctx); return s && s.sellerId ? '/embed/storefront.html?seller=' + encodeURIComponent(s.sellerId) : null; }, { skipReason: 'no published storefront yet' }),
  apiCheck('storefront-widget-feed', 'Embedded storefront widget data', 'high', async (ctx) => { const s = await storefrontInfo(ctx); return s && s.sellerId ? '/api/public/storefront/widget/' + s.sellerId : null; }, (j) => (j.success !== true ? 'widget feed did not succeed' : null)),
  apiCheck('marketplace-counts', 'Marketplace counts', 'high', '/api/public/marketplace/counts', (j) => (j.success !== true || !j.families ? 'counts have no families' : null)),
  apiCheck('auctions-api', 'Public auctions list', 'high', '/api/public/auctions', (j) => (j.success === false ? 'auctions list failed' : null)),
  apiCheck('categories-api', 'Categories', 'high', '/api/public/categories', (j) => (j.success === false ? 'categories failed' : null)),
  {
    id: 'sitemap', feature: 'Sitemap (SEO)', tier: 'high', kind: 'http',
    async run(ctx) {
      const r = await ctx.get('/sitemap.xml');
      const issues = [];
      if (r.status !== 200) issues.push({ code: 'HTTP_STATUS', severity: 'critical', detail: `answered ${r.status || r.error}` });
      else if (!/<urlset[\s>]/.test(r.text) || !/<loc>/.test(r.text)) issues.push({ code: 'SITEMAP_INVALID', severity: 'critical', detail: 'no <urlset> with <loc> entries' });
      return { status: issues.length ? 'fail' : 'ok', issues, reproduce: reproduceGet(r) };
    },
  },
  // ── normal: information pages ──
  ...['how-it-works', 'faq.html', 'buyer-faq.html', 'seller-faq.html', 'terms.html', 'privacy.html', 'professional-sellers.html', 'events.html', 'ending-soon.html']
    .map((p) => pageCheck('page-' + p.replace(/\.html$/, ''), 'Information page /' + p, 'normal', '/' + p, {})),
];

module.exports = { CHECKS, readOnlyGet, pageCheck, apiCheck, USER_AGENT, sitemapUrls };
