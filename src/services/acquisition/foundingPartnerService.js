'use strict';

/**
 * foundingPartnerService — Founding Auction Partners (migration 185).
 *
 * Commercial rule: Advantage.Bid may temporarily waive ITS professional auction platform/software fee for a
 * Founding Partner. The 3% card-processing fee is never waived: it is frozen at publish for every auction like any
 * other and stays the seller's responsibility. Nothing here touches the sitewide default, Storefront pricing or the
 * processing rate.
 *
 * No second fee engine. The introductory rate is written to the EXISTING per-seller rate
 * (seller_profiles.platform_fee_bps, the Moderation "Platform Fee"). The publish-time snapshot (auctionService)
 * already freezes that rate into auctions.platform_fee_bps, so restoring the return rate later changes only auctions
 * published afterwards. An explicit 0 is a real rate everywhere (never "unset").
 *
 * Lifecycle:
 *   designate  company → status 'prospect': moved into the FOUNDING_PARTNER journey (Claimed Listing and Event Partner
 *              can no longer message it), the company contact lock goes to the staff member handling it, and the
 *              records are tagged for attribution. No fee changes.
 *   activate   link the company's professional seller account → status 'active': the introductory rate is applied to
 *              the seller's rate (audited exactly like a Moderation change). Refused while a pricing agreement is
 *              accepted or awaiting the seller, because an agreement takes precedence over the seller's rate.
 *   restoreFee audited staff action: puts the return rate back. NOT automatic: the introductory period has no fixed
 *              length, an end date is optional and may be renegotiated, and a silent fee increase on a partner is the
 *              kind of change the Owner wants a person to make. Staff get an Owner alert before and after the end date
 *              and a warning on the Founding Partners page.
 *   end        status 'ended' (record and attribution kept). The journey is left as is: moving the company to another
 *              journey is a separate Super Admin decision in the Claimed Listings toolbox.
 *
 * Fail closed: an identity that resembles another company (an ambiguous pair) or sits in a refused merge is not
 * designated until staff resolve it; any lookup error refuses.
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');
const identity = require('./companyIdentityService');
const journeys = require('./journeyService');
const locks = require('./contactLockService');
const { PROFESSIONAL_SELLER_TYPES } = require('../../constants/sellerTypes');

const JOURNEY = 'FOUNDING_PARTNER';
const ENTITY_TYPES = ['organization', 'seller_profile', 'sales_prospect', 'authorized_event_source'];
const MARKET_RE = /^[a-z0-9_]{2,40}$/;
const MAX_BPS = 2500;
const REMIND_DAYS = 14;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function err(status, code, message, extra) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; if (extra) e.details = extra; return e; }

function bpsOrNull(v, label) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_BPS) throw err(400, 'INVALID_RATE', label + ' must be a whole number of basis points between 0 and ' + MAX_BPS + '.');
  return n;
}
function dateOrNull(v, label) {
  if (v == null || v === '') return null;
  if (!DATE_RE.test(String(v)) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw err(400, 'INVALID_DATE', label + ' must be a date (YYYY-MM-DD).');
  return String(v);
}
function marketOf(v) {
  const m = String(v || '').trim().toLowerCase();
  if (!MARKET_RE.test(m)) throw err(400, 'INVALID_MARKET', 'Market must be a short program key such as houston or ny_tristate (letters, digits, underscores).');
  return m;
}

/** Merge the Founding Partner designation into an acquisition record without disturbing what is already there. */
const ATTRIBUTION_SQL = (table) => `UPDATE ${table} SET acquisition = COALESCE(acquisition, '{}'::jsonb)
   || jsonb_build_object('founding_partner', jsonb_build_object('founding_partner_id', $2::text, 'market', $3::text, 'designated_at', now()))
   WHERE id = ANY($1::uuid[])`;

