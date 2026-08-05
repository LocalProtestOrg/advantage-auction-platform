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

// The BD member's Business Administration home (billing / membership / directory), used by the
// Railway member shell's "Business Administration" return link. It MUST be a native BD member page —
// never BD's `default_account_home_url` (currently `enter-auctions`, which is the bridge INTO Railway),
// or the return link would loop the member straight back into the app. Configurable so BD admin can
// point it at the exact loop-free member-area slug; the default is BD's member account root.
function bdMemberAdminUrl() {
  return (process.env.BD_MEMBER_ADMIN_URL || 'https://www.advantage.bid/business-administration').replace(/\/+$/, '');
}

module.exports = { bridgeEnabled, bridgeSecret, publicAppUrl, bdMemberAdminUrl };
