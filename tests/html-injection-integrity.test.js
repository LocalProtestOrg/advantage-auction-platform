'use strict';

/**
 * Served-HTML integrity. The seller agreement defect (2026-10-30) was invisible to every test that read pages from
 * disk: the page was correct on disk and broken only after middleware added a tag to it. These tests check pages
 * AS SERVED: after the Sasha and analytics tags are injected, every inline script must still be valid JavaScript and
 * every injected tag must sit outside page scripts. They also pin the capability-token rule (no third-party script on
 * a page whose address carries a secret).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseDocument, DomUtils } = require('htmlparser2');
const { beforeClosingBody, afterHeadOpen, isTokenPage } = require('../src/lib/htmlInjection');
const sashaTag = require('../src/middleware/sashaTag');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SASHA = '\n<script src="/widgets/sasha-loader.js" async></script>\n';
const GTAG = '\n<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script>\n<script>window.dataLayer=window.dataLayer||[];</script>\n';

function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['vendor', 'node_modules'].includes(e.name)) htmlFiles(p, out); }
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** Inline (non-src, JavaScript) scripts of a document, plus the src of every external script. */
function scriptsOf(html) {
  const doc = parseDocument(html);
  const scripts = DomUtils.findAll((n) => n.name === 'script', doc.children);
  const inline = []; const srcs = [];
  for (const s of scripts) {
    if (s.attribs && s.attribs.src) { srcs.push(s.attribs.src); continue; }
    const type = (s.attribs && s.attribs.type || '').toLowerCase();
    if (type && !/^(text|application)\/(javascript|ecmascript)$|^module$/.test(type)) continue;   // JSON-LD, templates
    inline.push({ code: DomUtils.textContent(s), module: type === 'module' });
  }
  return { inline, srcs };
}

// null when the code is valid JavaScript, else the syntax error. Module scripts are checked without their import/export lines.
function parses(code, isModule) {
  try { new vm.Script(isModule ? code.replace(/^\s*(import|export).*$/gm, '') : code, { filename: 'inline.js' }); return null; }
  catch (e) { return e.message; }
}

/** Inject like the real middleware (Sasha before </body>, analytics after <head>). */
function served(html) {
  const a = afterHeadOpen(html, GTAG) || html;
  return beforeClosingBody(a, SASHA) || a;
}

const PAGES = htmlFiles(PUBLIC).map((p) => [path.relative(ROOT, p).replace(/\\/g, '/'), p]);

describe('every public page still works after the server adds its tags', () => {
  test.each(PAGES)('%s: inline scripts stay valid and injected tags stay outside them', (_rel, file) => {
    const original = fs.readFileSync(file, 'utf8');
    if (!/<\/body>/i.test(original)) return;           // fragments and partials are not served as pages
    const before = scriptsOf(original);
    const after = scriptsOf(served(original));
    // As served, the analytics snippet comes first, then the page's own inline scripts in order: each one that was
    // valid on disk must still be valid.
    expect(after.inline.length).toBe(before.inline.length + 1);
    const broken = before.inline
      .map((s, i) => (!parses(s.code, s.module) && parses(after.inline[i + 1].code, s.module)) ? `script ${i + 1}: ${parses(after.inline[i + 1].code, s.module)}` : null)
      .filter(Boolean);
    expect(broken).toEqual([]);
    // The injected tags are real script elements (not swallowed into another script's text).
    expect(after.srcs).toContain('/widgets/sasha-loader.js');
    expect(after.srcs.some((s) => /googletagmanager/.test(s))).toBe(true);
  });
});

describe('the 2026-10-30 seller agreement defect', () => {
  const BEFORE_FIX = fs.readFileSync(path.join(__dirname, 'fixtures', 'sign-agreement-before-fix-2026-10-29.html'), 'utf8');
  const oldInject = (html, tag) => { const at = html.search(/<\/body>/i); return html.slice(0, at) + tag + html.slice(at); };

  test('reproduced: inserting before the FIRST </body> broke the page script (the reported raw-JavaScript page)', () => {
    const { inline } = scriptsOf(oldInject(BEFORE_FIX, SASHA));
    expect(inline.some((s) => parses(s.code))).toBe(true);
  });

  test('fixed: the same page with the current injection keeps a valid script', () => {
    const { inline, srcs } = scriptsOf(beforeClosingBody(BEFORE_FIX, SASHA));
    expect(inline.map((s) => parses(s.code))).toEqual(inline.map(() => null));
    expect(srcs).toContain('/widgets/sasha-loader.js');
  });

  test('sashaTag itself uses the safe insertion point', () => {
    const page = '<html><head></head><body><script>var s = "</body>";</script></body></html>';
    const out = sashaTag._internal.inject(page);
    expect(out.indexOf('sasha-loader.js')).toBeGreaterThan(out.indexOf('var s'));
    expect(scriptsOf(out).inline.map((s) => parses(s.code))).toEqual([null]);
  });

  test('the signing page contains no closing-tag text inside its scripts', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'sign-agreement.html'), 'utf8');
    for (const s of scriptsOf(html).inline) expect(s.code).not.toMatch(/<\//);
  });

  test('afterHeadOpen finds the real <head>, never <header>', () => {
    expect(afterHeadOpen('<html><header>x</header><head><title>t</title></head></html>', 'TAG')).toBe('<html><header>x</header><head>TAG<title>t</title></head></html>');
    expect(afterHeadOpen('<div>no head</div>', 'TAG')).toBeNull();
  });
});

describe('no third-party script on a page whose address carries a secret', () => {
  const req = (p, query = {}, originalUrl) => ({ path: p, query, originalUrl: originalUrl || p });
  test.each([
    ['/sign-agreement.html', {}], ['/reset-password.html', {}], ['/authorize-event-promotion.html', {}],
    ['/claim-listing.html', {}], ['/auction-partner.html', { invite: 'abc' }], ['/anything.html', { token: 'x' }],
  ])('%s %j is a token page', (p, q) => { expect(isTokenPage(req(p, q))).toBe(true); });
  test('a signing link routed through the login page is still a token page', () => {
    expect(isTokenPage(req('/login.html', { next: '/sign-agreement.html?token=abc' }, '/login.html?next=%2Fsign-agreement.html%3Ftoken%3Dabc'))).toBe(true);
  });
  test.each([['/', {}], ['/search.html', { q: 'chairs' }], ['/login.html', {}], ['/auction-partner.html', {}]])('%s %j is an ordinary page', (p, q) => {
    expect(isTokenPage(req(p, q))).toBe(false);
  });
});
