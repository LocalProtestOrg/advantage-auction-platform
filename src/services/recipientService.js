'use strict';

/**
 * recipientService — the single source of truth for a user's OUTBOUND transactional-email recipient.
 *
 * Bridge-created accounts (auth_source='bd_bridge') store a namespaced, undeliverable placeholder in
 * users.email (an internal unique login identifier only) and their real inbox in users.contact_email.
 * Native accounts have contact_email = NULL, so they resolve to users.email exactly as before.
 *
 * Every buyer transactional-email path MUST resolve its recipient through this module — either the
 * async resolveUserContactEmail(userId) helper, or by embedding recipientEmailSql(alias) inside an
 * existing query that already joins users. Keeping the COALESCE expression in ONE place prevents a
 * future email feature from silently sending to a namespaced placeholder.
 */

const db = require('./../db');

// Canonical recipient expression. `alias` is the table alias for users in the caller's query
// (e.g. 'u'); pass '' when selecting from users unqualified.
function recipientEmailSql(alias) {
  const p = alias ? alias + '.' : '';
  return `COALESCE(NULLIF(${p}contact_email, ''), ${p}email)`;
}

// Resolve a single user's deliverable recipient address. Returns null if the user does not exist.
async function resolveUserContactEmail(userId, runner) {
  const { rows } = await (runner || db).query(
    `SELECT ${recipientEmailSql('')} AS email FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] ? rows[0].email : null;
}

module.exports = { recipientEmailSql, resolveUserContactEmail };
