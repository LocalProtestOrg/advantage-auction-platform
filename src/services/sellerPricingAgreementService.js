'use strict';

/**
 * sellerPricingAgreementService — the DEDICATED Professional Seller negotiated-PLATFORM-fee agreement
 * workflow: authoring/issuance, seller acceptance, versioning, supersession, and audit.
 *
 * DESIGN (reuse, do not fork):
 *   • This is NOT a parallel pricing engine. The RESOLVED current platform-fee rate still lives on
 *     seller_profiles.platform_fee_bps (kept in sync when an agreement is accepted and effective), so the
 *     EXISTING publish-time snapshot (auctionService) and settlement engine (billingTermsService) are used
 *     UNCHANGED. effectivePlatformFeeBps() lets the publish snapshot prefer an accepted, effective agreement.
 *   • Resolution hierarchy (owner rule):
 *        SITEWIDE DEFAULT → SELLER/COMPANY OVERRIDE → EXECUTED AGREEMENT → AUCTION SNAPSHOT (frozen).
 *     Here resolvePlatformFeeBps() implements: executed agreement ?? seller override ?? sitewide default.
 *   • Platform (software) fee and processing fee stay SEPARATE. Only the PLATFORM fee is negotiated here;
 *     the processing fee is recorded for a transparent record and never negotiated/collapsed.
 *   • An ACCEPTED agreement is an immutable historical record. Any change issues a NEW version that
 *     supersedes it — historical acceptance is never mutated. Storefront (11%) and Individual economics are
 *     untouched by this service.
 */

const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const pricingConfig = require('./pricingConfigService');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');
const { MAX_PLATFORM_FEE_BPS } = require('../lib/settlementPolicy');

class PricingAgreementError extends Error {
  constructor(message, status = 400, code = 'PRICING_AGREEMENT_ERROR') {
    super(message); this.status = status; this.code = code;
  }
}

// ── PURE HELPERS (no I/O — unit-tested directly) ────────────────────────────────────

// Resolution hierarchy: an accepted+effective agreement wins over a bare seller override, which wins over
// the sitewide default. Any level may be null/undefined and is skipped. Never returns null when a default
// is supplied.
function resolvePlatformFeeBps({ agreementBps, sellerOverrideBps, sitewideDefaultBps }) {
  if (agreementBps != null && Number.isFinite(Number(agreementBps))) return Math.trunc(Number(agreementBps));
  if (sellerOverrideBps != null && Number.isFinite(Number(sellerOverrideBps))) return Math.trunc(Number(sellerOverrideBps));
  return Math.trunc(Number(sitewideDefaultBps));
}

// A rate is "negotiated" when it differs from the sitewide standard; otherwise it is standard pricing.
function isNegotiated(platformFeeBps, standardBps) {
  return Math.trunc(Number(platformFeeBps)) !== Math.trunc(Number(standardBps));
}

