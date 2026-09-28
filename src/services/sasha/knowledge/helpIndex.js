'use strict';

/**
 * helpIndex — Sasha's searchable copy of Advantage.Bid's PUBLIC help and policy pages.
 *
 * Built from the live page files at first use, so it always matches what customers can already read (no duplicated
 * manual to keep in sync). Pages are split into sections by heading and searched with a small keyword ranker —
 * deterministic, no external service. Only public, customer-facing pages are indexed (never dashboards or admin).
 *
 * Priority for answers (enforced in the system prompt): live platform facts > approved guidance > these pages.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', '..', 'public');
const SITE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

// Public, informational pages only (curated: app/dashboard pages are excluded on purpose).
const HELP_PAGES = [
  'faq.html', 'buyer-faq.html', 'how-to-buy.html', 'how-it-works.html', 'buyer-terms.html', 'terms.html', 'privacy.html',
  'seller-faq.html', 'start-selling.html', 'become-seller.html', 'become-professional-seller.html', 'professional-sellers.html',
  'how-sellers-get-paid.html', 'shipping-available.html', 'appraiser-membership.html', 'promote-estate-sale.html', 'after-estate-sale.html',
];

const STOP = new Set(('a an the and or of to in on for is are be it this that with as at by from your you our we can do does how what '
  + 'when where why who will my me i if not no yes any all into about may more than then there their they them its was were has have had '
  + 'please thanks hi hello').split(' '));

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '—')
  .replace(/&ndash;/g, '–').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%$.\s-]/g, ' ').split(/\s+/)
  .map((t) => t.replace(/^[.-]+|[.-]+$/g, '')).filter((t) => t && t.length > 1 && !STOP.has(t));

/** Split one page's HTML into { heading, text } sections (scripts/styles/nav/footer removed). */
function sectionsFromHtml(html) {
  let body = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const title = decode(((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim());
  body = body.replace(/<head[\s\S]*?<\/head>/i, ' ');
  const parts = body.split(/<h[1-4][^>]*>/i);
  const out = [];
  parts.forEach((part, i) => {
    let heading = i === 0 ? title : '';
    let rest = part;
    if (i > 0) {
      const m = part.match(/^([\s\S]*?)<\/h[1-4]>/i);
      heading = m ? decode(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
      rest = m ? part.slice(m[0].length) : part;
    }
    const text = decode(rest.replace(/<(br|\/p|\/li|\/div|\/tr)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    if (text.length > 40) out.push({ heading: heading || title, text: text.slice(0, 2400) });
  });
  return { title, sections: out };
}

let INDEX = null;
function build() {
  const docs = [];
  for (const file of HELP_PAGES) {
    let html;
    try { html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'); } catch (_e) { continue; }
    const { title, sections } = sectionsFromHtml(html);
    for (const s of sections) {
      const toks = tokens(s.heading + ' ' + s.heading + ' ' + s.text);   // headings count double
      const tf = new Map(); toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
      docs.push({ page: file, url: `${SITE}/${file}`, title, heading: s.heading, text: s.text, tf, len: toks.length || 1 });
    }
  }
  const df = new Map();
  docs.forEach((d) => d.tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));
  const avg = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
  INDEX = { docs, df, avg, n: docs.length, builtAt: new Date().toISOString() };
  return INDEX;
}

/** BM25 search over help sections. Returns [{ page, url, heading, text, score }]. */
function search(query, limit = 5) {
  const idx = INDEX || build();
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const k1 = 1.4, b = 0.75;
  const scored = idx.docs.map((d) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t); if (!f) continue;
      const idf = Math.log(1 + (idx.n - (idx.df.get(t) || 0) + 0.5) / ((idx.df.get(t) || 0) + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / idx.avg));
    }
    return { d, s };
  }).filter((x) => x.s > 0).sort((a, b2) => b2.s - a.s).slice(0, limit);
  return scored.map(({ d, s }) => ({ page: d.page, url: d.url, heading: d.heading, text: d.text.slice(0, 1400), score: Math.round(s * 100) / 100 }));
}

function stats() { const idx = INDEX || build(); return { pages: HELP_PAGES.length, sections: idx.n, built_at: idx.builtAt }; }

module.exports = { search, stats, sectionsFromHtml, HELP_PAGES, _reset: () => { INDEX = null; } };
