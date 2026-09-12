'use strict';

/**
 * partnerSuppressionService — Event Partner outreach suppression, deliberately its own record.
 *
 * Why not reuse the consumer marketing tables: `marketing_contacts.permission_basis` has a CHECK
 * constraint with no value for legitimate business-to-business outreach, and its frequency caps were
 * designed for consumer marketing. Reusing it would either misclassify the permission basis or force a
 * CHECK migration, and it would blur the separation Phase 1 was built to guarantee.
 *
 * The six separate records, never coupled:
 *   1. outreach suppression   (this file)
 *   2. company decline        (authorized_event_sources.status = 'declined')
 *   3. event-source authorization (authorized_event_sources, authorized states)
 *   4. authorization revocation   (authorized_event_sources.revoked_*)
 *   5. listing ownership          (organization_members / claim tokens)
 *   6. seller activation          (organization_capabilities)
 *
 * A STOP suppresses outreach and says nothing about an already-granted collection permission.
 * A revocation stops collection and says nothing about email permission. Neither implies the other,
 * and nothing here can change an authorization's status.
 *
 * `isSuppressed` honours BOTH this table and the platform-wide `email_suppressions` table — either
 * one is a hard stop, so a consumer-marketing unsubscribe is also respected here.
 */

const db = require('../../db');
const { normalizeEmail } = require('../../lib/emailNormalize');

const q = (client) => (client || db);

const REASONS = Object.freeze([
  'stop_request', 'decline', 'hard_bounce', 'complaint', 'wrong_contact', 'admin', 'compliance',
]);

/**
 * Suppress an address for Event Partner outreach. Idempotent; a later reason replaces an earlier one
 * so the most recent cause is what the record shows.
 */
async function suppress(input, client) {
  input = input || {};
  const normalized = normalizeEmail(input.email);
  if (!normalized) return null;
  const reason = REASONS.indexOf(input.reason) !== -1 ? input.reason : 'admin';
  const { rows } = await q(client).query(
    `INSERT INTO event_partner_suppressions
       (normalized_email, email, reason, source, organization_id, message_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (normalized_email) DO UPDATE
       SET reason = EXCLUDED.reason, source = EXCLUDED.source,
           organization_id = COALESCE(EXCLUDED.organization_id, event_partner_suppressions.organization_id),
           message_id = COALESCE(EXCLUDED.message_id, event_partner_suppressions.message_id),
           notes = COALESCE(EXCLUDED.notes, event_partner_suppressions.notes),
           updated_at = now()
     RETURNING *`,
    [normalized, input.email || normalized, reason, input.source || 'inbound_reply',
     input.organizationId || null, input.messageId || null, input.notes || null]);
  return rows[0];
}

/**
 * Is this address suppressed for Event Partner outreach? Checks the partner table AND the global
 * marketing suppression list. Returns a reason so a skip is always explainable.
 */
async function isSuppressed(email, client) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { suppressed: true, scope: 'invalid', reason: 'not a valid address' };

  const partner = (await q(client).query(
    'SELECT reason FROM event_partner_suppressions WHERE normalized_email = $1', [normalized])).rows[0];
  if (partner) return { suppressed: true, scope: 'event_partner', reason: partner.reason };

  // The platform-wide list is also honoured — a consumer unsubscribe is not overridden by this program.
  try {
    const global = (await q(client).query(
      'SELECT reason, scope FROM email_suppressions WHERE normalized_email = $1', [normalized])).rows[0];
    if (global) return { suppressed: true, scope: global.scope || 'marketing', reason: global.reason };
  } catch (e) { /* if the table is unavailable, the partner check above still applied */ }

  return { suppressed: false };
}

/** Lift a partner suppression. Admin-only in practice; never lifts a global marketing suppression. */
async function release(email, client) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const { rowCount } = await q(client).query(
    'DELETE FROM event_partner_suppressions WHERE normalized_email = $1', [normalized]);
  return rowCount > 0;
}

async function list(opts, client) {
  opts = opts || {};
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 500);
  const { rows } = await q(client).query(
    `SELECT normalized_email, reason, source, organization_id, created_at, updated_at
       FROM event_partner_suppressions ORDER BY updated_at DESC LIMIT $1`, [limit]);
  return rows;
}

module.exports = { REASONS, suppress, isSuppressed, release, list };
