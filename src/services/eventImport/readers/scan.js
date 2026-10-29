'use strict';

/**
 * scan — linear-time HTML/XML scanning helpers for content from websites we do not control.
 *
 * WHY. Lazy regex spans such as /<a\b[^>]*>([\s\S]*?)<\/a>/g or /<!--[\s\S]*?-->/g go quadratic when a hostile
 * page repeats an opener without its closer (each attempt scans to the end of the document). Every reader that
 * handles a partner's page uses these indexOf-based helpers instead, and every body is capped first.
 *
 *   capped(text)                          the text, cut to MAX_PARSE_BYTES
 *   stripBlocks(html, tags, {comments})   remove <!-- … --> and <tag …>…</tag> blocks, linearly
 *   elements(text, tag)                   [{ attrs, inner, start, end }] for every <tag …>inner</tag>, linearly
 *   between(text, open, close)            the first inner span between two literal markers (case-insensitive)
 */

const MAX_PARSE_BYTES = 1024 * 1024;

function capped(text) { const s = String(text == null ? '' : text); return s.length > MAX_PARSE_BYTES ? s.slice(0, MAX_PARSE_BYTES) : s; }

/** Remove comments and whole <tag>…</tag> blocks. Each closer is searched once per block: linear overall. */
function stripBlocks(html, tags = [], { comments = true } = {}) {
  let s = capped(html);
  if (comments) {
    let out = ''; let i = 0;
    for (;;) {
      const a = s.indexOf('<!--', i);
      if (a < 0) { out += s.slice(i); break; }
      out += s.slice(i, a);
      const b = s.indexOf('-->', a + 4);
      if (b < 0) break;            // an unclosed comment hides the rest, as a browser would
      i = b + 3;
    }
    s = out;
  }
  for (const tag of tags) {
    const lower = s.toLowerCase();
    const open = '<' + tag; const close = '</' + tag;
    let out = ''; let i = 0;
    for (;;) {
      let a = lower.indexOf(open, i);
      while (a >= 0 && /[\w-]/.test(lower.charAt(a + open.length))) a = lower.indexOf(open, a + 1);   // <script vs <scripts
      if (a < 0) { out += s.slice(i); break; }
      out += s.slice(i, a);
      const b = lower.indexOf(close, a + open.length);
      if (b < 0) break;
      const gt = lower.indexOf('>', b);
      i = gt < 0 ? s.length : gt + 1;
    }
    s = out;
  }
  return s;
}

/**
 * Every <tag attrs>inner</tag> in order (no nesting awareness, like the regexes it replaces). The next closer is
 * cached, so many unclosed openers cost one scan, not one scan each.
 */
function elements(text, tag, { limit = 5000 } = {}) {
  const s = capped(text);
  const lower = s.toLowerCase();
  const open = '<' + tag.toLowerCase(); const close = '</' + tag.toLowerCase();
  const out = [];
  let i = 0; let nextClose = -2;
  while (out.length < limit) {
    let a = lower.indexOf(open, i);
    while (a >= 0 && /[\w:-]/.test(lower.charAt(a + open.length))) a = lower.indexOf(open, a + 1);
    if (a < 0) break;
    const gt = lower.indexOf('>', a + open.length);
    if (gt < 0) break;
    if (nextClose !== -1 && nextClose < gt) nextClose = lower.indexOf(close, gt);
    if (nextClose < 0) break;      // no closer anywhere after this point: nothing more can match
    const endGt = lower.indexOf('>', nextClose);
    out.push({ attrs: s.slice(a + open.length, gt), inner: s.slice(gt + 1, nextClose), start: a, end: endGt < 0 ? s.length : endGt + 1 });
    i = endGt < 0 ? s.length : endGt + 1;
  }
  return out;
}

/** The first span between two literal markers (case-insensitive), or null. */
function between(text, openMarker, closeMarker) {
  const s = capped(text); const lower = s.toLowerCase();
  const a = lower.indexOf(openMarker.toLowerCase());
  if (a < 0) return null;
  const gt = lower.indexOf('>', a);
  if (gt < 0) return null;
  const b = lower.lastIndexOf(closeMarker.toLowerCase());
  return b > gt ? s.slice(gt + 1, b) : s.slice(gt + 1);
}

module.exports = { MAX_PARSE_BYTES, capped, stripBlocks, elements, between };
