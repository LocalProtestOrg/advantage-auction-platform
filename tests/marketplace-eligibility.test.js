'use strict';

/**
 * Marketplace eligibility + BD image classification (map-refinement initiative).
 *
 * Requirement 8 regression: administrative / non-business Brilliant Directories records
 * (the canonical "Admin User - Blog Author" case, plus sample/general-user accounts) must be
 * excluded from the Marketplace by a durable, structured rule — a non-empty `company` name —
 * and stay excluded after every nightly synchronization. Legitimate businesses are preserved.
 *
 * Also verifies the image-classification the card treatments depend on (logo / photo / default).
 */

const bd = require('../src/services/bdDirectoryService');

const rec = (o) => bd.normalize(o);
const FAVICON = 'https://www.advantage.bid/images/Advantage.Bid-Favicon-2.0.png';

describe('isEligible — only real businesses reach the Marketplace', () => {
  test('EXCLUDES the "Admin User - Blog Author" record (empty company)', () => {
    const r = rec({ user_id: '5', first_name: 'Admin User - ', last_name: 'Blog Author', company: '',
      status: 'Active', profession_id: '0', filename: 'new-york/admin-user-blog-author', image_main_file: FAVICON });
    expect(bd.isEligible(r)).toBe(false);
  });

  test('EXCLUDES general-user / individual accounts with no company', () => {
    expect(bd.isEligible(rec({ user_id: '351', first_name: 'Angela', last_name: 'Prejean', company: '', status: 'Active' }))).toBe(false);
    expect(bd.isEligible(rec({ user_id: '4', first_name: 'Sample General', last_name: 'User', company: '', status: 'Active' }))).toBe(false);
  });

  test('EXCLUDES sample/test/demo business names', () => {
    expect(bd.isEligible(rec({ user_id: '9', company: 'Sample Estate Co', status: 'Active' }))).toBe(false);
  });

  test('EXCLUDES non-active listings', () => {
    expect(bd.isEligible(rec({ user_id: '9', company: 'Real Co LLC', status: 'Pending' }))).toBe(false);
  });

  test('INCLUDES a real named business', () => {
    const r = rec({ user_id: '21', company: 'Simpson Galleries, LLC', status: 'Active',
      filename: 'united-states/houston/auction-house/simpson-galleries-llc', image_main_file: 'https://www.advantage.bid/logos/profile/limage-23.jpg' });
    expect(bd.isEligible(r)).toBe(true);
  });
});

describe('normalize — BD image classification + canonical fields', () => {
  test('uploaded logo → type "logo"', () => {
    expect(rec({ user_id: '1', company: 'X', image_main_file: 'https://www.advantage.bid/logos/profile/limage-23.jpg' }).bdImageType).toBe('logo');
  });
  test('uploaded picture → type "photo"', () => {
    expect(rec({ user_id: '1', company: 'X', image_main_file: 'https://www.advantage.bid/pictures/profile/pimage-1.jpg' }).bdImageType).toBe('photo');
  });
  test('BD favicon → type "default"', () => {
    expect(rec({ user_id: '1', company: 'X', image_main_file: FAVICON }).bdImageType).toBe('default');
  });
  test('carries the canonical profile slug', () => {
    expect(rec({ user_id: '1', company: 'X', filename: 'united-states/houston/auction-house/simpson-galleries-llc' }).profilePath)
      .toBe('united-states/houston/auction-house/simpson-galleries-llc');
  });
});
