'use strict';

/**
 * Config + feature flag for the BD → Advantage.Bid identity bridge (Option B).
 * DEFAULT OFF: unless IDENTITY_BRIDGE_ENABLED === 'true', the bridge routes are never mounted, so
 * production authentication is completely unaffected. Host-independent (env only).
 */

function bridgeEnabled() {
  return String(process.env.IDENTITY_BRIDGE_ENABLED || '').trim().toLowerCase() === 'true';
}
function bridgeSecret() {
  return process.env.BD_BRIDGE_SECRET || '';
}
function publicAppUrl() {
  return (process.env.PUBLIC_APP_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
}

module.exports = { bridgeEnabled, bridgeSecret, publicAppUrl };
