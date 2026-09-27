#!/usr/bin/env node
/* typography-codemod.js — migrate ONE surface of pages to the shared type scale (public/css/typography.css).

   For each HTML file given:
     1. opts the page in: <html ... data-type-scale>, the Quicksand font link and /css/typography.css (once);
     2. replaces every font-size inside the page's own <style> blocks and style="" attributes with a semantic
        token (var(--fs-*)), chosen from the selector and the current size. Logos, brand wordmarks, icons and
        emoji keep their size (never enlarged to satisfy text rules). Anything it cannot classify is left
        unchanged and listed for manual review.
   Shared stylesheets (marketplace.css etc.) are NOT rewritten: shared components are restyled by scoped rules
   in typography.css, so pages outside the surface are unaffected.

   Dry run (default) prints the plan; --write applies it.
     node scripts/typography-codemod.js public/start-selling.html public/faq.html          # dry run
     node scripts/typography-codemod.js --write public/start-selling.html public/faq.html  # apply
*/
const fs = require('fs');
const path = require('path');

const FONT_LINK = '<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap" />';
const TYPE_LINK = '<link rel="stylesheet" href="/css/typography.css" data-type-scale-css />';

function toPx(v) {
  const s = String(v).trim(); let m;
  if ((m = s.match(/^clamp\(\s*([^,]+),[^,]+,\s*([^)]+)\)/))) return Math.max(toPx(m[1]) || 0, toPx(m[2]) || 0); // clamp -> its max
  if ((m = s.match(/^([\d.]+)rem/))) return +m[1] * 16;
  if ((m = s.match(/^([\d.]+)em/))) return +m[1] * 16;   // em: treated relative to 16px (reported as approximate)
  if ((m = s.match(/^([\d.]+)px/))) return +m[1];
  if ((m = s.match(/^([\d.]+)pt/))) return +m[1] * 4 / 3;
  return null;
}

// Decoration keeps its size: logos, wordmarks, icons, emoji, glyphs, pseudo-element marks and the illustrated
// mock-ups on marketing pages (.mk-*), which are pictures of the product, not readable text.
// how-it-works also draws product screenshots in HTML (browser frames, the lot-builder kit, a flow diagram).
const KEEP = /(logo|brand|wordmark|icon|\.ic\b|emoji|avatar|svg|glyph|check-item::before|::before|::after|step-num|\.n\b|spinner|badge-dot|\.mk-|-plus\b|formula-op|arrow|\.lb-|se-frame|se-pane|se-suggest|se-breeze|se-photo|se-shot|statusbar|se-node|se-video-poster)/i;
const CAPTION = /(eyebrow|badge|chip|pill|tag\b|\.q\b|label|kicker|caption|legal|fine|timestamp|col-title|th\b|thead|uppercase|stat .l|\.l\b|objection-q|hero-card-title|payout-title|example-payout-title)/i;
const SECONDARY = /(nav|footer|meta|muted|note|hint|help|sub-?text|small|table|td\b|tr\b|fee-row|payout-row|payout-line|crumb|breadcrumb|copy|tagline|trust)/i;
const CONTROL = /(btn|button|cta|\.tab\b|toggle|summary)/i;

function tokenFor(selector, px) {
  const sel = selector.replace(/\s+/g, ' ').trim();
  if (KEEP.test(sel)) return null;
  // Small uppercase labels ("eyebrows", card kickers, column titles) are captions even when named "...-title".
  if (px != null && px < 13 && CAPTION.test(sel)) return 'var(--fs-caption)';
  if (/(^|[\s,>])h1\b|hero-title|display/i.test(sel)) return 'var(--fs-h1)';
  // A heading inside a card, step, option or list item is a card title, not a section heading.
  const inComponent = /(card|item|step|option|who|objection|benefit|presence|tile|panel|box|col|banner|callout|cta|help|statement|header|pt-content)/i.test(sel);
  if (/(^|[\s,>])h2\b/i.test(sel) && inComponent && px != null && px < 22) return 'var(--fs-h3)';
  // A small uppercase "section title" is a label, not a heading.
  if (/section-title/i.test(sel) && px != null && px < 18) return 'var(--fs-caption)';
  if (/(^|[\s,>])h2\b|section-h2|section-title|page-title/i.test(sel)) return 'var(--fs-h2)';
  if (/(^|[\s,>])h3\b/i.test(sel)) return inComponent && (px == null || px < 20) ? 'var(--fs-h4)' : 'var(--fs-h3)';
  if (/(^|[\s,>])h[4-6]\b|card-title|\bname\b/i.test(sel)) return px >= 15 ? 'var(--fs-h4)' : 'var(--fs-body)';
  if (px == null) return undefined;
  if (px >= 40) return 'var(--fs-h1)';
  if (px >= 30) return 'var(--fs-h2)';
  if (px >= 24) return 'var(--fs-h3)';
  // Classify by the element itself (the last compound of the selector): a paragraph inside a CTA band is
  // body text, not a button; a <small> is a caption.
  const last = sel.split(/[\s>+~]+/).filter(Boolean).pop() || sel;
  if (/^p(\b|:|\.)/.test(last) || /(^|\s)p$/.test(sel)) return px >= 18.5 && /sub|lead|intro|hero/i.test(sel) ? 'var(--fs-lead)' : 'var(--fs-body)';
  if (/^small\b/.test(last)) return 'var(--fs-caption)';
  if (CONTROL.test(last) && !/(note|text|desc|sub|copy)/i.test(last) && px < 24) return 'var(--fs-control)';
  if (px >= 18.5) return /sub|lead|intro|hero/i.test(sel) ? 'var(--fs-lead)' : 'var(--fs-h4)';
  if (px < 12) return 'var(--fs-caption)';
  if (CAPTION.test(last)) return 'var(--fs-caption)';
  if (SECONDARY.test(last)) return 'var(--fs-secondary)';
  return 'var(--fs-body)';
}

