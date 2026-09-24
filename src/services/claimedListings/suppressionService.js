'use strict';

/**
 * Claimed Listing suppression.
 *
 * A STOP to any Advantage.Bid B2B programme stops all of them, so every check reads three lists:
 *   email_suppressions (global) · listing_outreach_suppressions · event_partner_suppressions
 * and the company level: once any address at a company opts out, cold outreach to that company stops.
 *
 * The listing programme writes ONLY its own table (plus the global list for a hard bounce or
 * complaint, which the SES feedback path already does). It never writes Event Partner rows.
 *
 * Fail closed: a lookup error is returned as { error }, which every caller treats as suppressed.
 */

const db = require('../../db');
const { normalizeEmail } = require('../../lib/emailNormalize');

const REASONS = ['stop_request', 'unsubscribe', 'hard_bounce', 'complaint', 'not_my_company', 'business_closed',
  'wrong_contact', 'remove_listing', 'admin', 'compliance'];

/**
 * Is this address (or its company) suppressed for B2B outreach?
 * Returns { suppressed: bool, source?, reason? } or { suppressed: true, error } on lookup failure.
 */
async function check({ email, companyId = null, organizationId = null } = {}, runner = db) {
  const normalized = normalizeEmail(email || '');
  try {
    if (normalized) {
      const hit = (await runner.query(
        `SELECT 'global' AS src, reason FROM email_suppressions WHERE normalized_email = $1
          UNION ALL SELECT 'listing', reason FROM listing_outreach_suppressions WHERE normalized_email = $1
          UNION ALL SELECT 'event_partner', reason FROM event_partner_suppressions WHERE normalized_email = $1
          LIMIT 1`, [normalized])).rows[0];
      if (hit) return { suppressed: true, source: hit.src, reason: hit.reason };
    }
    if (companyId || organizationId) {
      const co = (await runner.query(
        `SELECT reason FROM listing_outreach_suppressions
          WHERE ($1::uuid IS NOT NULL AND company_id = $1) OR ($2::uuid IS NOT NULL AND organization_id = $2) LIMIT 1`,
        [companyId, organizationId])).rows[0];
      if (co) return { suppressed: true, source: 'listing_company', reason: co.reason };
    }
    return { suppressed: false };
  } catch (e) {
    return { suppressed: true, error: e.message, source: 'lookup_failed' };
  }
}

/** Add (or refresh) a listing-programme suppression. Idempotent on the address. */
async function suppress({ email, reason, source = null, companyId = null, organizationId = null, notes = null }, runner = db) {
  if (!REASONS.includes(reason)) throw new Error('unknown suppression reason: ' + reason);
  const normalized = normalizeEmail(email || '');
  if (!normalized) return { ok: false, reason: 'no address' };
  await runner.query(
    `INSERT INTO listing_outreach_suppressions (normalized_email, company_id, organization_id, reason, source, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (normalized_email) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source,
       company_id = COALESCE(listing_outreach_suppressions.company_id, EXCLUDED.company_id),
       organization_id = COALESCE(listing_outreach_suppressions.organization_id, EXCLUDED.organization_id),
       notes = COALESCE(EXCLUDED.notes, listing_outreach_suppressions.notes), updated_at = now()`,
    [normalized, companyId, organizationId, reason, source, notes]);
  // Any live listing sequence for this address or company stops now, before any queued send.
  await runner.query(
    `UPDATE listing_outreach_sequences s SET state = 'stopped', stop_reason = $3, next_send_at = NULL, updated_at = now()
      WHERE s.state IN ('queued','active','paused','dormant')
        AND (($1::uuid IS NOT NULL AND s.organization_id = $1) OR ($2::uuid IS NOT NULL AND s.company_id = $2))`,
    [organizationId, companyId, 'suppressed:' + reason]);
  return { ok: true, normalized };
}

module.exports = { REASONS, check, suppress };
