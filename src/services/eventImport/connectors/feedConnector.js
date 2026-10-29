'use strict';

/**
 * feedConnector — Connector Type 2 (Phase 5F): Member Feed Sync. One reusable connector that ingests a
 * MEMBER'S OWN event feed in three formats — RSS/Atom, iCal (.ics), and schema.org Event JSON-LD.
 *
 * LAWFUL BASIS: member_consent. The connector reads a feed the host company itself publishes and has
 * asked us to sync (their data, their permission) — no third-party scraping. The host IS the verified
 * organizer, so config.defaults typically carries { organizer_name, organizer_website_url }.
 *
 * MEMBER NEUTRALITY (2026-09-24). This is the ONE path by which any Professional Seller's external feed
 * is synced — no member gets a dedicated connector. Every feed entry names the member organization that
 * owns it and carries that member's consent; a feed without complete consent, or whose consent was
 * revoked, is never fetched. Items are attributed to that member (organizer defaults + host record).
 *
 * config: {
 *   connector: 'feed',
 *   feeds:   [ { url, type?, organization_id, organizer_name, organizer_website_url?,
 *                consent: { granted_by, granted_at, evidence }, revoked_at?,
 *                sale_type?, timezone? } ],   // the member's own declared sale type (when an item does not
 *                                              // say auction or estate sale itself) and local time zone
 *            // type ∈ 'rss' | 'ical' | 'jsonld' | 'auto' (default auto-detect)
 *   (a member entry may give `site` instead of `url` to discover its RSS/ICS/JSON-LD feeds from a page)
 *   defaults?: { organizer_name, organizer_website_url, sale_type, event_format, timezone }
 * }
 * Emits canonical-shaped payloads (identity fieldMap). One malformed item/feed never aborts the run.
 */

const { fetchText } = require('../http');
const diagnostics = require('../diagnostics');
const { IDENTITY_FIELD_MAP } = require('../normalize/identityFieldMap');
const { localToUtcIso } = require('../../../lib/timezoneUtils');

const IANA_RE = /^[A-Za-z]+\/[A-Za-z0-9_+-]+$/;

// ── shared helpers ─────────────────────────────────────────────────────────────
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'").replace(/&#x2019;/gi, '’').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? decodeEntities(m[1]) : null;
}
function stripHtml(s) { return s == null ? null : decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }

