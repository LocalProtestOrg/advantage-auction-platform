'use strict';

/**
 * Terms pages (owner direction 2026-11-06): /terms.html and /buyer-terms.html both render the CURRENT published
 * terms version from /api/terms/current through one safe renderer; registration has an unchecked acceptance box.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const md = require('../public/widgets/shared/md-render.js');

describe('safe markdown renderer', () => {
  test('raw HTML in the terms text is shown as text, never injected', () => {
    const html = md.render('Hello <script>alert(1)</script> <img src=x onerror=alert(1)> "quoted"');
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
  test('only safe link targets become links', () => {
    const html = md.render('[a](javascript:alert(1)) [b](data:text/html,x) [c](/buyer-terms.html) [d](https://advantage.bid/x?a=1&b=2) [e](mailto:info@advantage.bid) [f](#section-2) [g](//evil.example)');
    expect(html).not.toMatch(/href="(javascript|data|\/\/)/i);
    expect(html).toMatch(/<a href="\/buyer-terms\.html">c<\/a>/);
    expect(html).toMatch(/<a href="https:\/\/advantage\.bid\/x\?a=1&amp;b=2" target="_blank" rel="noopener">d<\/a>/);
    expect(html).toMatch(/<a href="mailto:info@advantage\.bid">e<\/a>/);
    expect(html).toMatch(/<a href="#section-2">f<\/a>/);
  });
  test('long documents get heading anchors (unique) and a contents list; tables and numbered lists render', () => {
    const doc = ['# Terms of Service', '', '## 1. Eligibility', 'Text.', '', '## 2. Bidding', '1. One', '2. Two', '', '## 3. Payment',
      '| Fee | Amount |', '| --- | --- |', '| Premium | 18% |', '', '## 4. Pickup', 'x', '', '## 4. Pickup', 'again'].join('\n');
    const html = md.render(doc);
    expect(html).toMatch(/<h2 id="1-eligibility">1\. Eligibility<\/h2>/);
    expect(html).toMatch(/<h2 id="4-pickup">/); expect(html).toMatch(/<h2 id="4-pickup-2">/);
    expect(html).toMatch(/<ol>\n<li>One<\/li>\n<li>Two<\/li>\n<\/ol>/);
    expect(html).toMatch(/<td>18%<\/td>/);
    const toc = md.toc(html, 4);
    expect(toc).toMatch(/<a href="#1-eligibility">1\. Eligibility<\/a>/);
    expect(md.toc(md.render('## A\n## B'), 4)).toBe('');   // short documents (like a summary) get no contents list
  });
});

describe('both terms pages render the current version (they can never differ)', () => {
  const terms = read('public', 'terms.html');
  const buyer = read('public', 'buyer-terms.html');
  const loader = read('public', 'widgets', 'shared', 'terms-page.js');
  test('the shared loader reads /api/terms/current and renders it with the safe renderer', () => {
    expect(loader).toMatch(/fetch\('\/api\/terms\/current'\)/);
    expect(loader).toMatch(/window\.renderMarkdown\(t\.body_markdown/);
  });
  test('/terms.html and /buyer-terms.html both load md-render.js and terms-page.js', () => {
    for (const p of [terms, buyer]) {
      expect(p).toMatch(/<script src="\/widgets\/shared\/md-render\.js"><\/script>/);
      expect(p).toMatch(/<script src="\/widgets\/shared\/terms-page\.js"><\/script>/);
    }
    expect(terms).toMatch(/AdvTermsPage\.mount\(\{ docId: 'doc', metaId: 'doc-meta', acceptId: 'doc-accept', fallbackId: 'doc-md' \}\)/);
    expect(buyer).toMatch(/AdvTermsPage\.mount\(\{ docId: 'doc-body', metaId: 'doc-meta' \}\)/);
    expect(buyer).not.toMatch(/function renderMarkdown/);   // no second renderer
  });
  test('/terms.html has a static statement of where the terms are (no script needed) and a noscript note', () => {
    expect(terms).toMatch(/are published on this page and on the\s+<a href="\/buyer-terms\.html">Buyer Terms<\/a> page/);
    expect(terms).toMatch(/<noscript>/);
  });
  test('the accept button sends the version shown and handles TERMS_CHANGED', () => {
    expect(buyer).toMatch(/body: JSON\.stringify\(\{ version_int: versionInt \}\)/);
    expect(buyer).toMatch(/d\.code === 'TERMS_CHANGED'/);
  });
  test('inline page scripts on the terms pages contain no closing-tag text (served HTML integrity)', () => {
    for (const p of [terms, buyer, read('public', 'verify-email.html')]) {
      const inline = [...p.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      for (const s of inline) expect(s).not.toMatch(/<\/[a-z]/i);
    }
  });
  test('no long dashes in the new visible copy', () => {
    for (const f of [['public', 'buyer-terms.html'], ['public', 'verify-email.html'], ['public', 'widgets', 'shared', 'terms-page.js'],
      ['public', 'widgets', 'shared', 'account-notices.js'], ['public', 'admin', 'buyer-safeguards.js']]) {
      expect(read(...f)).not.toMatch(/[–—]/);
    }
  });
});

describe('registration page', () => {
  const login = read('public', 'login.html');
  test('an unchecked acceptance box linking both documents; the request sends accept_terms and the version shown', () => {
    expect(login).toMatch(/<input type="checkbox" id="reg-terms" \/>/);   // no "checked" attribute
    expect(login).toMatch(/I have read and agree to the Advantage\.Bid <a href="\/terms\.html"[^>]*>Terms of Service<\/a> and <a href="\/buyer-terms\.html"[^>]*>Buyer Terms<\/a>/);
    expect(login).toMatch(/if \(!termsBox\.checked\)/);
    expect(login).toMatch(/accept_terms: true, terms_version_int: CURRENT_TERMS_V/);
  });
  test('the member dashboard loads the non-blocking account notices', () => {
    expect(read('public', 'app.html')).toMatch(/<script src="\/widgets\/shared\/account-notices\.js"><\/script>/);
    const n = read('public', 'widgets', 'shared', 'account-notices.js');
    expect(n).toMatch(/Our terms have been updated\./);
    expect(n).toMatch(/'Review and Accept'/);
    expect(n).toMatch(/'Not Now'/);
  });
});
