'use strict';

/**
 * Admin membership-tier assignment.
 *
 * Admins assign an organization's membership tier (Gold Retailer / Silver Retailer / Individual /
 * Appraiser / …) and the org's plan capabilities re-sync to the new tier. Guards: admin-gated
 * endpoint, tier validated, plan-sourced capabilities reconciled (admin grants preserved), change
 * audited.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

const cap = read('src', 'services', 'capabilityService.js');
const org = read('src', 'services', 'organizationsService.js');
const route = read('src', 'routes', 'adminPartners.js');
const server = read('server.js');

describe('capability re-sync on tier change', () => {
  test('syncPlanCapabilities drops stale plan caps and grants the new plan (admin grants kept)', () => {
    const fn = cap.slice(cap.indexOf('function syncPlanCapabilities'), cap.indexOf('function getEffectiveCapabilities'));
    expect(fn).toMatch(/DELETE FROM organization_capabilities/);
    expect(fn).toMatch(/source = 'plan'/);           // only plan-sourced caps are reconciled
    expect(fn).toMatch(/NOT IN \(SELECT capability FROM plan_capabilities WHERE plan_tier = \$2\)/);
    expect(fn).toMatch(/grantPlanCapabilities/);
    expect(cap).toMatch(/syncPlanCapabilities/);      // exported
  });
});

describe('organizationsService.setPlanTier', () => {
  const fn = org.slice(org.indexOf('async function setPlanTier'), org.indexOf('async function setPlanTier') + 1200);
  test('validates the tier and the org', () => {
    expect(fn).toContain('UNKNOWN_PLAN');
    expect(fn).toContain('ORG_NOT_FOUND');
    expect(fn).toMatch(/FROM organization_plans WHERE plan_tier = \$1/);
  });
  test('updates plan_tier, re-syncs capabilities, and audits the change', () => {
    expect(fn).toMatch(/UPDATE organizations SET plan_tier = \$2/);
    expect(fn).toMatch(/capabilityService\.syncPlanCapabilities\(orgId, planTier, client\)/);
    expect(fn).toContain("eventType: 'organization.plan_changed'");
    expect(fn).toMatch(/from: prev, to: planTier/);
  });
  test('setPlanTier + listPlans are exported', () => {
    expect(org).toMatch(/setPlanTier,/);
    expect(org).toMatch(/listPlans,/);
  });
});

describe('admin endpoint', () => {
  test('PUT /:orgId/plan is admin-only and delegates to setPlanTier', () => {
    expect(route).toMatch(/roleMiddleware\(\['admin'\]\)/);
    expect(route).toMatch(/put\('\/:orgId\/plan'/);
    expect(route).toMatch(/organizationsService\.setPlanTier\(req\.user\.id, req\.params\.orgId, planTier\)/);
    expect(route).toContain('PLAN_REQUIRED');
  });
  test('GET /plans lists assignable tiers for the picker', () => {
    expect(route).toMatch(/get\('\/plans'/);
    expect(route).toMatch(/organizationsService\.listPlans\(\)/);
  });
  test('route is mounted under /api/admin/partners', () => {
    expect(server).toMatch(/app\.use\('\/api\/admin\/partners', adminPartnersRoutes\)/);
  });
});
