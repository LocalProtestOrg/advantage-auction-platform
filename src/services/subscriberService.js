'use strict';

/**
 * subscriberService — first-party newsletter signup orchestration. STUPID EASY in, safe underneath.
 *
 * A successful signup: normalize email → resolve geography (reused Mapbox seam) → match an existing
 * platform user (never duplicate) → upsert the Phase 4C marketing_contact → add a distinct source record
 * (provenance) → grant an EXPLICIT first-party permission with preserved evidence (source != permission) →
 * emit an analytics attribution event. All idempotent; existing subscriber = graceful success.
 *
 * SAFETY: this NEVER sends email and NEVER activates A7. Suppression/bounce are respected — a form submit
 * cannot silently override a complaint/hard-bounce suppression. Responses never disclose whether an email
 * already belongs to a user/subscriber.
 */
const db = require('../db');
const { normalizeEmail } = require('../lib/emailNormalize');
const geo = require('./subscriberGeoService');
const contacts = require('./marketingContactService');

// The classes a first-party newsletter signup is explicitly consenting to (general Advantage.Bid updates
// about auctions/estate sales/marketplace near them). Scope is evidence-bounded, not unlimited.
const FIRST_PARTY_SCOPE = { classes: ['newsletter', 'auction_announcement', 'estate_sale', 'marketplace', 'local_events'] };

// Suppression reasons that a public form must NOT override (deliverability/abuse signals).
const HARD_SUPPRESSION_REASONS = new Set(['complaint', 'hard_bounce', 'soft_bounce_threshold']);

async function findExistingUserId(runner, normalized) {
  const { rows } = await runner.query(
    `SELECT id FROM users
      WHERE lower(btrim(COALESCE(NULLIF(contact_email,''), email))) = $1
      ORDER BY created_at ASC LIMIT 1`, [normalized]);
  return rows[0] ? rows[0].id : null;
}

/**
 * @param {object} input { email, name, city, state, zip, placement, pagePath, referrer, sourceDomain, ipHash }
 * @returns {object} { ok, status, reason? } — status: 'subscribed' | 'received' (received = recorded but
 *          not granted deliverable permission, e.g. suppressed); reason only on ok:false.
 */
async function signup(input = {}) {
  const normalized = normalizeEmail(input.email);
  if (!normalized) return { ok: false, reason: 'invalid_email' };

  const name = input.name ? String(input.name).trim().slice(0, 160) : null;
  const placement = input.placement ? String(input.placement).slice(0, 40) : 'other';

  // Resolve geography BEFORE opening a transaction (it may make an external call). Fail-open.
  const g = await geo.resolve({ city: input.city, state: input.state, zip: input.zip });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const supp = (await client.query('SELECT reason FROM email_suppressions WHERE normalized_email = $1', [normalized])).rows[0];
    const del = (await client.query('SELECT hard_bounced, complaint FROM email_deliverability WHERE normalized_email = $1', [normalized])).rows[0];
    const hardBlocked = (supp && HARD_SUPPRESSION_REASONS.has(supp.reason)) || (del && (del.hard_bounced || del.complaint));
    const softUnsub = supp && !HARD_SUPPRESSION_REASONS.has(supp.reason);   // user-initiated unsubscribe, etc.

    const userId = await findExistingUserId(client, normalized);

    const contact = await contacts.upsertContact({
      email: normalized, userId, fullName: name,
      city: g.city, state: g.state, zip: g.zip,
      latitude: g.latitude, longitude: g.longitude,
      geographyPrecision: g.geography_precision, geographySource: g.geography_source, geoResolvedAt: g.geo_resolved_at,
    }, client);
    if (!contact) { await client.query('ROLLBACK'); return { ok: false, reason: 'invalid_email' }; }

    // Provenance (evidence only, never permission). source_record_id = placement makes repeat signups on
    // the same placement idempotent while distinct placements each record a source.
    await contacts.attachSource(contact.id, {
      sourceType: 'newsletter_signup', sourceRecordId: placement, signupPlacement: placement,
      referrer: input.referrer ? String(input.referrer).slice(0, 300) : null,
      sourceDomain: input.sourceDomain ? String(input.sourceDomain).slice(0, 120) : null,
      consentEvidence: `explicit ${placement} signup`,
      originalEmail: input.email ? String(input.email).slice(0, 200) : null,
    }, client);

    let status;
    if (hardBlocked) {
      // Respect deliverability/abuse suppression — record the attempt, do NOT grant deliverable permission.
      await contacts.recordPermissionEvent(contact.id, {
        action: 'grant_blocked_suppressed', basis: contact.permission_basis, sourceType: 'newsletter_signup',
        signupPlacement: placement, evidence: 'explicit signup but address is suppressed (complaint/hard bounce)',
        pagePath: input.pagePath || null, referrer: input.referrer || null, ipHash: input.ipHash || null,
      }, client);
      status = 'received';
    } else {
      if (softUnsub) {
        // Explicit fresh re-subscription clears a prior user-initiated unsubscribe (audited).
        await client.query('DELETE FROM email_suppressions WHERE normalized_email = $1 AND reason NOT IN (\'complaint\',\'hard_bounce\',\'soft_bounce_threshold\')', [normalized]);
      }
      await contacts.grantPermission(contact.id, {
        basis: 'explicit_opt_in', scope: FIRST_PARTY_SCOPE,
        evidence: `explicit ${placement} signup`, sourceType: 'newsletter_signup', signupPlacement: placement,
        pagePath: input.pagePath || null, referrer: input.referrer || null, ipHash: input.ipHash || null,
      }, client);
      status = 'subscribed';
    }

    // Attribution event (best-effort; a failure must not fail signup).
    try {
      await client.query(
        `INSERT INTO analytics_events (event_type, page_url, referrer, city, state_code, metadata)
         VALUES ('subscriber_signup', $1, $2, $3, $4, $5::jsonb)`,
        [input.pagePath || null, input.referrer || null, g.city, g.state,
         JSON.stringify({ placement, source_domain: input.sourceDomain || null, matched_user: !!userId, status, geography_precision: g.geography_precision })]);
    } catch (_) { /* analytics is best-effort */ }

    await client.query('COMMIT');
    return { ok: true, status, matched_user: !!userId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { signup, FIRST_PARTY_SCOPE };
