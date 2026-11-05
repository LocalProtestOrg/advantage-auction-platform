'use strict';

/**
 * Auction shipping, Phase 1 (spec docs/projects/auction-shipping-spec.md). Server enforcement for:
 *   • a seller's reusable shipping profiles (own profiles only),
 *   • the one-time payout and fraud education acknowledgment,
 *   • marking a lot eligible to ship (only an eligible seller who acknowledged; never automatic),
 *   • administrator approval of an Individual Seller, the per-seller per-shipment limit, revocation and lot overrides
 *     (every administrator action audited),
 *   • the buyer-facing shipping summary for lots and auctions (labels computed in src/lib/auctionShippingPolicy.js).
 * Nothing here runs unless AUCTION_SHIPPING_ENABLED=true; callers check auctionShippingEnabled() first.
 */

const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const policy = require('../lib/auctionShippingPolicy');

class ShippingError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// ── Seller context ───────────────────────────────────────────────────────────────────────────────────────────
// Account status lives on users.is_active (a suspended seller's account is inactive).
const SELLER_COLS = `sp.id, sp.user_id, sp.seller_type, sp.capabilities, u.is_active, sp.shipping_approved_at, sp.shipping_approved_by,
  sp.shipping_approval_reason, sp.shipping_per_shipment_limit_cents, sp.shipping_education_acknowledged_at, sp.shipping_education_version`;
const SELLER_FROM = 'seller_profiles sp LEFT JOIN users u ON u.id = sp.user_id';

async function verificationBlocked(sellerProfileId) {
  try {
    return !!(await require('./verificationService').publicationGate(sellerProfileId)).blocked;
  } catch (e) {
    console.error('[auctionShipping] publication gate check failed', e.message);
    return true;   // fail closed: an unknown verification state never opens shipping
  }
}

async function eligibilityFor(sp) {
  const professional = require('./sellerTypeRules').isProfessional(sp.seller_type);
  return policy.sellerShippingEligibility({
    sellerType: sp.seller_type,
    capabilities: sp.capabilities,
    verificationBlocked: professional ? await verificationBlocked(sp.id) : false,
    isActive: sp.is_active,
    acknowledgedAt: sp.shipping_education_acknowledged_at,
  });
}

async function sellerByUser(userId) {
  const sp = (await db.query(`SELECT ${SELLER_COLS} FROM ${SELLER_FROM} WHERE sp.user_id = $1`, [userId])).rows[0];
  if (!sp) throw new ShippingError('SELLER_NOT_FOUND', 'Seller profile not found', 404);
  return sp;
}
async function sellerById(sellerProfileId) {
  if (!isUuid(sellerProfileId)) throw new ShippingError('SELLER_NOT_FOUND', 'Seller profile not found', 404);
  const sp = (await db.query(`SELECT ${SELLER_COLS} FROM ${SELLER_FROM} WHERE sp.id = $1`, [sellerProfileId])).rows[0];
  if (!sp) throw new ShippingError('SELLER_NOT_FOUND', 'Seller profile not found', 404);
  return sp;
}

function eligibilityMessage(e) {
  if (e.can_enable) return null;
  if (e.needs_acknowledgment) return policy.ELIGIBILITY_MESSAGES.needs_acknowledgment;
  return policy.ELIGIBILITY_MESSAGES[e.reason] || policy.ELIGIBILITY_MESSAGES.approval_required;
}

async function statusFor(sp) {
  const e = await eligibilityFor(sp);
  return {
    eligible: e.eligible,
    can_enable: e.can_enable,
    reason: e.reason,
    needs_acknowledgment: e.needs_acknowledgment,
    message: eligibilityMessage(e),
    acknowledged_at: sp.shipping_education_acknowledged_at || null,
    per_shipment_limit_cents: policy.perShipmentLimitCents(sp.shipping_per_shipment_limit_cents),
    signature_threshold_cents: policy.SIGNATURE_THRESHOLD_CENTS,
    payout_hold_business_days: policy.PAYOUT_HOLD_BUSINESS_DAYS,
    payout_explanation: policy.PAYOUT_EXPLANATION,
    education: policy.EDUCATION_POINTS,
    education_version: policy.EDUCATION_VERSION,
    profiles: await listProfilesFor(sp.id),
  };
}

async function getSellerStatus(userId) { return statusFor(await sellerByUser(userId)); }