async function load(id, runner = db, forUpdate = false) {
  const r = (await runner.query(`SELECT * FROM founding_partners WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!r) throw err(404, 'NOT_FOUND', 'Founding Partner record not found.');
  return r;
}

/** Why an identity is not safe to act on, or null. Pure given a snapshot. */
function identityConcern(snap, entityType, entityId) {
  const key = entityType + ':' + entityId;
  const amb = snap.ambiguousFor(entityType, String(entityId));
  if (amb.length) {
    const a = amb[0];
    return { code: 'AMBIGUOUS_IDENTITY', message: 'This company resembles ' + (a.a === key ? a.b_label : a.a_label)
      + ' but no strong identifier agrees (' + (a.weak || []).join(', ') + '). Resolve the identity review first.', pairs: amb.length };
  }
  const conflict = (snap.conflicts || []).find((c) => c.a === key || c.b === key);
  if (conflict) return { code: 'IDENTITY_CONFLICT', message: 'This record sits in a refused company merge (' + conflict.reason + '). Resolve it first.' };
  return null;
}

/**
 * Place a company under Founding Partner handling. Super Admin (the route enforces the permission).
 * Returns the record. Moves the journey FIRST: if anything after it fails the company is still protected.
 */
async function designate({ entityType, entityId, market, reason, internalNote = null, startDate = null, introEndDate = null,
  introPlatformFeeBps = 0, returnPlatformFeeBps = null, relationshipOwnerUserId = null, actorId, isSuperAdmin = false } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  if (!ENTITY_TYPES.includes(entityType) || !entityId) throw err(400, 'ENTITY_INVALID', 'Choose a company record.');
  if (!reason || String(reason).trim().length < 5) throw err(400, 'REASON_REQUIRED', 'A written reason is required.');
  const mk = marketOf(market);
  const intro = bpsOrNull(introPlatformFeeBps == null ? 0 : introPlatformFeeBps, 'Introductory platform fee');
  const ret = bpsOrNull(returnPlatformFeeBps, 'Return platform fee');
  const start = dateOrNull(startDate, 'Start date');
  const end = dateOrNull(introEndDate, 'Introductory end date');
  if (start && end && end < start) throw err(400, 'INVALID_DATE', 'The introductory end date is before the start date.');

  let snap;
  try { snap = await identity.snapshot(); } catch (e) { throw err(503, 'COMPANY_CHECK_FAILED', 'Could not build the company map. Nothing was changed; try again shortly.'); }
  const cluster = snap.clusterFor(entityType, String(entityId));
  if (!cluster) throw err(404, 'NOT_FOUND', 'That record does not exist.');
  for (const m of cluster.members) {
    const concern = identityConcern(snap, m.entity_type, m.entity_id);
    if (concern) throw err(409, concern.code, concern.message, { member: m.label });
  }
  const companyId = await identity.ensureCompany(entityType, String(entityId), { actorId });
  if (!companyId) throw err(404, 'NOT_FOUND', 'That record does not exist.');
  const open = (await db.query(`SELECT id, status FROM founding_partners WHERE company_id = $1 AND status <> 'ended'`, [companyId])).rows[0];
  if (open) throw err(409, 'ALREADY_FOUNDING_PARTNER', 'This company already has an open Founding Partner record.', { id: open.id });

  const members = (await db.query(`SELECT entity_type, entity_id FROM company_identity_links WHERE company_id = $1`, [companyId])).rows;
  const orgIds = members.filter((m) => m.entity_type === 'organization').map((m) => m.entity_id);
  const sellerIds = members.filter((m) => m.entity_type === 'seller_profile').map((m) => m.entity_id);
  const founder = cluster.members.find((m) => m.entity_type === 'organization') || cluster.members[0];

  // 1. Protection first.
  const before = await journeys.activeFor(companyId);
  if (!before || before.journey !== JOURNEY) {
    await journeys.move(companyId, { toJourney: JOURNEY, reason: 'Founding Auction Partner: ' + String(reason).trim(), actorId });
  }
  // 2. The person handling the company holds the contact lock (a lock held by someone else is reassigned, audited).
  const owner = relationshipOwnerUserId || actorId;
  let lockNote = null;
  try { await locks.acquire(companyId, { userId: owner, reason: 'Founding Auction Partner', reassign: true, isSuperAdmin }); }
  catch (e) { lockNote = 'contact lock not taken: ' + e.message; }

  // 3. The record, the attribution tags and the audit, together.
  const rec = await withTransaction(async (client) => {
    const row = (await client.query(
      `INSERT INTO founding_partners (company_id, organization_id, display_name, market, reason, internal_note, start_date, intro_end_date,
         intro_platform_fee_bps, return_platform_fee_bps, relationship_owner_user_id, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [companyId, orgIds[0] || null, founder.label || 'Company', mk, String(reason).trim(), internalNote || null, start, end,
        intro, ret, owner, actorId])).rows[0];
    if (orgIds.length) await client.query(ATTRIBUTION_SQL('organizations'), [orgIds, row.id, mk]);
    if (sellerIds.length) await client.query(ATTRIBUTION_SQL('seller_profiles'), [sellerIds, row.id, mk]);
    await auditService.logEvent(client, {
      eventType: 'founding_partner.designated', entityType: 'founding_partner', entityId: row.id, actorId,
      metadata: { company_id: companyId, entity: entityType + ':' + entityId, market: mk, intro_platform_fee_bps: intro,
        return_platform_fee_bps: ret, intro_end_date: end, previous_journey: before ? before.journey : null, lock: lockNote || 'held by ' + owner },
    });
    return row;
  });
  return Object.assign(rec, { lock_note: lockNote });
}

