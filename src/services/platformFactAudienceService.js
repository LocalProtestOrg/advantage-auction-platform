'use strict';

/**
 * platformFactAudienceService — populates the PLATFORM-FACT audiences (Phase 4H) directly from
 * authoritative platform state (users/bids/watchlists/seller_profiles/agreements/marketing_contacts +
 * events geography), independent of behavioral page tracking. Also derives the AUTHORITATIVE seller
 * signup abandonment signal. Writes to the shared marketing_audience_members + marketing_signals tables
 * (no new membership store). Members that no longer qualify are exited (conversion/decay/withdrawal).
 */
const db = require('../db');
const audiences = require('../lib/behavioralAudiences');

const VERSION = 'v1-platformfact';
const EMAIL_RADIUS_MILES = 50;

// Generic: given an audience key + a SELECT that yields (scope_type, scope_id, evidence jsonb), upsert
// qualified members and exit those no longer present.
async function syncAudience(r, audienceKey, qualifiedSql, params, windowDays) {
  const { rows: qualified } = await r.query(qualifiedSql, params);
  const keys = new Set();
  let entered = 0;
  for (const q of qualified) {
    if (!q.scope_id) continue;   // defensive: never write a null scope (e.g. org-linked seller_profile w/o user_id)
    keys.add(q.scope_type + '|' + q.scope_id);
    const ins = await r.query(
      `INSERT INTO marketing_audience_members (audience_key, scope_type, scope_id, last_qualified_at, expires_at, evidence, definition_version)
       VALUES ($1,$2,$3, now(), now() + ($4 || ' days')::interval, $5::jsonb, $6)
       ON CONFLICT (audience_key, scope_type, scope_id) DO UPDATE SET
         last_qualified_at = now(), expires_at = now() + ($4 || ' days')::interval, evidence = EXCLUDED.evidence,
         exited_at = NULL, exit_reason = NULL
       RETURNING (xmax = 0) AS inserted`,
      [audienceKey, q.scope_type, q.scope_id, String(windowDays), JSON.stringify(q.evidence || {}), VERSION]);
    if (ins.rows[0] && ins.rows[0].inserted) entered++;
  }
  const { rows: active } = await r.query(
    `SELECT scope_type, scope_id, expires_at FROM marketing_audience_members WHERE audience_key = $1 AND exited_at IS NULL`, [audienceKey]);
  let exited = 0;
  for (const m of active) {
    const still = keys.has(m.scope_type + '|' + m.scope_id);
    const expired = m.expires_at && new Date(m.expires_at) <= new Date();
    if (!still || expired) {
      await r.query(`UPDATE marketing_audience_members SET exited_at = now(), exit_reason = $3 WHERE audience_key = $1 AND scope_type = $2::text AND scope_id = $4 AND exited_at IS NULL`,
        [audienceKey, m.scope_type, expired ? 'expired' : 'converted_or_disqualified', m.scope_id]);
      exited++;
    }
  }
  return { audience_key: audienceKey, qualified: qualified.length, entered, exited };
}

// Registered users who never placed a qualifying bid.
function registeredNonBidder(r) {
  return syncAudience(r, 'registered_non_bidder',
    `SELECT 'user' AS scope_type, u.id::text AS scope_id, jsonb_build_object('reason','registered, no bid') AS evidence
       FROM users u
      WHERE u.is_active IS NOT FALSE
        AND (u.role = 'buyer' OR EXISTS (SELECT 1 FROM auction_buyers ab WHERE ab.user_id = u.id))
        AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.bidder_user_id = u.id)`, [], 60);
}

// Users watching a lot they have not bid on, where the lot is still actionable (open).
function watcherNoBid(r) {
  return syncAudience(r, 'watcher_no_bid',
    `SELECT DISTINCT 'user' AS scope_type, w.user_id::text AS scope_id,
            jsonb_build_object('reason','watching open lot, no bid') AS evidence
       FROM watchlists w JOIN lots l ON l.id = w.lot_id
      WHERE l.state IN ('open','active')
        AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = w.lot_id AND b.bidder_user_id = w.user_id)`, [], 30);
}

