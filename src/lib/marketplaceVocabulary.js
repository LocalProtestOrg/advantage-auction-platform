'use strict';

/**
 * marketplaceVocabulary — the ONE canonical set of public marketplace family labels (Phase 5F/owner-
 * locked). Every surface (map legend, filters, search, widgets, feed API display, structured-data and
 * analytics labels) must use these strings — never a local copy. Same governance as marketplaceVisibility:
 * one definition, imported everywhere, enforced by the Marketplace Integrity Suite.
 *
 * The four families:
 *   advantage_auction — Advantage.Bid Auctions   (native platform auctions; the `auctions` table)
 *   partner_event     — Auction Partner Events    (imported/partner auction EVENTS; events.sale_type='auction')
 *   estate_sale       — Estate Sales              (events.sale_type <> 'auction')
 *   marketplace       — Marketplace               (company / professional directory)
 */

const FAMILIES = {
  advantage_auction: { key: 'advantage_auction', label: 'Advantage.Bid Auctions', tip: 'Auctions hosted directly on Advantage.Bid.' },
  partner_event:     { key: 'partner_event',     label: 'Auction Partner Events', tip: 'Auctions run by partner auction companies, listed on Advantage.Bid.' },
  estate_sale:       { key: 'estate_sale',       label: 'Estate Sales',           tip: 'In-person estate sales from verified estate-sale companies.' },
  marketplace:       { key: 'marketplace',       label: 'Marketplace',            tip: 'Auction houses, estate-sale companies and appraisers in the directory.' },
};

const ORDER = ['advantage_auction', 'partner_event', 'estate_sale', 'marketplace'];

// Classify a marketplace-feed row → family key.
//   feedKind: the feed's `type` ('auction' | 'estate_sale'); isNative: true for the native auctions table.
function familyForFeedItem(feedKind, isNative) {
  if (feedKind === 'estate_sale') return 'estate_sale';
  return isNative ? 'advantage_auction' : 'partner_event';
}

function labelForFamily(key) { return (FAMILIES[key] || {}).label || null; }

module.exports = { FAMILIES, ORDER, familyForFeedItem, labelForFamily };