function rewriteCss(css, file, report) {
  // Walk rule blocks (handles @media nesting by treating each "selector { decls }" leaf).
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (whole, selector, decls) => {
    if (!/font-size\s*:/i.test(decls)) return whole;
    const out = decls.replace(/font-size\s*:\s*([^;]+?)(\s*!important)?\s*(;|$)/gi, (m, value, imp, end) => {
      if (/var\(--fs-/.test(value)) return m;
      const px = toPx(value);
      const tok = tokenFor(selector, px);
      if (tok === null) { report.kept.push(file + '  ' + selector.trim().slice(0, 60) + ' { font-size: ' + value.trim() + ' }  (logo/icon: unchanged)'); return m; }
      if (tok === undefined) { report.manual.push(file + '  ' + selector.trim().slice(0, 60) + ' { font-size: ' + value.trim() + ' }'); return m; }
      report.changes.push({ file, selector: selector.trim().slice(0, 70), from: value.trim(), px: px == null ? null : Math.round(px * 10) / 10, to: tok });
      return 'font-size: ' + tok + (imp || '') + end;
    });
    return selector + '{' + out + '}';
  });
}

function rewriteHtml(html, file, report) {
  let out = html;
  // 1. opt in (idempotent)
  if (!/<html[^>]*data-type-scale/i.test(out)) out = out.replace(/<html([^>]*)>/i, '<html$1 data-type-scale>');
  if (out.indexOf('data-type-scale-css') === -1) {
    const anchor = out.match(/<meta[^>]+name="viewport"[^>]*>/i) || out.match(/<meta[^>]+charset[^>]*>/i);
    const block = '\n  ' + FONT_LINK + '\n  ' + TYPE_LINK;
    out = anchor ? out.replace(anchor[0], anchor[0] + block) : out.replace(/<head[^>]*>/i, (h) => h + block);
  }
  // 2. page <style> blocks
  out = out.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, c) => a + rewriteCss(css, file, report) + c);
  // 3. inline style="" font sizes (selector context = the element's class attribute when present)
  out = out.replace(/<([a-z0-9]+)([^>]*?)\sstyle="([^"]*font-size[^"]*)"/gi, (m, tag, attrs, style) => {
    const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
    const sel = tag + (cls ? '.' + cls.split(/\s+/).join('.') : '');
    const newStyle = style.replace(/font-size\s*:\s*([^;]+)/i, (mm, v) => {
      if (/var\(--fs-/.test(v)) return mm;
      const px = toPx(v); const tok = tokenFor(sel, px);
      if (!tok) { (tok === null ? report.kept : report.manual).push(file + '  <' + sel + ' style="font-size:' + v.trim() + '">'); return mm; }
      report.changes.push({ file, selector: '<' + sel + '> inline', from: v.trim(), px: px == null ? null : Math.round(px * 10) / 10, to: tok });
      return 'font-size:' + tok;
    });
    return '<' + tag + attrs + ' style="' + newStyle + '"';
  });
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const files = args.filter((a) => !a.startsWith('--'));
  const report = { changes: [], manual: [], kept: [] };
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const out = rewriteHtml(src, path.basename(f), report);
    if (write && out !== src) fs.writeFileSync(f, out);
  }
  const byTok = report.changes.reduce((m, c) => { m[c.to] = (m[c.to] || 0) + 1; return m; }, {});
  console.log(JSON.stringify({ mode: write ? 'WRITE' : 'DRY RUN', files: files.length, replaced: report.changes.length, by_token: byTok,
    left_unchanged_logo_icon: report.kept.length, needs_manual_review: report.manual.length }, null, 1));
  if (report.manual.length) console.log('MANUAL:\n  ' + report.manual.join('\n  '));
  if (process.env.SHOW_CHANGES) for (const c of report.changes) console.log(c.file, '|', c.selector, '|', c.from, '(' + c.px + 'px) ->', c.to);
}

module.exports = { toPx, tokenFor, rewriteCss, rewriteHtml, FONT_LINK, TYPE_LINK };
