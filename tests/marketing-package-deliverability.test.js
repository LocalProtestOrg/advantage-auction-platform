'use strict';

/**
 * Owner decision 2026-11-07: a marketing package or promotion is sold only if every benefit it promises is actually
 * delivered by the current production system. Checked against the catalogue as seeded (migration 140, v1):
 *   - paid advertising is not live, so anything with a paid component is blocked (Premium, Signature, Reach, Spotlight);
 *   - owned placements (featured badge, listing priority, category prominence, notable-lot spotlight, Closing Soon,
 *     homepage) are recorded but never shown to buyers (no public page or API reads them, verified 2026-11-08), so
 *     Featured and Boost are blocked too;
 *   - Custom has no online composition.
 * Package definitions and purchase history are not changed; the packages simply cannot be bought until delivery exists.
 */
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/marketingPackagePurchaseService');

const SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '140_marketing_package_platform.sql'), 'utf8');
// Each v1 row: ('<key>', 1, '<name>', '<description>', '<benefits json>', '<guaranteed json>', '<discretionary json>', price, ...
function seededVersion(key) {
  const start = SQL.indexOf("('" + key + "', 1,");
  const jsonArrays = [];
  let i = start;
  while (jsonArrays.length < 3) {
    const open = SQL.indexOf("'[", i);
    const close = SQL.indexOf("]'", open);
    jsonArrays.push(JSON.parse(SQL.slice(open + 1, close + 1)));
    i = close + 2;
  }
  return { benefits: jsonArrays[0], guaranteed_deliverables: jsonArrays[1], discretionary_tools: jsonArrays[2] };
}

test.each(['featured', 'premium', 'signature'])('the %s package cannot be purchased', (key) => {
  const d = svc.packageDeliverability(seededVersion(key));
  expect(d.purchasable).toBe(false);
  expect(d.blocked.length).toBeGreaterThan(0);
});

test('Featured is blocked because its placements are never shown to buyers (not because of paid advertising)', () => {
  const d = svc.packageDeliverability(seededVersion('featured'));
  expect(d.reason).toMatch(/some of its benefits cannot be delivered yet/);
  expect(d.blocked).toEqual(expect.arrayContaining(['Featured badge & listing priority', 'Category prominence']));
});

test('Premium and Signature are blocked for paid advertising or undelivered placements', () => {
  for (const key of ['premium', 'signature']) expect(svc.packageDeliverability(seededVersion(key)).reason).toMatch(/cannot be purchased right now/);
});

test.each(['boost', 'reach', 'spotlight', 'custom'])('the %s promotion cannot be purchased', (key) => {
  expect(svc.promotionDeliverability(key).purchasable).toBe(false);
});

test('a version whose benefits are all really delivered stays purchasable (the rule is data-driven, not a blanket block)', () => {
  const d = svc.packageDeliverability({ guaranteed_deliverables: [{ key: 'reporting_standard', channel: 'analytics', label: 'Standard analytics' }], discretionary_tools: [] });
  expect(d).toEqual({ purchasable: true, blocked: [], reason: null });
});

test('an unmapped benefit (which would only be auto-marked complete) counts as not delivered', () => {
  expect(svc.isUndeliverable({ key: 'some_new_benefit', channel: 'service' })).toBe('not_delivered');
  expect(svc.isUndeliverable({ key: 'paid_local_promotion', channel: 'paid' })).toBe('paid');
});

test('the retired legacy purchase route refuses everyone, so no legacy package price can reach a seller settlement', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'marketing.js'), 'utf8');
  const route = src.slice(src.indexOf("router.post('/auctions/:auctionId/package'"));
  expect(route).toMatch(/res\.status\(409\)\.json\(\{\s*success: false, code: 'NOT_AVAILABLE'/);
  expect(src).not.toMatch(/createMarketingJob/);
});
