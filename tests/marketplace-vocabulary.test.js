'use strict';

// Owner-locked marketplace vocabulary (Phase 5F). Verifies the canonical labels, the feed's family
// classification, and that the homepage map legend uses the four labels (and drops "Other Estate…").

const fs = require('fs');
const path = require('path');
const vocab = require('../src/lib/marketplaceVocabulary');
const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const publicRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'public.js'), 'utf8');

describe('marketplaceVocabulary — the four locked labels', () => {
  test('exact owner-locked labels', () => {
    expect(vocab.FAMILIES.advantage_auction.label).toBe('Advantage.Bid Auctions');
    expect(vocab.FAMILIES.partner_event.label).toBe('Auction Partner Events');
    expect(vocab.FAMILIES.estate_sale.label).toBe('Estate Sales');
    expect(vocab.FAMILIES.marketplace.label).toBe('Marketplace');
    expect(vocab.ORDER).toEqual(['advantage_auction', 'partner_event', 'estate_sale', 'marketplace']);
  });
  test('familyForFeedItem: native auction → advantage_auction, event auction → partner_event, estate → estate_sale', () => {
    expect(vocab.familyForFeedItem('auction', true)).toBe('advantage_auction');
    expect(vocab.familyForFeedItem('auction', false)).toBe('partner_event');
    expect(vocab.familyForFeedItem('estate_sale', false)).toBe('estate_sale');
    expect(vocab.labelForFamily('partner_event')).toBe('Auction Partner Events');
  });
});

describe('feed API exposes the family + owner-locked family_label (additive, back-compat)', () => {
  test('native branch tags advantage_auction; event branch tags partner_event/estate_sale', () => {
    expect(publicRoutes).toMatch(/'advantage_auction'::text AS source_family/);
    expect(publicRoutes).toMatch(/'partner_event' ELSE 'estate_sale' END\)::text AS source_family/);
  });
  test('response carries type (unchanged), family and family_label', () => {
    expect(publicRoutes).toMatch(/type: r\.kind/);              // back-compat preserved
    expect(publicRoutes).toMatch(/family: r\.source_family/);
    expect(publicRoutes).toMatch(/family_label: labelForFamily\(r\.source_family\)/);
  });
});

describe('homepage map legend uses the four labels + drops "Other Estate…" + tooltips', () => {
  test('the four locked labels appear in the legend', () => {
    expect(index).toMatch(/>Advantage\.Bid Auctions</);
    expect(index).toMatch(/Auction Partner Events/);
    expect(index).toMatch(/label:'Estate Sales'/);
    expect(index).toMatch(/>Marketplace</);
  });
  test('the confusing "Other Estate Services" row is excluded from the legend', () => {
    expect(index).toMatch(/c\.key!=='estate_services'/);       // filtered out of the rendered legend
  });
  test('legend rows carry hover tooltips (helper text replaced by title=)', () => {
    expect(index).toMatch(/LEGEND_TIPS/);
    expect(index).toMatch(/title="'\+esc\(tip\)\+'"/);
  });
});

describe('marketplace-feed widget uses the owner-locked family_label', () => {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'public', 'widgets', 'marketplace-feed.js'), 'utf8');
  test('card badge reads it.family_label (from the canonical API), with a back-compat fallback', () => {
    expect(widget).toMatch(/it\.family_label \|\|/);
  });
});
