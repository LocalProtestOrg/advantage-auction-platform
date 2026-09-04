'use strict';

/**
 * audienceEligibilityService — the ONE authoritative "is this address eligible to receive this marketing
 * email RIGHT NOW" decision. Computed at SEND TIME (never cached into a durable eligible list), so a
 * suppression or bounce that lands after selection is always honored.
 *
 * A7 (autonomous email) never receives an unrestricted raw address list. It receives an audience
 * SPECIFICATION (this module's query + the campaign's scope), and each candidate is re-checked here at
 * the moment of send. Every rejection returns a machine-readable reason.
 *
 * Gate order (fail-closed, first failing gate wins):
 *   1. SUPPRESSED                 — address in email_suppressions (terminal)
 *   2. HARD_BOUNCED / COMPLAINT / INVALID  — deliverability terminal states
 *   3. PERMISSION_UNKNOWN / PERMISSION_WITHDRAWN  — no evidence of permission (default posture)
 *   4. PERMISSION_SCOPE_MISMATCH  — permission exists but not for this campaign's marketing class
 *   5. GEO_MISMATCH               — campaign geo strategy excludes this contact (email geo != paid 30-mi)
 *   6. FREQUENCY_CAPPED / SPACING — over the 30-day cap or inside the min-spacing window
 *   7. DUPLICATE_CAMPAIGN_RECIPIENT — already selected/sent for this campaign (idempotency)
 *   8. DEMO_EXCLUDED              — is_demo contact never receives real marketing
 *
 * This module NEVER sends. It evaluates. Callers (a future A7) act on the decision.
 */
const db = require('../db');
const { normalizeEmail } = require('../lib/emailNormalize');
const marketingConfig = require('./marketingConfigService');

const REASON = {
  SUPPRESSED: 'SUPPRESSED',
  HARD_BOUNCED: 'HARD_BOUNCED',
  COMPLAINT: 'COMPLAINT',
  INVALID: 'INVALID',
  PERMISSION_UNKNOWN: 'PERMISSION_UNKNOWN',
  PERMISSION_WITHDRAWN: 'PERMISSION_WITHDRAWN',
  PERMISSION_SCOPE_MISMATCH: 'PERMISSION_SCOPE_MISMATCH',
  GEO_MISMATCH: 'GEO_MISMATCH',
  FREQUENCY_CAPPED: 'FREQUENCY_CAPPED',
  MIN_SPACING: 'MIN_SPACING',
  DUPLICATE_CAMPAIGN_RECIPIENT: 'DUPLICATE_CAMPAIGN_RECIPIENT',
  DEMO_EXCLUDED: 'DEMO_EXCLUDED',
};

// Permission bases that are, on their own, sufficient to email (subject to scope). 'unknown' and
// 'withdrawn' are NOT sufficient — permission must be affirmatively established.
const PERMITTED_BASES = new Set(['platform_relationship', 'explicit_opt_in', 'follower_optin']);

