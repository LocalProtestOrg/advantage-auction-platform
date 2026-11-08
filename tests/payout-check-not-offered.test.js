'use strict';

/**
 * Owner decision 2026-11-08: direct deposit (ACH) is the only standard payout method, matching Seller Agreement 7.6.
 * The seller payout page no longer offers a mailed check, and both seller save routes refuse one. Check details saved
 * earlier stay on record (the service still reads them for Advantage.Bid's manual settlement); no record is changed.
 * Production at the time: 0 sellers had chosen a check and 0 payouts were paid by check.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('the seller payout page offers direct deposit only', () => {
  const page = read('public', 'payout-profile.html');
  expect(page).not.toMatch(/id="m-check"|id="sec-check"|Mailed Check|ck-save|payout_method: 'check'/);
  expect(page).toMatch(/Direct Deposit \(ACH\)/);
  expect(page).toMatch(/Payouts are made by direct deposit \(ACH\), as your Seller Agreement provides\./);
  expect(page).not.toMatch(/[–—]/);
});

test('both seller save routes refuse a mailed check (409 CHECK_NOT_OFFERED); admins are not restricted', () => {
  const profile = read('src', 'routes', 'payoutProfile.js');
  expect(profile).toMatch(/router\.put\('\/me', auth, role\(\['seller'\]\), \(req, res\) => res\.status\(409\)\.json\(\{ success: false, code: 'CHECK_NOT_OFFERED'/);
  expect(profile).not.toMatch(/saveCheckProfile/);
  const prefs = read('src', 'routes', 'payoutPreferences.js');
  expect(prefs).toMatch(/if \(req\.user\.role !== 'admin' && \(req\.body \|\| \{\}\)\.payout_method === 'check'\) \{\s*return res\.status\(409\)/);
});

test('historical check details are still readable by the service (nothing is deleted)', () => {
  const pp = require('../src/lib/payoutProfile');
  expect(typeof pp.payoutProfileStatus).toBe('function');
  expect(pp.payoutProfileStatus({ payout_method: 'check', check_payee_name: 'Jane Roe', check_address_line1: '1 Main St',
    check_city: 'Detroit', check_state: 'MI', check_postal_code: '48226' })).toBe(pp.PAYOUT_STATUS.READY);
});