/** One-time acknowledgment of the payout and fraud education. Creates the default shipping profile if none exists. */
async function acknowledgeEducation(userId, body = {}) {
  if (body.acknowledged !== true) throw new ShippingError('ACK_REQUIRED', 'Please confirm that you have read how shipping affects your payout.');
  const sp = await sellerByUser(userId);
  const e = await eligibilityFor(sp);
  if (!e.eligible) throw new ShippingError('SHIPPING_NOT_ALLOWED', eligibilityMessage(e), 403);
  if (!sp.shipping_education_acknowledged_at) {
    await db.query(`UPDATE seller_profiles SET shipping_education_acknowledged_at = now(), shipping_education_version = $2 WHERE id = $1`,
      [sp.id, policy.EDUCATION_VERSION]);
    await writeAuditLog({ event_type: 'auction_shipping_education_acknowledged', entity_type: 'seller_profile', entity_id: sp.id,
      actor_id: userId, metadata: { version: policy.EDUCATION_VERSION } });
  }
  const existing = (await db.query(`SELECT 1 FROM seller_shipping_profiles WHERE seller_profile_id = $1 AND archived_at IS NULL LIMIT 1`, [sp.id])).rows[0];
  if (!existing) await insertProfile(sp.id, { ...policy.SHIPPING_PROFILE_DEFAULTS, is_default: true });
  return statusFor(await sellerById(sp.id));
}

// ── Shipping profiles ────────────────────────────────────────────────────────────────────────────────────────
const PROFILE_COLS = `id, seller_profile_id, name, method, flat_rate_cents, handling_days, destinations, excluded_states, packaging_note,
  is_default, archived_at, created_at, updated_at`;

async function listProfilesFor(sellerProfileId) {
  return (await db.query(`SELECT ${PROFILE_COLS} FROM seller_shipping_profiles WHERE seller_profile_id = $1 AND archived_at IS NULL
    ORDER BY is_default DESC, created_at ASC`, [sellerProfileId])).rows;
}

function normalizeProfile(input, current = null) {
  const src = input && typeof input === 'object' ? input : {};
  const base = current || policy.SHIPPING_PROFILE_DEFAULTS;
  const out = {};
  const name = src.name !== undefined ? String(src.name || '').trim() : base.name;
  if (!name || name.length > 80) throw new ShippingError('INVALID_NAME', 'Give the shipping settings a name of up to 80 characters.');
  out.name = name;
  const method = src.method !== undefined ? src.method : base.method;
  if (!['flat_rate', 'quote_required'].includes(method)) throw new ShippingError('INVALID_METHOD', 'Choose a flat rate or "quote required".');
  out.method = method;
  if (method === 'flat_rate') {
    const raw = src.flat_rate_cents !== undefined ? src.flat_rate_cents : base.flat_rate_cents;
    const cents = Number(raw);
    if (raw === null || raw === '' || !Number.isInteger(cents) || cents < 0 || cents > 1000000) {
      throw new ShippingError('INVALID_RATE', 'Enter the flat shipping rate (from $0.00 to $10,000.00).');
    }
    out.flat_rate_cents = cents;
  } else out.flat_rate_cents = null;
  const hd = Number(src.handling_days !== undefined ? src.handling_days : base.handling_days);
  if (!Number.isInteger(hd) || hd < 1 || hd > 30) throw new ShippingError('INVALID_HANDLING', 'Handling time must be from 1 to 30 business days.');
  out.handling_days = hd;
  out.destinations = 'domestic_us';   // domestic only at launch
  const ex = src.excluded_states !== undefined ? src.excluded_states : base.excluded_states;
  const list = (Array.isArray(ex) ? ex : String(ex || '').split(',')).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean);
  const bad = list.filter((s) => !policy.US_STATE_CODES.includes(s));
  if (bad.length) throw new ShippingError('INVALID_STATES', 'Unknown state code: ' + bad.join(', ') + '. Use two-letter codes such as AK or HI.');
  out.excluded_states = Array.from(new Set(list)).sort();
  const note = src.packaging_note !== undefined ? src.packaging_note : base.packaging_note;
  const n = note == null ? null : String(note).trim();
  if (n && n.length > 500) throw new ShippingError('INVALID_NOTE', 'The packaging note can be up to 500 characters.');
  out.packaging_note = n || null;
  return out;
}

