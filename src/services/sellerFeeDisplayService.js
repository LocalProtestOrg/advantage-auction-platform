'use strict';

/**
 * sellerFeeDisplayService — the EFFECTIVE professional platform fee for staff screens (Moderation › Sellers).
 *
 * The stored per-seller rate (seller_profiles.platform_fee_bps) is not always what a seller is charged: an accepted,
 * effective pricing agreement takes precedence over it at publish. This resolves the same hierarchy the publish-time
 * snapshot uses (sellerPricingAgreementService.resolvePlatformFeeBps) so staff see the rate a new auction would
 * freeze, and why. Read-only. An explicit 0 is a real rate (never treated as unset).
 */

const db = require('../db');
const pricing = require('./sellerPricingAgreementService');
const pricingConfig = require('./pricingConfigService');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');

/** Pure: the effective fee and its basis for one seller. */
function describe({ sellerType, storedBps, agreement, sitewideBps, foundingPartner }) {
  const isPro = PROFESSIONAL_SELLER_TYPES.includes(sellerType);
  if (!isPro) {
    return { effective_platform_fee_bps: 0, fee_basis: 'individual', fee_note: 'Not a professional seller: no platform fee applies (processing is separate).' };
  }
  const agreementBps = agreement ? Number(agreement.platform_fee_bps) : null;
  const eff = pricing.resolvePlatformFeeBps({ agreementBps, sellerOverrideBps: storedBps, sitewideDefaultBps: sitewideBps });
  const pct = (n) => (Number(n) / 100).toFixed(2) + '%';
  let basis; let note;
  if (agreementBps != null) {
    basis = 'agreement';
    note = 'Pricing agreement v' + agreement.version + ' (' + pct(agreementBps) + ') applies'
      + (storedBps != null && Number(storedBps) !== agreementBps ? '; it overrides the stored rate of ' + pct(storedBps) + '.' : '.');
  } else if (storedBps != null) {
    basis = 'seller_rate';
    note = 'Stored seller rate applies.';
  } else {
    basis = 'sitewide_default';
    note = 'No seller rate: the sitewide default applies.';
  }
  if (foundingPartner) note += ' Founding Auction Partner (' + foundingPartner.status + ', introductory ' + pct(foundingPartner.intro_platform_fee_bps) + ').';
  return { effective_platform_fee_bps: eff, fee_basis: basis, fee_note: note, overridden_by_agreement: basis === 'agreement' && storedBps != null && Number(storedBps) !== eff };
}

/** Adds effective_platform_fee_bps, fee_basis, fee_note, overridden_by_agreement and founding_partner to each row. */
async function annotate(rows, runner = db) {
  const ids = rows.map((r) => r.seller_profile_id).filter(Boolean);
  if (!ids.length) return rows;
  const sitewideBps = await pricingConfig.currentProPlatformBps();
  const agreements = new Map((await runner.query(
    `SELECT DISTINCT ON (seller_profile_id) seller_profile_id, platform_fee_bps, version
       FROM professional_pricing_agreements
      WHERE seller_profile_id = ANY($1::uuid[]) AND status = 'accepted' AND effective_date <= now()
      ORDER BY seller_profile_id, effective_date DESC, version DESC`, [ids])).rows.map((a) => [a.seller_profile_id, a]));
  const fps = new Map((await runner.query(
    `SELECT id, seller_profile_id, status, intro_platform_fee_bps, return_platform_fee_bps, intro_end_date, fee_restored_at
       FROM founding_partners WHERE seller_profile_id = ANY($1::uuid[]) AND status <> 'ended'`, [ids])
    .catch(() => ({ rows: [] }))).rows.map((f) => [f.seller_profile_id, f]));
  for (const r of rows) {
    const fp = fps.get(r.seller_profile_id) || null;
    Object.assign(r, describe({ sellerType: r.seller_type, storedBps: r.platform_fee_bps, agreement: agreements.get(r.seller_profile_id) || null, sitewideBps, foundingPartner: fp }));
    r.founding_partner = fp;
  }
  return rows;
}

module.exports = { describe, annotate };
