'use strict';

/**
 * Sales Near You — BD footer placement + durable success state.
 *
 * THE BUG THIS LOCKS SHUT. The persistent signup was anchored with
 * `querySelector('footer, .footer, #footer')`. On the live marketing site most templates put the
 * real site footer in a `div.footer`, so that worked — but the homepage carries an EARLIER element
 * with the same class sitting above a major content section, so the first match was a decoy and the
 * signup landed mid-page. There is no semantic <footer> and no role="contentinfo" anywhere on that
 * site, so no selector alone is trustworthy. Placement is now decided by GEOMETRY.
 *
 * The placement tests run the REAL resolver — extracted from the shipped file and evaluated against
 * a minimal DOM stub — rather than a reimplementation. jsdom is not a dependency of this project,
 * and a stub suffices because the algorithm needs only geometry, class names and parentage.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-bd-placement';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const WIDGET = read('public', 'widgets', 'shared', 'local-alerts.js');
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
const WIDGET_CODE = stripComments(WIDGET);

// ── Harness: run the shipped resolver against a stub DOM ────────────────────────────────────────
function resolverSource() {
  const start = WIDGET.indexOf('var FOOTER_SELECTORS');
  const end = WIDGET.indexOf('// ── Footer strip');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return WIDGET.slice(start, end);
}

function makeDom(spec, pageHeight) {
  const nodes = spec.map((n, i) => ({
    tagName: (n.tag || 'div').toUpperCase(),
    className: n.cls || '',
    id: n.id || '',
    _top: n.top,
    _h: n.h == null ? 100 : n.h,
    _display: n.display || 'block',
    parentElement: null,
    getBoundingClientRect() { return { top: this._top, width: 1000, height: this._h }; },
    contains() { return false; },
    _i: i,
  }));
  spec.forEach((n, i) => { if (n.parent != null) nodes[i].parentElement = nodes[n.parent]; });

  const matches = (el, sel) => {
    const s = sel.trim();
    if (s === 'footer') return el.tagName === 'FOOTER';
    if (s.charAt(0) === '#') return el.id === s.slice(1);
    if (s.charAt(0) === '.') return (' ' + el.className + ' ').indexOf(' ' + s.slice(1) + ' ') !== -1;
    return false;   // [role=...] — none exist on the target site
  };

  const document = {
    body: { scrollHeight: pageHeight },
    documentElement: { scrollHeight: pageHeight, scrollTop: 0 },
    querySelectorAll: (sel) => nodes.filter((el) => sel.split(',').some((p) => matches(el, p))),
    querySelector: () => null,
  };
  const window = {
    pageYOffset: 0,
    getComputedStyle: (el) => ({ display: el._display, visibility: 'visible' }),
  };
  return { document, window, nodes };
}

/** @returns index of the chosen anchor, or -1 for "no anchor — append to body". */
function runResolver(spec, pageHeight) {
  const { document, window, nodes } = makeDom(spec, pageHeight);
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', resolverSource() + '\nreturn findFooterAnchor();');
  const anchor = fn(document, window);
  return anchor ? nodes.indexOf(anchor) : -1;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('footer placement works regardless of template', () => {
  test('a standard template: the site footer at the bottom is chosen', () => {
    expect(runResolver([
      { cls: 'content', top: 0, h: 800 },
      { cls: 'footer', top: 900, h: 300 },
    ], 1200)).toBe(1);
  });

  test('THE HOMEPAGE CASE: an early decoy .footer loses to the real footer below it', () => {
    expect(runResolver([
      { cls: 'footer', top: 400, h: 60 },                      // decoy above real content
      { cls: 'homepage-featured-auctions', top: 500, h: 700 },
      { cls: 'footer', top: 1250, h: 300 },                    // the actual site footer
    ], 1550)).toBe(2);
  });

  test('a semantic <footer> is honoured', () => {
    expect(runResolver([
      { cls: 'content', top: 0, h: 800 },
      { tag: 'footer', top: 900, h: 200 },
    ], 1100)).toBe(1);
  });

  test('#footer is honoured', () => {
    expect(runResolver([
      { cls: 'content', top: 0, h: 800 },
      { id: 'footer', top: 900, h: 200 },
    ], 1100)).toBe(1);
  });

  test('neither present: returns null so the caller appends to the end of the body', () => {
    expect(runResolver([{ cls: 'content', top: 0, h: 900 }], 900)).toBe(-1);
    expect(WIDGET_CODE).toMatch(/else document\.body\.appendChild\(host\);/);
  });

  test('a landmark in the TOP HALF is refused as a decoy rather than used', () => {
    expect(runResolver([
      { cls: 'footer', top: 200, h: 80 },
      { cls: 'body-content', top: 300, h: 700 },
    ], 1000)).toBe(-1);
  });

  test('a hidden footer is skipped even though it sits lowest', () => {
    expect(runResolver([
      { cls: 'content', top: 0, h: 800 },
      { cls: 'footer', top: 1400, h: 0, display: 'none' },
      { cls: 'footer', top: 900, h: 300 },
    ], 1200)).toBe(2);
  });

  test('a nested footer menu resolves UP to its containing footer', () => {
    // Anchoring to the container keeps the signup above the whole footer rather than wedged
    // between its navigation columns.
    expect(runResolver([
      { cls: 'content', top: 0, h: 800 },
      { cls: 'footer', top: 900, h: 300 },
      { cls: 'footer_menu', top: 950, h: 100, parent: 1 },
    ], 1200)).toBe(1);
  });

  test('the candidate list covers the landmarks that actually exist on the marketing site', () => {
    const sel = resolverSource();
    ['footer', '[role="contentinfo"]', '.site-footer', '#footer', '.footer', '.footer_menu']
      .forEach((s) => expect(sel).toContain(s));
  });

  test('exactly one persistent signup can ever be created', () => {
    expect(WIDGET_CODE).toMatch(/if \(document\.querySelector\('\.advla-strip'\)\) return;/);
    expect(WIDGET_CODE).toMatch(/__advLocalAlertsBooted/);
  });

  test('the strip goes BEFORE the footer, never inside it', () => {
    expect(WIDGET_CODE).toMatch(/anchor\.parentNode\.insertBefore\(host, anchor\)/);
    expect(WIDGET_CODE).not.toMatch(/anchor\.appendChild\(host\)/);
  });

  test('placement never reads a class name alone — geometry decides', () => {
    const src = resolverSource();
    expect(src).toMatch(/getBoundingClientRect/);
    expect(src).toMatch(/pageHeight \* 0\.5/);
    expect(src).not.toMatch(/querySelector\('footer, \.footer, #footer'\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the success state is durable, not a flash', () => {
  const confirmFn = () => WIDGET_CODE.slice(
    WIDGET_CODE.indexOf('function showSubscribed'),
    WIDGET_CODE.indexOf('function buildForm'));

  test('a successful signup REPLACES the form with a confirmation', () => {
    expect(WIDGET_CODE).toMatch(/function showSubscribed\(form, msg\)/);
    expect(WIDGET_CODE).toMatch(/form\.parentNode\.replaceChild\(box, form\)/);
  });

  test('it carries the approved wording', () => {
    expect(WIDGET).toContain('You&#39;re signed up!'.replace('&#39;', "'"));
    expect(WIDGET).toContain("We'll let you know when qualifying sales are added near you.");
  });

  test('it promises QUALIFYING sales, not every nearby event', () => {
    expect(WIDGET_CODE).toMatch(/qualifying sales/);
    expect(confirmFn()).not.toMatch(/every (nearby )?(sale|event)/i);
  });

  test('nothing auto-closes the modal on success any more', () => {
    expect(WIDGET_CODE).not.toMatch(/setTimeout\(onDone, \d+\)/);
    expect(WIDGET_CODE).toMatch(/if \(typeof onDone === 'function'\) onDone\(\);/);
  });

  test('the modal relabels its exit to Close so the visitor dismisses when ready', () => {
    expect(WIDGET_CODE).toMatch(/no\.textContent = 'Close';/);
  });

  test('closing AFTER subscribing is not recorded as a dismissal', () => {
    // Otherwise a success would also be reported as someone rejecting the offer.
    expect(WIDGET_CODE).toMatch(/if \(subscribed\) \{ close\(\); return; \}/);
  });

  test('the confirmation is announced to assistive technology', () => {
    const fn = confirmFn();
    expect(fn).toMatch(/setAttribute\('role', 'status'\)/);
    expect(fn).toMatch(/setAttribute\('aria-live', 'polite'\)/);
  });

  test('it is styled to be visually obvious, on both surfaces', () => {
    expect(WIDGET).toMatch(/\.advla-done\{/);
    expect(WIDGET).toMatch(/\.advla-tick\{/);
  });

  test('a known subscriber remains suppressed afterwards', () => {
    expect(WIDGET_CODE).toMatch(/writeState\(\{ subscribed: true, subscribedAt: Date\.now\(\) \}\)/);
    expect(WIDGET_CODE).toMatch(/function alreadySubscribed/);
  });

  test('no internal terminology leaks into the confirmation', () => {
    expect(confirmFn()).not.toMatch(/marketing_contacts|entitlement|audience|suppress|radius|geocod/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('nothing else regressed', () => {
  test('the canonical endpoint and BD attribution are unchanged', () => {
    expect(WIDGET_CODE).toMatch(/var ENDPOINT = API_BASE \+ '\/api\/public\/subscribers'/);
    expect(WIDGET_CODE).toMatch(/function resolvePlacement/);
    expect(WIDGET_CODE).toContain('bd_estate_sales');
  });

  test('sensitive routes remain excluded on both surfaces', () => {
    const m = WIDGET.match(/var SUPPRESSED_PATHS = new RegExp\(\[([\s\S]*?)\]\.join\('\|'\), 'i'\);/);
    expect(m).toBeTruthy();
    // eslint-disable-next-line no-eval
    const re = new RegExp(eval('[' + m[1] + ']').join('|'), 'i');
    ['/login', '/my-account', '/cart', '/checkout', '/payment.html', '/auction-view.html',
     '/admin/x', '/seller-dashboard.html', '/privacy', '/terms'].forEach((p) => {
      expect(re.test(p)).toBe(true);
    });
    ['/', '/estate-sales', '/auctions', '/blog/a-post', '/events.html'].forEach((p) => {
      expect(re.test(p)).toBe(false);
    });
  });

  test('the popup triggers and caps are untouched', () => {
    expect(WIDGET_CODE).toMatch(/engagedMs: 25000/);
    expect(WIDGET_CODE).toMatch(/detailViewsToTrigger: 2/);
    expect(WIDGET_CODE).toMatch(/dismissDays: 30/);
    expect(WIDGET_CODE).toMatch(/showEveryDays: 7/);
    expect(WIDGET_CODE).toMatch(/maxLifetimeShows: 3/);
  });

  test('the approved acquisition copy is untouched', () => {
    expect(WIDGET).toContain('Never Miss a Sale Near You Again!');
    expect(WIDGET).toContain('Get notified when new estate sales and auctions are added near you.');
    expect(WIDGET).toContain('Notify Me About Nearby Sales');
  });

  test('mobile behaviour is untouched', () => {
    expect(WIDGET).toMatch(/@media \(max-width:560px\)/);
    expect(WIDGET).toMatch(/border-radius:18px 18px 0 0/);
  });

  test('no secret reaches the client', () => {
    expect(WIDGET_CODE).not.toMatch(/API_KEY|_SECRET|Bearer |X-Api-Key/i);
  });
});