async function insertProfile(sellerProfileId, data) {
  const p = normalizeProfile(data);
  const hasDefault = (await db.query(`SELECT 1 FROM seller_shipping_profiles WHERE seller_profile_id = $1 AND is_default AND archived_at IS NULL`,
    [sellerProfileId])).rows[0];
  const makeDefault = data.is_default === true || !hasDefault;   // the first profile is always the default
  if (makeDefault && hasDefault) {
    await db.query(`UPDATE seller_shipping_profiles SET is_default = false, updated_at = now() WHERE seller_profile_id = $1 AND is_default`, [sellerProfileId]);
  }
  return (await db.query(`INSERT INTO seller_shipping_profiles
      (seller_profile_id, name, method, flat_rate_cents, handling_days, destinations, excluded_states, packaging_note, is_default)
    VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9) RETURNING ${PROFILE_COLS}`,
  [sellerProfileId, p.name, p.method, p.flat_rate_cents, p.handling_days, p.destinations, p.excluded_states, p.packaging_note, makeDefault])).rows[0];
}

async function requireCanEnable(sp) {
  const e = await eligibilityFor(sp);
  if (!e.can_enable) throw new ShippingError(e.needs_acknowledgment ? 'ACK_REQUIRED' : 'SHIPPING_NOT_ALLOWED', eligibilityMessage(e), 403);
}

async function listProfiles(userId) { return listProfilesFor((await sellerByUser(userId)).id); }

async function createProfile(userId, body) {
  const sp = await sellerByUser(userId);
  await requireCanEnable(sp);
  return insertProfile(sp.id, body || {});
}

// Ownership: a profile is found only through the signed-in seller's own seller profile (another seller's id is "not found").
async function ownProfile(sellerProfileId, profileId) {
  if (!isUuid(profileId)) throw new ShippingError('PROFILE_NOT_FOUND', 'Shipping settings not found', 404);
  const p = (await db.query(`SELECT ${PROFILE_COLS} FROM seller_shipping_profiles WHERE id = $1 AND seller_profile_id = $2 AND archived_at IS NULL`,
    [profileId, sellerProfileId])).rows[0];
  if (!p) throw new ShippingError('PROFILE_NOT_FOUND', 'Shipping settings not found', 404);
  return p;
}

async function updateProfile(userId, profileId, body) {
  const sp = await sellerByUser(userId);
  await requireCanEnable(sp);
  const cur = await ownProfile(sp.id, profileId);
  const p = normalizeProfile(body || {}, cur);
  if (body && body.is_default === true && !cur.is_default) {
    await db.query(`UPDATE seller_shipping_profiles SET is_default = false, updated_at = now() WHERE seller_profile_id = $1 AND is_default`, [sp.id]);
  }
  return (await db.query(`UPDATE seller_shipping_profiles SET name = $3, method = $4, flat_rate_cents = $5, handling_days = $6,
      excluded_states = $7::text[], packaging_note = $8, is_default = (is_default OR $9), updated_at = now()
    WHERE id = $1 AND seller_profile_id = $2 RETURNING ${PROFILE_COLS}`,
  [cur.id, sp.id, p.name, p.method, p.flat_rate_cents, p.handling_days, p.excluded_states, p.packaging_note, !!(body && body.is_default === true)])).rows[0];
}

/** Archive (never delete). Refused while an open lot still ships with it, so a buyer's shown terms never lose their source. */
async function archiveProfile(userId, profileId) {
  const sp = await sellerByUser(userId);
  const cur = await ownProfile(sp.id, profileId);
  const inUse = Number((await db.query(`SELECT count(*)::int n FROM lots WHERE shipping_profile_id = $1 AND shipping_eligible AND state = 'open'`,
    [cur.id])).rows[0].n);
  if (inUse > 0) throw new ShippingError('PROFILE_IN_USE', 'These shipping settings are used by ' + inUse + ' open lot' + (inUse === 1 ? '' : 's') + '. Choose other settings for those lots first.', 409);
  await db.query(`UPDATE seller_shipping_profiles SET archived_at = now(), is_default = false, updated_at = now() WHERE id = $1`, [cur.id]);
  if (cur.is_default) {   // promote the oldest remaining profile so the seller always has a default
    await db.query(`UPDATE seller_shipping_profiles SET is_default = true, updated_at = now() WHERE id = (
      SELECT id FROM seller_shipping_profiles WHERE seller_profile_id = $1 AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1)`, [sp.id]);
  }
  return { archived: true, id: cur.id };
}

