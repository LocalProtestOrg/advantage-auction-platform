'use strict';

/**
 * paidAuthorizationService — the platform owner's explicit, written authority for ONE paid campaign (migration 223).
 *
 * An authorization names the campaign, channel, market, maximum amount, delivery window and the exact creative (and
 * optionally the exact creative package). It is created only by the platform owner and expires.
 *
 * EVERY path that creates or activates paid delivery calls assertCovers() first: paidExecutionService.createCampaign,
 * metaDeliveryService.buildExperimentHierarchy and activateExperiment, and metaAdsProvider.setStatus(ACTIVE). Each
 * refuses unless a matching, unexpired authorization covers the amount, the dates and the creative. Activation
 * consumes the authorization, so resuming a stopped or paused campaign needs a fresh one.
 *
 * This layer sits ON TOP of the existing gates (kill switch, execution gate, Director mode, measurement, ledger,
 * spend freshness, launched market). It never replaces them and never contacts a provider.
 */

const db = require('../../db');

const CHANNELS = ['meta_ads', 'google_ads'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usd = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

function refuse(reason) { return { ok: false, reason }; }

/** Mark lapsed authorizations expired (lazy; also done on every check). */
async function expireLapsed(runner = db) {
  await runner.query(`UPDATE marketing_paid_authorizations SET status = 'expired', updated_at = now()
                        WHERE status = 'authorized' AND (expires_at <= now() OR ends_at <= now())`);
}

async function list({ limit = 100, campaignKey = null, runner = db } = {}) {
  await expireLapsed(runner).catch(() => {});
  return (await runner.query(
    `SELECT a.id, a.campaign_key, a.channel, a.market_key, a.amount_cents, a.starts_at, a.ends_at, a.creative_id,
            a.creative_asset_key, a.package_key, a.purchase_kind, a.purchase_id, a.auction_id, a.seller_profile_id,
            a.authorized_at, a.expires_at, a.status, a.consumed_at, a.revoked_at, a.notes,
            u.email AS authorized_by_email, c.filename AS creative_filename
       FROM marketing_paid_authorizations a
       LEFT JOIN users u ON u.id = a.authorized_by
       LEFT JOIN marketing_production_creative c ON c.id = a.creative_id
      WHERE ($1::text IS NULL OR a.campaign_key = $1)
      ORDER BY a.created_at DESC LIMIT $2`, [campaignKey, Math.min(500, Math.max(1, Number(limit) || 100))])).rows;
}

/**
 * Create an authorization. Owner only (checked here as well as on the route). Returns { ok, authorization } or
 * { ok:false, reason }. Input: campaign_key, channel, market_key?, amount_cents (or amount_usd), starts_at, ends_at,
 * expires_at? (defaults to ends_at), creative_id or creative_asset_key, package_key?, notes?, and for a future
 * seller-authorized campaign purchase_kind/purchase_id/auction_id/seller_profile_id.
 */
async function create(input = {}, { actor, runner = db } = {}) {
  const owner = require('../../lib/platformOwner');
  if (!actor || !(await owner.isPlatformOwner(actor, runner))) return refuse(owner.OWNER_REQUIRED_MESSAGE);

  const campaignKey = String(input.campaign_key || '').trim();
  if (!campaignKey || campaignKey.length > 200) return refuse('campaign_key is required.');
  const channel = String(input.channel || 'meta_ads');
  if (!CHANNELS.includes(channel)) return refuse('Unknown channel.');
  const amount = input.amount_cents != null ? Number(input.amount_cents) : Math.round(Number(input.amount_usd) * 100);
  if (!Number.isInteger(amount) || amount <= 0) return refuse('The authorized amount must be a positive whole number of cents.');
  const starts = new Date(input.starts_at); const ends = new Date(input.ends_at);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) return refuse('Start and end dates are required.');
  if (!(ends > starts)) return refuse('The end must be after the start.');
  if (!(ends > new Date())) return refuse('The authorization window has already ended.');
  const expires = input.expires_at ? new Date(input.expires_at) : ends;
  if (Number.isNaN(expires.getTime()) || !(expires > new Date())) return refuse('The expiry must be in the future.');

  const ledger = require('../paidBudgetLedger');
  const ceilings = await ledger.ceilings();
  if (amount > ceilings.campaign_cents) return refuse(`${usd(amount)} exceeds the per-campaign ceiling of ${usd(ceilings.campaign_cents)}.`);
  if (amount > ceilings.monthly_cents) return refuse(`${usd(amount)} exceeds the monthly ceiling of ${usd(ceilings.monthly_cents)}.`);

  // The creative: an Owner-approved, production-eligible asset (never do-not-use, never a training example).
  let creative = null;
  if (input.creative_id && UUID.test(String(input.creative_id))) {
    creative = (await runner.query('SELECT id, asset_key, category, production_eligible FROM marketing_production_creative WHERE id = $1', [input.creative_id])).rows[0];
  } else if (input.creative_asset_key) {
    creative = (await runner.query('SELECT id, asset_key, category, production_eligible FROM marketing_production_creative WHERE asset_key = $1', [String(input.creative_asset_key)])).rows[0];
  }
  if (!creative) return refuse('An authorization must name one registered production creative.');
  if (creative.category === 'do-not-use' || creative.production_eligible !== true) return refuse('That creative is not production-eligible.');

  let packageKey = null;
  if (input.package_key) {
    const pkg = (await runner.query('SELECT package_key, production_creative_id FROM marketing_creative_packages WHERE package_key = $1', [String(input.package_key)])).rows[0];
    if (!pkg) return refuse('Unknown creative package.');
    if (String(pkg.production_creative_id) !== String(creative.id)) return refuse('That creative package uses a different image than the authorized creative.');
    packageKey = pkg.package_key;
  }
  let marketKey = null;
  if (input.market_key) {
    const m = (await runner.query('SELECT market_key FROM marketing_paid_markets WHERE market_key = $1', [String(input.market_key)])).rows[0];
    if (!m) return refuse('Unknown market.');
    marketKey = m.market_key;
  }
  const purchaseKind = input.purchase_kind ? String(input.purchase_kind) : null;
  if (purchaseKind && !['package', 'additional_promotion'].includes(purchaseKind)) return refuse('Unknown purchase kind.');
  const optId = (v) => (v && UUID.test(String(v)) ? String(v) : null);

  let row;
  try {
    row = (await runner.query(
      `INSERT INTO marketing_paid_authorizations
         (campaign_key, channel, market_key, amount_cents, starts_at, ends_at, creative_id, creative_asset_key, package_key,
          purchase_kind, purchase_id, auction_id, seller_profile_id, authorized_by, expires_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [campaignKey, channel, marketKey, amount, starts.toISOString(), ends.toISOString(), creative.id, creative.asset_key, packageKey,
        purchaseKind, optId(input.purchase_id), optId(input.auction_id), optId(input.seller_profile_id), actor.id || actor.userId,
        expires.toISOString(), input.notes ? String(input.notes).slice(0, 1000) : null])).rows[0];
  } catch (e) {
    if (/uq_mpa_one_open_per_campaign|duplicate key/.test(e.message)) return refuse('This campaign already has an open authorization. Revoke it first.');
    throw e;
  }
  await require('../ownerNotifyService').notify({
    subject: `Paid advertising authorized: ${campaignKey} up to ${usd(amount)}`,
    reason: `A paid advertising authorization was recorded for ${campaignKey} (${channel}${marketKey ? ', ' + marketKey : ''}), up to ${usd(amount)}, from ${starts.toISOString().slice(0, 16)} to ${ends.toISOString().slice(0, 16)} UTC, creative ${creative.asset_key}.`,
    risk: 'This authorization lets the campaign be built and activated up to the amount shown.',
    recommendation: 'If you did not authorize this, revoke it on the Marketing Agency page.',
    adminPath: '/admin/marketing-agency.html',
  }, { runner }).catch(() => null);
  return { ok: true, authorization: row };
}

async function revoke(id, { actor, reason = null, runner = db } = {}) {
  const owner = require('../../lib/platformOwner');
  if (!actor || !(await owner.isPlatformOwner(actor, runner))) return refuse(owner.OWNER_REQUIRED_MESSAGE);
  if (!UUID.test(String(id || ''))) return refuse('Unknown authorization.');
  const row = (await runner.query(
    `UPDATE marketing_paid_authorizations SET status = 'revoked', revoked_at = now(), revoked_by = $2, updated_at = now(),
            notes = CASE WHEN $3::text IS NULL THEN notes ELSE COALESCE(notes || ' | ', '') || 'revoked: ' || $3 END
      WHERE id = $1 AND status = 'authorized' RETURNING *`, [id, actor.id || actor.userId, reason ? String(reason).slice(0, 300) : null])).rows[0];
  if (!row) return refuse('Only an open authorization can be revoked.');
  await require('../ownerNotifyService').notify({
    subject: 'Paid advertising authorization revoked: ' + row.campaign_key,
    reason: 'The authorization for ' + row.campaign_key + ' (' + usd(row.amount_cents) + ') was revoked. Nothing new can be built or activated under it.',
    adminPath: '/admin/marketing-agency.html',
  }, { runner }).catch(() => null);
  return { ok: true, authorization: row };
}

/**
 * Does an open authorization cover this delivery action? Pure refusal reasons, no side effects beyond expiring lapsed
 * rows. `creativeIds` / `packageKeys` are every creative and package the action would use. `window` is the delivery
 * schedule the provider will enforce, when there is one. `requireStarted` refuses before the window opens.
 */
async function assertCovers({ campaignKey, channel = null, marketKey = null, amountCents, creativeIds = [], packageKeys = [],
  window = null, requireStarted = false, action = 'delivery', runner = db } = {}) {
  if (!campaignKey) return refuse('no campaign named');
  let a;
  try {
    await expireLapsed(runner);
    a = (await runner.query(
      `SELECT * FROM marketing_paid_authorizations WHERE campaign_key = $1 AND status = 'authorized' ORDER BY created_at DESC LIMIT 1`, [campaignKey])).rows[0];
  } catch (e) {
    return refuse('owner authorization could not be checked (' + e.message + ')');
  }
  if (!a) return refuse(`no open owner authorization for ${campaignKey}: the platform owner must authorize this campaign before ${action}`);
  const now = new Date();
  if (new Date(a.expires_at) <= now || new Date(a.ends_at) <= now) return refuse('the owner authorization for ' + campaignKey + ' has expired');
  if (requireStarted && new Date(a.starts_at) > now) return refuse('the owner authorization for ' + campaignKey + ' starts ' + new Date(a.starts_at).toISOString().slice(0, 16) + ' UTC');
  if (channel && a.channel !== channel) return refuse('the owner authorization is for ' + a.channel + ', not ' + channel);
  if (a.market_key && marketKey && a.market_key !== marketKey) return refuse('the owner authorization is for market ' + a.market_key + ', not ' + marketKey);
  const amount = Number(amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return refuse('no amount to authorize');
  if (amount > Number(a.amount_cents)) return refuse(`${usd(amount)} exceeds the owner authorization of ${usd(a.amount_cents)} for ${campaignKey}`);
  // creativeIds === null means the caller re-checks the creative itself (metaAdsProvider.setStatus: the per-object
  // backstop); any other value must name only the authorized creative.
  if (creativeIds !== null) {
    const ids = (creativeIds || []).filter(Boolean).map(String);
    if (!ids.length) return refuse('no creative named for ' + campaignKey);
    if (ids.some((id) => id !== String(a.creative_id))) return refuse('the creative differs from the creative the owner authorized (' + (a.creative_asset_key || a.creative_id) + ')');
  }
  if (a.package_key && (packageKeys || []).some((k) => k && k !== a.package_key)) return refuse('the creative package differs from the package the owner authorized (' + a.package_key + ')');
  if (window) {
    const s = window.startTime ? new Date(window.startTime) : null; const e = window.endTime ? new Date(window.endTime) : null;
    if (s && s < new Date(new Date(a.starts_at).getTime() - 60000)) return refuse('the delivery would start before the authorized window');
    if (!e || e > new Date(a.ends_at)) return refuse('the delivery must end by the authorized end, ' + new Date(a.ends_at).toISOString().slice(0, 16) + ' UTC');
  }
  return { ok: true, authorization: a };
}

/** Record which authorization a campaign runs under, and its attribution (purchase, auction, seller). */
async function linkCampaign(campaignKey, a, runner = db) {
  await runner.query(
    `UPDATE marketing_paid_campaigns SET authorization_id = $2,
            purchase_kind = COALESCE(purchase_kind, $3), purchase_id = COALESCE(purchase_id, $4),
            auction_id = COALESCE(auction_id, $5), seller_profile_id = COALESCE(seller_profile_id, $6),
            evidence = CASE WHEN evidence ? 'auto_stop_at_authorization' THEN evidence ELSE evidence || '{"auto_stop_at_authorization": true}'::jsonb END,
            updated_at = now()
      WHERE campaign_key = $1`, [campaignKey, a.id, a.purchase_kind, a.purchase_id, a.auction_id, a.seller_profile_id]);
}

/** Activation consumes the authorization: resuming later needs a fresh owner decision. */
async function consume(id, runner = db) {
  await runner.query(`UPDATE marketing_paid_authorizations SET status = 'consumed', consumed_at = now(), updated_at = now()
                        WHERE id = $1 AND status = 'authorized'`, [id]);
}

module.exports = { CHANNELS, list, create, revoke, assertCovers, linkCampaign, consume, expireLapsed };
