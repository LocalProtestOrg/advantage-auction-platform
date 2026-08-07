'use strict';

/**
 * gsaConnector — Connector Type 1 (Phase 5F). The official GSA Auctions API: federal surplus auctions.
 *
 * LAWFUL BASIS: U.S. federal government works are public domain (Open Government Data Act, 2018); the
 * GSA Auctions API is published on data.gov for public/developer use via api.data.gov keys. No scraping,
 * no ToS conflict. (See docs/projects/phase-5e-lawful-event-source-program.md.)
 *
 * Source: GET https://api.gsa.gov/assets/gsaauctions/v2/auctions?format=json&api_key=…  which 303-
 * redirects to a FRESHLY-SIGNED S3 snapshot ({"Results":[ …lot rows… ]}) on every call — so each
 * scheduled run pulls current inventory (never a frozen copy). One GSA "sale" (saleNo) can hold many
 * lots; we emit ONE event per sale (the representative lot), keyed by saleNo, as an ONLINE auction
 * (bidding happens on gsaauctions.gov). Emits canonical-shaped payloads → normalized by the identity map.
 */

const { fetchJson } = require('../http');
const { IDENTITY_FIELD_MAP } = require('../normalize/identityFieldMap');

const DEFAULT_API_URL = 'https://api.gsa.gov/assets/gsaauctions/v2/auctions?format=json';

// GSA supplies dates as YYYY-MM-DD (date only). Keep them as local dates: start_at = start-of-day,
// end_date = the closing local date (the canonical deriveEndAt turns it into 23:59 local so an auction
// closing "8/10" stays active through that day rather than expiring at midnight).
function localDate(v) { const t = String(v == null ? '' : v).trim(); return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null; }

// Active + Preview (scheduled) sales are current/upcoming; anything else is skipped. Case-insensitive.
function isCurrent(status) { const s = String(status || '').toLowerCase(); return s === 'active' || s === 'preview'; }

// Only ingest a PUBLICLY displayable cover image. GSA's imageURL points at the authenticated PPMS image
// API (www.ppms.gov/gw/auction/ppms/api/…), which returns HTTP 401 to anonymous/public requests and cannot
// be hotlinked on the public marketplace — storing it yields a broken image plus a wasted 401 request on
// every card render. Excluding it lets the card use the branded placeholder fallback. Canonical-model
// contract: a stored event image URL must be publicly renderable. No re-hosting; Railway stays the truth.
function isPubliclyDisplayableImage(u) {
  try { const host = new URL(u).hostname.toLowerCase(); return host !== 'ppms.gov' && !host.endsWith('.ppms.gov'); }
  catch (e) { return false; }
}

module.exports = {
  key: 'gsa',
  kind: 'rest',
  capabilities: { incremental: false, deletions: false, images: true },

  fieldMap: IDENTITY_FIELD_MAP,

  /**
   * Yield one raw record per GSA SALE (deduped across its lots within the run).
   * config: { apiUrl?, apiKeyEnv?, timezone? }  — apiKeyEnv names the env var holding an api.data.gov key.
   */
  async *fetch({ config, limit, signal } = {}) {
    config = config || {};
    const apiKey = (config.apiKeyEnv && process.env[config.apiKeyEnv]) || process.env.GSA_API_KEY || 'DEMO_KEY';
    const base = config.apiUrl || DEFAULT_API_URL;
    const url = base + (base.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(apiKey);
    const tz = config.timezone || 'America/New_York';

    const body = await fetchJson(url, { expectType: 'json', signal, maxBytes: 24 * 1024 * 1024, timeoutMs: 40000 });
    const rows = Array.isArray(body) ? body : (body && Array.isArray(body.Results) ? body.Results : []);

    const seenSale = new Set();
    let n = 0;
    for (const r of rows) {
      if (limit != null && n >= limit) return;
      if (!r || !isCurrent(r.auctionStatus)) continue;
      const saleNo = r.saleNo != null ? String(r.saleNo).trim() : null;
      if (!saleNo || seenSale.has(saleNo)) continue;    // one event per sale (first/representative lot)
      const end = localDate(r.aucEndDt);
      const start = localDate(r.aucStartDt);
      if (!start || !end) continue;                      // needs a computable date range
      seenSale.add(saleNo);

      const itemUrl = typeof r.itemDescURL === 'string' && /^https?:\/\//i.test(r.itemDescURL) ? r.itemDescURL : null;
      const rawImageUrl = (typeof r.imageURL === 'string' && /^https?:\/\//i.test(r.imageURL)) ? r.imageURL : null;
      const images = (rawImageUrl && isPubliclyDisplayableImage(rawImageUrl)) ? [{ url: rawImageUrl, position: 0 }] : [];
      const descParts = [r.lotDescript, r.instruction].filter((x) => x && String(x).trim());
      const payload = {
        title: (r.itemName && String(r.itemName).trim()) || ('GSA Federal Surplus Auction ' + saleNo),
        description: descParts.length ? descParts.join('\n\n') : (r.itemName || null),
        sale_type: 'auction',
        event_format: 'online',                          // GSA Auctions are online-bid → no coords needed
        start_at: start,
        end_date: end,                                   // → canonical derives 23:59 local end_at
        timezone: tz,
        city: r.propertyCity || r.locationCity || null,
        state: r.propertyState || r.locationST || null,
        zip: r.propertyZip || r.locationZip || null,
        organizer_name: r.agencyName || r.bureauName || 'U.S. General Services Administration',
        bidding_url: itemUrl,                            // gsaauctions.gov (host page; policy keeps it internal)
        external_url: itemUrl,
        contact_email: r.coEmail || null,
      };
      yield { sourceEventId: saleNo, sourceUrl: itemUrl, sourceUpdatedAt: null, payload, images };
      n++;
    }
  },

  describe() {
    return { name: 'GSA Auctions (federal surplus)', basis: 'public_domain',
      docs: 'Official api.gsa.gov/assets/gsaauctions/v2/auctions (data.gov). Public-domain federal data.' };
  },
};