/**
 * Link the company's professional seller account and apply the introductory rate to it. Super Admin.
 * The seller must belong to the company; a seller with no company yet can be linked explicitly (audited).
 */
async function activate(id, { sellerProfileId, actorId } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  if (!sellerProfileId) throw err(400, 'SELLER_REQUIRED', 'Choose the professional seller account.');
  const fp = await load(id);
  if (fp.status !== 'prospect') throw err(409, 'NOT_PROSPECT', 'Only a prospect can be activated (this record is ' + fp.status + ').');
  const sp = (await db.query(`SELECT id, seller_type, platform_fee_bps FROM seller_profiles WHERE id = $1`, [sellerProfileId])).rows[0];
  if (!sp) throw err(404, 'NOT_FOUND', 'Seller account not found.');
  if (!PROFESSIONAL_SELLER_TYPES.includes(sp.seller_type)) {
    throw err(409, 'NOT_PROFESSIONAL', 'The introductory platform fee applies to professional sellers only. Set the seller type first (this seller is ' + (sp.seller_type || 'unset') + ').');
  }
  // An agreement outranks the seller's rate: a 0% here would not be what the partner is charged.
  const agr = (await db.query(
    `SELECT status, platform_fee_bps, version FROM professional_pricing_agreements
      WHERE seller_profile_id = $1 AND status IN ('accepted','pending','draft') ORDER BY version DESC LIMIT 1`, [sellerProfileId])).rows[0];
  if (agr) {
    throw err(409, 'PRICING_AGREEMENT_EXISTS', 'This seller has a pricing agreement (version ' + agr.version + ', ' + agr.status + ', '
      + (Number(agr.platform_fee_bps) / 100).toFixed(2) + '%). An agreement takes precedence over the seller rate, so the introductory fee would not apply. '
      + 'Resolve the agreement with Finance first.');
  }
  const link = (await db.query(`SELECT company_id FROM company_identity_links WHERE entity_type = 'seller_profile' AND entity_id = $1`, [sellerProfileId])).rows[0];
  if (link && link.company_id !== fp.company_id) throw err(409, 'SELLER_IN_OTHER_COMPANY', 'This seller account belongs to a different company record.');
  const other = (await db.query(`SELECT id FROM founding_partners WHERE seller_profile_id = $1 AND status <> 'ended' AND id <> $2`, [sellerProfileId, id])).rows[0];
  if (other) throw err(409, 'SELLER_ALREADY_PARTNER', 'This seller account is already on another Founding Partner record.');

  return withTransaction(async (client) => {
    const cur = await load(id, client, true);
    if (cur.status !== 'prospect') throw err(409, 'NOT_PROSPECT', 'This record changed; reload and try again.');
    const s = (await client.query(`SELECT platform_fee_bps FROM seller_profiles WHERE id = $1 FOR UPDATE`, [sellerProfileId])).rows[0];
    const prior = s.platform_fee_bps == null ? null : Number(s.platform_fee_bps);
    if (!link) {
      await client.query(
        `INSERT INTO company_identity_links (company_id, entity_type, entity_id, match_method, confidence, linked_by)
         VALUES ($1,'seller_profile',$2,'admin','admin',$3) ON CONFLICT (entity_type, entity_id) DO NOTHING`, [cur.company_id, sellerProfileId, actorId]);
      await auditService.logEvent(client, { eventType: 'company_identity.linked', entityType: 'company_identity', entityId: cur.company_id, actorId,
        metadata: { entity_type: 'seller_profile', entity_id: sellerProfileId, method: 'admin', reason: 'Founding Partner activation' } });
    }
    const intro = Number(cur.intro_platform_fee_bps);
    await client.query(`UPDATE seller_profiles SET platform_fee_bps = $1 WHERE id = $2`, [intro, sellerProfileId]);
    await client.query(ATTRIBUTION_SQL('seller_profiles'), [[sellerProfileId], cur.id, cur.market]);
    const row = (await client.query(
      `UPDATE founding_partners SET status = 'active', seller_profile_id = $2, prior_platform_fee_bps = $3,
          return_platform_fee_bps = COALESCE(return_platform_fee_bps, $3), start_date = COALESCE(start_date, CURRENT_DATE),
          fee_applied_at = now(), fee_applied_by = $4, updated_at = now()
        WHERE id = $1 RETURNING *`, [id, sellerProfileId, prior, actorId])).rows[0];
    // The same audit event a Moderation fee change writes, so the seller's fee history stays in one place.
    if (prior !== intro) {
      await auditService.logEvent(client, { eventType: 'seller_platform_fee_changed', entityType: 'seller_profile', entityId: sellerProfileId, actorId,
        metadata: { before_bps: prior, after_bps: intro, before_pct: prior != null ? prior / 100 : null, after_pct: intro / 100, source: 'founding_partner', founding_partner_id: id } });
    }
    await auditService.logEvent(client, { eventType: 'founding_partner.activated', entityType: 'founding_partner', entityId: id, actorId,
      metadata: { seller_profile_id: sellerProfileId, prior_platform_fee_bps: prior, intro_platform_fee_bps: intro, return_platform_fee_bps: row.return_platform_fee_bps } });
    return row;
  });
}

