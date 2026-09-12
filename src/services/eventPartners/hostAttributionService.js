'use strict';

/**
 * hostAttributionService — records WHICH COMPANY conducted an event, separately from which
 * organization operates the record.
 *
 * The two concepts, kept apart on purpose:
 *   events.organization_id      — the operating owner. For imports this is the importing organization.
 *                                 It drives tenant scoping and the plan-quota exemption, and the import
 *                                 writer forbids updating it. This service NEVER touches it.
 *   events.host_organization_id — the company that actually held the sale. Display and attribution.
 *
 * The rule the Owner set: no guessing. A host is recorded only when one of four proofs holds:
 *   authorized_source      — the event came from a source owned by an authorized partner. The company
 *                            told us that website is theirs, so events collected from it are theirs.
 *   organization_authored  — the event was created by the organization itself on the platform.
 *   admin_verified         — an administrator verified the association and said what the evidence was.
 *   claim_verified         — the company proved ownership of the listing through a verified claim.
 *
 * Historical reconciliation (the 462 pre-existing imported events) is deliberately NOT automatic.
 * proposeHistoricalMatches() only REPORTS candidates whose evidence is exact; an administrator still
 * has to accept each one, which lands as admin_verified with the evidence attached.
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const authorization = require('./authorizationService');

function err(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e;
}

const q = (client) => (client || db);

const METHODS = Object.freeze(['authorized_source', 'organization_authored', 'admin_verified', 'claim_verified']);

/**
 * Attribute one event to a host organization. Idempotent; refuses to silently overwrite an existing,
 * differently-attributed host (that needs an explicit reattribution decision by an administrator).
 */
async function attribute(eventId, organizationId, input) {
  input = input || {};
  const method = input.method;
  if (METHODS.indexOf(method) === -1) throw err(400, 'INVALID_METHOD', 'A recognized attribution method is required.');
  if (method === 'admin_verified' && !String(input.evidence || '').trim()) {
    throw err(400, 'EVIDENCE_REQUIRED', 'Administrator attribution must state the evidence.');
  }

  const run = async (client) => {
    const ev = (await client.query(
      'SELECT id, organization_id, host_organization_id, source, organizer_name FROM events WHERE id = $1 FOR UPDATE',
      [eventId])).rows[0];
    if (!ev) throw err(404, 'EVENT_NOT_FOUND', 'Event not found.');
    const org = (await client.query('SELECT id, name FROM organizations WHERE id = $1', [organizationId])).rows[0];
    if (!org) throw err(404, 'ORG_NOT_FOUND', 'Organization not found.');

    if (ev.host_organization_id && ev.host_organization_id !== organizationId && input.force !== true) {
      throw err(409, 'HOST_ALREADY_SET', 'This event is already attributed to a different company.');
    }
    if (ev.host_organization_id === organizationId) return ev;   // already correct — no-op, no audit noise

    const { rows } = await client.query(
      `UPDATE events
          SET host_organization_id = $2, host_attribution_method = $3,
              host_attributed_at = now(), host_attributed_by = $4, updated_at = now()
        WHERE id = $1 RETURNING id, organization_id, host_organization_id, host_attribution_method`,
      [eventId, organizationId, method, input.actorId || null]);
    await auditService.logEvent(client, {
      eventType: 'event.host_attributed', entityType: 'event', entityId: eventId,
      actorId: input.actorId || null,
      metadata: {
        host_organization_id: organizationId, method,
        evidence: input.evidence || null,
        previous_host_organization_id: ev.host_organization_id || null,
        // Recorded so an auditor can see the operating owner was untouched.
        operating_organization_id: ev.organization_id,
      },
    });
    return rows[0];
  };
  return input.client ? run(input.client) : withTransaction(run);
}

/**
 * Attribute an event that has just been imported from a partner's own authorized source. Called from
 * the import path with the pg client already in hand, so attribution commits with the event write.
 * Silently does nothing when the source is not a partner source — ordinary imports are unaffected.
 */
async function attributeFromSource(client, eventId, sourceId) {
  if (!client || !eventId || !sourceId) return null;
  try {
    const row = (await client.query(
      `SELECT a.organization_id, a.status
         FROM authorized_event_sources a
        WHERE a.import_source_id = $1 AND a.status IN ('authorized','source_configured','collecting','paused')
        LIMIT 1`, [sourceId])).rows[0];
    if (!row) return null;
    return await attribute(eventId, row.organization_id, { method: 'authorized_source', client, actorId: null });
  } catch (e) {
    // Attribution is a display fact; it must never fail an import. The absence is visible in admin.
    return null;
  }
}

