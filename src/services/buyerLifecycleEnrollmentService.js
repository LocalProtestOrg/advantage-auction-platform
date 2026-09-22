'use strict';

/**
 * buyerLifecycleEnrollmentService — turns a buyer registration into a durable Sales Near You
 * relationship, on the strength of terms the buyer was actually shown.
 *
 * The gap this closes: buyer registration, auction registration, bidding and purchase did nothing
 * with the subscriber system. Production held 95 users, 45 auction registrations and 392 bids
 * against 1 marketing contact — every buyer relationship was being discarded.
 *
 * THE CONSENT RULE, and it is the whole point of this file: enrolment happens only when the person
 * accepted a terms version that ACTUALLY DISCLOSES Sales Near You (terms_versions.includes_sales_near_you).
 * No historical acceptance is rewritten and none is assumed. A buyer who registered under an older
 * version is simply not enrolled; they meet the new term naturally at their next auction
 * registration, which the existing current-terms gate already requires. That is the "natural,
 * low-friction transition" — no re-consent campaign, and nothing fabricated.
 *
 * ONE CANONICAL IDENTITY. Enrolment goes through subscriberService.signup, which already matches an
 * existing platform user by normalized email and upserts rather than inserting. So the same person
 * creating an account, registering for five auctions, bidding repeatedly, buying, and separately
 * using the public Sales Near You form still resolves to ONE marketing contact — with each event
 * preserved as distinct provenance. There is no separate "registered bidders" list.
 *
 * WHAT THIS NEVER DOES: it never sends email, never overrides a suppression (subscriberService
 * refuses to resurrect a complaint or hard bounce), and never touches transactional delivery.
 */

const db = require('../db');
const configService = require('./configService');
const subscriberService = require('./subscriberService');

/** Placement labels so registration-sourced contacts are attributable in reporting. */
const TRIGGER_PLACEMENT = Object.freeze({
  account_registration: 'buyer_registration',
  auction_registration: 'auction_registration',
  admin_backfill: 'admin_backfill',
});

const q = (client) => (client || db);

/** Is registration-driven enrolment switched on? Collection only; sending is governed elsewhere. */
async function enabled() {
  const v = await configService.get(null, 'marketing.sales_near_you.enroll_on_registration');
  return v !== false;   // default on: it is a disclosed benefit of registering
}

/**
 * The buyer's most recent acceptance of a terms version that DISCLOSES Sales Near You.
 * Returns null when they have never accepted such a version — which is a refusal to enrol, not an
 * error. This is the single check that keeps consent honest.
 */
async function acceptedDisclosingTerms(userId, client) {
  if (!userId) return null;
  const { rows } = await q(client).query(
    `SELECT ta.id AS acceptance_id, ta.accepted_at, tv.id AS terms_version_id, tv.version_int
       FROM terms_acceptances ta
       JOIN terms_versions tv ON tv.id = ta.terms_version_id
      WHERE ta.user_id = $1 AND tv.kind = 'buyer_terms' AND tv.includes_sales_near_you = true
      ORDER BY ta.accepted_at DESC NULLS LAST
      LIMIT 1`, [userId]);
  return rows[0] || null;
}

/**
 * Geography the platform ALREADY legitimately holds for this buyer.
 *
 * Stupid-easy principle: never ask again for something we have. The tax address is supplied by the
 * buyer at checkout, and only its CITY and STATE are used — never the street line — which is the
 * same precision the public signup form collects and enough to select a 30-mile audience. Returns
 * null when nothing is known; a contact without geography is simply not radius-eligible yet
 * (audience matching fails closed) and can be improved later.
 */
async function knownGeography(userId, client) {
  if (!userId) return null;
  const { rows } = await q(client).query(
    'SELECT tax_city, tax_state FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u || !u.tax_city || !u.tax_state) return null;
  return { city: String(u.tax_city).trim(), state: String(u.tax_state).trim(), source: 'tax_address' };
}

/**
 * Enrol a buyer, or explain why not. Never throws into a registration flow: a marketing side effect
 * must not be able to fail somebody's account creation or auction registration.
 *
 * @param {object} input { userId, email, trigger, auctionId?, city?, state?, ip?, userAgent? }
 * @returns {{ enrolled: boolean, reason?: string, contactId?: string, status?: string }}
 */
async function enroll(input = {}) {
  try {
    if (!(await enabled())) return { enrolled: false, reason: 'enrollment_disabled' };
    const trigger = TRIGGER_PLACEMENT[input.trigger] ? input.trigger : null;
    if (!trigger) return { enrolled: false, reason: 'unknown_trigger' };
    if (!input.email) return { enrolled: false, reason: 'no_email' };

    // CONSENT GATE. Without an accepted disclosing version there is no enrolment and no record.
    const accepted = await acceptedDisclosingTerms(input.userId);
    if (!accepted) return { enrolled: false, reason: 'terms_not_disclosing_sales_near_you' };

    // Prefer geography supplied by the caller, else what we already hold. Never invent one.
    let city = input.city || null;
    let state = input.state || null;
    let geoSource = city && state ? 'registration_form' : null;
    if (!city || !state) {
      const known = await knownGeography(input.userId);
      if (known) { city = known.city; state = known.state; geoSource = known.source; }
    }

    // ONE canonical contact: signup matches the existing user and upserts, never duplicating.
    const result = await subscriberService.signup({
      email: input.email,
      city, state,
      placement: TRIGGER_PLACEMENT[trigger],
      pagePath: input.pagePath || null,
      sourceDomain: input.sourceDomain || null,
      ipHash: input.ipHash || null,
    });
    if (!result || result.ok !== true) {
      return { enrolled: false, reason: (result && result.reason) || 'signup_failed' };
    }

    // Registration-specific evidence: which event, under which disclosed version.
    const contact = (await db.query(
      `SELECT id, geography_precision, geography_source FROM marketing_contacts
        WHERE normalized_email = lower(btrim($1))`, [input.email])).rows[0];
    if (contact) {
      await db.query(
        `INSERT INTO buyer_sales_near_you_enrollments
           (contact_id, user_id, trigger, auction_id, terms_version_id, terms_version_int,
            terms_accepted_at, geography_source, geography_precision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING`,
        [contact.id, input.userId || null, trigger, input.auctionId || null,
         accepted.terms_version_id, accepted.version_int, accepted.accepted_at || null,
         geoSource, contact.geography_precision || null]).catch(() => {});
    }

    return {
      enrolled: true,
      status: result.status,                 // 'subscribed' | 'received' (suppressed — respected)
      contactId: contact ? contact.id : null,
      termsVersionInt: accepted.version_int,
      geographySource: geoSource,
    };
  } catch (e) {
    // A marketing side effect must never break registration.
    return { enrolled: false, reason: 'error:' + e.message };
  }
}

/** Fire-and-forget wrapper for use inside a registration request path. */
function enrollDetached(input) {
  Promise.resolve().then(() => enroll(input)).catch(() => {});
}

module.exports = {
  enroll, enrollDetached, enabled, acceptedDisclosingTerms, knownGeography, TRIGGER_PLACEMENT,
};
