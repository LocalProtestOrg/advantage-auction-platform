'use strict';

/**
 * microdata — schema.org Event read from HTML microdata (itemscope / itemtype / itemprop) and basic RDFa
 * (typeof / property). Pure: string in, items out; no network, no dependencies.
 *
 * Items use the feedConnector item shape. A value is taken only from the markup the site published
 * (content / datetime / href / src attributes first, element text otherwise); nothing is inferred.
 *
 *   parseMicrodataEvents(html, baseUrl, { timezone }?) → [item]
 */

const { localToUtcIso } = require('../../../lib/timezoneUtils');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const NAMED = { ndash: '–', mdash: '—', raquo: '»', laquo: '«', rsquo: '’', lsquo: '‘', rdquo: '”',
  ldquo: '“', hellip: '…', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', ensp: ' ', emsp: ' ', thinsp: ' ' };

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(ndash|mdash|raquo|laquo|rsquo|lsquo|rdquo|ldquo|hellip|middot|bull|copy|reg|trade|ensp|emsp|thinsp);/gi, (_, n) => NAMED[n.toLowerCase()])
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch (_) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ''; } })
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;|&#0*39;/g, "'").replace(/&amp;/g, '&');
}
const textOf = (html) => decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseAttrs(s) {
  const out = {};
  const re = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s || ''))) out[m[1].toLowerCase()] = decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '');
  return out;
}

function resolveUrl(u, base) {
  if (!u) return null;
  try { return new URL(String(u).trim(), base || undefined).toString(); } catch (_) { return null; }
}