// ── Lot eligibility ──────────────────────────────────────────────────────────────────────────────────────────
async function lotWithSeller(lotId) {
  if (!isUuid(lotId)) throw new ShippingError('LOT_NOT_FOUND', 'Lot not found', 404);
  const row = (await db.query(`SELECT l.id, l.auction_id, l.state, l.bid_count, l.shipping_eligible, l.shipping_profile_id, l.shipping_restriction,
      l.shipping_quote_required, a.seller_id, sp.user_id AS owner_user_id
    FROM lots l JOIN auctions a ON a.id = l.auction_id JOIN seller_profiles sp ON sp.id = a.seller_id WHERE l.id = $1`, [lotId])).rows[0];
  if (!row) throw new ShippingError('LOT_NOT_FOUND', 'Lot not found', 404);
  return row;
}

function lotSettings(row) {
  return { lot_id: row.id, shipping_eligible: row.shipping_eligible === true, shipping_profile_id: row.shipping_profile_id || null,
    shipping_restriction: row.shipping_restriction || null, shipping_quote_required: row.shipping_quote_required === true };
}

async function getLotSettings(user, lotId) {
  const row = await lotWithSeller(lotId);
  if (user.role !== 'admin' && String(row.owner_user_id) !== String(user.id)) throw new ShippingError('LOT_NOT_FOUND', 'Lot not found', 404);
  return lotSettings(row);
}

/**
 * Set or clear a lot's shipping. body: { shipping_eligible, shipping_profile_id?, shipping_restriction?, shipping_quote_required?,
 * override_reason? (admin) }. Sellers: own lot, the catalog edit lock applies, only while the lot is open with no bids, and
 * only when the seller may offer shipping and acknowledged the education. Administrators may override any of this with a
 * reason; every change is audited.
 */
async function setLotShipping(user, lotId, body = {}) {
  const isAdmin = user.role === 'admin';
  const row = await lotWithSeller(lotId);
  if (!isAdmin && String(row.owner_user_id) !== String(user.id)) throw new ShippingError('LOT_NOT_FOUND', 'Lot not found', 404);
  const overrideReason = isAdmin && typeof body.override_reason === 'string' ? body.override_reason.trim() : '';
  const overrides = [];

  if (!isAdmin) {
    const gate = await require('../routes/lots').canMutateLot(user.id, user.role, lotId);
    if (!gate.allowed) throw new ShippingError('LOT_LOCKED', 'This lot can no longer be edited. Contact Advantage.Bid to change it.', 403);
  }
  if (row.state !== 'open' || Number(row.bid_count) > 0) {
    if (!isAdmin) throw new ShippingError('LOT_HAS_BIDS', 'Shipping terms cannot change after bidding has started on this lot, because buyers bid on the terms shown.', 409);
    overrides.push('lot_has_bids_or_closed');
  }

  const eligible = body.shipping_eligible === true;
  let profileId = null; let restriction = null; let quoteRequired = false;
  if (eligible) {
    const sp = await sellerById(row.seller_id);
    const e = await eligibilityFor(sp);
    if (!e.can_enable) {
      if (!isAdmin) throw new ShippingError(e.needs_acknowledgment ? 'ACK_REQUIRED' : 'SHIPPING_NOT_ALLOWED', eligibilityMessage(e), 403);
      overrides.push('seller_not_eligible:' + e.reason);
    }
    if (body.shipping_profile_id) {
      profileId = (await ownProfile(row.seller_id, body.shipping_profile_id)).id;
    } else {
      const def = (await db.query(`SELECT id FROM seller_shipping_profiles WHERE seller_profile_id = $1 AND is_default AND archived_at IS NULL`, [row.seller_id])).rows[0];
      if (!def) throw new ShippingError('PROFILE_REQUIRED', 'Set up your shipping settings first, then mark lots that can ship.');
      profileId = def.id;
    }
    restriction = typeof body.shipping_restriction === 'string' ? body.shipping_restriction.trim() : '';
    if (restriction.length > policy.MAX_RESTRICTION_LENGTH) throw new ShippingError('INVALID_RESTRICTION', 'Shipping restrictions can be up to 300 characters.');
    restriction = restriction || null;
    quoteRequired = body.shipping_quote_required === true;
  }
  if (overrides.length && !overrideReason) throw new ShippingError('OVERRIDE_REASON_REQUIRED', 'An override reason is required (' + overrides.join(', ') + ').');

  const before = lotSettings(row);
  // lots.shippable (the legacy discovery flag) follows the eligibility set here, so older surfaces never show a
  // shipping badge on a lot the new rule says is pickup only, nor the reverse, for lots managed through this path.
  const updated = (await db.query(`UPDATE lots SET shipping_eligible = $2, shipping_profile_id = $3, shipping_restriction = $4,
      shipping_quote_required = $5, shippable = $2, updated_at = now()
    WHERE id = $1 RETURNING id, shipping_eligible, shipping_profile_id, shipping_restriction, shipping_quote_required`,
  [row.id, eligible, profileId, restriction, quoteRequired])).rows[0];
  const after = lotSettings(updated);
  await writeAuditLog({
    event_type: overrides.length ? 'auction_shipping_admin_override' : 'lot_shipping_updated',
    entity_type: 'lot', entity_id: row.id, auction_id: row.auction_id, lot_id: row.id, actor_id: user.id,
    metadata: { before, after, actor_role: user.role, overrides, override_reason: overrideReason || null },
  });
  return after;
}