// Best-effort "City, ST [ZIP]" extraction from a free-text location (iCal LOCATION / RSS). Returns
// { city, state, zip } — any field null when not confidently derivable. Never guesses beyond a trailing
// two-letter state token, so a bare venue name yields nothing (the record is then held on location).
function parseLocationString(loc) {
  const s = String(loc || '').replace(/,\s*USA?\.?$/i, '').trim();
  const m = s.match(/(?:^|,)\s*([A-Za-z][A-Za-z .'\-]+?),\s*([A-Za-z]{2})\.?(?:\s+(\d{5})(?:-\d{4})?)?\s*$/);
  if (!m) return { city: null, state: null, zip: null };
  return { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] || null };
}

// ── format detection ────────────────────────────────────────────────────────────
function detectType(text, contentType, urlHint) {
  const t = (text || '').slice(0, 400);
  const ct = (contentType || '').toLowerCase();
  if (/BEGIN:VCALENDAR/i.test(t) || ct.includes('calendar') || /\.ics(\?|$)/i.test(urlHint || '')) return 'ical';
  if (/<rss[\s>]/i.test(t) || /<feed[\s>][^>]*xmlns/i.test(t) || (ct.includes('xml') && /<(rss|feed)\b/i.test(text || ''))) return 'rss';
  if (ct.includes('json') && !/</.test(t)) return 'jsonld';        // a raw JSON-LD document
  return 'jsonld';                                                 // default: treat as HTML → scan for JSON-LD
}

// ── iCal ──────────────────────────────────────────────────────────────────────
function unfoldIcal(text) {
  // RFC5545 line folding: a CRLF followed by space/tab continues the previous line.
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}
function icalDateToPayload(val, params, tz) {
  // Returns { start_at?, end_date?, dateOnly } for a DTSTART/DTEND value.
  const v = String(val || '').trim();
  if (/^\d{8}$/.test(v)) {                                          // date only (all-day)
    return { iso: null, localDate: v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8), dateOnly: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return { iso: null, localDate: null, dateOnly: false };
  const [, y, mo, d, h, mi, , z] = m;
  if (z) return { iso: `${y}-${mo}-${d}T${h}:${mi}:00.000Z`, localDate: null, dateOnly: false };
  const zone = (params.TZID && IANA_RE.test(params.TZID)) ? params.TZID : tz;   // floating/TZID → convert
  const iso = localToUtcIso(`${y}-${mo}-${d}T${h}:${mi}`, zone) || null;
  return { iso, localDate: iso ? null : `${y}-${mo}-${d}`, dateOnly: false };
}
function parseIcalProp(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  const left = line.slice(0, idx), value = line.slice(idx + 1);
  const parts = left.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) { const eq = p.indexOf('='); if (eq > -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1); }
  return { name, params, value: value.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, '\n').replace(/\\\\/g, '\\') };
}
function* parseIcal(text, tz) {
  const body = unfoldIcal(text);
  const blocks = body.split(/BEGIN:VEVENT/i).slice(1);
  for (const b of blocks) {
    const block = b.split(/END:VEVENT/i)[0];
    const props = {};
    for (const line of block.split('\n')) { const p = parseIcalProp(line.trim()); if (p) props[p.name] = props[p.name] || p; }
    const summary = props.SUMMARY && props.SUMMARY.value;
    if (!summary) continue;
    const dtstart = props.DTSTART ? icalDateToPayload(props.DTSTART.value, props.DTSTART.params, tz) : null;
    const dtend = props.DTEND ? icalDateToPayload(props.DTEND.value, props.DTEND.params, tz) : null;
    const loc = props.LOCATION && props.LOCATION.value;
    const geoParsed = parseLocationString(loc);
    yield {
      sourceEventId: (props.UID && props.UID.value) || null,
      url: props.URL && props.URL.value,
      saleHints: props.CATEGORIES ? props.CATEGORIES.value : null,
      payload: {
        title: decodeEntities(summary),
        description: props.DESCRIPTION ? stripHtml(props.DESCRIPTION.value) : null,
        start_at: dtstart ? (dtstart.iso || dtstart.localDate) : null,
        end_at: dtend && dtend.iso ? dtend.iso : null,
        end_date: dtend && !dtend.iso ? dtend.localDate : null,
        venue_name: loc || null,
        city: geoParsed.city || undefined,
        state: geoParsed.state || undefined,
        zip: geoParsed.zip || undefined,
      },
    };
  }
}

// ── RSS / Atom ──────────────────────────────────────────────────────────────────
function firstDate(block, names) {
  for (const n of names) { const v = tag(block, n); if (v) { const d = new Date(v); if (!isNaN(d.getTime())) return d.toISOString(); } }
  return null;
}
function* parseRss(text) {
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const itemTag = isAtom ? 'entry' : 'item';
  const re = new RegExp('<' + itemTag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + itemTag + '>', 'gi');
  let m;
  while ((m = re.exec(text))) {
    const block = m[1];
    const title = tag(block, 'title');
    if (!title) continue;
    let link = tag(block, 'link');
    if (!link && isAtom) { const lm = block.match(/<link[^>]*href=["']([^"']+)["']/i); link = lm ? lm[1] : null; }
    // Only a field that states the EVENT's date counts. A post's publication date (pubDate, published,
    // updated, dc:date) is when it was written, not when the sale happens: an item without an event date
    // is held for review rather than misdated (e.g. a WordPress post feed announcing an estate sale).
    const start = firstDate(block, ['start_date', 'startDate', 'ev:startdate']);
    const end = firstDate(block, ['end_date', 'endDate', 'ev:enddate']);
    const guid = tag(block, 'guid') || tag(block, 'id') || link;
    yield {
      sourceEventId: guid || null,
      url: link || null,
      saleHints: (block.match(/<category(?:\s[^>]*)?>[\s\S]*?<\/category>/gi) || []).map((c) => stripHtml(c)).join(' | ') || null,
      payload: {
        title: title,
        description: stripHtml(tag(block, 'description') || tag(block, 'content:encoded') || tag(block, 'summary') || tag(block, 'content')),
        start_at: start, end_at: end,
      },
    };
  }
}

// ── JSON-LD (schema.org Event) ───────────────────────────────────────────────────
function collectLdNodes(text) {
  const nodes = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m; const scripts = [];
  while ((m = re.exec(text))) scripts.push(m[1]);
  if (!scripts.length && /^\s*[[{]/.test(text)) scripts.push(text);  // raw JSON-LD document
  for (const s of scripts) {
    let parsed; try { parsed = JSON.parse(s.trim()); } catch (e) { continue; }
    const stack = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (node && typeof node === 'object') {
        if (node['@graph']) stack.push(...[].concat(node['@graph']));
        nodes.push(node);
      }
    }
  }
  return nodes;
}
function isEventType(t) {
  const types = [].concat(t || []).map((x) => String(x).toLowerCase());
  return types.some((x) => x === 'event' || x.endsWith('event') || x === 'saleevent');
}
function ldStr(v) { if (v == null) return null; if (typeof v === 'string') return v; if (typeof v === 'object') return v.name || v['@value'] || v.url || null; return String(v); }
function ldImages(img) {
  const out = []; const add = (x) => { const u = typeof x === 'string' ? x : (x && (x.url || x.contentUrl)); if (u) out.push({ url: u, position: out.length }); };
  [].concat(img || []).forEach(add); return out;
}
function* parseJsonLd(text) {
  for (const node of collectLdNodes(text)) {
    if (!isEventType(node['@type'])) continue;
    const loc = [].concat(node.location || [])[0] || {};
    const addr = (loc && loc.address) || {};
    const geo = (loc && loc.geo) || {};
    const org = [].concat(node.organizer || [])[0] || {};
    const online = String(node.eventAttendanceMode || '').toLowerCase().includes('online');
    yield {
      sourceEventId: ldStr(node.url) || node['@id'] || (ldStr(node.name) ? ldStr(node.name) + '|' + (node.startDate || '') : null),
      url: ldStr(node.url),
      saleHints: [].concat(node.keywords || [], node.about ? [].concat(node.about).map(ldStr) : []).map(String).join(' | ') || null,
      payload: {
        title: ldStr(node.name),
        description: stripHtml(ldStr(node.description)),
        start_at: node.startDate || null,
        end_at: node.endDate || null,
        event_format: online ? 'online' : undefined,
        venue_name: ldStr(loc.name) || null,
        address: typeof addr === 'string' ? addr : (addr.streetAddress || null),
        city: (typeof addr === 'object' && addr.addressLocality) || null,
        state: (typeof addr === 'object' && addr.addressRegion) || null,
        zip: (typeof addr === 'object' && addr.postalCode) || null,
        lat: geo && geo.latitude != null ? geo.latitude : undefined,
        lng: geo && geo.longitude != null ? geo.longitude : undefined,
        organizer_name: ldStr(org.name) || undefined,
        organizer_website_url: ldStr(org.url) || undefined,
        images: ldImages(node.image),
      },
    };
  }
}

// ── feed discovery from a member site page ───────────────────────────────────────
function discoverFeeds(html, baseUrl) {
  const feeds = [];
  const linkRe = /<link\b[^>]*>/gi; let m;
  while ((m = linkRe.exec(html))) {
    const t = m[0];
    const type = (t.match(/type=["']([^"']+)["']/i) || [])[1] || '';
    const href = (t.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    let url; try { url = new URL(href, baseUrl).toString(); } catch (e) { continue; }
    if (/rss\+xml|atom\+xml/i.test(type)) feeds.push({ url, type: 'rss' });
    else if (/calendar/i.test(type) || /\.ics(\?|$)/i.test(href)) feeds.push({ url, type: 'ical' });
  }
  if (/<script[^>]*application\/ld\+json/i.test(html)) feeds.push({ url: baseUrl, type: 'jsonld', inlineHtml: html });
  return feeds;
}

// ── the connector ────────────────────────────────────────────────────────────────
/** Does this feed carry a complete, unrevoked member consent? Pure. */
function hasMemberConsent(feed) {
  const c = feed && feed.consent;
  return !!(feed && feed.organization_id && feed.organizer_name && !feed.revoked_at
    && c && typeof c.granted_by === 'string' && c.granted_by.trim() && c.granted_at && c.evidence);
}

// Auction or estate sale, from what the item itself says (its title and categories, never its long
// description, which may mention an auction in passing). Returns null when it does not say, or says both;
// the feed's own declared sale type then applies, and otherwise the event is held for review. Pure.
function classifySaleType(...texts) {
  const s = texts.filter(Boolean).join(' | ').toLowerCase();
  const estate = /\bestate[\s-]+sales?\b|\btag[\s-]+sales?\b/.test(s);
  const auction = /\bauctions?\b/.test(s);
  if (estate && !auction) return 'estate_sale';
  if (auction && !estate) return 'auction';
  return null;
}

// Did a successfully loaded body look like a feed of the expected format at all? A 200 that is an HTML
// error page, a login wall or a redesigned site is a FORMAT CHANGE, not "nothing upcoming". Pure.
function looksLikeFeed(type, text) {
  const t = String(text || '');
  if (type === 'ical') return /BEGIN:VCALENDAR/i.test(t);
  if (type === 'rss') return /<(rss|feed|rdf:RDF)[\s>]/i.test(t);
  return collectLdNodes(t).length > 0;
}

async function* iterateFeed(feed, tz, signal, diag) {
  let text = feed.inlineHtml || null, contentType = '', http = feed.inlineHtml ? 200 : null;
  const report = (outcome, items, note) => { if (diag && diag.partner) diag.partner({ organization_id: feed.organization_id,
    organizer_name: feed.organizer_name, feed: feed.url || feed.site, http, outcome, items, note }); };
  if (!text) {
    let r;
    try { r = await fetchText(feed.url, { signal, timeoutMs: 25000 }); }
    catch (e) {
      const m = /\bHTTP (\d{3})\b/.exec(String(e && e.message));
      http = m ? Number(m[1]) : 'network';
      if (diag) diag.record(feed.url, http, e && e.message);
      report(diagnostics.feedOutcome(http, 0), 0, e && e.message);
      throw e;
    }
    http = r ? r.status : 'network';
    if (diag) diag.record(feed.url, http);
    // A refused or failed response is never parsed: an "Access Denied" page is not an empty feed.
    if (!r || !r.ok) { report(diagnostics.feedOutcome(http, 0), 0, r && r.reason); if (r && !r.text) throw new Error('feed fetch failed: ' + r.status); return; }
    text = r.text; contentType = r.contentType;
  }
  const type = feed.type && feed.type !== 'auto' ? feed.type : detectType(text, contentType, feed.url);
  const zone = feed.timezone || tz;
  const gen = type === 'ical' ? parseIcal(text, zone) : type === 'rss' ? parseRss(text) : parseJsonLd(text);
  let items = 0;
  for (const item of gen) {
    if (!item || !item.sourceEventId || !(item.payload && item.payload.title)) continue;
    // Attribute to the member who owns this feed: their organizer name / site unless the item states its own.
    const payload = Object.assign({}, item.payload);
    if (!payload.organizer_name && feed.organizer_name) payload.organizer_name = feed.organizer_name;
    if (!payload.organizer_website_url && feed.organizer_website_url) payload.organizer_website_url = feed.organizer_website_url;
    const saleType = classifySaleType(payload.title, item.saleHints) || feed.sale_type || null;
    if (saleType) payload.sale_type = saleType;
    if (feed.timezone && !payload.timezone) payload.timezone = feed.timezone;
    items++;
    yield {
      sourceEventId: String(item.sourceEventId),
      sourceUrl: item.url || feed.url || null,
      sourceUpdatedAt: null,
      payload,
      images: item.payload.images || [],
      memberOrganizationId: feed.organization_id || null,
    };
  }
  report(diagnostics.feedOutcome(http, items, items > 0 || looksLikeFeed(type, text)), items);
}

module.exports = {
  key: 'feed',
  kind: 'rss',
  capabilities: { incremental: false, deletions: false, images: true },
  fieldMap: IDENTITY_FIELD_MAP,

  async *fetch({ config, limit, signal, diag } = {}) {
    config = config || {};
    const tz = (config.defaults && config.defaults.timezone) || config.timezone || 'America/New_York';
    // Only member-consented, unrevoked feeds are ever fetched. A member entry may give its own `site`
    // instead of a feed url: feeds discovered there inherit THAT member's ownership and consent. There
    // is no anonymous source-level discovery — every fetched feed belongs to a consenting member.
    const consented = (Array.isArray(config.feeds) ? config.feeds : []).filter(hasMemberConsent);
    let feeds = consented.filter((fd) => fd.url);
    for (const member of consented.filter((fd) => !fd.url && fd.site)) {
      const report = (http, outcome, note) => { if (diag && diag.partner) diag.partner({ organization_id: member.organization_id,
        organizer_name: member.organizer_name, feed: member.site, http, outcome, items: 0, note }); };
      try {
        const r = await fetchText(member.site, { signal, expectType: 'html', timeoutMs: 20000 });
        const http = r ? r.status : 'network';
        if (diag) diag.record(member.site, http);
        // Feeds are discovered only on a page that actually loaded, never on an "Access Denied" page.
        if (r && r.ok && r.text) {
          const inherit = { organization_id: member.organization_id, organizer_name: member.organizer_name,
            organizer_website_url: member.organizer_website_url, consent: member.consent,
            sale_type: member.sale_type, timezone: member.timezone };
          const found = discoverFeeds(r.text, r.url || member.site).map((d) => Object.assign({}, d, inherit));
          if (!found.length) report(http, 'no_feed_found', 'the page loaded but publishes no RSS, iCal or structured event data');
          feeds = feeds.concat(found);
        } else report(http, diagnostics.feedOutcome(http, 0), r && r.reason);
      } catch (e) {
        const m = /\bHTTP (\d{3})\b/.exec(String(e && e.message));
        const http = m ? Number(m[1]) : 'network';
        if (diag) diag.record(member.site, http, e && e.message);
        report(http, diagnostics.feedOutcome(http, 0), e && e.message);
      }
    }

    let n = 0;
    for (const feed of feeds) {
      try {
        for await (const raw of iterateFeed(feed, tz, signal, diag)) {
          if (limit != null && n >= limit) return;
          yield raw; n++;
        }
      } catch (e) {
        // One feed failing must never stop the others (§ autonomous operation). The run continues.
        continue;
      }
    }
  },

  // exported for focused tests
  _parsers: { parseIcal, parseRss, parseJsonLd, detectType, discoverFeeds, classifySaleType, looksLikeFeed },
  hasMemberConsent,

  describe() {
    return { name: 'Member Feed Sync (RSS / iCal / JSON-LD)', basis: 'member_consent',
      docs: 'Ingests a member-published event feed. RSS/Atom, iCal (.ics), or schema.org Event JSON-LD.' };
  },
};
