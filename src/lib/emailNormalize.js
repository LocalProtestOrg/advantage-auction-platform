'use strict';

/**
 * emailNormalize — the ONE canonical email normalization used across suppression + audience operations.
 * Conservative: trim + lowercase only (never alters mailbox identity, e.g. no gmail dot-stripping).
 * The original/source address is preserved separately by callers.
 */
function normalizeEmail(email) {
  if (email == null) return null;
  const s = String(email).trim().toLowerCase();
  if (!s || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return null; // invalid → null (never a false key)
  return s;
}
module.exports = { normalizeEmail };