// ── Administrator controls (all audited) ─────────────────────────────────────────────────────────────────────
function adminView(sp, status) {
  return { seller_profile_id: sp.id, seller_type: sp.seller_type, approved_at: sp.shipping_approved_at || null,
    approved_by: sp.shipping_approved_by || null, approval_reason: sp.shipping_approval_reason || null,
    per_shipment_limit_override_cents: sp.shipping_per_shipment_limit_cents == null ? null : Number(sp.shipping_per_shipment_limit_cents),
    ...status };
}

async function adminGetSeller(sellerProfileId) {
  const sp = await sellerById(sellerProfileId);
  return adminView(sp, await statusFor(sp));
}

function parseLimit(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;   // back to the $500 default
  const n = Number(v);
  if (!Number.isInteger(n) || n < 100 || n > 100000000) throw new ShippingError('INVALID_LIMIT', 'per_shipment_limit_cents must be a whole number of cents from 100 to 100000000, or null for the default.');
  return n;
}
function requireReason(body) {
  const r = body && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (r.length < 5) throw new ShippingError('REASON_REQUIRED', 'A reason of at least 5 characters is required.');
  return r;
}

/** Approve an Individual Seller for shipping (sets the existing capabilities.shipping_enabled gate) with a reason and optional limit. */
async function adminApprove(actorId, sellerProfileId, body = {}) {
  const reason = requireReason(body);
  const limit = parseLimit(body.per_shipment_limit_cents);
  const sp = await sellerById(sellerProfileId);
  const beforeCaps = sp.capabilities || {};
  const afterCaps = { ...beforeCaps, shipping_enabled: true };
  await db.query(`UPDATE seller_profiles SET capabilities = $2::jsonb, shipping_approved_at = now(), shipping_approved_by = $3,
      shipping_approval_reason = $4, shipping_per_shipment_limit_cents = CASE WHEN $5::boolean THEN $6::int ELSE shipping_per_shipment_limit_cents END
    WHERE id = $1`, [sp.id, JSON.stringify(afterCaps), actorId, reason, limit !== undefined, limit === undefined ? null : limit]);
  await writeAuditLog({ event_type: 'auction_shipping_seller_approved', entity_type: 'seller_profile', entity_id: sp.id, actor_id: actorId,
    metadata: { reason, seller_type: sp.seller_type, capabilities_before: beforeCaps, capabilities_after: afterCaps,
      per_shipment_limit_cents: limit === undefined ? sp.shipping_per_shipment_limit_cents : limit } });
  return adminGetSeller(sp.id);
}

/** Revoke shipping approval. Open lots with no bids return to Local Pickup; lots with bids keep the terms buyers bid on. */
async function adminRevoke(actorId, sellerProfileId, body = {}) {
  const reason = requireReason(body);
  const sp = await sellerById(sellerProfileId);
  const beforeCaps = sp.capabilities || {};
  const afterCaps = { ...beforeCaps, shipping_enabled: false };
  await db.query(`UPDATE seller_profiles SET capabilities = $2::jsonb, shipping_approved_at = NULL, shipping_approved_by = NULL,
      shipping_approval_reason = NULL WHERE id = $1`, [sp.id, JSON.stringify(afterCaps)]);
  const cleared = (await db.query(`UPDATE lots l SET shipping_eligible = false, shipping_profile_id = NULL, shipping_restriction = NULL,
      shipping_quote_required = false, shippable = false, updated_at = now()
    FROM auctions a WHERE a.id = l.auction_id AND a.seller_id = $1 AND l.shipping_eligible AND l.state = 'open' AND COALESCE(l.bid_count, 0) = 0
    RETURNING l.id`, [sp.id])).rows.length;
  const keptWithBids = Number((await db.query(`SELECT count(*)::int n FROM lots l JOIN auctions a ON a.id = l.auction_id
    WHERE a.seller_id = $1 AND l.shipping_eligible AND l.state = 'open'`, [sp.id])).rows[0].n);
  await writeAuditLog({ event_type: 'auction_shipping_seller_revoked', entity_type: 'seller_profile', entity_id: sp.id, actor_id: actorId,
    metadata: { reason, capabilities_before: beforeCaps, capabilities_after: afterCaps, lots_returned_to_pickup: cleared, open_lots_kept_with_bids: keptWithBids } });
  return { ...(await adminGetSeller(sp.id)), lots_returned_to_pickup: cleared, open_lots_kept_with_bids: keptWithBids };
}

