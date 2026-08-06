'use strict';

/**
 * feedConnector — Connector Type 2 (Phase 5F): Member Feed Sync. One reusable connector that ingests a
 * MEMBER'S OWN event feed in three formats — RSS/Atom, iCal (.ics), and schema.org Event JSON-LD.
 *
 * LAWFUL BASIS: member_consent. The connector reads a feed the host company itself publishes and has
 * asked us to sync (their data, their permission) — no third-party scraping. The host IS the verified
 * organizer, so config.defaults typically carries { organizer_name, organizer_website_url }.
 *
 * config: {
 *   connector: 'feed',
 *   feeds:   [ { url, type? } ],   // type ∈ 'rss' | 'ical' | 'jsonld' | 'auto' (default auto-detect)
 *   site?:   'https://member.example.com',  // optional: discover feeds (RSS/ICS/JSON-LD) from a page
 *   defaults?: { organizer_name, organizer_website_url, sale_type, event_format, timezone }
 * }
 * Emits canonical-shaped payloads (identity fieldMap). One malformed item/feed never aborts the run.
 */

const { fetchText } = require('../http');
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
    const start = firstDate(block, ['start_date', 'startDate', 'ev:startdate', 'dc:date', 'pubDate', 'published', 'updated']);
    const end = firstDate(block, ['end_date', 'endDate', 'ev:enddate']);
    const guid = tag(block, 'guid') || tag(block, 'id') || link;
    yield {
      sourceEventId: guid || null,
      url: link || null,
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
async function* iterateFeed(feed, tz, signal) {
  let text = feed.inlineHtml || null, contentType = '';
  if (!text) {
    const r = await fetchText(feed.url, { signal, timeoutMs: 25000 });
    if (!r.ok && !r.text) throw new Error('feed fetch failed: ' + r.status);
    text = r.text; contentType = r.contentType;
  }
  const type = feed.type && feed.type !== 'auto' ? feed.type : detectType(text, contentType, feed.url);
  const gen = type === 'ical' ? parseIcal(text, tz) : type === 'rss' ? parseRss(text) : parseJsonLd(text);
  for (const item of gen) {
    if (!item || !item.sourceEventId || !(item.payload && item.payload.title)) continue;
    yield {
      sourceEventId: String(item.sourceEventId),
      sourceUrl: item.url || feed.url || null,
      sourceUpdatedAt: null,
      payload: item.payload,
      images: item.payload.images || [],
    };
  }
}

module.exports = {
  key: 'feed',
  kind: 'rss',
  capabilities: { incremental: false, deletions: false, images: true },
  fieldMap: IDENTITY_FIELD_MAP,

  async *fetch({ config, limit, signal } = {}) {
    config = config || {};
    const tz = (config.defaults && config.defaults.timezone) || config.timezone || 'America/New_York';
    let feeds = Array.isArray(config.feeds) ? config.feeds.slice() : [];

    if (config.site) {
      try {
        const r = await fetchText(config.site, { signal, expectType: 'html', timeoutMs: 20000 });
        if (r.text) feeds = feeds.concat(discoverFeeds(r.text, r.url || config.site));
      } catch (e) { /* discovery is best-effort; explicit feeds still process */ }
    }

    let n = 0;
    for (const feed of feeds) {
      try {
        for await (const raw of iterateFeed(feed, tz, signal)) {
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
  _parsers: { parseIcal, parseRss, parseJsonLd, detectType, discoverFeeds },

  describe() {
    return { name: 'Member Feed Sync (RSS / iCal / JSON-LD)', basis: 'member_consent',
      docs: 'Ingests a member-published event feed. RSS/Atom, iCal (.ics), or schema.org Event JSON-LD.' };
  },
};
