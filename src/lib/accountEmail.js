'use strict';

/**
 * Account email matching (security audit 2026-10-15, owner item 6): emails are matched case-insensitively and without
 * surrounding spaces, so "Ann@Example.com" and "ann@example.com " are the same account. Accounts are NEVER merged: if
 * two existing accounts differ only by case (none in production on 2026-10-15), an exact match wins, and otherwise the
 * lookup is treated as ambiguous (no account) and logged for staff to resolve.
 */
const db = require('../db');

function normalizeEmail(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }

/** The one account for this email, or null (none, or ambiguous). `columns` is a fixed SQL column list from the caller. */
async function findUserByEmail(email, columns = '*', runner = db) {
  const raw = typeof email === 'string' ? email.trim() : '';
  if (!raw) return null;
  const { rows } = await runner.query(
    `SELECT ${columns}, (email = $1) AS _exact FROM users WHERE lower(btrim(email)) = $2 ORDER BY (email = $1) DESC, created_at ASC LIMIT 2`,
    [raw, normalizeEmail(raw)]);
  if (!rows.length) return null;
  if (rows.length > 1 && !rows[0]._exact) {
    console.warn('[account-email] two accounts differ only by letter case; sign-in refused until staff resolve it');
    return null;
  }
  const { _exact, ...user } = rows[0];
  return user;
}

module.exports = { normalizeEmail, findUserByEmail };
