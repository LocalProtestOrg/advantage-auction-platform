'use strict';

/**
 * listing_claim_events — the Claimed Listing funnel ledger.
 *
 * Definitions (handoff section 8): `sent` = SES accepted · `delivered/bounced/complained` = SES on the
 * claimed_listing stream · `link_fetch` = a server GET of /claim/:token (automated or unknown: mail
 * scanners pre-open links) · `page_view` (= "clicked") = a human beacon after DOM ready AND an
 * interaction, or a POST · `claim_started` = "This is my company, continue" · `claim_verified` = ownership
 * granted · then activation and Professional Seller milestones. OPENS ARE NOT MEASURED (no pixel).
 *
 * Every row carries is_internal (staff, admin, demo, test domains) and is_automated (crawlers, link
 * scanners); dashboards exclude both by default. Never throws: the ledger must not break a claim.
 */

const db = require('../../db');
const { normalizeEmail } = require('../../lib/emailNormalize');

const TEST_DOMAINS = /(^|\.)(example\.(com|org|net)|test|invalid|localhost|advantage\.bid|advantageauction\.bid)$/i;
const BOT_UA = /bot\b|crawler|spider|slurp|preview|scanner|safelinks|proofpoint|mimecast|barracuda|messagelabs|symantec|cloudmark|headless|python-requests|curl\/|wget|go-http-client|java\/|okhttp|facebookexternalhit|linkexpanding|urldefense|trendmicro|sophos|fortiguard|zscaler/i;

/** 'automated' | 'browser' | 'unknown' for a user agent. */
function uaClass(ua) {
  const s = String(ua || '');
  if (!s) return 'unknown';
  if (BOT_UA.test(s)) return 'automated';
  if (/Mozilla\/5\.0/.test(s)) return 'browser';
  return 'unknown';
}

async function isInternal({ userId = null, email = null }, runner = db) {
  try {
    const n = normalizeEmail(email || '');
    if (n && TEST_DOMAINS.test(n.split('@')[1] || '')) return true;
    const u = userId
      ? (await runner.query('SELECT role, staff_role, COALESCE(is_demo,false) AS is_demo FROM users WHERE id = $1', [userId])).rows[0]
      : n ? (await runner.query('SELECT role, staff_role, COALESCE(is_demo,false) AS is_demo FROM users WHERE lower(email) = $1', [n])).rows[0] : null;
    return !!(u && (u.role === 'admin' || u.staff_role || u.is_demo));
  } catch (_) { return false; }
}

/**
 * Record one event. `email` (optional) is used only to classify internal traffic, never stored.
 * `idempotencyKey` makes repeats (a double beacon, a retried webhook) a no-op.
 */
async function record(eventKey, o = {}, runner = db) {
  try {
    const internal = o.isInternal != null ? !!o.isInternal : await isInternal({ userId: o.userId, email: o.email }, runner);
    const r = await runner.query(
      `INSERT INTO listing_claim_events (organization_id, company_id, sequence_id, message_id, token_id, user_id, visitor_id,
          event_key, is_internal, is_automated, ip_hash, idempotency_key, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [o.organizationId || null, o.companyId || null, o.sequenceId || null, o.messageId || null, o.tokenId || null,
       o.userId || null, o.visitorId ? String(o.visitorId).slice(0, 64) : null, eventKey, internal, !!o.isAutomated,
       o.ipHash || null, o.idempotencyKey || null, JSON.stringify(o.meta || {})]);
    return r.rows[0] ? { id: r.rows[0].id } : { deduped: true };
  } catch (e) {
    return { error: e.message };
  }
}

/** Count events for rate limiting (e.g. self-requests per org / per IP). */
async function countSince(eventKey, { organizationId = null, ipHash = null, hours }, runner = db) {
  const r = await runner.query(
    `SELECT count(*)::int AS n FROM listing_claim_events
      WHERE event_key = $1 AND occurred_at > now() - ($2 || ' hours')::interval
        AND ($3::uuid IS NULL OR organization_id = $3) AND ($4::text IS NULL OR ip_hash = $4)`,
    [eventKey, String(hours), organizationId, ipHash]);
  return r.rows[0].n;
}

module.exports = { uaClass, isInternal, record, countSince, TEST_DOMAINS };