// Permissioned subscribers within range of an upcoming published event.
function localEvent(r) {
  return syncAudience(r, 'local_event_interest',
    `SELECT DISTINCT 'contact' AS scope_type, mc.id::text AS scope_id,
            jsonb_build_object('reason','subscriber near an upcoming event') AS evidence
       FROM marketing_contacts mc
      WHERE mc.is_demo = false AND mc.latitude IS NOT NULL AND mc.longitude IS NOT NULL
        AND mc.permission_basis IN ('platform_relationship','explicit_opt_in','follower_optin')
        AND EXISTS (
          SELECT 1 FROM events e
           WHERE e.status = 'published' AND (e.end_at IS NULL OR e.end_at >= now())
             AND e.lat IS NOT NULL AND e.lng IS NOT NULL
             AND 3958.7613 * acos(LEAST(1, GREATEST(-1,
                 sin(radians(e.lat))*sin(radians(mc.latitude)) +
                 cos(radians(e.lat))*cos(radians(mc.latitude))*cos(radians(mc.longitude)-radians(e.lng))))) <= $1)`,
    [EMAIL_RADIUS_MILES], 21);
}

// AUTHORITATIVE abandoned individual seller signup: enrolled (seller_profiles) but no signed agreement,
// older than the threshold. Also upserts the SELLER_SIGNUP_ABANDONMENT signal (scope user) so onsite can
// act from platform truth; a signed agreement removes both.
async function abandonedSellerSignup(r, thresholdHours = 24) {
  const qualifiedSql =
    `SELECT 'user' AS scope_type, sp.user_id::text AS scope_id,
            jsonb_build_object('reason','enrolled but no signed agreement') AS evidence, sp.id AS seller_profile_id
       FROM seller_profiles sp
      WHERE sp.user_id IS NOT NULL
        AND sp.created_at < now() - ($1 || ' hours')::interval
        AND sp.agreement_waived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agreements a WHERE a.seller_profile_id = sp.id AND a.status IN ('signed','countersigned'))`;
  const res = await syncAudience(r, 'abandoned_individual_seller_signup', qualifiedSql, [String(thresholdHours)], 21);
  // Mirror to a signal for the onsite abandoned-seller-resume playbook.
  const { rows: q } = await r.query(qualifiedSql, [String(thresholdHours)]);
  const activeIds = new Set(q.map((x) => x.scope_id).filter(Boolean));
  for (const x of q) {
    if (!x.scope_id) continue;
    await r.query(
      `INSERT INTO marketing_signals (scope_type, scope_id, signal_type, level, active, reason, derived_by_version, expires_at)
       VALUES ('user',$1,'SELLER_SIGNUP_ABANDONMENT',4,true,'enrolled, no signed agreement',$2, now() + interval '21 days')
       ON CONFLICT (scope_type, scope_id, signal_type) DO UPDATE SET active=true, level=4, reason=EXCLUDED.reason, updated_at=now(), expires_at=EXCLUDED.expires_at`,
      [x.scope_id, VERSION]);
  }
  // Deactivate the signal for users who converted (signed) — no longer in the qualified set.
  await r.query(
    `UPDATE marketing_signals SET active=false, updated_at=now()
      WHERE signal_type='SELLER_SIGNUP_ABANDONMENT' AND derived_by_version=$1 AND active=true
        AND NOT (scope_id = ANY($2::text[]))`, [VERSION, Array.from(activeIds)]);
  return res;
}

async function refreshAll(runner) {
  const r = runner || db;
  return {
    registered_non_bidder: await registeredNonBidder(r),
    watcher_no_bid: await watcherNoBid(r),
    local_event_interest: await localEvent(r),
    abandoned_individual_seller_signup: await abandonedSellerSignup(r),
  };
}

module.exports = { refreshAll, registeredNonBidder, watcherNoBid, localEvent, abandonedSellerSignup, syncAudience, VERSION };
