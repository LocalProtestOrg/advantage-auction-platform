'use strict';

const scan = require('./scan');

/**
 * htmlEvent — generic extraction of ONE event from a public event detail page that publishes no
 * structured data (Phase 4 of provider-neutral discovery). Pure: string in, result out; no network.
 *
 * ACCURACY OVER COVERAGE. A wrong sale date is the one failure the platform must not have, so:
 *   • a date is taken ONLY from a <time datetime> element or from text right after an explicit label
 *     ("Auction begins:", "Sale Dates:", "Bidding closes:" …);
 *   • dates after excluded labels (preview, inspection, pickup, removal, checkout, registration,
 *     posted / published / updated) are never a start or end, and a WordPress post-date <time> is
 *     never an event date;
 *   • two different labeled start dates → not ok ('competing_dates'), or 'multiple_events' when they
 *     sit under different headings; no year → not ok ('year_missing') unless the page URL states it;
 *     a time with no time zone (no abbreviation, no channel zone) → not ok ('timezone_unknown');
 *   • a location is taken only from a structured address or a full US postal address.
 * The result says what each value was read from (evidence); a channel's confirmed profile and
 * checkDrift() detect when the site's pages stop matching what an administrator confirmed.
 *
 *   extractEventFromHtml(html, pageUrl, { timezone, profile }) → { ok, item, confidence, reasons, evidence, drift? }
 *   buildProfile(samples)                                       → profile
 *   checkDrift(profile, result)                                 → { drift, reasons }
 */

const { localToUtcIso } = require('../../../lib/timezoneUtils');
const microdata = require('./microdata');

const { parseAttrs, decodeEntities } = microdata._internal;
const textOf = (html) => decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// ── vocabulary ────────────────────────────────────────────────────────────────────────────────
const START_LABELS = ['online auction begins', 'online auction starts', 'online auction opens', 'auction begins', 'auction starts',
  'auction start', 'auction dates', 'auction date', 'bidding opens', 'bidding begins', 'bidding starts', 'live auction',
  'sale dates', 'sale date', 'sale starts', 'sale begins', 'sale hours', 'start date', 'start time', 'starts', 'dates', 'date'];
const END_LABELS = ['lots begin closing', 'lots start closing', 'lots begin to close', 'lots close', 'bidding closes', 'bidding ends',
  'auction ends', 'auction closes', 'auction end', 'end date', 'ends', 'closes'];
const EXCLUDED_WORDS = /\b(preview|inspection|pick[\s-]?up|removal|check[\s-]?out|registration|register|posted|published|updated|modified|payment due|deadline)\b/i;
const EXCLUDED_CLASS = /\b(published|updated|entry-date|post-date|posted-on|posted|modified|byline|entry-meta|post-meta)\b/i;

const byLength = (a, b) => b.length - a.length;
const labelAlt = (list) => list.slice().sort(byLength).map((l) => l.replace(/\s+/g, '\\s+')).join('|');
const START_RE = new RegExp('^(' + labelAlt(START_LABELS) + ')(?:\\s*\\(s\\))?\\s*(?:[:\\-–—]\\s*|\\s+(?=\\S))(.*)$', 'i');
const END_RE = new RegExp('^(' + labelAlt(END_LABELS) + ')(?:\\s*\\(s\\))?\\s*(?:[:\\-–—]\\s*|\\s+(?=\\S))(.*)$', 'i');
const START_ONLY = new RegExp('^(' + labelAlt(START_LABELS) + ')(?:\\s*\\(s\\))?\\s*:?$', 'i');
const END_ONLY = new RegExp('^(' + labelAlt(END_LABELS) + ')(?:\\s*\\(s\\))?\\s*:?$', 'i');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const TZ_ABBR = { cst: 'America/Chicago', cdt: 'America/Chicago', ct: 'America/Chicago', central: 'America/Chicago',
  est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York', eastern: 'America/New_York',
  mst: 'America/Denver', mdt: 'America/Denver', mt: 'America/Denver', mountain: 'America/Denver',
  pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles', pacific: 'America/Los_Angeles' };

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
const validDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

// ── text model ────────────────────────────────────────────────────────────────────────────────
// Lines of visible text. <time datetime> becomes a marker ⟦T:value|x?⟧ (x = a post/updated date),
// headings become ⟦H⟧ lines so different sections can be told apart.
function toLines(html) {
  // Linear scanning throughout (readers/scan): hostile markup cannot make this quadratic.
  let s = scan.stripBlocks(html, ['script', 'style', 'noscript', 'template']);
  const body = scan.between(s, '<body', '</body>');
  if (body != null) s = body;
  let rebuilt = ''; let at = 0;
  for (const el of scan.elements(s, 'time')) {
    const a = parseAttrs(el.attrs);
    rebuilt += s.slice(at, el.start);
    if (!a.datetime) rebuilt += el.inner;
    else {
      const excluded = EXCLUDED_CLASS.test(a.class || '') || EXCLUDED_CLASS.test(a.itemprop || '') || /date(published|modified)/i.test(a.itemprop || '');
      rebuilt += ' ⟦T:' + a.datetime.replace(/[⟦⟧|]/g, '') + '|' + (excluded ? 'x' : '') + '⟧ ' + el.inner;
    }
    at = el.end;
  }
  s = rebuilt + s.slice(at);
  s = s.replace(/<h([1-6])\b[^>]*>/gi, '\n⟦H$1⟧ ').replace(/<\/h[1-6]>/gi, '\n');
  s = s.replace(/<\/?(br|p|div|li|tr|td|th|dt|dd|section|article|header|footer|ul|ol|table|tbody|thead|hr|nav|aside|main|figure|figcaption|blockquote)\b[^>]*>/gi, '\n');
  s = decodeEntities(s.replace(/<[^>]*>/g, ' '));
  return s.split(/\n/).map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean);
}

