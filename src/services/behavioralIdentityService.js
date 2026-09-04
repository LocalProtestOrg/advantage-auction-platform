'use strict';

/**
 * behavioralIdentityService — links an anonymous first-party visitor_id to a KNOWN identity (user and/or
 * marketing contact) ONLY when an authoritative first-party action occurs (login/register/subscribe).
 *
 * Rules: explicit linkage event, recorded source + confidence, dedup-safe (idempotent upsert), auditable,
 * reversible (row-deletable), historical anonymous evidence preserved (raw analytics_events keep their
 * visitor_id; linking never rewrites them). No silent speculative merge, no fingerprint-based identity.
 */
const db = require('../db');

const VALID_SOURCES = new Set(['login', 'register', 'subscribe', 'seller_signup']);

/**
 * Link a visitor to a user (and/or contact). Idempotent on (visitor_id,user_id).
 * @returns {object|null} the link row, or null when inputs are unusable.
 */
async function link({ visitorId, userId = null, contactId = null, source } = {}, runner) {
  const r = runner || db;
  const vid = visitorId && String(visitorId).trim();
  if (!vid || vid.length > 64) return null;
  if (!userId && !contactId) return null;                 // nothing to link to
  if (!VALID_SOURCES.has(source)) return null;
  const { rows } = await r.query(
    `INSERT INTO behavioral_identity_links (visitor_id, user_id, contact_id, source)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (visitor_id, user_id) DO UPDATE SET
       contact_id = COALESCE(EXCLUDED.contact_id, behavioral_identity_links.contact_id)
     RETURNING *`,
    [vid, userId, contactId, source]);
  return rows[0] || null;
}

// Return the visitor_ids linked to a user (for signal/audience resolution). Read-only.
async function visitorsForUser(userId, runner) {
  const r = runner || db;
  const { rows } = await r.query('SELECT DISTINCT visitor_id FROM behavioral_identity_links WHERE user_id = $1', [userId]);
  return rows.map((x) => x.visitor_id);
}

// Reverse a link (privacy / correction). Auditable by absence; raw events keep their anonymous visitor_id.
async function unlink({ visitorId, userId } = {}, runner) {
  const r = runner || db;
  const res = await r.query('DELETE FROM behavioral_identity_links WHERE visitor_id = $1 AND user_id = $2', [visitorId, userId]);
  return res.rowCount > 0;
}

module.exports = { link, visitorsForUser, unlink, VALID_SOURCES };