/** Adjust one seller's per-shipment limit (null = back to the $500 default). Applies to Professional and Individual Sellers. */
async function adminSetLimit(actorId, sellerProfileId, body = {}) {
  const reason = requireReason(body);
  const limit = parseLimit(body.per_shipment_limit_cents);
  if (limit === undefined) throw new ShippingError('INVALID_LIMIT', 'per_shipment_limit_cents is required (null restores the default).');
  const sp = await sellerById(sellerProfileId);
  await db.query(`UPDATE seller_profiles SET shipping_per_shipment_limit_cents = $2 WHERE id = $1`, [sp.id, limit]);
  await writeAuditLog({ event_type: 'auction_shipping_limit_changed', entity_type: 'seller_profile', entity_id: sp.id, actor_id: actorId,
    metadata: { reason, before: sp.shipping_per_shipment_limit_cents == null ? null : Number(sp.shipping_per_shipment_limit_cents), after: limit,
      effective_after: policy.perShipmentLimitCents(limit) } });
  return adminGetSeller(sp.id);
}

// ── Buyer-facing summaries (added to the existing auction and lot payloads; no second retrieval path) ─────────────
/** Map lotId → shipping summary for a set of lot ids. One query for lots + profiles + seller limit. */
async function summariesForLotIds(lotIds) {
  const ids = (lotIds || []).filter(isUuid);
  const out = {};
  if (!ids.length) return out;
  const { rows } = await db.query(`SELECT l.id, l.shipping_eligible, l.shipping_quote_required, l.shipping_restriction,
      p.method, p.flat_rate_cents, p.handling_days, p.excluded_states, p.archived_at AS profile_archived_at, p.id AS profile_id,
      sp.shipping_per_shipment_limit_cents
    FROM lots l JOIN auctions a ON a.id = l.auction_id JOIN seller_profiles sp ON sp.id = a.seller_id
    LEFT JOIN seller_shipping_profiles p ON p.id = l.shipping_profile_id AND p.seller_profile_id = a.seller_id
    WHERE l.id = ANY($1::uuid[])`, [ids]);
  for (const r of rows) {
    const profile = r.profile_id ? { method: r.method, flat_rate_cents: r.flat_rate_cents, handling_days: r.handling_days, excluded_states: r.excluded_states } : null;
    out[r.id] = policy.lotShippingSummary(r, profile, { maxItemValueCents: policy.perShipmentLimitCents(r.shipping_per_shipment_limit_cents) });
  }
  return out;
}

async function auctionSummary(auctionId) {
  if (!isUuid(auctionId)) return policy.auctionShippingLabel([]);
  const ids = (await db.query(`SELECT id FROM lots WHERE auction_id = $1 AND state <> 'withdrawn' AND is_withdrawn IS NOT TRUE`, [auctionId])).rows.map((r) => r.id);
  const map = await summariesForLotIds(ids);
  return policy.auctionShippingLabel(ids.map((id) => map[id] || policy.lotShippingSummary(null, null)));
}

/** Adds `shipping` to each lot object in place (only call when the flag is on). Never throws: a failure leaves lots unlabeled. */
async function attachLotSummaries(lots) {
  try {
    const list = (Array.isArray(lots) ? lots : [lots]).filter(Boolean);
    const map = await summariesForLotIds(list.map((l) => l.id));
    for (const l of list) l.shipping = map[l.id] || policy.lotShippingSummary(null, null);
  } catch (e) { console.error('[auctionShipping] lot summaries failed', e.message); }
  return lots;
}

module.exports = {
  ShippingError, getSellerStatus, acknowledgeEducation, listProfiles, createProfile, updateProfile, archiveProfile,
  getLotSettings, setLotShipping, adminGetSeller, adminApprove, adminRevoke, adminSetLimit,
  summariesForLotIds, auctionSummary, attachLotSummaries, normalizeProfile,
};
