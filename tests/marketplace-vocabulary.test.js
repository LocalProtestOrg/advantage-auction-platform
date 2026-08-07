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

describe('homepage map legend — five owner-locked sections, canonical counts, tooltips', () => {
  test('sections: Advantage.Bid Auctions, Auction Partner Events, Estate Sales, Marketplace, Professionals', () => {
    for (const s of ['Advantage\\.Bid Auctions', 'Auction Partner Events', 'Estate Sales', 'Marketplace', 'Professionals']) {
      expect(index).toMatch(new RegExp("legendSec\\('" + s + "'"));
    }
  });
  test('family counts come from CANONICAL inventory (CANON_COUNTS.families), NOT map pins/viewport', () => {
    expect(index).toMatch(/marketplace\/counts/);                     // fetched from the canonical endpoint
    expect(index).toMatch(/'Auction Partner Events',f\.partner_event/); // partner_event inventory total
    expect(index).toMatch(/'Estate Sales',f\.estate_sale/);
    expect(index).toMatch(/'Marketplace',f\.marketplace/);            // Marketplace = fixed-price family, not directory
  });
  test('Professionals is a SEPARATE section (directory), counts from professionals.*', () => {
    expect(index).toMatch(/legendSec\('Professionals'/);
    expect(index).toMatch(/pr\[c\.key\]/);                            // professional rows use professionals counts
  });
  test('the confusing "Other Estate Services" row is excluded', () => {
    expect(index).toMatch(/c\.key!=='estate_services'/);
  });
  test('tooltips: hover + keyboard focus (title on rows and sections, tabindex on sections)', () => {
    expect(index).toMatch(/LEGEND_TIPS/);
    expect(index).toMatch(/title="'\+esc\(tip\)\+'"/);
    expect(index).toMatch(/legendSec\(label,tip\)\{[\s\S]{0,120}tabindex="0" title=/);
  });
});

describe('canonical counts endpoint + Marketplace-vs-Professionals rule', () => {
  test('/api/public/marketplace/counts exposes families + professionals from canonicalCounts', () => {
    expect(publicRoutes).toMatch(/\/marketplace\/counts/);
    expect(publicRoutes).toMatch(/families: c\.families/);
    expect(publicRoutes).toMatch(/professionals: c\.professionals/);
    expect(publicRoutes).toMatch(/canonicalCounts/);
  });
});

describe('MARKETPLACE_ARCHITECTURE.md exists at repo root with the locked rules', () => {
  const p = path.join(__dirname, '..', 'MARKETPLACE_ARCHITECTURE.md');
  test('the permanent architecture document exists', () => {
    expect(fs.existsSync(p)).toBe(true);
  });
  test('documents the four families + Marketplace=fixed-price + Professionals separate + no viewport counts', () => {
    const md = fs.readFileSync(p, 'utf8');
    for (const s of ['Advantage.Bid Auctions', 'Auction Partner Events', 'Estate Sales', 'Marketplace']) expect(md).toContain(s);
    expect(md).toMatch(/fixed-price/i);
    expect(md).toMatch(/Professionals/);
    expect(md).toMatch(/never.*map pins|never.*viewport|not.*from map pins/i);
    expect(md).toMatch(/GSA.*partner_event|partner_event.*GSA/i);
  });
});

describe('marketplace-feed widget uses the owner-locked family_label', () => {
  const widget = fs.readFileSync(path.join(__dirname, '..', 'public', 'widgets', 'marketplace-feed.js'), 'utf8');
  test('card badge reads it.family_label (from the canonical API), with a back-compat fallback', () => {
    expect(widget).toMatch(/it\.family_label \|\|/);
  });
});
