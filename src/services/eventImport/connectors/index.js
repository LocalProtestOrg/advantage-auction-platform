'use strict';

/**
 * Connector registry. A source selects its connector by config.connector (preferred, explicit) or falls
 * back to its DB `kind`. Phase 5F ships two lawful production connectors alongside the csv PoC:
 *   • gsa  — official GSA Auctions API (public domain). Source kind='rest'.
 *   • feed — Member Feed Sync: RSS / iCal / JSON-LD (member consent). Source kind='rss'.
 */

const csvConnector = require('./csvConnector');
const gsaConnector = require('./gsaConnector');
const feedConnector = require('./feedConnector');
const txauctionConnector = require('./txauctionConnector');

// Logical names (config.connector) + a kind fallback for sources that only set `kind`.
//
// MEMBER NEUTRALITY (2026-09-24): no connector here is dedicated to an Advantage.Bid MEMBER company.
// Members publish through their member account, or through the generic, consent-gated Member Feed Sync
// ('feed') that every Professional Seller can use. The former Lewis & Maese connector was retired; its
// source row stays (disabled, RETIRED) for history and its events keep their original attribution.
const REGISTRY = {
  csv: csvConnector,
  gsa: gsaConnector,
  feed: feedConnector,
  txauction: txauctionConnector,   // Gaston & Sheehan (Treasury/USMS/local gov auctions); select via config.connector

  // kind fallbacks (import_sources.kind is constrained to csv|rest|rss|xml|json|partner|manual):
  rest: gsaConnector,
  rss: feedConnector,
  xml: feedConnector,
  json: feedConnector,
};

// getConnector(kind, selector?) — `selector` (config.connector) wins when it resolves; else kind.
function getConnector(kind, selector) {
  // A source that NAMES a connector gets exactly that connector or nothing. Falling back to its kind
  // would let a retired/unknown connector silently run a different source's importer (e.g. a retired
  // 'rest' connector quietly becoming the GSA connector) — fail closed instead.
  if (selector) {
    if (!REGISTRY[selector]) throw new Error('No connector registered for: ' + selector);
    return REGISTRY[selector];
  }
  const conn = REGISTRY[kind];
  if (!conn) throw new Error('No connector registered for: ' + (selector || kind));
  return conn;
}

module.exports = { getConnector, REGISTRY };