/**
 * Put the return rate back on the seller (audited staff action). Affects only auctions published afterwards.
 * Refuses when the seller's rate is no longer the introductory rate (someone changed it in Moderation): a person
 * must look at that rather than overwrite it.
 */
async function restoreFee(id, { actorId, returnPlatformFeeBps = null } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  const override = bpsOrNull(returnPlatformFeeBps, 'Return platform fee');
  return withTransaction(async (client) => {
    const fp = await load(id, client, true);
    if (fp.status !== 'active' || !fp.fee_applied_at) throw err(409, 'NOT_APPLIED', 'The introductory fee is not applied on this record.');
    if (fp.fee_restored_at) throw err(409, 'ALREADY_RESTORED', 'The return fee was already restored.');
    const ret = override != null ? override : (fp.return_platform_fee_bps != null ? Number(fp.return_platform_fee_bps) : null);
    if (ret == null) throw err(400, 'RETURN_FEE_REQUIRED', 'Enter the return platform fee.');
    const s = (await client.query(`SELECT platform_fee_bps FROM seller_profiles WHERE id = $1 FOR UPDATE`, [fp.seller_profile_id])).rows[0];
    if (!s) throw err(404, 'NOT_FOUND', 'Seller account not found.');
    const now = s.platform_fee_bps == null ? null : Number(s.platform_fee_bps);
    if (now !== Number(fp.intro_platform_fee_bps)) {
      throw err(409, 'FEE_CHANGED_ELSEWHERE', 'The seller\'s rate is ' + (now == null ? 'unset' : (now / 100).toFixed(2) + '%')
        + ', not the introductory ' + (Number(fp.intro_platform_fee_bps) / 100).toFixed(2) + '%. It was changed outside this program; review it in Moderation.');
    }
    await client.query(`UPDATE seller_profiles SET platform_fee_bps = $1 WHERE id = $2`, [ret, fp.seller_profile_id]);
    const row = (await client.query(
      `UPDATE founding_partners SET return_platform_fee_bps = $2, fee_restored_at = now(), fee_restored_by = $3, updated_at = now()
        WHERE id = $1 RETURNING *`, [id, ret, actorId])).rows[0];
    await auditService.logEvent(client, { eventType: 'seller_platform_fee_changed', entityType: 'seller_profile', entityId: fp.seller_profile_id, actorId,
      metadata: { before_bps: now, after_bps: ret, before_pct: now / 100, after_pct: ret / 100, source: 'founding_partner_restore', founding_partner_id: id } });
    await auditService.logEvent(client, { eventType: 'founding_partner.fee_restored', entityType: 'founding_partner', entityId: id, actorId,
      metadata: { from_bps: now, to_bps: ret, intro_end_date: fp.intro_end_date } });
    return row;
  });
}

