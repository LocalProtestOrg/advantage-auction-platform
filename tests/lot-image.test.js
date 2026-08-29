'use strict';

/**
 * Global lot-image fallback rule. A lot with a real photo shows it; a lot with none resolves to the
 * official Advantage.Bid placeholder — never fabricated/borrowed. Presentation only: the truth signal
 * (hasNoRealImage) still reports zero real images, and the placeholder is never treated as a real image.
 */
const img = require('../src/lib/lotImage');

describe('isRealImageUrl', () => {
  test('real URLs are real', () => {
    expect(img.isRealImageUrl('https://res.cloudinary.com/x/lot-1.jpg')).toBe(true);
  });
  test('empty / null are not real', () => {
    expect(img.isRealImageUrl(null)).toBe(false);
    expect(img.isRealImageUrl('')).toBe(false);
    expect(img.isRealImageUrl('   ')).toBe(false);
  });
  test('the placeholder itself is NOT a real image', () => {
    expect(img.isRealImageUrl(img.PLACEHOLDER_URL)).toBe(false);
    expect(img.isRealImageUrl('https://cdn/img/lot-placeholder.png')).toBe(false);
  });
});

describe('primaryRealImage', () => {
  test('real image lot → its first real image (from images[])', () => {
    expect(img.primaryRealImage({ images: ['https://a/1.jpg', 'https://a/2.jpg'] })).toBe('https://a/1.jpg');
  });
  test('images[] of {image_url} objects', () => {
    expect(img.primaryRealImage({ images: [{ image_url: 'https://a/1.jpg' }] })).toBe('https://a/1.jpg');
  });
  test('falls back to thumbnail_url when images[] empty', () => {
    expect(img.primaryRealImage({ images: [], thumbnail_url: 'https://a/t.jpg' })).toBe('https://a/t.jpg');
  });
  test('no image lot → null (never a fabricated/borrowed url)', () => {
    expect(img.primaryRealImage({ images: [], thumbnail_url: null })).toBeNull();
    expect(img.primaryRealImage({})).toBeNull();
  });
  test('the placeholder in data is ignored (not a real image)', () => {
    expect(img.primaryRealImage({ thumbnail_url: img.PLACEHOLDER_URL, images: [] })).toBeNull();
  });
});

describe('lotDisplayImage + hasNoRealImage (presentation vs truth)', () => {
  test('real image lot: displays the real image; NOT flagged image-less', () => {
    const lot = { images: ['https://a/1.jpg'] };
    expect(img.lotDisplayImage(lot)).toBe('https://a/1.jpg');
    expect(img.hasNoRealImage(lot)).toBe(false);
  });
  test('multiple-image lot: primary is the first; gallery data untouched', () => {
    const lot = { images: ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg'] };
    expect(img.lotDisplayImage(lot)).toBe('https://a/1.jpg');
    expect(lot.images.length).toBe(3); // helper never mutates the lot
  });
  test('no-image lot: DISPLAY resolves to the placeholder, but TRUTH says image-less', () => {
    const lot = { images: [], thumbnail_url: null };
    expect(img.lotDisplayImage(lot)).toBe(img.PLACEHOLDER_URL);
    expect(img.hasNoRealImage(lot)).toBe(true); // seller/admin/import still know a photo is missing
  });
  test('imageOrPlaceholder resolves a single url', () => {
    expect(img.imageOrPlaceholder('https://a/1.jpg')).toBe('https://a/1.jpg');
    expect(img.imageOrPlaceholder(null)).toBe(img.PLACEHOLDER_URL);
    expect(img.imageOrPlaceholder('')).toBe(img.PLACEHOLDER_URL);
  });
});