const isHeading = (l) => /^⟦H[1-6]⟧/.test(l);
const stripMarkers = (l) => l.replace(/⟦T:[^⟧]*⟧/g, '').replace(/^⟦H[1-6]⟧\s*/, '').replace(/\s+/g, ' ').trim();
const timeMarkers = (l) => [...String(l).matchAll(/⟦T:([^|⟧]*)\|(x?)⟧/g)].map((m) => ({ value: m[1].trim(), excluded: m[2] === 'x' }));

// Text before a colon (within the first 40 characters) is the line's label.
function labelSegment(line) {
  const t = stripMarkers(line);
  const i = t.indexOf(':');
  return i > -1 && i <= 40 ? t.slice(0, i) : t.slice(0, 30);
}

// ── date parsing ──────────────────────────────────────────────────────────────────────────────
function parseTimes(text) {
  const out = [];
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])|\bnoon\b/gi;
  let m;
  while ((m = re.exec(text)) && out.length < 2) {
    if (/noon/i.test(m[0])) { out.push({ h: 12, mi: 0 }); continue; }
    let h = Number(m[1]); const mi = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || mi > 59) continue;
    const pm = /^p/i.test(m[3]);
    if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0;
    out.push({ h, mi });
  }
  if (!out.length) {
    const t24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
    while ((m = t24.exec(text)) && out.length < 2) out.push({ h: Number(m[1]), mi: Number(m[2]) });
  }
  return out;
}

function parseTz(text) {
  const m = /\b(CST|CDT|CT|EST|EDT|ET|MST|MDT|MT|PST|PDT|PT|Central|Eastern|Mountain|Pacific)(?:\s+(?:time|standard time|daylight time))?\b/.exec(text);
  return m ? { abbr: m[1], zone: TZ_ABBR[m[1].toLowerCase()] } : null;
}

// Year stated by the page URL for this month (e.g. /estate-sale-september-19-2026/). Pure.
function yearFromUrl(pageUrl, month) {
  let path = '';
  try { path = decodeURIComponent(new URL(pageUrl).pathname).toLowerCase(); } catch (_) { return null; }
  const name = MONTH_NAMES[month - 1];
  if (!path.includes(name) && !path.includes(name.slice(0, 3) + '-')) return null;
  const y = /(?:^|[^\d])(20\d{2})(?:[^\d]|$)/.exec(path);
  return y ? Number(y[1]) : null;
}

/**
 * Parse one labeled value. Returns { date:{y,m,d}, end_date?, times:[], tz?, instant?, year_source } or { error }.
 * Never fills in a missing part from anywhere but the value itself (or the page URL for a year).
 */
