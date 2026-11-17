'use strict';

/* preflightStripeMode - which payment mode (LIVE or TEST) a read-only pre-flight should assume.

   The application derives the mode from its secret key (src/lib/stripeMode). A pre-flight run from the command line often
   cannot see that key (it is sealed in the host), so it used to assume TEST and hide every LIVE payout account, reporting a
   ready seller as not ready. This helper never reads, prints or needs a credential:

     1. If this process can see a secret key, the mode comes from its prefix, exactly as the application does.
     2. Otherwise the mode is the one the production server itself reports on its public health endpoint (stripe_mode).
     3. If neither is available the mode is UNKNOWN: nothing is patched and the pre-flight says so.

   apply() changes only how THIS process reads payout records (the default mode of maskPayoutPrefForMode). It runs inside the
   read-only pre-flight, before any service loads; the running application is not touched. */

async function resolve({ env = process.env, base, fetchImpl = (typeof fetch === 'function' ? fetch : null) } = {}) {
  const stripeMode = require('../../src/lib/stripeMode');
  const fromKey = stripeMode.secretKeyMode(env.STRIPE_SECRET_KEY);
  if (fromKey) return { live: fromKey === 'live', source: 'key' };
  if (!base || !fetchImpl) return { live: null, source: 'unknown' };
  try {
    const res = await fetchImpl(String(base).replace(/\/+$/, '') + '/api/health', { headers: { 'User-Agent': 'AdvantageBid-PilotPreflight/1.0' } });
    const h = await res.json();
    if (h && (h.stripe_mode === 'live' || h.stripe_mode === 'test') && h.stripe_keys_consistent !== false) {
      return { live: h.stripe_mode === 'live', source: 'health' };
    }
  } catch (_e) { /* unreachable: unknown */ }
  return { live: null, source: 'unknown' };
}

/** Make payout-record reads in this process use the resolved mode. No-op when the mode is unknown or came from the key. */
function apply(resolved, stripeMode = require('../../src/lib/stripeMode')) {
  if (!resolved || resolved.source !== 'health' || typeof resolved.live !== 'boolean') return false;
  const original = stripeMode.maskPayoutPrefForMode;
  stripeMode.maskPayoutPrefForMode = (pref, live = resolved.live) => original(pref, live);
  return true;
}

module.exports = { resolve, apply };
