'use strict';

/**
 * marketplaceIntegrity — the Marketplace Integrity Suite (Phase 6A).
 *
 * Verifies the platform's ONE-authoritative-source rule: the canonical DB tally (marketplaceVisibility
 * .canonicalCounts) must equal what every canonical public API reports, and the SEO/structured-data
 * surfaces must be intact. Used by three callers with the same core:
 *   • scripts/marketplace-integrity.js  — deployment gate + manual runner (non-zero exit on FAIL)
 *   • the scheduled worker health check  — continuous monitoring (logs/audits anomalies)
 *   • tests/marketplace-integrity.test.js — hermetic unit coverage
 *
 * Count parity is the strongest single signal: if a hidden/private listing leaked, an API count would
 * EXCEED canonical (FAIL); if a professional listing were dropped, it would be BELOW canonical (FAIL);
 * if a surface re-implemented filtering differently, its count would diverge (FAIL). Exact equality is
 * required for counts. Live SEO/structure checks degrade to WARNING when a URL is unreachable so the
 * gate never fails on a transient network blip, but a definitively-broken surface FAILS.
 */

const { canonicalCounts } = require('../lib/marketplaceVisibility');

const PASS = 'PASS', WARN = 'WARNING', FAIL = 'FAIL';
const rank = { PASS: 0, WARNING: 1, FAIL: 2 };

function rollup(checks) {
  return checks.reduce((acc, c) => (rank[c.status] > rank[acc] ? c.status : acc), PASS);
}

// A default fetch that returns a normalized { ok, status, text, json } and never throws.
async function safeFetch(url, fetchImpl) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, status: 0, error: 'no fetch', text: '', json: null };
  try {
    const res = await f(url, { headers: { 'User-Agent': 'AdvantageBid-IntegritySuite/1.0' }, redirect: 'follow' });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { ok: res.ok, status: res.status, text, json };
  } catch (e) { return { ok: false, status: 0, error: String(e && e.message), text: '', json: null }; }
}

function countCheck(surface, expected, actual) {
  const ok = Number(expected) === Number(actual);
  return { surface, category: 'count', expected: Number(expected), actual: (actual == null ? null : Number(actual)),
    status: ok ? PASS : FAIL,
    detail: ok ? 'matches canonical' : `MISMATCH: canonical=${expected} api=${actual} (Δ${actual == null ? '?' : Number(actual) - Number(expected)})` };
}

/**
 * verify({ db, baseUrl, fetchImpl, live }) → { generatedAt, overall, canonical, checks[] }
 *   db        — pg-like { query } (required)
 *   baseUrl   — public origin to probe (optional; when absent only DB-side canonical is computed)
 *   live      — when false, skip HTTP probes (DB-only mode for fast unit runs)
 */
