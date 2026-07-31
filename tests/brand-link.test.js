'use strict';

// Navigation correction: the upper-left Advantage.Bid wordmark on the Railway application/auth
// surfaces must link to the apex marketing site https://advantage.bid — HTTPS, apex (not bid., not
// www), same window, and never the old advantageauction.bid fallback.

const fs = require('fs');
const CANON = 'https://advantage.bid';

const read = (p) => fs.readFileSync(p, 'utf8');
const authPages = {
  'public/login.html': read('public/login.html'),
  'public/forgot-password.html': read('public/forgot-password.html'),
  'public/reset-password.html': read('public/reset-password.html'),
};
const shell = read('public/widgets/shared/member-shell.js');

describe('auth-surface brand wordmark → apex marketing site', () => {
  for (const [file, src] of Object.entries(authPages)) {
    test(file + ' brand links to ' + CANON, () => {
      expect(src).toContain('<a class="brand" href="' + CANON + '">Advantage.Bid</a>');
      // the old Railway-root destination is gone from the brand anchor
      expect(src).not.toMatch(/<a class="brand" href="\/">/);
    });
  }
});

describe('shared member-shell dashboard brand (Defect 2: was unlinked)', () => {
  test('rail brand is now an anchor to ' + CANON, () => {
    expect(shell).toContain('<a class="adv-brand" href="' + CANON + '"');
    expect(shell).not.toContain('<div class="adv-brand"><div class="adv-brand-mark">');
  });
  test('mobile brand is now an anchor to ' + CANON, () => {
    expect(shell).toContain('<a class="adv-mobile-brand" href="' + CANON + '"');
    expect(shell).not.toContain('<div class="adv-mobile-brand"><div class="adv-brand-mark">');
  });
  test('brand anchors preserve appearance (no underline) and add an accessible home label', () => {
    const hits = shell.match(/<a class="adv-(mobile-)?brand" href="https:\/\/advantage\.bid"[^>]*>/g) || [];
    expect(hits.length).toBe(2);
    hits.forEach((tag) => {
      expect(tag).toContain('text-decoration:none');
      expect(tag).toContain('aria-label="Advantage.Bid home"');
    });
  });
});

describe('canonical destination hygiene across the fixed brand links', () => {
  const fixed = [...Object.values(authPages), shell];
  test('no fixed brand link uses bid.advantage.bid, advantageauction.bid, www, or http://', () => {
    const brandTags = [];
    fixed.forEach((src) => {
      (src.match(/<a class="(?:adv-brand|adv-mobile-brand|brand)"[^>]*>/g) || []).forEach((t) => brandTags.push(t));
    });
    expect(brandTags.length).toBeGreaterThanOrEqual(5); // 3 auth pages + 2 shell brands
    brandTags.forEach((tag) => {
      expect(tag).toContain('https://advantage.bid');
      expect(tag).not.toMatch(/bid\.advantage\.bid/);
      expect(tag).not.toMatch(/advantageauction\.bid/);
      expect(tag).not.toMatch(/https:\/\/www\.advantage\.bid/);
      expect(tag).not.toMatch(/href="http:\/\//);
      expect(tag).not.toMatch(/target=|rel="nofollow"/); // same window, no nofollow
    });
  });
});