/** Edit the program fields. The introductory rate can change only before it is applied. */
async function update(id, fields = {}, { actorId } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  return withTransaction(async (client) => {
    const fp = await load(id, client, true);
    if (fp.status === 'ended') throw err(409, 'ENDED', 'This record has ended.');
    const next = {};
    if ('market' in fields) next.market = marketOf(fields.market);
    if ('internal_note' in fields) next.internal_note = fields.internal_note ? String(fields.internal_note) : null;
    if ('reason' in fields) { if (!fields.reason || String(fields.reason).trim().length < 5) throw err(400, 'REASON_REQUIRED', 'A written reason is required.'); next.reason = String(fields.reason).trim(); }
    if ('start_date' in fields) next.start_date = dateOrNull(fields.start_date, 'Start date');
    if ('intro_end_date' in fields) next.intro_end_date = dateOrNull(fields.intro_end_date, 'Introductory end date');
    if ('return_platform_fee_bps' in fields) next.return_platform_fee_bps = bpsOrNull(fields.return_platform_fee_bps, 'Return platform fee');
    if ('relationship_owner_user_id' in fields) next.relationship_owner_user_id = fields.relationship_owner_user_id || null;
    if ('intro_platform_fee_bps' in fields) {
      if (fp.fee_applied_at) throw err(409, 'FEE_APPLIED', 'The introductory fee is already applied. Change the seller\'s rate in Moderation or restore the return fee.');
      next.intro_platform_fee_bps = bpsOrNull(fields.intro_platform_fee_bps, 'Introductory platform fee');
      if (next.intro_platform_fee_bps == null) throw err(400, 'INVALID_RATE', 'Introductory platform fee is required.');
    }
    const s = next.start_date !== undefined ? next.start_date : fp.start_date && String(fp.start_date instanceof Date ? fp.start_date.toISOString().slice(0, 10) : fp.start_date);
    const e = next.intro_end_date !== undefined ? next.intro_end_date : fp.intro_end_date && String(fp.intro_end_date instanceof Date ? fp.intro_end_date.toISOString().slice(0, 10) : fp.intro_end_date);
    if (s && e && e < s) throw err(400, 'INVALID_DATE', 'The introductory end date is before the start date.');
    const keys = Object.keys(next);
    if (!keys.length) return fp;
    const sets = keys.map((k, i) => k + ' = $' + (i + 2));
    const row = (await client.query(`UPDATE founding_partners SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => next[k])])).rows[0];
    const before = {}; for (const k of keys) before[k] = fp[k];
    await auditService.logEvent(client, { eventType: 'founding_partner.updated', entityType: 'founding_partner', entityId: id, actorId, metadata: { before, after: next } });
    return row;
  });
}

/** End the record. The introductory fee must be restored first (unless it equals the return fee). */
async function end(id, { reason, actorId } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  if (!reason || String(reason).trim().length < 5) throw err(400, 'REASON_REQUIRED', 'A written reason is required.');
  return withTransaction(async (client) => {
    const fp = await load(id, client, true);
    if (fp.status === 'ended') throw err(409, 'ENDED', 'This record has already ended.');
    if (fp.fee_applied_at && !fp.fee_restored_at && Number(fp.intro_platform_fee_bps) !== Number(fp.return_platform_fee_bps)) {
      throw err(409, 'RESTORE_FEE_FIRST', 'The introductory fee is still on the seller. Restore the return fee first.');
    }
    const row = (await client.query(
      `UPDATE founding_partners SET status = 'ended', ended_at = now(), ended_by = $2, end_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, actorId, String(reason).trim()])).rows[0];
    await auditService.logEvent(client, { eventType: 'founding_partner.ended', entityType: 'founding_partner', entityId: id, actorId,
      metadata: { reason: String(reason).trim(), previous_status: fp.status, journey_left_as: JOURNEY } });
    return row;
  });
}

/** The open Founding Partner record a seller publishes under (for the auction stamp), or null. */
async function forSeller(sellerProfileId, runner = db) {
  if (!sellerProfileId) return null;
  return (await runner.query(
    `SELECT id, intro_platform_fee_bps, fee_applied_at, fee_restored_at FROM founding_partners WHERE seller_profile_id = $1 AND status = 'active' LIMIT 1`, [sellerProfileId])).rows[0] || null;
}

