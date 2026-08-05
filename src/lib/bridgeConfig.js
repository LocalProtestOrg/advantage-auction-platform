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

// The BD member's Business Administration workspace (membership / billing / company listing / leads /
// reviews / QR / account), used by the member shell's "Business Administration" return link. This is
// BD's real authenticated member area (`/account`) — NOT the `/business-administration` marketing/intro
// landing (which re-prompts login and routes outward), and NOT `default_account_home_url` (`enter-auctions`,
// the bridge INTO Railway → would loop). Configurable via env for BD admin.
function bdMemberAdminUrl() {
  return (process.env.BD_MEMBER_ADMIN_URL || 'https://www.advantage.bid/account').replace(/\/+$/, '');
}

module.exports = { bridgeEnabled, bridgeSecret, publicAppUrl, bdMemberAdminUrl };
