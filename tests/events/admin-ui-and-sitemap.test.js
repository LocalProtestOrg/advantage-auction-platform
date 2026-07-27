'use strict';

/**
 * Admin tier-assignment UI + sitemap events (follow-ups).
 *
 * Guards: the memberships admin page drives the tier endpoints via the shared admin auth helper and
 * nav; the org picker endpoint exists; and the (already-wired) /sitemap.xml route now emits published
 * Marketplace Event URLs + the unified /all-events page.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

const page = read('public', 'admin', 'memberships.html');
const route = read('src', 'routes', 'adminPartners.js');
const nav = read('public', 'widgets', 'shared', 'admin-nav.js');
const server = read('server.js');

describe('membership admin UI', () => {
  test('uses the shared admin nav + admin auth helper (requireAdmin)', () => {
    expect(page).toContain('/widgets/shared/admin-nav.js');
    expect(page).toContain('/admin/events-admin.js');
    expect(page).toMatch(/AE\.requireAdmin\(\)/);
  });
  test('drives the tier endpoints: list plans, list orgs, assign', () => {
    expect(page).toContain('/api/admin/partners/plans');
    expect(page).toContain('/api/admin/partners/organizations');
    expect(page).toMatch(/AE\.api\('PUT', '\/api\/admin\/partners\/' \+ encodeURIComponent\(selected\.id\) \+ '\/plan'/);
    expect(page).toContain('plan_tier: tier');
  });
  test('surfaces effective capabilities before/after a change', () => {
    expect(page).toMatch(/\/capabilities/);
  });
  test('is discoverable in the shared admin nav', () => {
    expect(nav).toMatch(/\/admin\/memberships\.html/);
  });
});

describe('partners org-picker endpoint', () => {
  test('GET /organizations returns name + current plan_tier, name-searchable', () => {
    const fn = route.slice(route.indexOf("get('/organizations'"), route.indexOf("get('/plans'"));
    expect(fn).toMatch(/name ILIKE \$1/);
    expect(fn).toMatch(/SELECT id, name, city, state, plan_tier FROM organizations/);
  });
});

describe('/sitemap.xml includes Marketplace Events', () => {
  test('emits an event.html?slug URL per published event + the unified page', () => {
    expect(server).toMatch(/entries\.events \|\| \[\]/);
    expect(server).toMatch(/event\.html\?slug=\$\{encodeURIComponent\(ev\.slug\)\}/);
    expect(server).toContain("'/all-events.html'");
  });
});