// "http://schema.org/SaleEvent" | "schema:Event" | "Event" → "SaleEvent" / "Event".
const shortType = (t) => String(t || '').trim().split(/\s+/)[0].replace(/^.*[/#:]/, '');
const propNames = (p) => String(p || '').trim().split(/\s+/).filter(Boolean).map((x) => x.replace(/^.*[/#:]/, ''));

// Value of a property-bearing element that carries its value in an attribute (or null for "use text").
function attrValue(tag, a, base) {
  if (a.content != null) return a.content;
  if (tag === 'time' && a.datetime) return a.datetime;
  if (tag === 'meta') return a.content != null ? a.content : '';
  if (['a', 'area', 'link'].includes(tag) && a.href) return resolveUrl(a.href, base);
  if (['img', 'audio', 'embed', 'iframe', 'source', 'track', 'video'].includes(tag) && a.src) return resolveUrl(a.src, base);
  if (['data', 'meter'].includes(tag) && a.value != null) return a.value;
  if (a.resource) return resolveUrl(a.resource, base);
  return null;
}

/** Every schema.org item (microdata + RDFa) in the document: [{ type, props: { name: [values] } }]. */
function parseItems(html, baseUrl) {
  const src = require('./scan').stripBlocks(html, ['script', 'style', 'noscript']);   // linear (readers/scan)
  const items = [];
  const stack = [];   // { tag, scope, prop: { scope, names, textFrom } }
  const re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/g;
  let m;
  const currentScope = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].scope) return stack[i].scope; return null; };
  const assign = (scope, names, value) => { if (!scope) return; for (const n of names) (scope.props[n] = scope.props[n] || []).push(value); };
  while ((m = re.exec(src))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      let i = stack.length - 1;
      while (i >= 0 && stack[i].tag !== tag) i--;
      if (i < 0) continue;                                     // stray close tag: ignore
      while (stack.length > i) {
        const el = stack.pop();
        if (el.prop && !el.scope) assign(el.prop.scope, el.prop.names, textOf(src.slice(el.prop.textFrom, m.index)));
      }
      continue;
    }
    const a = parseAttrs(m[3]);
    const selfClosing = /\/\s*$/.test(m[3]) || VOID.has(tag);
    const isScope = ('itemscope' in a) || a.typeof != null;
    const names = propNames(a.itemprop != null ? a.itemprop : a.property);
    const parent = currentScope();
    const el = { tag, scope: null, prop: null };
    if (isScope) {
      const item = { type: shortType(a.itemtype || a.typeof), props: {}, id: a.itemid || a.about || a.resource || null };
      items.push(item);
      if (names.length) assign(parent, names, item);
      el.scope = item;
    } else if (names.length) {
      const v = attrValue(tag, a, baseUrl);
      if (v != null || selfClosing) assign(parent, names, v != null ? v : '');
      else el.prop = { scope: parent, names, textFrom: m.index + m[0].length };
    }
    // Only elements that carry a scope or a property matter here. Tracking just those (and at most 512 deep) keeps
    // a hostile page of unclosed tags linear instead of rescanning an ever-growing stack.
    if (!selfClosing && (el.scope || el.prop) && stack.length < 512) stack.push(el);
  }
  // Unclosed property elements at end of document: take their text to the end.
  while (stack.length) { const el = stack.pop(); if (el.prop && !el.scope) assign(el.prop.scope, el.prop.names, textOf(src.slice(el.prop.textFrom))); }
  return items;
}

const first = (item, name) => { const v = item && item.props[name]; return v && v.length ? v[0] : null; };
const str = (v) => (v == null ? null : typeof v === 'string' ? (v.trim() || null) : (v.props ? (first(v, 'name') || null) : String(v)));

// A schema.org date value → ISO (offset known), 'YYYY-MM-DD' (date only) or the local value converted
// in the given zone. Without a zone a local date-time is kept as published (never re-zoned by guess).
function dateValue(v, tz) {
  const s = str(v);
  if (!s) return { value: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s, date_only: true };
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (local) return tz ? { value: localToUtcIso(local[1] + 'T' + local[2] + ':' + local[3], tz), zone: tz } : { value: s, timezone_missing: true };
  const d = new Date(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(d.getTime())) return { value: d.toISOString() };
  return { value: null, unparsed: s };
}

function placeFields(loc) {
  if (!loc) return {};
  if (typeof loc === 'string') return { venue_name: loc };
  const addr = first(loc, 'address');
  const out = { venue_name: str(first(loc, 'name')) };
  if (addr && addr.props) {
    out.address = str(first(addr, 'streetAddress'));
    out.city = str(first(addr, 'addressLocality'));
    out.state = str(first(addr, 'addressRegion'));
    out.zip = str(first(addr, 'postalCode'));
  } else if (addr) out.address = str(addr);
  const geo = first(loc, 'geo');
  if (geo && geo.props) {
    const lat = Number(str(first(geo, 'latitude'))), lng = Number(str(first(geo, 'longitude')));
    if (Number.isFinite(lat) && Number.isFinite(lng)) { out.lat = lat; out.lng = lng; }
  }
  return out;
}

/** schema.org Events in microdata / RDFa → feedConnector-shaped items. */
function parseMicrodataEvents(html, baseUrl, opts = {}) {
  const out = [];
  for (const it of parseItems(html, baseUrl)) {
    if (!/Event$/.test(it.type)) continue;
    const title = str(first(it, 'name'));
    if (!title) continue;
    const start = dateValue(first(it, 'startDate'), opts.timezone);
    const end = dateValue(first(it, 'endDate'), opts.timezone);
    const url = resolveUrl(str(first(it, 'url')), baseUrl) || null;
    const images = (it.props.image || []).map((v) => (v && v.props ? str(first(v, 'url')) || str(first(v, 'contentUrl')) : str(v)))
      .map((u) => resolveUrl(u, baseUrl)).filter(Boolean).map((u, i) => ({ url: u, position: i }));
    const payload = Object.assign({
      title,
      description: str(first(it, 'description')),
      start_at: start.value,
      end_at: end.value && !end.date_only ? end.value : null,
      end_date: end.value && end.date_only ? end.value : undefined,
      venue_name: null, address: null, city: null, state: null, zip: null,
      images,
    }, placeFields(first(it, 'location')));
    if (opts.timezone && (start.zone || end.zone)) payload.timezone = opts.timezone;
    const categories = [].concat(it.props.keywords || [], it.props.about || []).map(str).filter(Boolean);
    out.push({
      sourceEventId: url || it.id || (title + '|' + (start.value || '')),
      url,
      saleHints: [it.type, ...categories].filter(Boolean).join(' | ') || null,
      payload,
      evidence: { reader: 'microdata', itemtype: it.type, start_text: str(first(it, 'startDate')), end_text: str(first(it, 'endDate')),
        timezone_missing: !!(start.timezone_missing || end.timezone_missing) },
    });
  }
  return out;
}

module.exports = { parseMicrodataEvents, _internal: { parseItems, parseAttrs, decodeEntities, resolveUrl, dateValue } };
