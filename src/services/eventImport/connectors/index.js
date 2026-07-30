'use strict';

/**
 * Connector registry. A new source registers here (or is loaded by kind) and touches nothing else in
 * the pipeline. V1 ships only the CSV proof-of-concept; rss/xml/json/rest/partner are future waves.
 */

const csvConnector = require('./csvConnector');

const REGISTRY = { csv: csvConnector };

function getConnector(kind) {
  const conn = REGISTRY[kind];
  if (!conn) throw new Error('No connector registered for kind: ' + kind);
  return conn;
}

module.exports = { getConnector, REGISTRY };