function parseDateText(value, { pageUrl } = {}) {
  const text = String(value || '');
  const iso = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?/.exec(text);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!validDate(y, m, d)) return { error: 'unparsed' };
    if (iso[4] && iso[6]) {
      const t = new Date(iso[0].replace(' ', 'T'));
      if (!Number.isNaN(t.getTime())) return { date: { y, m, d }, instant: t.toISOString(), times: [], year_source: 'value' };
    }
    return { date: { y, m, d }, times: iso[4] ? [{ h: Number(iso[4]), mi: Number(iso[5]) }] : parseTimes(text.slice(iso.index + iso[0].length)),
      tz: parseTz(text), year_source: 'value' };
  }
  const num = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b(?:\s*(?:–|—|-|to|through|thru)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b)?/.exec(text);
  if (num) {
    const [m, d, y] = [Number(num[1]), Number(num[2]), Number(num[3])];
    if (!validDate(y, m, d)) return { error: 'unparsed' };
    const out = { date: { y, m, d }, times: parseTimes(text.slice(num.index + num[0].length)), tz: parseTz(text), year_source: 'value' };
    if (num[4]) { const e = { y: Number(num[6]), m: Number(num[4]), d: Number(num[5]) }; if (validDate(e.y, e.m, e.d)) out.end_date = e; }
    return out;
  }
  const re = new RegExp('\\b' + MONTH_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?'
    + '(?:\\s*(?:–|—|-|&|and|to|through|thru)\\s*(?:' + MONTH_RE + '\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?![:\\d]|\\s*(?:a\\.?\\s?m|p\\.?\\s?m)))?'
    + '(?:,?\\s*(\\d{4}))?', 'i');
  const md = re.exec(text);
  if (!md) return { error: 'unparsed' };
  const month = MONTHS[md[1].toLowerCase().slice(0, 3)];
  const day = Number(md[2]);
  let year = md[5] ? Number(md[5]) : null, year_source = 'value';
  if (!year) { year = yearFromUrl(pageUrl, month); year_source = 'url'; }
  if (!year) return { error: 'year_missing' };
  if (!validDate(year, month, day)) return { error: 'unparsed' };
  const out = { date: { y: year, m: month, d: day }, times: parseTimes(text.slice(md.index + md[0].length)), tz: parseTz(text), year_source };
  if (md[4]) {
    const em = md[3] ? MONTHS[md[3].toLowerCase().slice(0, 3)] : month;
    const ed = Number(md[4]);
    const ey = em < month ? year + 1 : year;
    if (validDate(ey, em, ed) && (ey > year || em > month || ed > day)) out.end_date = { y: ey, m: em, d: ed };
  }
  return out;
}

// A parsed value → { start_at, end_at?, end_date?, timezone?, timezone_source, has_time } or { error }.
function resolve(p, zoneOption) {
  if (p.error) return { error: p.error };
  const day = ymd(p.date.y, p.date.m, p.date.d);
  if (p.instant) return { day, start_at: p.instant, has_time: true, timezone_source: 'offset' };
  const tzZone = p.tz ? p.tz.zone : null;
  const zone = tzZone || zoneOption || null;
  const out = { day, has_time: p.times.length > 0, timezone_source: tzZone ? 'abbreviation' : (zoneOption ? 'channel' : null) };
  if (p.times.length) {
    if (!zone) return { error: 'timezone_unknown' };
    out.timezone = zone;
    out.start_at = localToUtcIso(day + 'T' + pad(p.times[0].h) + ':' + pad(p.times[0].mi), zone);
    if (p.times[1]) {
      const ed = p.end_date ? ymd(p.end_date.y, p.end_date.m, p.end_date.d) : day;
      out.end_at = localToUtcIso(ed + 'T' + pad(p.times[1].h) + ':' + pad(p.times[1].mi), zone);
    } else if (p.end_date) out.end_date = ymd(p.end_date.y, p.end_date.m, p.end_date.d);
  } else {
    out.start_at = day;
    if (p.end_date) out.end_date = ymd(p.end_date.y, p.end_date.m, p.end_date.d);
  }
  return out;
}

// A <time datetime> value → resolved date.
function resolveTimeValue(v, zoneOption) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { day: v, start_at: v, has_time: false, timezone_source: null };
  return resolve(parseDateText(v), zoneOption);
}

