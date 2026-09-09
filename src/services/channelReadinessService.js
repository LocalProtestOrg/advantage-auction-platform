'use strict';

/**
 * channelReadinessService — reports per-channel fulfillment readiness for the obligation engine so it can
 * plan, substitute, or hold rather than falsely mark work complete. Reuses the existing execution gates
 * (executionAuthorizationService / marketing.* config) — it NEVER flips a gate. Status vocabulary:
 *   available     — can be fulfilled now (internal channel, or an enabled external channel)
 *   gated         — capability exists but is intentionally OFF (e.g. paid/email/social not activated)
 *   unavailable   — no provider/capability at all
 *   degraded      — partially available
 * Internal channels (listing/homepage/creative/onsite-internal/analytics) are available; external
 * publishing/sending/spend channels report their real gate state.
 */

const marketingConfig = require('./marketingConfigService');

async function statusFor(channel) {
  switch (channel) {
    case 'listing':
    case 'creative':
    case 'analytics':
    case 'homepage':
      return 'available';                                  // internal Advantage.Bid capabilities
    case 'onsite':
      return (await marketingConfig.getBool('marketing.onsite.enabled', false)) ? 'available' : 'gated';
    case 'email':
      return (await marketingConfig.getBool('marketing.a7_send_enabled', false)) ? 'available' : 'gated';
    case 'social':
      return (await marketingConfig.getBool('marketing.a9_publish_enabled', false)) ? 'available' : 'gated';
    case 'paid':
      // Paid is available only if at least one paid destination gate is on.
      if (await marketingConfig.getBool('marketing.destinations.google_ads_enabled', false)) return 'available';
      // PAID Meta gate (split from the organic publishing gate marketing.destinations.meta_enabled — mig 146).
      if (await marketingConfig.getBool('marketing.destinations.meta_ads_enabled', false)) return 'available';
      return 'gated';
    default:
      return 'unavailable';
  }
}

// Whether an obligation on this channel can currently be executed live.
async function isExecutable(channel) { return (await statusFor(channel)) === 'available'; }

// Full readiness matrix (admin-facing; no secrets).
async function matrix() {
  const channels = ['listing', 'homepage', 'creative', 'analytics', 'onsite', 'email', 'social', 'paid'];
  const out = {};
  for (const c of channels) out[c] = await statusFor(c);
  return out;
}

// ── Phase 3O 6-state readiness (NOT_CONFIGURED/CONFIGURED_UNVERIFIED/SHADOW_CERTIFIED/ACTIVE/PAUSED/REVOKED)
// Read from the durable marketing_channel_readiness table (seeded by mig 141). Internal channels = ACTIVE;
// gated externals = SHADOW_CERTIFIED (software built) until an Owner/provider activates them.
const db = require('../db');
async function phase3oState(channelKey, runner) {
  const r = runner || db;
  const row = (await r.query(`SELECT state FROM marketing_channel_readiness WHERE channel_key=$1`, [String(channelKey || '').toLowerCase()])).rows[0];
  return row ? row.state : 'NOT_CONFIGURED';
}
async function phase3oMatrix(runner) {
  const r = runner || db;
  const rows = (await r.query(`SELECT channel_key, state, owner_action_required, fallback_ladder FROM marketing_channel_readiness ORDER BY channel_key`)).rows;
  return rows;
}
// A channel is executable for REAL fulfillment only when ACTIVE. SHADOW_CERTIFIED = software-certified, not
// real send (evidence marked shadow).
async function isActive(channelKey, runner) { return (await phase3oState(channelKey, runner)) === 'ACTIVE'; }

module.exports = { statusFor, isExecutable, matrix, phase3oState, phase3oMatrix, isActive };