const iso = (d) => (d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));
function daysUntil(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const t = Date.parse(iso(dateStr) + 'T00:00:00Z');
  const today = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.round((t - today) / 86400000);
}

/**
 * Warnings for one record. Pure. `effectiveBps` = what a publish today would freeze (agreement-aware).
 */
function warningsFor(r, { now = new Date(), effectiveBps = null, journey = null } = {}) {
  const w = [];
  const applied = r.status === 'active' && r.fee_applied_at && !r.fee_restored_at;
  const d = daysUntil(r.intro_end_date, now);
  if (applied && d != null && d < 0) w.push({ level: 'critical', code: 'INTRO_ENDED', text: 'The introductory period ended ' + (-d) + ' day(s) ago and the introductory fee is still applied. Restore the return fee or extend the end date.' });
  else if (applied && d != null && d <= REMIND_DAYS) w.push({ level: 'warning', code: 'INTRO_ENDING', text: 'The introductory period ends in ' + d + ' day(s) (' + iso(r.intro_end_date) + ').' });
  if (applied && r.seller_platform_fee_bps != null && Number(r.seller_platform_fee_bps) !== Number(r.intro_platform_fee_bps)) {
    w.push({ level: 'warning', code: 'FEE_CHANGED_ELSEWHERE', text: 'The seller\'s rate was changed outside this program (now ' + (Number(r.seller_platform_fee_bps) / 100).toFixed(2) + '%).' });
  }
  if (applied && effectiveBps != null && Number(effectiveBps) !== Number(r.intro_platform_fee_bps)) {
    w.push({ level: 'critical', code: 'EFFECTIVE_FEE_DIFFERS', text: 'A new auction would be charged ' + (Number(effectiveBps) / 100).toFixed(2) + '%, not the introductory ' + (Number(r.intro_platform_fee_bps) / 100).toFixed(2) + '% (a pricing agreement takes precedence).' });
  }
  if (r.status !== 'ended' && journey !== JOURNEY) w.push({ level: 'critical', code: 'NOT_PROTECTED', text: 'The company is not in the Founding Partner journey (' + (journey || 'none') + '); automated programs are not blocked.' });
  if (applied && !r.intro_end_date) w.push({ level: 'info', code: 'NO_END_DATE', text: 'No introductory end date is set; the introductory fee stays until staff restore the return fee.' });
  return w;
}

/** All records with seller, fee, journey, lock and warning detail for the staff page. */
async function list({ includeEnded = true } = {}, runner = db) {
  const pricing = require('../sellerPricingAgreementService');
  const pricingConfig = require('../pricingConfigService');
  const rows = (await runner.query(
    `SELECT fp.*, sp.platform_fee_bps AS seller_platform_fee_bps, sp.seller_type, u.email AS seller_email,
            ro.full_name AS relationship_owner_name, ab.full_name AS approved_by_name,
            j.journey AS active_journey, l.holder_type AS lock_holder_type, lu.full_name AS lock_holder_name, l.expires_at AS lock_expires_at,
            (SELECT count(*)::int FROM auctions a WHERE a.founding_partner_id = fp.id) AS auctions_published,
            (SELECT count(*)::int FROM listing_outreach_sequences s WHERE s.company_id = fp.company_id AND s.state IN ('queued','active','paused','dormant')) AS live_listing_sequences
       FROM founding_partners fp
       LEFT JOIN seller_profiles sp ON sp.id = fp.seller_profile_id
       LEFT JOIN users u ON u.id = sp.user_id
       LEFT JOIN users ro ON ro.id = fp.relationship_owner_user_id
       LEFT JOIN users ab ON ab.id = fp.approved_by
       LEFT JOIN acquisition_journey_assignments j ON j.company_id = fp.company_id AND j.status = 'active'
       LEFT JOIN company_contact_locks l ON l.company_id = fp.company_id AND l.expires_at > now()
       LEFT JOIN users lu ON lu.id = l.holder_user_id
      WHERE ($1 OR fp.status <> 'ended')
      ORDER BY (fp.status = 'ended'), fp.created_at DESC`, [includeEnded])).rows;
  const sitewide = await pricingConfig.currentProPlatformBps();
  for (const r of rows) {
    let effective = null;
    if (r.seller_profile_id) {
      const agreementBps = await pricing.effectivePlatformFeeBps(r.seller_profile_id, new Date(), runner);
      effective = pricing.resolvePlatformFeeBps({ agreementBps, sellerOverrideBps: r.seller_platform_fee_bps, sitewideDefaultBps: sitewide });
      r.effective_fee_basis = agreementBps != null ? 'agreement' : 'seller_rate';
    }
    r.effective_platform_fee_bps = effective;
    r.start_date = iso(r.start_date); r.intro_end_date = iso(r.intro_end_date);
    r.days_until_intro_end = daysUntil(r.intro_end_date);
    r.suppresses = r.active_journey === JOURNEY ? ['Claimed Listing outreach', 'Event Partner outreach', 'other staff without the contact lock'] : [];
    r.warnings = warningsFor(r, { effectiveBps: effective, journey: r.active_journey });
  }
  return rows;
}