// Next per-seller version from the set of existing versions (1-based, gap-free by max+1).
function nextVersion(existingVersions) {
  const nums = (existingVersions || []).map((v) => Number(v)).filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// Human-readable agreement reference: PSA-<seller8>-v<version>.
function buildAgreementRef(sellerProfileId, version) {
  const short = String(sellerProfileId || '').replace(/-/g, '').slice(0, 8);
  return `PSA-${short}-v${version}`;
}

// Validate + normalize a proposed platform-fee rate. Accepts bps (integer) or percent (decimal).
function normalizeBps({ platform_fee_bps, platform_fee_percent }) {
  let bps;
  if (platform_fee_bps != null) bps = Number(platform_fee_bps);
  else if (platform_fee_percent != null) bps = Math.round(Number(platform_fee_percent) * 100);
  else throw new PricingAgreementError('platform_fee_percent (e.g. 4.00) or platform_fee_bps is required', 400, 'MISSING_RATE');
  if (!Number.isFinite(bps) || !Number.isInteger(bps) || bps < 0 || bps > MAX_PLATFORM_FEE_BPS) {
    throw new PricingAgreementError(
      `Platform fee must be between 0% and ${MAX_PLATFORM_FEE_BPS / 100}% (0–${MAX_PLATFORM_FEE_BPS} bps).`, 400, 'INVALID_RATE');
  }
  return bps;
}

// Is an accepted agreement effective at the given date?
function isEffective(effectiveDate, atDate) {
  if (!effectiveDate) return false;
  const eff = new Date(effectiveDate + (String(effectiveDate).length <= 10 ? 'T00:00:00Z' : ''));
  return eff.getTime() <= new Date(atDate).getTime();
}

// ── STANDARD PRICING ────────────────────────────────────────────────────────────────
async function standardPricing() {
  const [platform, processing] = await Promise.all([
    pricingConfig.currentProPlatformBps(),
    pricingConfig.currentProcessingBps(),
  ]);
  return { platform_fee_bps: platform, processing_fee_bps: processing };
}

// ── RESOLVER used by the publish-time snapshot (agreement-aware). Returns bps or null. ─
// Prefers the latest ACCEPTED agreement whose effective_date <= atDate. Returns null if none, so the
// caller falls back to seller_profiles.platform_fee_bps (existing behavior) — fully backward-compatible.
async function effectivePlatformFeeBps(sellerProfileId, atDate, runner) {
  const r = runner || db;
  if (!sellerProfileId) return null;
  const at = atDate ? new Date(atDate) : new Date();
  const { rows } = await r.query(
    `SELECT platform_fee_bps FROM professional_pricing_agreements
      WHERE seller_profile_id = $1 AND status = 'accepted' AND effective_date <= $2
      ORDER BY effective_date DESC, version DESC LIMIT 1`,
    [sellerProfileId, at]);
  return rows[0] ? Number(rows[0].platform_fee_bps) : null;
}

// ── ISSUE a proposed agreement (Admin / Finance-manage) ──────────────────────────────
async function issue({ sellerProfileId, platform_fee_bps, platform_fee_percent, effective_date, terms_summary, legal_terms_version, expires_in_days, actorId }, runner) {
  const r = runner || db;
  const bps = normalizeBps({ platform_fee_bps, platform_fee_percent });

  const sp = (await r.query(
    `SELECT id, user_id, seller_type, platform_fee_bps FROM seller_profiles WHERE id = $1`, [sellerProfileId])).rows[0];
  if (!sp) throw new PricingAgreementError('Seller profile not found', 404, 'SELLER_NOT_FOUND');
  if (PROFESSIONAL_SELLER_TYPES.indexOf(String(sp.seller_type || '').toLowerCase()) === -1) {
    throw new PricingAgreementError('Pricing agreements apply to Professional Sellers only', 422, 'NOT_PROFESSIONAL');
  }

  const std = await standardPricing();
  const versions = (await r.query(
    `SELECT version FROM professional_pricing_agreements WHERE seller_profile_id = $1`, [sellerProfileId])).rows.map((x) => x.version);
  const version = nextVersion(versions);
  const ref = buildAgreementRef(sellerProfileId, version);
  const effDate = effective_date || new Date().toISOString().slice(0, 10);
  const negotiated = isNegotiated(bps, std.platform_fee_bps);
  const snapshot = {
    platform_fee_bps: bps,
    processing_fee_bps: std.processing_fee_bps,
    standard_platform_fee_bps: std.platform_fee_bps,
    is_negotiated: negotiated,
    effective_date: effDate,
    presented_at: new Date().toISOString(),
    note: 'Platform/software fee and payment processing are separate; only the platform fee is negotiated.',
  };
  const expiresAt = expires_in_days ? new Date(Date.now() + Number(expires_in_days) * 86400000).toISOString() : null;

  const row = (await r.query(
    `INSERT INTO professional_pricing_agreements
       (seller_profile_id, version, agreement_ref, status, platform_fee_bps, processing_fee_bps, processing_basis,
        standard_platform_fee_bps, is_negotiated, effective_date, terms_summary, legal_terms_version,
        pricing_snapshot, issued_at, issued_by, expires_at, created_by)
     VALUES ($1,$2,$3,'pending',$4,$5,'standard_passthrough',$6,$7,$8,$9,$10,$11::jsonb, now(), $12, $13, $12)
     RETURNING *`,
    [sellerProfileId, version, ref, bps, std.processing_fee_bps, std.platform_fee_bps, negotiated,
     effDate, terms_summary || null, legal_terms_version || null, JSON.stringify(snapshot), actorId || null, expiresAt])).rows[0];

  await writeAuditLog({
    event_type: 'pricing_agreement_issued', entity_type: 'professional_pricing_agreement', entity_id: row.id,
    actor_id: actorId || null,
    metadata: { seller_profile_id: sellerProfileId, version, agreement_ref: ref, platform_fee_bps: bps,
      standard_platform_fee_bps: std.platform_fee_bps, processing_fee_bps: std.processing_fee_bps,
      is_negotiated: negotiated, effective_date: effDate },
  });
  return row;
}

// ── ACCEPT (authorized seller user only) ─────────────────────────────────────────────
async function accept(agreementId, { userId, ip, userAgent }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ag = (await client.query(
      `SELECT a.*, sp.user_id AS seller_user_id
         FROM professional_pricing_agreements a
         JOIN seller_profiles sp ON sp.id = a.seller_profile_id
        WHERE a.id = $1 FOR UPDATE`, [agreementId])).rows[0];
    if (!ag) throw new PricingAgreementError('Agreement not found', 404, 'NOT_FOUND');

    // AUTHORIZATION: only the seller who owns this profile may accept (server-derived; prevents cross-seller).
    if (!ag.seller_user_id || String(ag.seller_user_id) !== String(userId)) {
      throw new PricingAgreementError('Not authorized to accept this agreement', 403, 'FORBIDDEN');
    }
    // Lazy-expire an overdue pending offer.
    if (ag.expires_at && new Date(ag.expires_at) <= new Date()) {
      await client.query(`UPDATE professional_pricing_agreements SET status='expired', expired_at=now(), updated_at=now() WHERE id=$1 AND status='pending'`, [agreementId]);
      await client.query('COMMIT');
      throw new PricingAgreementError('This agreement offer has expired', 409, 'EXPIRED');
    }
    if (ag.status !== 'pending') {
      throw new PricingAgreementError(`Agreement is not pending (status: ${ag.status})`, 409, 'NOT_PENDING');
    }

    // Supersede any currently-accepted agreement for this seller (only one active accepted at a time).
    await client.query(
      `UPDATE professional_pricing_agreements
          SET status='superseded', superseded_at=now(), superseded_by_id=$2, updated_at=now()
        WHERE seller_profile_id=$1 AND status='accepted' AND id <> $2`,
      [ag.seller_profile_id, agreementId]);

    // Execute acceptance (immutable economics: only lifecycle stamps change — never the terms/pricing).
    await client.query(
      `UPDATE professional_pricing_agreements
          SET status='accepted', accepted_at=now(), accepted_by_user_id=$2, accepted_ip=$3, accepted_user_agent=$4, updated_at=now()
        WHERE id=$1`,
      [agreementId, userId, ip || null, (userAgent || '').slice(0, 512) || null]);

    // Sync the DENORMALIZED current rate to seller_profiles ONLY if effective now, so the existing publish
    // snapshot + admin display reflect it immediately. Future-dated agreements are applied by the publish
    // resolver once effective (no scheduler needed). Never touches individual/non-pro economics.
    let synced = false;
    if (isEffective(ag.effective_date, new Date())) {
      await client.query(`UPDATE seller_profiles SET platform_fee_bps=$1 WHERE id=$2`, [ag.platform_fee_bps, ag.seller_profile_id]);
      synced = true;
    }
    await client.query('COMMIT');

    await writeAuditLog({
      event_type: 'pricing_agreement_accepted', entity_type: 'professional_pricing_agreement', entity_id: agreementId,
      actor_id: userId,
      metadata: { seller_profile_id: ag.seller_profile_id, version: ag.version, agreement_ref: ag.agreement_ref,
        platform_fee_bps: ag.platform_fee_bps, effective_date: ag.effective_date, seller_override_synced: synced, ip: ip || null },
    });
    return { id: agreementId, status: 'accepted', seller_override_synced: synced };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── REVOKE a pending/draft offer (Admin / Finance-manage). Accepted agreements are immutable. ─
async function revoke(agreementId, { reason } = {}, actorId, runner) {
  const r = runner || db;
  const ag = (await r.query(`SELECT id, status, seller_profile_id, version FROM professional_pricing_agreements WHERE id=$1`, [agreementId])).rows[0];
  if (!ag) throw new PricingAgreementError('Agreement not found', 404, 'NOT_FOUND');
  if (ag.status === 'accepted' || ag.status === 'superseded') {
    throw new PricingAgreementError('An executed agreement is immutable and cannot be revoked; issue a new version instead', 409, 'IMMUTABLE');
  }
  if (ag.status !== 'pending' && ag.status !== 'draft') {
    throw new PricingAgreementError(`Cannot revoke a ${ag.status} agreement`, 409, 'BAD_STATE');
  }
  await r.query(`UPDATE professional_pricing_agreements SET status='revoked', revoked_at=now(), revoke_reason=$2, updated_at=now() WHERE id=$1`, [agreementId, reason || null]);
  await writeAuditLog({
    event_type: 'pricing_agreement_revoked', entity_type: 'professional_pricing_agreement', entity_id: agreementId,
    actor_id: actorId || null, metadata: { seller_profile_id: ag.seller_profile_id, version: ag.version, reason: reason || null },
  });
  return { id: agreementId, status: 'revoked' };
}

// ── READ MODELS ──────────────────────────────────────────────────────────────────────
async function listForSeller(sellerProfileId, runner) {
  const r = runner || db;
  return (await r.query(
    `SELECT * FROM professional_pricing_agreements WHERE seller_profile_id=$1 ORDER BY version DESC`, [sellerProfileId])).rows;
}

async function getById(id, runner) {
  const r = runner || db;
  return (await r.query(`SELECT * FROM professional_pricing_agreements WHERE id=$1`, [id])).rows[0] || null;
}

// Admin summary for a seller's record: standard vs negotiated, current accepted, pending, effective-now.
async function getSellerSummary(sellerProfileId, runner) {
  const r = runner || db;
  const sp = (await r.query(`SELECT id, seller_type, platform_fee_bps FROM seller_profiles WHERE id=$1`, [sellerProfileId])).rows[0];
  if (!sp) throw new PricingAgreementError('Seller profile not found', 404, 'SELLER_NOT_FOUND');
  const std = await standardPricing();
  const accepted = (await r.query(
    `SELECT * FROM professional_pricing_agreements WHERE seller_profile_id=$1 AND status='accepted' ORDER BY effective_date DESC, version DESC LIMIT 1`, [sellerProfileId])).rows[0] || null;
  const pending = (await r.query(
    `SELECT * FROM professional_pricing_agreements WHERE seller_profile_id=$1 AND status='pending' ORDER BY version DESC LIMIT 1`, [sellerProfileId])).rows[0] || null;
  const effBps = await effectivePlatformFeeBps(sellerProfileId, new Date(), r);
  const currentBps = resolvePlatformFeeBps({
    agreementBps: effBps, sellerOverrideBps: sp.platform_fee_bps, sitewideDefaultBps: std.platform_fee_bps });
  const basis = (effBps != null) ? 'negotiated_agreement'
    : (sp.platform_fee_bps != null && isNegotiated(sp.platform_fee_bps, std.platform_fee_bps)) ? 'negotiated_override'
    : 'standard';
  return {
    seller_profile_id: sellerProfileId,
    standard_platform_fee_bps: std.platform_fee_bps,
    processing_fee_bps: std.processing_fee_bps,
    seller_override_bps: sp.platform_fee_bps,
    current_platform_fee_bps: currentBps,
    pricing_basis: basis,
    current_agreement: accepted,
    pending_agreement: pending,
  };
}

// Seller-facing: their pending offer (needs acceptance) + current accepted.
async function getSellerView(sellerProfileId, runner) {
  const s = await getSellerSummary(sellerProfileId, runner);
  const std = { platform_fee_bps: s.standard_platform_fee_bps, processing_fee_bps: s.processing_fee_bps };
  return { standard: std, current_agreement: s.current_agreement, pending_agreement: s.pending_agreement,
    current_platform_fee_bps: s.current_platform_fee_bps, pricing_basis: s.pricing_basis };
}

module.exports = {
  // pure helpers
  resolvePlatformFeeBps, isNegotiated, nextVersion, buildAgreementRef, normalizeBps, isEffective,
  // io
  standardPricing, effectivePlatformFeeBps, issue, accept, revoke, listForSeller, getById,
  getSellerSummary, getSellerView,
  PricingAgreementError, MAX_PLATFORM_FEE_BPS,
};
