'use strict';

/**
 * Global auction/sale COVER-image fallback. Real seller cover → shown; no real cover → the official square
 * Advantage.Bid placeholder, rendered CONTAINED (never cropped/zoomed). Presentation only — the placeholder
 * never becomes database/media truth. Reuses the certified lot-image placeholder asset + helper; the
 * existing LOT fallback stays intact.
 */
const fs = require('fs');
const path = require('path');
const img = require('../src/lib/lotImage');
const clientJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'widgets', 'shared', 'lot-image.js'), 'utf8');

const A = (over) => Object.assign({ cover_image_url: null, banner_image_url: null }, over);

describe('auction cover fallback (server helper)', () => {
  test('CASE 1 — real cover is returned as-is', () => {
    const a = A({ cover_image_url: 'https://res.cloudinary.com/x/cover.jpg' });
    expect(img.hasRealAuctionCover(a)).toBe(true);
    expect(img.auctionCoverOrPlaceholder(a)).toBe('https://res.cloudinary.com/x/cover.jpg');
  });
  test('CASE 2 — null cover → official placeholder', () => {
    expect(img.auctionCoverOrPlaceholder(A({ cover_image_url: null }))).toBe(img.PLACEHOLDER_URL);
    expect(img.PLACEHOLDER_URL).toBe('/img/lot-placeholder.png');
  });
  test('CASE 3 — empty/whitespace cover → placeholder', () => {
    expect(img.auctionCoverOrPlaceholder(A({ cover_image_url: '' }))).toBe(img.PLACEHOLDER_URL);
    expect(img.auctionCoverOrPlaceholder(A({ cover_image_url: '   ' }))).toBe(img.PLACEHOLDER_URL);
  });
  test('CASE 4 — legacy default/wide graphic → treated as NO cover → placeholder', () => {
    const a = A({ cover_image_url: 'https://bid.advantage.bid/img/social-card.png' });
    expect(img.isLegacyAuctionCoverDefault(a.cover_image_url)).toBe(true);
    expect(img.hasRealAuctionCover(a)).toBe(false);
    expect(img.auctionCoverOrPlaceholder(a)).toBe(img.PLACEHOLDER_URL);
  });
  test('banner_image_url is used when cover_image_url is absent', () => {
    expect(img.auctionCoverOrPlaceholder(A({ banner_image_url: 'https://x/banner.jpg' }))).toBe('https://x/banner.jpg');
  });
  test('CASE 8 — placeholder is NOT auction cover truth (helper never mutates; hasRealAuctionCover=false)', () => {
    const a = A({ cover_image_url: null });
    img.auctionCoverOrPlaceholder(a);
    expect(a.cover_image_url).toBeNull();       // unchanged — presentation only
    expect(img.hasRealAuctionCover(a)).toBe(false);
  });
  test('CASE 9 — a Maplewood-like auction (no cover) resolves to the placeholder', () => {
    const maplewood = { title: 'The Maplewood Estate Collection', cover_image_url: null, banner_image_url: null };
    expect(img.hasRealAuctionCover(maplewood)).toBe(false);
    expect(img.auctionCoverOrPlaceholder(maplewood)).toBe(img.PLACEHOLDER_URL);
  });
  test('the branded partner-EVENT placeholders are NOT treated as auction legacy defaults (events untouched)', () => {
    expect(img.isLegacyAuctionCoverDefault('/img/auction-partner-placeholder.svg')).toBe(false);
    expect(img.isLegacyAuctionCoverDefault('/img/gsa-surplus-placeholder.svg')).toBe(false);
  });
});

describe('placeholder is rendered CONTAINED, real covers keep crop (client helper)', () => {
  test('CASE 6 — placeholder gets the contain class + injected contain style', () => {
    expect(clientJs).toMatch(/adv-lot-ph/);
    expect(clientJs).toMatch(/\.adv-lot-img\.adv-lot-ph\{object-fit:contain/);
  });
  test('CASE 7 — a REAL image does NOT get the contain class (keeps page cover/crop)', () => {
    // img() adds adv-lot-ph only when the url is not real.
    expect(clientJs).toMatch(/real \? '' : ' adv-lot-ph'/);
  });
  test('CASE 5 — a broken image falls back to the CONTAINED placeholder without a loop', () => {
    expect(clientJs).toMatch(/data-adv-fallback/);                 // loop guard
    expect(clientJs).toMatch(/classList\.add\('adv-lot-ph'\)/);    // broken → contained placeholder
  });
});

describe('CASE 10 — existing LOT-image fallback remains intact', () => {
  test('lot helpers still resolve real image vs placeholder', () => {
    expect(img.lotDisplayImage({ images: ['https://a/1.jpg'] })).toBe('https://a/1.jpg');
    expect(img.lotDisplayImage({ images: [], thumbnail_url: null })).toBe(img.PLACEHOLDER_URL);
    expect(img.hasNoRealImage({ images: [] })).toBe(true);
    expect(img.primaryRealImage({ images: ['https://a/2.jpg'] })).toBe('https://a/2.jpg');
  });
});