// Great-circle distance in miles. Centroid-to-point — used for approximate proximity, never presented
// to a recipient as exact household distance.
function haversineMiles(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function geoMatches(strategy, contact) {
  if (!strategy || strategy === 'nationwide_or_interest' || strategy === 'nationwide') return true;
  // Radius strategy (email geography — INDEPENDENT from the paid 30-mile advertising radius).
  if (strategy.kind === 'radius' || (strategy.radius_miles && (strategy.lat != null))) {
    const lat = contact.latitude, lng = contact.longitude;
    if (lat == null || lng == null) return false;   // no coordinates → excluded from radius (fail closed)
    return haversineMiles(Number(strategy.lat), Number(strategy.lng), Number(lat), Number(lng)) <= Number(strategy.radius_miles);
  }
  if (strategy.state && contact.address_state) return String(strategy.state).toUpperCase() === String(contact.address_state).toUpperCase();
  if (Array.isArray(strategy.states) && strategy.states.length) {
    return !!contact.address_state && strategy.states.map((s) => String(s).toUpperCase()).includes(String(contact.address_state).toUpperCase());
  }
  if (Array.isArray(strategy.zips) && strategy.zips.length) {
    return !!contact.zip && strategy.zips.includes(String(contact.zip));
  }
  if (strategy.city && contact.city) return String(strategy.city).toLowerCase() === String(contact.city).toLowerCase();
  // A geo strategy that specifies constraints but the contact can't satisfy → fail closed.
  return false;
}

function scopeMatches(permissionScope, marketingClass) {
  if (!marketingClass) return true;              // campaign didn't scope → basis alone governs
  if (!permissionScope) return true;             // no explicit scope recorded → basis governs
  // permission_scope may be { classes: [...] } or { all: true }
  if (permissionScope.all === true) return true;
  if (Array.isArray(permissionScope.classes)) return permissionScope.classes.includes(marketingClass);
  return true;
}

/**
 * Evaluate ONE contact for ONE campaign at send time.
 * @param {object} opts { contact, campaignId, marketingClass, geoStrategy, runner }
 *        contact must include: id, normalized_email, address_state, zip, is_demo,
 *        permission_basis, permission_scope
 * @returns {object} { eligible:boolean, reason?:string, detail?:string }
 */
async function evaluateContact({ contact, campaignId = null, marketingClass = null, geoStrategy = null } = {}, runner) {
  const r = runner || db;
  const normalized = normalizeEmail(contact && (contact.normalized_email || contact.preferred_email || contact.email));
  if (!normalized) return { eligible: false, reason: REASON.INVALID, detail: 'no normalizable email' };

  // 1. Suppression (terminal).
  const sup = await r.query('SELECT reason FROM email_suppressions WHERE normalized_email = $1', [normalized]);
  if (sup.rowCount) return { eligible: false, reason: REASON.SUPPRESSED, detail: sup.rows[0].reason || 'suppressed' };

  // 2. Deliverability terminal states.
  const del = (await r.query('SELECT hard_bounced, complaint, invalid FROM email_deliverability WHERE normalized_email = $1', [normalized])).rows[0];
  if (del) {
    if (del.complaint) return { eligible: false, reason: REASON.COMPLAINT };
    if (del.hard_bounced) return { eligible: false, reason: REASON.HARD_BOUNCED };
    if (del.invalid) return { eligible: false, reason: REASON.INVALID };
  }

  // 8. Demo contacts never receive real marketing (checked early — cheap, and a hard exclusion).
  if (contact.is_demo) return { eligible: false, reason: REASON.DEMO_EXCLUDED };

  // 3-4. Permission (default posture is NO).
  const basis = contact.permission_basis || 'unknown';
  if (basis === 'withdrawn') return { eligible: false, reason: REASON.PERMISSION_WITHDRAWN };
  if (!PERMITTED_BASES.has(basis)) return { eligible: false, reason: REASON.PERMISSION_UNKNOWN, detail: basis };
  if (!scopeMatches(contact.permission_scope, marketingClass)) return { eligible: false, reason: REASON.PERMISSION_SCOPE_MISMATCH, detail: marketingClass };

  // 5. Geography (email geo is independent from the paid 30-mile radius).
  if (!geoMatches(geoStrategy, contact)) return { eligible: false, reason: REASON.GEO_MISMATCH };

  // 6. Frequency + spacing (config-driven). Layered caps: per-day, per-7d, per-30d, min spacing.
  if (contact.id) {
    const cap = await marketingConfig.getInt('marketing.email.frequency_cap_per_30d', 4);
    const perDay = await marketingConfig.getInt('marketing.email.max_per_day', 1);
    const per7d = await marketingConfig.getInt('marketing.email.max_per_7d', 3);
    const spacingHours = await marketingConfig.getInt('marketing.email.min_spacing_hours', 48);
    const recent = (await r.query(
      `SELECT count(*)::int AS c, max(created_at) AS last_at,
              count(*) FILTER (WHERE created_at > now() - interval '1 day')::int  AS c1d,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS c7d
         FROM marketing_campaign_recipients
        WHERE contact_id = $1 AND status IN ('queued','sent') AND created_at > now() - interval '30 days'`,
      [contact.id])).rows[0];
    if (recent && recent.c1d >= perDay) return { eligible: false, reason: REASON.FREQUENCY_CAPPED, detail: `${recent.c1d}/${perDay} in 1d` };
    if (recent && recent.c7d >= per7d) return { eligible: false, reason: REASON.FREQUENCY_CAPPED, detail: `${recent.c7d}/${per7d} in 7d` };
    if (recent && recent.c >= cap) return { eligible: false, reason: REASON.FREQUENCY_CAPPED, detail: `${recent.c}/${cap} in 30d` };
    if (recent && recent.last_at) {
      const gap = await r.query(`SELECT (now() - $1::timestamptz) < ($2 || ' hours')::interval AS too_soon`, [recent.last_at, String(spacingHours)]);
      if (gap.rows[0] && gap.rows[0].too_soon) return { eligible: false, reason: REASON.MIN_SPACING, detail: `< ${spacingHours}h` };
    }
    // 7. Per-campaign idempotency.
    if (campaignId) {
      const dup = await r.query('SELECT 1 FROM marketing_campaign_recipients WHERE campaign_id = $1 AND contact_id = $2', [campaignId, contact.id]);
      if (dup.rowCount) return { eligible: false, reason: REASON.DUPLICATE_CAMPAIGN_RECIPIENT };
    }
  }

  return { eligible: true, normalized_email: normalized };
}

/**
 * Produce an audience SPECIFICATION for a campaign (what A7 would receive) — NOT a materialized address
 * list. It describes the candidate query and the gates that will run at send time, plus a dry-run count.
 * A7 must still call evaluateContact() per address at the moment of send.
 */
async function buildAudienceSpec({ campaignId = null, marketingClass = null, geoStrategy = null } = {}, runner) {
  const r = runner || db;
  // configService.get returns the JSONB value already parsed (a string here), so no JSON.parse.
  const strategy = geoStrategy || (await marketingConfig.raw('marketing.email.default_geo_strategy', 'nationwide_or_interest'));
  // Candidate universe = contacts with an affirmative permission basis, not withdrawn, not demo.
  const candidateCount = (await r.query(
    `SELECT count(*)::int AS c FROM marketing_contacts
      WHERE permission_basis IN ('platform_relationship','explicit_opt_in','follower_optin')
        AND is_demo = false`)).rows[0].c;
  return {
    kind: 'audience_specification',
    campaign_id: campaignId,
    marketing_class: marketingClass,
    geo_strategy: strategy,
    candidate_universe_count: candidateCount,
    send_time_gates: Object.values(REASON),
    note: 'A7 receives this specification and MUST re-check each address via evaluateContact() at send time. No raw address list is emitted here.',
  };
}

/**
 * Admin PREVIEW/PLANNING count of first-party subscribers for a geography — NOT a send, NOT a raw list.
 * Returns { potential, eligible, strategy }. `potential` = permissioned, non-demo contacts matching the
 * geography; `eligible` additionally excludes suppressed + hard-bounced/complaint addresses. Email radius
 * is INDEPENDENT of the paid 30-mile advertising rule. Exact counts only — never invents numbers.
 */
async function previewAudience({ lat = null, lng = null, radiusMiles = null, state = null, city = null } = {}, runner) {
  const r = runner || db;
  const params = [];
  let geoWhere = 'TRUE';
  let strategy;
  if (radiusMiles != null && lat != null && lng != null) {
    params.push(Number(lat), Number(lng), Number(radiusMiles));
    geoWhere = `(mc.latitude IS NOT NULL AND mc.longitude IS NOT NULL AND
      3958.7613 * acos(LEAST(1, GREATEST(-1,
        sin(radians($1)) * sin(radians(mc.latitude)) +
        cos(radians($1)) * cos(radians(mc.latitude)) * cos(radians(mc.longitude) - radians($2))))) <= $3)`;
    strategy = { kind: 'radius', lat: Number(lat), lng: Number(lng), radius_miles: Number(radiusMiles) };
  } else if (state) { params.push(state); geoWhere = 'upper(mc.address_state) = upper($1)'; strategy = { state }; }
  else if (city) { params.push(city); geoWhere = 'lower(mc.city) = lower($1)'; strategy = { city }; }
  else { strategy = { kind: 'nationwide' }; }

  const base = `FROM marketing_contacts mc
    WHERE mc.is_demo = false
      AND mc.permission_basis IN ('platform_relationship','explicit_opt_in','follower_optin')
      AND ${geoWhere}`;
  const potential = (await r.query(`SELECT count(*)::int AS c ${base}`, params)).rows[0].c;
  const eligible = (await r.query(
    `SELECT count(*)::int AS c ${base}
       AND NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.normalized_email = mc.normalized_email)
       AND NOT EXISTS (SELECT 1 FROM email_deliverability d WHERE d.normalized_email = mc.normalized_email AND (d.hard_bounced OR d.complaint))`,
    params)).rows[0].c;
  return { potential, eligible, strategy };
}

module.exports = { evaluateContact, buildAudienceSpec, previewAudience, haversineMiles, REASON, PERMITTED_BASES };
