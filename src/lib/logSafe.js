'use strict';

/**
 * Log-safe forms of personal data (security audit 2026-10-15): logs keep enough to trace a problem (first character and
 * domain) without storing customers' full email addresses in the hosting provider's log retention.
 */
function maskEmailForLog(value) {
  if (Array.isArray(value)) return value.map(maskEmailForLog).join(', ');
  const s = String(value == null ? '' : value).trim();
  if (!s) return '(none)';
  return s.split(/\s*,\s*/).map((one) => {
    const m = /<?([^<>\s@]+)@([^<>\s@]+)>?$/.exec(one);
    return m ? m[1].charAt(0) + '***@' + m[2].toLowerCase() : '(address hidden)';
  }).join(', ');
}

module.exports = { maskEmailForLog };
