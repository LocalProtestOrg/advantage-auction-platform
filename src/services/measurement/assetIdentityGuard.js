'use strict';

/**
 * assetIdentityGuard — explicit identity verification for every advertising-measurement asset (Meta dataset / Pixel,
 * Google Ads customer, conversion actions) BEFORE any software may address it. Phase 3P.2 rule: NEVER connect
 * Lewis & Maese (or any other client's) assets to Advantage.Bid automation, and never invent an id.
 *
 * An asset is usable only when ALL of the following hold:
 *   1. its id was recorded by the Owner in platform_config (never defaulted, never guessed, never derived);
 *   2. an explicit identity record exists for it ({ id, name, owner_business, verified_at, verified_by }) — the id in
 *      the record must equal the configured id (a stale record for a different id does not carry over);
 *   3. the recorded name / owning business identifies Advantage.Bid and matches NO denied client identity.
 * Anything else → { ok:false, reason } and the caller stays gated off. Pure checks; nothing here calls a provider.
 */

const DENIED_IDENTITIES = [/lewis/i, /maese/i, /l\s*&\s*m\b/i];
const REQUIRED_IDENTITY = /advantage[\s._-]*bid|advantage auction/i;

function isRealId(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined') return false;
  return !/^(x+|0+|test|placeholder|todo|tbd|changeme|your[_-].*|<.*>)$/i.test(s);
}

/**
 * @param {string} assetType 'meta_dataset' | 'google_ads_customer' | 'google_conversion_action'
 * @param {*} configuredId  the id read from platform_config
 * @param {object|null} identity the Owner-recorded identity record for that asset
 */
function check(assetType, configuredId, identity) {
  if (!isRealId(configuredId)) return { ok: false, asset: assetType, reason: 'NOT_CONFIGURED', detail: 'no Owner-recorded id (ids are never invented)' };
  if (!identity || typeof identity !== 'object') return { ok: false, asset: assetType, reason: 'IDENTITY_UNVERIFIED', detail: 'no explicit identity record for this asset' };
  if (String(identity.id || '').trim() !== String(configuredId).trim()) return { ok: false, asset: assetType, reason: 'IDENTITY_MISMATCH', detail: 'identity record belongs to a different id' };
  const names = [identity.name, identity.owner_business].filter(Boolean).map(String);
  if (names.some((n) => DENIED_IDENTITIES.some((re) => re.test(n)))) return { ok: false, asset: assetType, reason: 'DENIED_CLIENT_ASSET', detail: 'asset belongs to a client, not Advantage.Bid — never connected' };
  if (!names.some((n) => REQUIRED_IDENTITY.test(n))) return { ok: false, asset: assetType, reason: 'NOT_ADVANTAGE_BID', detail: 'asset identity does not name Advantage.Bid' };
  if (!identity.verified_at) return { ok: false, asset: assetType, reason: 'IDENTITY_UNVERIFIED', detail: 'identity record has no verification time' };
  return { ok: true, asset: assetType };
}

module.exports = { check, isRealId, DENIED_IDENTITIES };