// ── page parts ────────────────────────────────────────────────────────────────────────────────
function metaContent(html, prop) {
  const re = /<meta\b([^>]*)>/gi; let m;
  while ((m = re.exec(html))) { const a = parseAttrs(m[1]); if ((a.property || a.name || '').toLowerCase() === prop) return (a.content || '').trim() || null; }
  return null;
}
function linkHref(html, rel) {
  const re = /<link\b([^>]*)>/gi; let m;
  while ((m = re.exec(html))) { const a = parseAttrs(m[1]); if ((a.rel || '').toLowerCase().split(/\s+/).includes(rel) && a.href) return a.href; }
  return null;
}
function stripSiteSuffix(t, siteName) {
  if (!t || !siteName) return t;
  const parts = t.split(/\s+(?:\||–|—|-|::)\s+/);
  if (parts.length > 1 && parts[parts.length - 1].trim().toLowerCase() === siteName.trim().toLowerCase()) return parts.slice(0, -1).join(' - ').trim();
  return t;
}
function titleOf(html) {
  const site = metaContent(html, 'og:site_name');
  const og = metaContent(html, 'og:title');
  if (og) return { title: stripSiteSuffix(decodeEntities(og), site), source: 'og:title' };
  const h1s = [...new Set(scan.elements(html, 'h1').map((el) => textOf(el.inner)).filter(Boolean))];
  if (h1s.length > 1) return { error: 'multiple_titles', candidates: h1s.slice(0, 5) };
  if (h1s.length === 1) return { title: h1s[0], source: 'h1' };
  const te = scan.elements(html, 'title', { limit: 1 })[0];
  const t = te ? [null, te.inner] : null;
  if (t && textOf(t[1])) return { title: stripSiteSuffix(textOf(t[1]), site), source: 'title' };
  return { error: 'no_title' };
}
function hintsOf(html) {
  const out = [];
  for (const m of String(html).matchAll(/<(nav|div|ol|ul|span|p)\b[^>]*class=["'][^"']*\b(breadcrumbs?|cat-links|categories|post-categories)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi)) out.push(textOf(m[3]));
  for (const m of String(html).matchAll(/<a\b[^>]*rel=["'][^"']*\bcategory\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) out.push(textOf(m[1]));
  return [...new Set(out.filter(Boolean))];
}

const STREET = '(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Trl|Trail|Loop|Fwy|Freeway|Sq|Square|Ter|Terrace)';
const POSTAL = new RegExp('(\\d{1,6}\\s+[A-Za-z0-9.\'# -]{1,60}?\\b' + STREET + '\\.?(?:\\s+(?:Suite|Ste\\.?|Unit|#)\\s*[\\w-]+)?)\\s*,?\\s+([A-Za-z][A-Za-z .\'-]{1,40}?),\\s*([A-Z]{2})\\.?\\s+(\\d{5})(?:-\\d{4})?\\b');

function locationOf(html, lines) {
  for (const it of microdata._internal.parseItems(html)) {
    if (!/PostalAddress$/.test(it.type)) continue;
    const g = (k) => { const v = it.props[k]; return v && v.length && typeof v[0] === 'string' ? v[0].trim() || null : null; };
    if (g('streetAddress') && g('addressLocality') && g('addressRegion')) {
      return { address: g('streetAddress'), city: g('addressLocality'), state: g('addressRegion'), zip: g('postalCode'), source: 'structured_address' };
    }
  }
  // Excluded lines (e.g. "Pickup location: …") never supply the sale's location.
  const usable = lines.filter((l) => !isHeading(l) && !EXCLUDED_WORDS.test(labelSegment(l))).map(stripMarkers);
  for (let i = 0; i < usable.length; i++) {
    for (const t of [usable[i], usable[i] + ', ' + (usable[i + 1] || ''), usable[i] + ' ' + (usable[i + 1] || '')]) {
      const m = POSTAL.exec(t);
      if (m) return { address: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4], source: 'postal_address' };
    }
  }
  return null;
}

// ── extraction ────────────────────────────────────────────────────────────────────────────────
function extractEventFromHtml(html, pageUrl, opts = {}) {
  const reasons = [];
  const evidence = { reader: 'html', excluded_dates: [] };
  const src = String(html || '');
  const lines = toLines(src);

  const t = titleOf(src);
  if (t.error) reasons.push(t.error); else evidence.title_source = t.source;

  // Labeled candidates.
  const starts = [], ends = [];
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isHeading(line)) { heading = i; continue; }
    const seg = labelSegment(line);
    const plain = stripMarkers(line);
    if (EXCLUDED_WORDS.test(seg)) { evidence.excluded_dates.push({ label: seg.slice(0, 40), text: plain.slice(0, 120) }); continue; }
    let m = START_RE.exec(plain), kind = 'start';
    if (!m) { m = END_RE.exec(plain); kind = 'end'; }
    let label, value, markers = timeMarkers(line);
    if (m) { label = m[1]; value = m[2]; }
    else {
      const only = START_ONLY.exec(plain) || END_ONLY.exec(plain);
      if (only && lines[i + 1] && !isHeading(lines[i + 1])) {
        kind = START_ONLY.test(plain) ? 'start' : 'end'; label = only[1]; value = stripMarkers(lines[i + 1]); markers = timeMarkers(lines[i + 1]);
      } else continue;
    }
    // A value never runs on into an excluded label ("Nov 14 – 15 … Preview: Nov 13").
    value = String(value).split(EXCLUDED_WORDS)[0];
    const marker = markers.find((x) => !x.excluded);
    const parsed = marker ? resolveTimeValue(marker.value, opts.timezone) : resolve(parseDateText(value, { pageUrl }), opts.timezone);
    if (parsed.error) { if (parsed.error !== 'unparsed') reasons.push(parsed.error); continue; }
    (kind === 'start' ? starts : ends).push({ label: label.toLowerCase().replace(/\s+/g, ' '), text: value.trim().slice(0, 160), heading,
      source: marker ? 'time_element' : 'labeled_text', parsed });
  }
  // Unlabeled <time datetime> elements outside excluded contexts (a post date is never one of them).
  const freeTimes = [];
  for (const line of lines) {
    const seg = labelSegment(line);
    if (EXCLUDED_WORDS.test(seg) || START_RE.test(stripMarkers(line)) || END_RE.test(stripMarkers(line))) continue;
    for (const mk of timeMarkers(line)) {
      if (mk.excluded) { evidence.excluded_dates.push({ label: 'post date', text: mk.value }); continue; }
      const p = resolveTimeValue(mk.value, opts.timezone);
      if (!p.error) freeTimes.push({ label: null, text: mk.value, heading: -1, source: 'time_element', parsed: p });
    }
  }

  let start = null;
  const distinct = (list) => [...new Set(list.map((c) => c.parsed.day))];
  if (starts.length) {
    const days = distinct(starts);
    if (days.length > 1) {
      const headings = new Set(starts.map((c) => c.heading));
      reasons.push(headings.size > 1 ? 'multiple_events' : 'competing_dates');
    } else {
      start = starts.find((c) => c.parsed.has_time) || starts[0];
    }
  } else if (freeTimes.length) {
    if (distinct(freeTimes).length > 1) reasons.push('competing_dates');
    else start = freeTimes.find((c) => c.parsed.has_time) || freeTimes[0];
  } else if (!reasons.some((r) => /year_missing|timezone_unknown/.test(r))) reasons.push('no_event_date');

  let end = null;
  if (start && ends.length) {
    const days = distinct(ends);
    if (days.length > 1) reasons.push('competing_end_dates'); else end = ends.find((c) => c.parsed.has_time) || ends[0];
  }

  const loc = locationOf(src, lines);
  const canonical = linkHref(src, 'canonical') || metaContent(src, 'og:url') || pageUrl;
  let url = null;
  try { const u = new URL(canonical, pageUrl); u.hash = ''; url = u.toString(); } catch (_) { url = pageUrl || null; }

  const payload = { title: t.title || null, description: metaContent(src, 'og:description') || metaContent(src, 'description') || null,
    start_at: null, end_at: null, venue_name: null, address: null, city: null, state: null, zip: null, images: [] };
  if (start) {
    payload.start_at = start.parsed.start_at;
    if (start.parsed.end_at) payload.end_at = start.parsed.end_at;
    if (start.parsed.end_date) payload.end_date = start.parsed.end_date;
    if (start.parsed.timezone) payload.timezone = start.parsed.timezone;
    evidence.date_source = start.source; evidence.date_label = start.label; evidence.date_text = start.text;
    evidence.timezone = start.parsed.timezone || null; evidence.timezone_source = start.parsed.timezone_source;
  }
  if (end) {
    const e = end.parsed;
    if (e.has_time && e.start_at) { payload.end_at = e.start_at; delete payload.end_date; }
    else if (!payload.end_at) payload.end_date = e.day;
    evidence.end_label = end.label; evidence.end_text = end.text;
  }
  if (payload.end_at && payload.start_at && /T/.test(payload.start_at) && Date.parse(payload.end_at) < Date.parse(payload.start_at)) {
    reasons.push('end_before_start'); payload.end_at = null;
  }
  if (loc) { Object.assign(payload, { address: loc.address, city: loc.city, state: loc.state, zip: loc.zip }); evidence.location_source = loc.source; }
  const img = metaContent(src, 'og:image');
  if (img) { try { payload.images = [{ url: new URL(img, pageUrl).toString(), position: 0 }]; } catch (_) { /* no image */ } }

  const blocking = ['multiple_titles', 'no_title', 'competing_dates', 'multiple_events', 'no_event_date', 'year_missing', 'timezone_unknown'];
  const ok = !!(payload.title && payload.start_at) && !reasons.some((r) => blocking.includes(r) && !(start && (r === 'year_missing' || r === 'timezone_unknown')));
  let confidence = 0;
  if (payload.title) confidence += evidence.title_source === 'title' ? 0.2 : 0.3;
  if (start) confidence += start.source === 'time_element' ? 0.35 : 0.3;
  if (start && start.parsed.has_time) confidence += 0.1;
  if (start && start.parsed.timezone_source === 'abbreviation') confidence += 0.05;
  if (loc) confidence += 0.15;
  if (end) confidence += 0.05;
  if (!ok) confidence = Math.min(confidence, 0.4);

  const result = {
    ok,
    item: { sourceEventId: url, url, saleHints: [payload.title, ...hintsOf(src)].filter(Boolean).join(' | ') || null, payload, evidence },
    confidence: Math.round(Math.min(1, confidence) * 100) / 100,
    reasons: [...new Set(reasons)],
    evidence,
  };
  if (opts.profile) result.drift = checkDrift(opts.profile, result);
  return result;
}

// ── confirmed profiles ────────────────────────────────────────────────────────────────────────
const mode = (xs) => { const c = {}; let best = null; for (const x of xs.filter((v) => v != null)) { c[x] = (c[x] || 0) + 1; if (best == null || c[x] > c[best]) best = x; } return best; };

/** What an administrator confirmed about a channel's pages, from the confirmed extraction results. Pure. */
function buildProfile(samples) {
  const ok = (samples || []).filter((s) => s && s.ok);
  return {
    version: 1,
    title_source: mode(ok.map((s) => s.evidence.title_source)),
    date_source: mode(ok.map((s) => s.evidence.date_source)),
    date_labels: [...new Set(ok.map((s) => s.evidence.date_label).filter(Boolean))],
    end_labels: [...new Set(ok.map((s) => s.evidence.end_label).filter(Boolean))],
    timezone: mode(ok.map((s) => s.evidence.timezone)),
    location_source: mode(ok.map((s) => s.evidence.location_source)),
    confirmed_samples: ok.length,
  };
}

/** Does a new extraction still match the confirmed profile? Pure. */
function checkDrift(profile, result) {
  const reasons = [];
  if (!profile) return { drift: false, reasons };
  if (!result || !result.ok) reasons.push('extraction_failed' + (result && result.reasons && result.reasons.length ? ':' + result.reasons.join(',') : ''));
  const ev = (result && result.evidence) || {};
  if (profile.title_source && ev.title_source && ev.title_source !== profile.title_source) reasons.push('title_source_changed');
  if (result && result.ok) {
    if (profile.date_labels && profile.date_labels.length && ev.date_label && !profile.date_labels.includes(ev.date_label)) reasons.push('date_label_changed');
    if (profile.date_source && ev.date_source && ev.date_source !== profile.date_source) reasons.push('date_source_changed');
    if (profile.location_source && !ev.location_source) reasons.push('location_missing');
    if (profile.timezone && ev.timezone && ev.timezone !== profile.timezone) reasons.push('timezone_changed');
  }
  return { drift: reasons.length > 0, reasons };
}

module.exports = { extractEventFromHtml, buildProfile, checkDrift,
  _internal: { toLines, parseDateText, resolve, parseTimes, parseTz, titleOf, locationOf, yearFromUrl, START_LABELS, END_LABELS } };
