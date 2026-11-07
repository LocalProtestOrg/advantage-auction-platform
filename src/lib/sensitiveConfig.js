'use strict';

/**
 * sensitiveConfig — the ONE list of platform settings that only the platform owner may change (owner decision
 * 2026-11-06). Everything else stays editable by any active admin, as before.
 *
 * Sensitive: pricing and business terms, paid advertising authority (gates, ceilings, budgets, kill switches,
 * destinations, measurement), outreach and messaging programme switches, Sasha, seller activation, owner notice
 * addresses and webhooks. Pure: no I/O.
 *
 * Also owns secret masking for the platform setting audit trail, so a stored token or key never lands in an audit
 * row or an owner notice in clear text.
 */

const PREFIXES = Object.freeze([
  'pricing.', 'business.',
  'marketing.paid',                // marketing.paid.*, marketing.paid_growth.* and any other marketing.paid* key
  'marketing.destinations.', 'marketing.measurement.',
  'sasha.', 'seller_activation.', 'claimed_listings.', 'event_partners.', 'auction_sms.',
  'owner.', 'webhooks.',
]);
const EXACT = Object.freeze(['marketing.a7_send_enabled', 'marketing.a9_publish_enabled']);
const CONTAINS = Object.freeze(['kill', 'ceiling', 'budget', 'execution']);

function normalize(key) { return String(key == null ? '' : key).trim().toLowerCase(); }

/** True when only the platform owner may write this key. */
function isSensitive(key) {
  const k = normalize(key);
  if (!k) return false;
  if (EXACT.includes(k)) return true;
  if (PREFIXES.some((p) => k.startsWith(p))) return true;
  return CONTAINS.some((w) => k.includes(w));
}

/**
 * A write that only turns something OFF (or engages a kill switch) is a safety stop. Any active admin may make one
 * on the routes that offer it; the owner is notified. Never a way to turn anything on.
 */
function isSafetyStopValue(key, value) {
  const k = normalize(key);
  if (k.includes('kill')) return value === true || value === 'true';
  return value === false || value === 'false';
}

const SECRET_NAME = /(token|secret|password|passwd|api[_-]?key|apikey|private|credential|signing|auth[_-]?key|access[_-]?key|client[_-]?secret)/i;
const SECRET_VALUE = /^(sk|rk|pk|whsec|xox[abprs])_[A-Za-z0-9_]{8,}|^EAA[A-Za-z0-9]{20,}|^AKIA[A-Z0-9]{12,}|^[A-Za-z0-9+/_=-]{40,}$/;

/** A copy of `value` with anything that looks secret replaced by '[masked]'. Never throws. */
function maskValue(key, value, depth = 0) {
  if (SECRET_NAME.test(String(key || ''))) return value == null ? value : '[masked]';
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return SECRET_VALUE.test(value.trim()) ? '[masked]' : value;
  if (Array.isArray(value)) return value.map((v) => maskValue('', v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_NAME.test(k) ? (v == null ? v : '[masked]') : maskValue('', v, depth + 1);
    return out;
  }
  return value;
}

module.exports = { PREFIXES, EXACT, CONTAINS, isSensitive, isSafetyStopValue, maskValue };
