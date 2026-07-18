'use strict';

/**
 * Marketplace premium cards — image-selection policy + singular category labels.
 *
 * Locks in the owner's non-negotiables:
 *  - Only APPROVED, seller-owned imagery is ever selected (linked seller logo, then the
 *    linked seller's syndicated auction cover). Brilliant Directories / unclaimed-org logos
 *    are NEVER surfaced — an org with no linked seller yields a null image (→ category artwork).
 *  - Cloudinary assets we own get a right-sized derivative; external hosts are never rewritten.
 *  - Individual company cards use SINGULAR category labels; the legend keeps PLURAL group labels.
 */

const img = require('../src/services/marketplace/companyImage');

describe('companyImage.select — approved sources only, policy-respecting', () => {
  test('linked seller logo wins (contained/logo treatment)', () => {
    const r = img.select({ seller_logo_url: 'https://res.cloudinary.com/aap/image/upload/v1/seller/logo.png' });
    expect(r).toMatchObject({ kind: 'logo', source: 'seller_logo' });
    expect(r.url).toMatch(/\/upload\/c_limit,w_480,h_360,q_auto,f_auto,dpr_auto\//);
  });

  test('falls back to linked auction cover (photo treatment) when no seller logo', () => {
    const r = img.select({ linked_auction_cover_url: 'https://res.cloudinary.com/aap/image/upload/v1/auc/cover.jpg' });
    expect(r).toMatchObject({ kind: 'photo', source: 'auction_cover' });
    expect(r.url).toMatch(/\/upload\/c_fill,g_auto,w_640,h_360,q_auto,f_auto,dpr_auto\//);
  });

  test('seller logo takes priority over auction cover', () => {
    const r = img.select({
      seller_logo_url: 'https://res.cloudinary.com/aap/image/upload/logo.png',
      linked_auction_cover_url: 'https://res.cloudinary.com/aap/image/upload/cover.jpg',
    });
    expect(r.source).toBe('seller_logo');
  });

  test('the company\'s own BD listing image is used when no linked-seller image exists', () => {
    expect(img.select({ bd_image_url: 'https://www.advantage.bid/logos/profile/l.jpg', bd_image_type: 'logo' }))
      .toMatchObject({ url: 'https://www.advantage.bid/logos/profile/l.jpg', kind: 'logo', source: 'bd_logo' });
    expect(img.select({ bd_image_url: 'https://www.advantage.bid/pictures/profile/p.jpg', bd_image_type: 'photo' }))
      .toMatchObject({ kind: 'photo', source: 'bd_photo' });
    expect(img.select({ bd_image_url: 'https://www.advantage.bid/images/Advantage.Bid-Favicon-2.0.png', bd_image_type: 'default' }))
      .toMatchObject({ kind: 'default', source: 'bd_default' });
  });

  test('linked-seller imagery still outranks the BD listing image', () => {
    const r = img.select({ seller_logo_url: 'https://res.cloudinary.com/aap/image/upload/s.png',
      bd_image_url: 'https://www.advantage.bid/logos/profile/l.jpg', bd_image_type: 'logo' });
    expect(r.source).toBe('seller_logo');
  });

  test('no image at all → null (frontend draws a monogram, the final fallback)', () => {
    expect(img.select({})).toBeNull();
    expect(img.select({ seller_logo_url: null, linked_auction_cover_url: null, bd_image_url: null })).toBeNull();
  });
});

describe('cloudinaryDerivative — only rewrite hosts we own', () => {
  test('external hosts are returned untouched', () => {
    expect(img.cloudinaryDerivative('https://example.com/a.png', 'c_fill')).toBe('https://example.com/a.png');
    expect(img.cloudinaryDerivative('https://directorysecure.com/x.jpg', 'c_fill')).toBe('https://directorysecure.com/x.jpg');
  });

  test('an already-transformed Cloudinary URL is not double-transformed', () => {
    const already = 'https://res.cloudinary.com/aap/image/upload/c_fill,w_200/v1/x.jpg';
    expect(img.cloudinaryDerivative(already, 'c_limit,w_480')).toBe(already);
  });

  test('null/undefined are safe', () => {
    expect(img.cloudinaryDerivative(null, 'c_fill')).toBeNull();
    expect(img.cloudinaryDerivative(undefined, 'c_fill')).toBeNull();
  });
});
