'use strict';

/**
 * External auction ingestion repair — publication gate (gov-surplus placeholder unblocks GSA auctions)
 * + auction-inventory health target (100+ / LOW / CRITICAL) + non-silent alerting.
 *
 * Root cause under test: GSA / Federal-Surplus auctions have login-gated (ppms.gov) images that cannot
 * be re-hosted, so the gate's HARD image_missing kept every GSA auction in draft forever. The public
 * feed already renders a branded gov-surplus placeholder, so those events should publish; all OTHER
 * imported events must still require a real image (quality bar unchanged).
 */
const { evaluatePublication } = require('../src/services/eventImport/publicationGate');
const health = require('../src/services/eventImport/health');

const NOW = Date.parse('2026-08-24T12:00:00Z');
const FUTURE = new Date(NOW + 7 * 864e5).toISOString();
const PAST = new Date(NOW - 864e5).toISOString();
const base = {
  source: 'imported', title: 'Surplus Item', start_at: new Date(NOW - 864e5).toISOString(), end_at: FUTURE,
  event_format: 'online', city: 'Washington', state: 'DC', lat: 38.9, lng: -77, organizer_name: 'Dept of X',
};

describe('publicationGate — gov-surplus placeholder satisfies the image requirement', () => {
  test('GSA auction, no re-hostable image, future → READY (placeholder warning, not blocked)', () => {
    const r = evaluatePublication({ ...base, external_url: 'https://www.gsaauctions.gov/x' }, { now: NOW });
    expect(r.ready).toBe(true);
    expect(r.reasons).not.toContain('image_missing');
    expect(r.warnings).toContain('image_placeholder_used');
  });
  test('GSA auction whose only image is a login-gated ppms.gov URL → READY via placeholder', () => {
    const r = evaluatePublication({ ...base, external_url: 'https://www.gsaauctions.gov/x', cover_image_url: 'https://ppms.gov/i.jpg' }, { now: NOW });
    expect(r.ready).toBe(true);
    expect(r.warnings).toContain('image_placeholder_used');
  });
  test('NON-gov imported event with no image → still BLOCKED (image_missing) — quality bar preserved', () => {
    const r = evaluatePublication({ ...base, external_url: 'https://someauctioncompany.com/x' }, { now: NOW });
    expect(r.ready).toBe(false);
    expect(r.reasons).toContain('image_missing');
  });
  test('non-gov imported event WITH a real image → READY', () => {
    const r = evaluatePublication({ ...base, external_url: 'https://co.com/x', cover_image_url: 'https://co.com/i.jpg' }, { now: NOW });
    expect(r.ready).toBe(true);
  });
});

describe('publicationGate — expiration + attribution still enforced (no stale/untrusted inventory)', () => {
  test('EXPIRED gov auction is blocked (expired_event) — expiration remains correct', () => {
    const r = evaluatePublication({ ...base, external_url: 'https://www.gsaauctions.gov/x', end_at: PAST }, { now: NOW });
    expect(r.ready).toBe(false);
    expect(r.reasons).toContain('expired_event');
  });
  test('FUTURE gov auction is included', () => {
    const r = evaluatePublication({ ...base, external_url: 'https://www.gsaauctions.gov/x' }, { now: NOW });
    expect(r.ready).toBe(true);
  });
  test('host company still required (host_company_missing stays HARD)', () => {
    const r = evaluatePublication({ ...base, external_url: 'https://www.gsaauctions.gov/x', organizer_name: '' }, { now: NOW });
    expect(r.ready).toBe(false);
    expect(r.reasons).toContain('host_company_missing');
  });
  test('invalid dates blocked', () => {
    const r = evaluatePublication({ ...base, external_url: 'https://www.gsaauctions.gov/x', start_at: FUTURE, end_at: PAST }, { now: NOW });
    expect(r.ready).toBe(false);
    expect(r.reasons).toContain('invalid_dates');
  });
});

describe('auction inventory health target (owner: 100+)', () => {
  test('HEALTHY >= 100', () => expect(health.auctionInventoryStatus(120).status).toBe('HEALTHY'));
  test('LOW 50–99', () => {
    expect(health.auctionInventoryStatus(50).status).toBe('LOW');
    expect(health.auctionInventoryStatus(99).status).toBe('LOW');
  });
  test('CRITICAL < 50', () => {
    expect(health.auctionInventoryStatus(49).status).toBe('CRITICAL');
    expect(health.auctionInventoryStatus(0).status).toBe('CRITICAL');
  });
  test('target + low threshold reported', () => {
    const s = health.auctionInventoryStatus(10);
    expect(s.target).toBe(100); expect(s.low_threshold).toBe(50);
  });
});

describe('non-silent alerting on low/critical auction inventory', () => {
  const snapBase = {
    total_active_public: 200, active_auctions: 0, active_estate_sales: 150,
    last_success_run: new Date(NOW - 3600e3).toISOString(), last_run: { status: 'completed' },
  };
  test('CRITICAL external auctions → critical alert (even when estate sales are plentiful)', () => {
    const snap = { ...snapBase, auction_inventory: health.auctionInventoryStatus(1) };
    const alerts = health.evaluateAlerts(snap, health.thresholds({}), { now: NOW, expectedWindow: new Date(NOW - 3600e3).toISOString() });
    const a = alerts.find(x => x.code === 'auctions_critical');
    expect(a).toBeTruthy();
    expect(a.level).toBe('critical');
  });
  test('LOW external auctions → warn alert', () => {
    const snap = { ...snapBase, auction_inventory: health.auctionInventoryStatus(72) };
    const alerts = health.evaluateAlerts(snap, health.thresholds({}), { now: NOW, expectedWindow: new Date(NOW - 3600e3).toISOString() });
    expect(alerts.find(x => x.code === 'auctions_below_target')).toBeTruthy();
  });
  test('HEALTHY → no auction-target alert', () => {
    const snap = { ...snapBase, auction_inventory: health.auctionInventoryStatus(140) };
    const alerts = health.evaluateAlerts(snap, health.thresholds({}), { now: NOW, expectedWindow: new Date(NOW - 3600e3).toISOString() });
    expect(alerts.some(x => x.code === 'auctions_below_target' || x.code === 'auctions_critical')).toBe(false);
  });
});
