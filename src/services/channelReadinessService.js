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
      if (await marketingConfig.getBool('marketing.destinations.meta_enabled', false)) return 'available';
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

module.exports = { statusFor, isExecutable, matrix };