// ── cohort review (read-only) ─────────────────────────────────────────────────────────────────

const PROFESSION = { 3: 'auction_house', 4: 'estate_sale_company', 5: 'appraiser' };
const NY_TRISTATE = new Set(['NY', 'NJ', 'CT']);
// Greater Houston (the nine-county metro) cities that appear in directory data.
const HOUSTON_METRO = new Set(['houston', 'bellaire', 'conroe', 'the woodlands', 'spring', 'katy', 'sugar land', 'pearland', 'cypress', 'humble',
  'pasadena', 'league city', 'friendswood', 'missouri city', 'tomball', 'kingwood', 'richmond', 'rosenberg', 'baytown', 'stafford',
  'magnolia', 'montgomery', 'galveston', 'seabrook', 'webster', 'west university place', 'jersey village', 'atascocita', 'fulshear']);

/**
 * Market and profile for one directory record. Pure. Strict: a record whose state is not a valid code is NOT
 * counted, it is flagged (Marketing decides).
 */
function targetProfile(o) {
  const { usStateCode } = require('../claimedListings/listingContext');
  const st = usStateCode(o.state);
  const city = String(o.city || '').trim().toLowerCase();
  const prof = PROFESSION[String((o.bd_metadata && o.bd_metadata.profession_id) || o.profession_id || '')] || null;
  let market = null;
  if (st && NY_TRISTATE.has(st)) market = 'ny_tristate';
  else if (st === 'TX' && HOUSTON_METRO.has(city)) market = 'houston';
  const flags = [];
  // Pasadena is excluded: Pasadena, California is far more common in directory data.
  if (st !== 'TX' && HOUSTON_METRO.has(city) && city !== 'pasadena') {
    flags.push('city ' + o.city + ' is in Greater Houston but the state is recorded as "' + o.state + '"');
  }
  return { market, profession: prof, estate_sale: prof === 'estate_sale_company', in_target: !!market && prof === 'estate_sale_company', flags };
}

