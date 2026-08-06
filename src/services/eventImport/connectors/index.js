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

// Logical names (config.connector) + a kind fallback for sources that only set `kind`.
const REGISTRY = {
  csv: csvConnector,
  gsa: gsaConnector,
  feed: feedConnector,
  // kind fallbacks (import_sources.kind is constrained to csv|rest|rss|xml|json|partner|manual):
  rest: gsaConnector,
  rss: feedConnector,
  xml: feedConnector,
  json: feedConnector,
};

// getConnector(kind, selector?) — `selector` (config.connector) wins when it resolves; else kind.
function getConnector(kind, selector) {
  const conn = (selector && REGISTRY[selector]) || REGISTRY[kind];
  if (!conn) throw new Error('No connector registered for: ' + (selector || kind));
  return conn;
}

module.exports = { getConnector, REGISTRY };
