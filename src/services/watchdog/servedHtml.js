'use strict';

/**
 * servedHtml — every page AS SERVED, including pages behind sign-in that no outside monitor can open.
 *
 * The 2026-10-30 seller agreement defect: sign-agreement.html was correct on disk, but the server's tag injection put
 * a <script> inside the page's own script, so the seller saw raw JavaScript. This check reads each page from disk,
 * applies the REAL injection code (src/middleware/sashaTag and src/middleware/analyticsTag, which use
 * src/lib/htmlInjection) exactly as the server would, and verifies that:
 *   - every inline script that is valid JavaScript on disk is still valid after injection, and
 *   - each injected tag is a real script element (not swallowed into another script's text).
 * Pages the middleware excludes are still checked: an exclusion is a policy, not a guarantee that a page is safe.
 * Pure file reading; no network, no database, no change to anything.
 */

const fs = require('fs');
const path = require('path');
const { parseDocument } = require('htmlparser2');
const { scriptsOf, scriptError } = require('./htmlAnalysis');
const sashaTag = require('../../middleware/sashaTag');
const analyticsTag = require('../../middleware/analyticsTag');

const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', 'public');
const PROBE_ID = 'G-WATCHDOG01';                     // a syntactically valid measurement id; never sent anywhere

function htmlFiles(dir = PUBLIC_DIR, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['vendor', 'node_modules'].includes(e.name)) htmlFiles(p, out); }
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** The page as the server would send it: analytics tag after <head>, help-button loader before </body>. */
function served(html, { inject = { sasha: sashaTag._internal.inject, analytics: analyticsTag._internal.inject } } = {}) {
  const a = inject.analytics(html, PROBE_ID) || html;
  return inject.sasha(a) || a;
}

/** Problems with one page after injection. `inject` is replaceable so tests can reproduce the old defect. */
function checkPage(html, opts = {}) {
  if (!/<\/body>/i.test(html)) return [];              // fragments are not served as pages
  const before = scriptsOf(parseDocument(html));
  const out = served(html, opts);
  const after = scriptsOf(parseDocument(out));
  const issues = [];
  const extra = after.inline.length - before.inline.length;   // the analytics snippet adds inline scripts before the page's
  if (extra < 0) issues.push({ code: 'SCRIPT_SWALLOWED', severity: 'critical', detail: `${-extra} inline script(s) disappeared after the server added its tags` });
  before.inline.forEach((s, i) => {
    if (scriptError(s.code, s.module)) return;           // invalid on disk already: reported by the release tests, not here
    const now = after.inline[i + Math.max(0, extra)];
    const e = now ? scriptError(now.code, s.module) : 'script missing';
    if (e) issues.push({ code: 'SCRIPT_SYNTAX', severity: 'critical', detail: `inline script ${i + 1} breaks once the server adds its tags: ${e}` });
  });
  if (!after.srcs.includes('/widgets/sasha-loader.js') && /<\/body>/i.test(out) && out !== html) {
    issues.push({ code: 'TAG_SWALLOWED', severity: 'critical', detail: 'the help-button tag ended up inside another element\'s text' });
  }
  return issues;
}

/** Check every page under public/. Returns { pages, issues: [{ page, code, severity, detail }] }. */
function checkAll({ files = htmlFiles(), inject } = {}) {
  const issues = [];
  for (const f of files) {
    let html;
    try { html = fs.readFileSync(f, 'utf8'); } catch (e) { issues.push({ page: f, code: 'UNREADABLE', severity: 'critical', detail: e.message }); continue; }
    const rel = '/' + path.relative(PUBLIC_DIR, f).replace(/\\/g, '/');
    for (const i of checkPage(html, inject ? { inject } : {})) issues.push({ page: rel, ...i });
  }
  return { pages: files.length, issues };
}

module.exports = { checkAll, checkPage, served, htmlFiles, PUBLIC_DIR };
