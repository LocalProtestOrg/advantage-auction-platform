'use strict';

/**
 * pageHealth — what a real browser sees that HTTP status codes do not. Shared by the browser regression tests and the
 * site watchdog. Works with a Playwright `page`.
 *
 *   const probe = attach(page, { origin });   // start collecting console errors, page errors and failed requests
 *   await page.goto(url);
 *   const issues = await inspect(page, probe, { expectText: ['Seller Agreement'] });
 *
 * Each issue: { code, severity, detail }. Codes:
 *   PAGE_ERROR          an uncaught JavaScript exception (e.g. a broken script)
 *   CONSOLE_ERROR       console.error output from the page
 *   REQUEST_FAILED      a same-site request that failed or answered 4xx/5xx (other sites are ignored)
 *   RAW_SCRIPT_TEXT     JavaScript source visible as page text: the seller agreement defect of 2026-10-30
 *   TEMPLATE_MARKERS    unfilled {{placeholders}} visible to the reader
 *   MISSING_CONTENT     an expected piece of text is not on the page
 *   NO_TITLE            the document has no <title>
 *   HORIZONTAL_OVERFLOW the page is wider than the viewport (unusable on a phone)
 */

// Script source that should never be visible text. Each pattern is specific to code, not prose.
const RAW_SCRIPT_PATTERNS = [
  /document\.getElementById\(/, /\bfunction\s*\([^)]*\)\s*\{/, /addEventListener\(\s*['"]/, /\bvar\s+\w+\s*=\s*[^;\n]{0,80};/,
  /=>\s*\{/, /\)\s*;\s*\}\s*\)?\s*;?/, /localStorage\.(get|set)Item\(/, /\bawait\s+fetch\(/,
];

function attach(page, { origin } = {}) {
  const probe = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  const sameSite = (u) => { try { return !origin || new URL(u).origin === origin; } catch (_) { return false; } };
  page.on('pageerror', (e) => probe.pageErrors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') probe.consoleErrors.push(m.text()); });
  // ERR_ABORTED = cancelled by a navigation (e.g. leaving the login page mid-request): not a failure.
  page.on('requestfailed', (r) => { const err = (r.failure() || {}).errorText || ''; if (/ERR_ABORTED/.test(err)) return; if (sameSite(r.url())) probe.failedRequests.push({ url: r.url(), status: 0, error: (r.failure() || {}).errorText || 'failed' }); });
  page.on('response', (r) => { if (r.status() >= 400 && sameSite(r.url())) probe.failedRequests.push({ url: r.url(), status: r.status() }); });
  return probe;
}

/** Visible-text checks, run inside the page. */
async function visibleFacts(page) {
  return page.evaluate(() => {
    const body = document.body;
    const text = body ? body.innerText || '' : '';
    return {
      title: document.title || '',
      text: text.slice(0, 200000),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

async function inspect(page, probe, { expectText = [], allowConsoleErrors = [], allowRequests = [], checkOverflow = true } = {}) {
  const issues = [];
  const add = (code, severity, detail) => issues.push({ code, severity, detail });
  const facts = await visibleFacts(page);
  for (const e of probe.pageErrors) add('PAGE_ERROR', 'critical', e.slice(0, 300));
  for (const e of probe.consoleErrors) if (!allowConsoleErrors.some((re) => re.test(e))) add('CONSOLE_ERROR', 'warning', e.slice(0, 300));
  for (const r of probe.failedRequests) if (!allowRequests.some((re) => re.test(r.url))) add('REQUEST_FAILED', r.status >= 500 || r.status === 0 ? 'critical' : 'warning', `${r.status || r.error} ${r.url}`.slice(0, 300));
  const raw = RAW_SCRIPT_PATTERNS.filter((re) => re.test(facts.text));
  if (raw.length >= 2) add('RAW_SCRIPT_TEXT', 'critical', 'script source is visible on the page (' + raw.map(String).slice(0, 3).join(' ') + ')');
  const markers = facts.text.match(/\{\{\s*[\w.]+\s*\}\}/g);
  if (markers) add('TEMPLATE_MARKERS', 'critical', 'unfilled placeholders: ' + [...new Set(markers)].slice(0, 5).join(', '));
  for (const t of expectText) {
    const ok = t instanceof RegExp ? t.test(facts.text) : facts.text.includes(t);
    if (!ok) add('MISSING_CONTENT', 'critical', 'expected text not found: ' + String(t));
  }
  if (!facts.title.trim()) add('NO_TITLE', 'warning', 'the page has no title');
  if (checkOverflow && facts.scrollWidth > facts.innerWidth + 2) add('HORIZONTAL_OVERFLOW', 'warning', `page is ${facts.scrollWidth}px wide in a ${facts.innerWidth}px viewport`);
  return issues;
}

const critical = (issues) => issues.filter((i) => i.severity === 'critical');

module.exports = { attach, inspect, critical, RAW_SCRIPT_PATTERNS };