/** Remove an attribution (a mistake, or a company that asked to be unlinked). Always audited. */
async function clearAttribution(eventId, input) {
  input = input || {};
  return withTransaction(async (client) => {
    const ev = (await client.query(
      'SELECT id, host_organization_id FROM events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
    if (!ev) throw err(404, 'EVENT_NOT_FOUND', 'Event not found.');
    if (!ev.host_organization_id) return ev;
    const { rows } = await client.query(
      `UPDATE events SET host_organization_id = NULL, host_attribution_method = NULL,
              host_attributed_at = NULL, host_attributed_by = NULL, updated_at = now()
        WHERE id = $1 RETURNING id`, [eventId]);
    await auditService.logEvent(client, {
      eventType: 'event.host_attribution_cleared', entityType: 'event', entityId: eventId,
      actorId: input.actorId || null,
      metadata: { previous_host_organization_id: ev.host_organization_id, reason: input.reason || null },
    });
    return rows[0];
  });
}

/**
 * Report — never apply — historical events that could belong to a given authorized company.
 *
 * Evidence is intentionally narrow: the event's organizer website must be on the company's AUTHORIZED
 * domain. An organizer NAME that merely looks similar is not evidence and is not proposed here,
 * because two unrelated companies routinely share a name across states. Every candidate is returned
 * with the exact matched field so a human decides.
 */
async function proposeHistoricalMatches(authorizationId, opts, client) {
  opts = opts || {};
  const auth = await authorization.getById(authorizationId, client);
  if (!auth) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
  if (authorization.AUTHORIZED_STATES.indexOf(auth.status) === -1) {
    throw err(409, 'NOT_AUTHORIZED', 'Only an authorized company may be matched to historical events.');
  }
  const domain = auth.authorized_domain;
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  // Host-suffix match on the organizer's own website: example.com matches example.com and
  // www.example.com / sales.example.com, and never matches notexample.com.
  const { rows } = await q(client).query(
    `SELECT e.id, e.slug, e.title, e.start_at, e.status, e.city, e.state,
            e.organizer_name, e.organizer_website_url, e.host_organization_id, e.organization_id
       FROM events e
      WHERE e.host_organization_id IS NULL
        AND e.organizer_website_url IS NOT NULL
        AND (
          lower(split_part(split_part(regexp_replace(e.organizer_website_url, '^[a-z]+://', '', 'i'), '/', 1), ':', 1)) = $1
          OR lower(split_part(split_part(regexp_replace(e.organizer_website_url, '^[a-z]+://', '', 'i'), '/', 1), ':', 1)) LIKE '%.' || $1
        )
      ORDER BY e.start_at DESC NULLS LAST
      LIMIT $2`, [domain, limit]);
  return rows.map((r) => ({
    event: r,
    matched_on: 'organizer_website_url_host',
    matched_value: r.organizer_website_url,
    authorized_domain: domain,
    proposed_host_organization_id: auth.organization_id,
    // Nothing is applied. An administrator must accept each candidate individually.
    requires_admin_confirmation: true,
  }));
}

/** Accept one proposed historical match. Lands as admin_verified with the evidence recorded. */
async function acceptHistoricalMatch(authorizationId, eventId, input) {
  input = input || {};
  if (!input.actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  const auth = await authorization.getById(authorizationId);
  if (!auth) throw err(404, 'NOT_FOUND', 'Authorization record not found.');
  if (authorization.AUTHORIZED_STATES.indexOf(auth.status) === -1) {
    throw err(409, 'NOT_AUTHORIZED', 'Only an authorized company may be attributed historical events.');
  }
  // Re-derive the candidate so an id from a stale page cannot attribute an unrelated event.
  const candidates = await proposeHistoricalMatches(authorizationId, { limit: 200 });
  const match = candidates.find((c) => c.event.id === eventId);
  if (!match) throw err(409, 'NOT_A_CANDIDATE', 'This event is not an evidenced match for that company.');
  return attribute(eventId, auth.organization_id, {
    method: 'admin_verified', actorId: input.actorId,
    evidence: `organizer_website_url host matches authorized domain ${auth.authorized_domain}: ${match.matched_value}`,
  });
}

module.exports = {
  METHODS, attribute, attributeFromSource, clearAttribution,
  proposeHistoricalMatches, acceptHistoricalMatch,
};
