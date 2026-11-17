'use strict';
/**
 * Exemption certificates apply only within their valid scope (owner 2026-11-16). An unreviewed, rejected or expired
 * certificate never applies; a single-state certificate applies only in its state, and with no state recorded it applies
 * nowhere; only the multi-state forms may apply without a state.
 */
jest.mock('../src/db/index', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../src/services/cloudinaryService', () => ({}));
const { exemptionApplies } = require('../src/services/taxExemptionService');

const today = new Date('2026-11-16');
const ok = (o) => ({ status: 'approved', exemption_type: 'resale', jurisdiction_state: 'NJ', effective_date: '2026-01-01', expiration_date: '2027-01-01', ...o });

test('checking a box or uploading a certificate is not an exemption: only an approved record applies', () => {
  for (const status of ['pending', 'rejected', 'more_info', undefined]) expect(exemptionApplies(ok({ status }), { state: 'NJ', date: today })).toBe(false);
  expect(exemptionApplies(null, { state: 'NJ', date: today })).toBe(false);
  expect(exemptionApplies(ok(), { state: 'NJ', date: today })).toBe(true);
});
test('a certificate applies only in its own state and only within its dates', () => {
  expect(exemptionApplies(ok(), { state: 'NY', date: today })).toBe(false);
  expect(exemptionApplies(ok(), { state: 'nj', date: today })).toBe(true);
  expect(exemptionApplies(ok(), { state: 'NJ', date: new Date('2027-02-01') })).toBe(false);
  expect(exemptionApplies(ok(), { state: 'NJ', date: new Date('2025-12-31') })).toBe(false);
});
test('a single-state certificate with no state recorded applies nowhere; a multi-state form may', () => {
  for (const exemption_type of ['resale', 'state_exemption', 'other', null]) {
    expect(exemptionApplies(ok({ exemption_type, jurisdiction_state: null }), { state: 'NJ', date: today })).toBe(false);
  }
  for (const exemption_type of ['streamlined_sst', 'mtc']) {
    expect(exemptionApplies(ok({ exemption_type, jurisdiction_state: null }), { state: 'NJ', date: today })).toBe(true);
  }
});
