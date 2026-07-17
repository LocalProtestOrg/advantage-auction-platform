'use strict';

/**
 * BD directory eligibility + normalization (hardened sync). Only real, active, named
 * companies enter the public mirror; sample/test/placeholder and non-active BD statuses
 * are excluded objectively (no manual curation). Street is captured for geocoding fallback.
 */

const { normalize, isEligible } = require('../src/services/bdDirectoryService');

const raw = (o) => Object.assign({ user_id: '1', company: 'Acme Auctions', status: 'Active' }, o);

describe('normalize', () => {
  test('captures name, street, coords, category, and BD publish signals', () => {
    const n = normalize(raw({ address1: '123 Main St', city: 'Houston', state_code: 'tx', lat: '29.7', lon: '-95.3', profession_id: '3', status: 'Active' }));
    expect(n.name).toBe('Acme Auctions');
    expect(n.street).toBe('123 Main St');
    expect(n.state).toBe('TX');
    expect(n.lat).toBe(29.7);
    expect(n.lng).toBe(-95.3);
    expect(n.professionId).toBe('3');
    expect(n.bdStatus).toBe('active');
  });
  test('prefers company over full_name', () => {
    expect(normalize(raw({ company: 'Beta Estate Co', full_name: 'John Doe' })).name).toBe('Beta Estate Co');
  });
});

describe('isEligible', () => {
  test('real active named company is eligible', () => {
    expect(isEligible(normalize(raw({ company: 'Simpson Galleries' })))).toBe(true);
  });
  test('sample/test/demo/placeholder names are excluded', () => {
    for (const name of ['Sample General User', 'Test Auctions LLC', 'Demo Company', 'Placeholder Estate', 'Example Sales']) {
      expect(isEligible(normalize(raw({ company: name })))).toBe(false);
    }
  });
  test('non-active BD status is excluded', () => {
    expect(isEligible(normalize(raw({ company: 'Foo Estate', status: 'Suspended' })))).toBe(false);
    expect(isEligible(normalize(raw({ company: 'Foo Estate', status: 'Pending' })))).toBe(false);
  });
  test('missing status defaults to allow (BD does not always populate it)', () => {
    expect(isEligible(normalize(raw({ company: 'Bar Auctions', status: undefined })))).toBe(true);
  });
  test('nameless or id-less records are excluded', () => {
    expect(isEligible(normalize(raw({ company: '', full_name: '' })))).toBe(false);
    expect(isEligible(normalize(raw({ user_id: undefined })))).toBe(false);
  });
});