/** The pending members of a Claimed Listing cohort with identity detail. Read-only: changes nothing. */
async function cohortReview(cohortId, runner = db) {
  const rows = (await runner.query(
    `SELECT m.id AS member_id, m.status AS member_status, o.id AS organization_id, o.name, o.city, o.state, o.bd_listing_id, o.website_url,
            o.contact_email, o.contact_phone, o.google_place_id, o.bd_metadata, o.verification_status, o.linked_seller_profile_id,
            s.tier, s.score,
            (SELECT d.decision FROM listing_outreach_eligibility_decisions d WHERE d.organization_id = o.id ORDER BY d.evaluated_at DESC LIMIT 1) AS decision
       FROM listing_outreach_cohort_members m JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN listing_outreach_scores s ON s.organization_id = o.id
      WHERE m.cohort_id = $1 AND m.status NOT IN ('excluded','skipped','stopped')
      ORDER BY o.state, o.city, o.name`, [cohortId])).rows;
  let snap = null;
  try { snap = await identity.snapshot(runner); } catch (_) { snap = null; }
  const fps = (await runner.query(`SELECT id, company_id, organization_id, status FROM founding_partners WHERE status <> 'ended'`)).rows;
  const out = rows.map((o) => {
    const t = targetProfile(o);
    const cluster = snap ? snap.clusterFor('organization', String(o.organization_id)) : null;
    const concern = snap ? identityConcern(snap, 'organization', String(o.organization_id)) : { code: 'COMPANY_CHECK_FAILED', message: 'company map unavailable' };
    const fp = fps.find((f) => f.organization_id === o.organization_id || (cluster && cluster.companyId && f.company_id === cluster.companyId)) || null;
    const email = String(o.contact_email || '');
    return {
      member_id: o.member_id, member_status: o.member_status, organization_id: o.organization_id, name: o.name, city: o.city, state: o.state,
      bd_listing_id: o.bd_listing_id, website: o.website_url, email_domain: email.includes('@') ? email.split('@')[1].toLowerCase() : null,
      has_phone: !!o.contact_phone, has_google_place: !!o.google_place_id, verification_status: o.verification_status,
      profession: t.profession, market: t.market, in_target_profile: t.in_target, data_flags: t.flags,
      tier: o.tier, score: o.score, eligibility_decision: o.decision,
      company_records: cluster ? cluster.members.length : 1, journey: cluster ? cluster.journey : null,
      identity_concern: concern ? concern.message : null, can_place_under_protection: !concern && !fp,
      founding_partner: fp ? { id: fp.id, status: fp.status } : null,
    };
  });
  const summary = {
    pending: out.length,
    in_target_profile: out.filter((r) => r.in_target_profile).length,
    by_market: out.reduce((m, r) => { const k = (r.market || 'other') + (r.in_target_profile ? ':estate_sale' : ':' + (r.profession || 'unknown')); m[k] = (m[k] || 0) + 1; return m; }, {}),
    flagged: out.filter((r) => r.data_flags.length).length,
    identity_concerns: out.filter((r) => r.identity_concern).length,
    already_founding_partner: out.filter((r) => r.founding_partner).length,
  };
  return { cohort_id: cohortId, summary, members: out };
}

// ── reminders ─────────────────────────────────────────────────────────────────────────────────

/**
 * Owner alert once when an applied introductory period is within REMIND_DAYS of its end date, and once when it has
 * passed without the return fee being restored. Never changes a fee. Never throws.
 */
async function sendReminders({ now = new Date(), runner = db, alert = null } = {}) {
  const out = { checked: 0, ending: 0, ended: 0 };
  try {
    const notify = alert || require('../ownerAlertService').notifyAdminActionRequired;
    const types = require('../ownerAlertService').ALERT_TYPES || {};
    const rows = (await runner.query(
      `SELECT id, display_name, market, intro_end_date, intro_platform_fee_bps, return_platform_fee_bps FROM founding_partners
        WHERE status = 'active' AND fee_applied_at IS NOT NULL AND fee_restored_at IS NULL AND intro_end_date IS NOT NULL`)).rows;
    for (const r of rows) {
      out.checked += 1;
      const d = daysUntil(r.intro_end_date, now);
      if (d == null || d > REMIND_DAYS) continue;
      const ended = d < 0;
      const fee = (n) => (Number(n) / 100).toFixed(2) + '%';
      await notify({
        actionType: types.FOUNDING_PARTNER_INTRO_ENDING || 'founding_partner_intro_ending',
        entityType: 'founding_partner', entityId: r.id + (ended ? ':ended' : ':ending'),
        headline: ended ? 'Founding Partner introductory fee period has ENDED' : 'Founding Partner introductory fee period ends in ' + d + ' day(s)',
        context: r.display_name + ' (' + r.market + '): introductory ' + fee(r.intro_platform_fee_bps) + ', return '
          + (r.return_platform_fee_bps == null ? 'not set' : fee(r.return_platform_fee_bps)) + ', end date ' + iso(r.intro_end_date) + '. The fee does not change by itself.',
        adminPath: '/admin/founding-partners.html', adminId: r.id, actionLabel: 'Review',
      });
      if (ended) out.ended += 1; else out.ending += 1;
    }
  } catch (e) { out.error = e.message; }
  return out;
}

let timer = null;
function startReminders() {
  if (timer) return;
  const run = () => sendReminders().then((r) => { if (r.ending || r.ended || r.error) console.log('[founding-partners] reminders ' + JSON.stringify(r)); });
  setTimeout(run, 3 * 60 * 1000);
  timer = setInterval(run, 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  JOURNEY, ENTITY_TYPES, REMIND_DAYS, designate, activate, restoreFee, update, end, forSeller, list, cohortReview,
  sendReminders, startReminders, warningsFor, targetProfile, identityConcern, daysUntil,
};
