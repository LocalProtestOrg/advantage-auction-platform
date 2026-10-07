'use strict';

/**
 * Global admin navigation (grouped redesign, 2026-10-07). Guards: every destination that was in the old flat nav is
 * still present with EXACTLY the same visibility rule; every standalone admin page is reachable from the nav; every
 * admin page loads the shared nav; the mobile menu is closed by default with accessible open/close controls; the
 * header stays sticky and keeps publishing --admin-nav-h. Browser-level checks (1440/1024/430/390/360px) were run with
 * Playwright against the real page files; these source checks keep the contract from regressing.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const NAV = read('public/widgets/shared/admin-nav.js');

const entries = [...NAV.matchAll(/\{ href: '([^']+)', label: '([^']+)'(?:, perm: '([^']+)')? \}/g)].map((m) => ({ href: m[1], label: m[2], perm: m[3] || null }));
const byHref = Object.fromEntries(entries.map((e) => [e.href, e]));

// The pre-redesign flat nav: href -> required permission (null = Super Admin only). Must be preserved exactly.
const PREVIOUS = {
  '/admin/moderation.html': null, '/admin/compliance.html': null, '/admin/users.html': null, '/admin/buyers.html': null,
  '/admin/verification.html': null, '/admin/agreements.html': null, '/admin/events.html': null, '/admin/business-listings.html': null,
  '/admin/imported-events.html': null, '/admin/sasha-inbox.html': 'support.view', '/admin/sasha.html': 'support.view', '/admin/invoices.html': null,
  '/admin/pricing.html': 'seller_platform_fee.view', '/admin/marketplace-config.html': null, '/admin/marketplace-orders.html': null,
  '/admin/follower-emails.html': null, '/admin/subscribers.html': 'members.view', '/admin/marketing-campaigns.html': 'members.view',
  '/admin/audiences.html': 'members.view', '/admin/director.html': 'members.view', '/admin/sales.html': 'sales.view',
  '/admin/founding-partners.html': null, '/admin/staff.html': 'staff.view',
};
// Pages added to the nav (they existed but were reachable only by deep link). Visibility mirrors each page's API gate.
const ADDED = {
  '/admin/event-partners.html': 'event_partners.view',     // requirePermission('event_partners.view')
  '/admin/marketing-agency.html': 'members.view',          // requirePermission('members.view')
  '/admin/marketing-packages.html': null,                  // role(['admin'])
  '/admin/social-destinations.html': null,                 // role(['admin'])
  '/admin/launch-readiness.html': null,                    // role(['admin'])
};
const DETAIL_PAGES = ['/admin/index.html', '/admin/invoice-detail.html', '/admin/event-detail.html', '/admin/settlement-review.html'];

describe('no admin destination removed, no visibility loosened', () => {
  test.each(Object.entries(PREVIOUS))('%s keeps its visibility rule', (href, perm) => {
    expect(byHref[href]).toBeTruthy();
    expect(byHref[href].perm).toBe(perm);
  });
  test.each(Object.entries(ADDED))('%s is gated like its API', (href, perm) => {
    expect(byHref[href]).toBeTruthy();
    expect(byHref[href].perm).toBe(perm);
  });
  test('every standalone admin page is reachable from the nav; detail pages map to a parent', () => {
    const pages = fs.readdirSync(path.join(__dirname, '..', 'public', 'admin')).filter((f) => f.endsWith('.html')).map((f) => '/admin/' + f);
    for (const p of pages) if (!DETAIL_PAGES.includes(p)) expect(byHref[p]).toBeTruthy();
    expect(NAV).toMatch(/href === '\/admin\/moderation\.html' && p === '\/admin\/settlement-review\.html'/);
    expect(NAV).toMatch(/var HOME = '\/admin\/'/);
  });
  test('visibility rule is unchanged: Super Admin sees all, others only links whose permission they hold', () => {
    expect(NAV).toMatch(/if \(STAFF\.is_super_admin\) return true;\s+return !!\(link\.perm && STAFF\.permissions\.indexOf\(link\.perm\) !== -1\);/);
    expect(NAV).toMatch(/fetch\('\/api\/admin\/staff\/me'/);
    expect(NAV).toMatch(/GROUPS\.map\(function \(g\) \{ return \{ g: g, links: g\.links\.filter\(canSee\) \}; \}\)\.filter\(function \(x\) \{ return x\.links\.length; \}\)/);
  });
  test('every admin page loads the shared nav', () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'public', 'admin')).filter((x) => x.endsWith('.html'))) {
      expect([f, read('public/admin/' + f).includes('<script src="/widgets/shared/admin-nav.js"></script>')]).toEqual([f, true]);
    }
  });
});

describe('grouped information architecture', () => {
  test('five groups in order, each destination in exactly one group', () => {
    expect([...NAV.matchAll(/\{ key: '(\w+)', label: '([^']+)', title: '([^']+)'/g)].map((m) => m[3]))
      .toEqual(['Operations', 'People & Sellers', 'Marketing & Growth', 'Sasha & Customer Service', 'Platform']);
    const hrefs = entries.map((e) => e.href).filter((h) => h !== '/admin/');
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs).toHaveLength(Object.keys(PREVIOUS).length + Object.keys(ADDED).length);
  });
  test('Marketing Director lives under Marketing & Growth', () => {
    const growth = NAV.slice(NAV.indexOf("key: 'growth'"), NAV.indexOf("key: 'support'"));
    expect(growth).toMatch(/label: 'Marketing Director', perm: 'members\.view'/);
  });
});

describe('desktop and mobile behaviour', () => {
  test('dropdowns are buttons with aria-expanded / aria-controls, close on Escape, outside click and focus leaving', () => {
    expect(NAV).toMatch(/aria-expanded="false" aria-controls="' \+ id \+ '" aria-haspopup="true"/);
    expect(NAV).toMatch(/if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); closeMenus\(true\); \}/);
    expect(NAV).toMatch(/document\.addEventListener\('click', function \(e\) \{ if \(openGroup && !openGroup\.contains\(e\.target\)\) closeMenus\(false\); \}\)/);
    expect(NAV).toMatch(/ArrowDown/);
  });
  test('mobile: Menu button, panel closed by default, Close control, Escape and backdrop close it, focus is trapped and restored', () => {
    expect(NAV).toMatch(/<button class="an-menubtn" type="button" aria-expanded="false" aria-controls="an-panel">Menu<\/button>/);
    expect(NAV).toMatch(/<div class="an-panel" id="an-panel" hidden>/);
    expect(NAV).toMatch(/<button class="an-close" type="button">Close menu<\/button>/);
    expect(NAV).toMatch(/e\.key === 'Escape' && panelOpen\(header\)/);
    expect(NAV).toMatch(/\.an-backdrop'\)\.addEventListener\('click'/);
    expect(NAV).toMatch(/function trapFocus/);
    expect(NAV).toMatch(/max-width:' \+ MOBILE_MAX \+ 'px\)\{' \+\s+'#admin-nav \.an-links,#admin-nav \.an-auth\{display:none\}'/);
    expect(NAV).toMatch(/max-height:calc\(100% - 56px\)/);   // a tappable strip always remains to dismiss
    expect(NAV).toMatch(/min-height:44px/);                   // touch-friendly rows
  });
  test('logout still goes through /logout and the header keeps its contract', () => {
    expect(NAV).toMatch(/location\.href = '\/logout';/);
    expect(NAV).toMatch(/window\.adminLogout = doLogout;/);
    expect(NAV).toMatch(/#admin-nav\{position:sticky;top:0/);
    expect(() => new vm.Script(NAV)).not.toThrow();
  });
  test('no visible AI or vendor wording in the nav', () => {
    expect(entries.map((e) => e.label).join(' ')).not.toMatch(/\b(AI|GPT|OpenAI|Stripe|Railway)\b/);
  });
  test('Social Destinations page styles no longer leak onto the shared header', () => {
    const p = read('public/admin/social-destinations.html');
    expect(p).toMatch(/header:not\(#admin-nav\) \{ background: #0f172a;/);
    expect(p).not.toMatch(/\n\s+header \{/);
  });
});