async function verify({ db, baseUrl, fetchImpl, live = true } = {}) {
  const checks = [];
  const canonical = await canonicalCounts(db);

  if (baseUrl && live) {
    const base = String(baseUrl).replace(/\/$/, '');
    const feed = async (preset) => safeFetch(`${base}/api/public/marketplace/feed?preset=${preset}&page=1&pageSize=1`, fetchImpl);
    const [allEv, auc, est, mapRes] = await Promise.all([
      feed('all-events'), feed('auctions'), feed('estate-sales'),
      safeFetch(`${base}/api/public/events/map`, fetchImpl),
    ]);

    // ── Count parity: canonical DB tally === each canonical public API ──
    const feedTotal = (r) => (r.json && r.json.total != null ? r.json.total : (r.json && r.json.pagination && r.json.pagination.totalItems));
    checks.push(countCheck('feed:all-events', canonical.expect.feed_all_events, allEv.ok ? feedTotal(allEv) : null));
    checks.push(countCheck('feed:auctions', canonical.expect.feed_auctions, auc.ok ? feedTotal(auc) : null));
    checks.push(countCheck('feed:estate-sales', canonical.expect.feed_estate_sales, est.ok ? feedTotal(est) : null));
    const mapCounts = mapRes.json && mapRes.json.counts;
    checks.push(countCheck('map:auction', canonical.expect.map_auction, mapCounts ? mapCounts.auction : null));
    checks.push(countCheck('map:estate_sale', canonical.expect.map_estate_sale, mapCounts ? mapCounts.estate_sale : null));

    // ── Pagination integrity: total ≥ returned page, presets are honored (auctions≠estate leak) ──
    const p1 = await safeFetch(`${base}/api/public/marketplace/feed?preset=all-events&page=1&pageSize=12`, fetchImpl);
    if (p1.ok && p1.json) {
      const t = feedTotal(p1), items = (p1.json.data || []).length;
      checks.push({ surface: 'feed:pagination', category: 'pagination', expected: 'total≥items & pageSize honored',
        actual: `total=${t} items=${items}`, status: (t >= items && items <= 12) ? PASS : FAIL,
        detail: (t >= items && items <= 12) ? 'consistent' : 'pagination total/page inconsistent' });
      const leak = (p1.json.data || []).some((x) => x.type && x.type !== 'auction' && x.type !== 'estate_sale');
      checks.push({ surface: 'feed:classification', category: 'schema', expected: 'auction|estate_sale only',
        actual: leak ? 'unknown type present' : 'ok', status: leak ? FAIL : PASS, detail: leak ? 'unexpected item type' : 'canonical types only' });
    }

    // ── SEO / structured data: sitemap present, an event detail page carries canonical + Event JSON-LD ──
    const sitemap = await safeFetch(`${base}/sitemap.xml`, fetchImpl);
    checks.push({ surface: 'seo:sitemap', category: 'seo',
      expected: '200 + <url> entries', actual: `HTTP ${sitemap.status}`,
      status: (sitemap.ok && /<url>|<loc>/.test(sitemap.text)) ? PASS : (sitemap.status === 0 ? WARN : FAIL),
      detail: sitemap.ok ? 'sitemap served with entries' : 'sitemap missing/empty' });

    const oneEvent = await safeFetch(`${base}/api/public/events?limit=1`, fetchImpl);
    const slug = oneEvent.json && oneEvent.json.data && oneEvent.json.data[0] && oneEvent.json.data[0].slug;
    if (slug) {
      const page = await safeFetch(`${base}/event.html?slug=${encodeURIComponent(slug)}`, fetchImpl);
      const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(page.text);
      const hasJsonLd = /application\/ld\+json/i.test(page.text) && /"@type"\s*:\s*"[^"]*Event"/i.test(page.text);
      checks.push({ surface: 'seo:event-detail', category: 'schema', expected: 'canonical + Event JSON-LD',
        actual: `canonical=${hasCanonical} jsonld=${hasJsonLd}`,
        status: (page.ok && hasCanonical && hasJsonLd) ? PASS : (page.status === 0 ? WARN : FAIL),
        detail: (hasCanonical && hasJsonLd) ? 'structured data intact' : 'missing canonical or Event JSON-LD' });
    } else {
      checks.push({ surface: 'seo:event-detail', category: 'schema', expected: 'canonical + Event JSON-LD',
        actual: 'no event to sample', status: WARN, detail: 'no active event slug available to probe' });
    }
  }

  const overall = rollup(checks.length ? checks : [{ status: PASS }]);
  return { generatedAt: new Date().toISOString(), overall, canonical, checks };
}

// Render a human-readable Marketplace Integrity Report.
function formatReport(result) {
  const lines = [];
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║           MARKETPLACE INTEGRITY REPORT                        ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push(`OVERALL:   ${result.overall}`);
  lines.push('');
  const c = result.canonical;
  lines.push('Canonical DB tally (single source of truth):');
  lines.push(`  events: auction=${c.events.auction} estate_sale=${c.events.estate_sale} total=${c.events.total}` +
    ` | with-coords: auction=${c.events.auction_with_coords} estate=${c.events.estate_sale_with_coords}`);
  lines.push(`  native auctions: ${c.native_auctions}`);
  lines.push('');
  lines.push('Surface checks:');
  for (const chk of result.checks) {
    const mark = chk.status === 'PASS' ? '✓' : chk.status === 'WARNING' ? '⚠' : '✗';
    lines.push(`  ${mark} [${chk.status}] ${chk.surface} — ${chk.detail}`);
  }
  if (!result.checks.length) lines.push('  (DB-only mode: no live surface probed)');
  return lines.join('\n');
}

module.exports = { verify, formatReport, PASS, WARN, FAIL };
