'use strict';

/**
 * paidExecutionService — PLAN → SELECT CREATIVE → BUILD → VALIDATE → ENFORCE BUDGET → CREATE →
 * OBSERVE → MODIFY → PAUSE → STOP → LEARN.
 *
 * This is the layer the Marketing Agency was missing. The Director could reason about campaigns but
 * nothing could run one, and nothing could stop one.
 *
 * EVERY EXECUTION PASSES THE SAME PREFLIGHT, and any single failure is fatal to the attempt:
 *
 *   1. global kill switch          marketing.paid.global_kill
 *   2. paid execution gate         marketing.paid.execution_enabled
 *   3. channel gate                marketing.destinations.<channel>_enabled
 *   4. Director mode               marketing.paid_growth.mode must be 'live'
 *   5. measurement readiness       the minimum set for the channel must be VERIFIED
 *   6. provider permission         ads_management must actually be granted
 *   7. asset isolation             the ad account must be the verified Advantage.Bid account
 *   8. creative                    an Owner-approved, production-ELIGIBLE asset must exist
 *   9. budget                      authority must be reserved before the provider is called
 *
 * The order matters: the cheapest and most absolute checks run first, and money is reserved last —
 * but still BEFORE the provider is contacted, so a provider success can never outrun the ledger.
 *
 * KILL BEATS EVERYTHING. The global kill switch is checked first on create, and separately honoured
 * by `enforceKill()`, which pauses every ACTIVE campaign. It is not a per-channel setting and
 * nothing in the learning loop can clear it.
 */

const db = require('../../db');
const configService = require('../configService');
const ledger = require('../paidBudgetLedger');
const registry = require('../productionCreativeRegistry');
const meta = require('./metaAdsProvider');

const CHANNEL_GATE = Object.freeze({
  meta_ads: 'marketing.destinations.meta_ads_enabled',
  google_ads: 'marketing.destinations.google_ads_enabled',
});
const CHANNEL_MEASUREMENT = Object.freeze({ meta_ads: 'minimum_for_meta', google_ads: 'minimum_for_google' });

const on = (v) => v === true || v === 'true';

/** The one switch that stops everything, regardless of any other setting. */
async function killed() {
  return on(await configService.get(null, 'marketing.paid.global_kill'));
}

/**
 * Can anything spend right now, and if not, exactly why? Returns every reason, not just the first,
 * so the Owner sees the whole picture rather than fixing one gate at a time.
 */
async function preflight({ channel = 'meta_ads', funnel = 'buyer', runner = db } = {}) {
  const reasons = [];

  if (await killed()) reasons.push('the global paid-marketing kill switch is ON');
  if (!on(await configService.get(null, 'marketing.paid.execution_enabled'))) reasons.push('paid execution is OFF (marketing.paid.execution_enabled)');
  const gateKey = CHANNEL_GATE[channel];
  if (!gateKey) reasons.push('unknown channel ' + channel);
  else if (!on(await configService.get(null, gateKey))) reasons.push(channel + ' is OFF (' + gateKey + ')');
  const mode = await configService.get(null, 'marketing.paid_growth.mode');
  if (mode !== 'live') reasons.push('the Director is in ' + (mode || 'shadow') + ' mode');

  // Measurement: a campaign we cannot measure is a campaign we cannot learn from or stop on evidence.
  let readiness = null;
  try {
    readiness = await require('../measurement/measurementReadinessService').evaluate(runner);
    const rule = readiness.rules && readiness.rules[CHANNEL_MEASUREMENT[channel]];
    if (!rule || rule.ready !== true) {
      reasons.push('measurement not ready for ' + channel + ': ' + ((rule && rule.not_verified) || ['not evaluated']).join(', '));
    }
  } catch (e) { reasons.push('measurement readiness could not be evaluated: ' + e.message); }

  // Provider permission + asset isolation.
  let account = null;
  let perms = null;
  if (channel === 'meta_ads') {
    const resolved = await meta.resolveAdAccount(runner);
    if (!resolved.ok) reasons.push('ad account: ' + resolved.reason);
    else account = resolved.account;
    perms = await meta.permissions();
    if (!perms.ok) reasons.push('provider permissions unreadable: ' + perms.reason);
    else if (!perms.ads_management) reasons.push('ads_management is not granted to the Advantage.Bid system user');
  } else {
    reasons.push(channel + ' has no execution provider implemented');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    channel,
    funnel,
    account,
    permissions: perms ? { ads_read: perms.ads_read, ads_management: perms.ads_management } : null,
    measurement_ready: readiness ? readiness.measurement_ready : null,
  };
}

/**
 * Inventory the buyer funnel can actually convert on.
 *
 * Buying bidders for a marketplace with nothing to bid on wastes the Owner's money, so this is a
 * real Director input — but it is deliberately a SIGNAL, not a permanent switch. Low inventory
 * today reduces the recommendation today; it never disables buyer acquisition.
 */
async function buyerInventory({ runner = db } = {}) {
  const r = await runner.query(`
    SELECT
      (SELECT count(*)::int FROM auctions
        WHERE state IN ('published','active') AND NOT COALESCE(is_archived,false)
          AND COALESCE(marketplace_status,'') = 'syndicated') AS live_auctions,
      (SELECT count(*)::int FROM lots l JOIN auctions a ON a.id = l.auction_id
        WHERE a.state IN ('published','active') AND NOT COALESCE(a.is_archived,false)
          AND COALESCE(a.marketplace_status,'') = 'syndicated' AND l.state = 'open') AS live_lots,
      (SELECT count(*)::int FROM events WHERE COALESCE(status,'') = 'published') AS live_events`);
  const inv = r.rows[0] || { live_auctions: 0, live_lots: 0, live_events: 0 };
  const auctions = Number(inv.live_auctions), lots = Number(inv.live_lots), events = Number(inv.live_events);

  // A buyer we acquire needs something to do. Auctions are the strongest destination, events are a
  // real but weaker one (discovery rather than bidding).
  let posture, rationale;
  if (auctions > 0 && lots >= 30) { posture = 'NORMAL'; rationale = `${auctions} live auction(s) with ${lots} open lots — buyers have something to bid on`; }
  else if (auctions > 0) { posture = 'REDUCED'; rationale = `${auctions} live auction(s) but only ${lots} open lots — keep buyer spend small`; }
  else if (events >= 10) { posture = 'DISCOVERY_ONLY'; rationale = `no live auctions; ${events} published events — buyer campaigns may only promote discovery, not bidding`; }
  else { posture = 'HOLD'; rationale = `no live auctions and only ${events} published events — acquiring bidders now would buy attention we cannot convert`; }

  return { live_auctions: auctions, live_lots: lots, live_events: events, posture, rationale };
}

// ── campaign lifecycle ────────────────────────────────────────────────────────────────────────

/**
 * Build a campaign record WITHOUT contacting any provider. Safe to run at any time, including while
 * everything is gated off — this is how the Owner sees a prepared portfolio before activation.
 * A campaign with no eligible creative is recorded CREATIVE_BLOCKED rather than quietly substituting
 * a training image.
 */
async function prepareCampaign({ campaignKey, proposalId = null, channel = 'meta_ads', objective, funnel,
  market = null, audience = null, budgetCents = 0, dailyBudgetCents = null, category = null, runner = db } = {}) {
  if (!campaignKey) return { ok: false, reason: 'campaign_key required' };
  if (!['buyer', 'individual_seller', 'professional_seller'].includes(funnel)) return { ok: false, reason: 'unknown funnel ' + funnel };

  const pick = await registry.selectForCampaign({ category, funnel, runner });
  const destination = registry.DESTINATIONS[funnel] || registry.DESTINATIONS.buyer;
  const state = pick.asset ? 'PLANNED' : 'CREATIVE_BLOCKED';
  const evidence = { creative_lookup: pick.asset ? { asset_key: pick.asset.asset_key, category: pick.asset.category } : { blocked: pick.reason } };

  if (funnel === 'buyer') {
    const inv = await buyerInventory({ runner });
    evidence.inventory = inv;
  }

  const row = (await runner.query(
    `INSERT INTO marketing_paid_campaigns
       (campaign_key, proposal_id, channel, objective, funnel, market, audience, destination_url,
        creative_id, budget_cents, daily_budget_cents, state, blocked_reason, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
     ON CONFLICT (campaign_key) DO UPDATE SET
       objective=EXCLUDED.objective, market=EXCLUDED.market, audience=EXCLUDED.audience,
       destination_url=EXCLUDED.destination_url, creative_id=EXCLUDED.creative_id,
       budget_cents=EXCLUDED.budget_cents, daily_budget_cents=EXCLUDED.daily_budget_cents,
       state=CASE WHEN marketing_paid_campaigns.state IN ('ACTIVE','PAUSED','STOPPED')
                  THEN marketing_paid_campaigns.state ELSE EXCLUDED.state END,
       blocked_reason=EXCLUDED.blocked_reason, evidence=EXCLUDED.evidence, updated_at=now()
     RETURNING *`,
    [campaignKey, proposalId, channel, objective, funnel, market, audience, destination,
     pick.asset ? pick.asset.id : null, budgetCents, dailyBudgetCents, state,
     pick.asset ? null : pick.reason, JSON.stringify(evidence)])).rows[0];
  return { ok: true, campaign: row, creative: pick.asset || null, blocked_reason: pick.asset ? null : pick.reason };
}

/**
 * Actually create the campaign at the provider. Reserves budget FIRST, then calls the provider, and
 * releases the reservation if the provider refuses — so a failed creation never silently consumes
 * the Owner's monthly authority.
 *
 * Idempotent: the same campaign_key re-uses its reservation and will not create a second provider
 * campaign.
 */
async function createCampaign({ campaignKey, runner = db } = {}) {
  const c = (await runner.query('SELECT * FROM marketing_paid_campaigns WHERE campaign_key = $1', [campaignKey])).rows[0];
  if (!c) return { ok: false, reason: 'no campaign record for ' + campaignKey };
  if (c.provider_campaign_id) return { ok: true, replayed: true, campaign: c, note: 'already created at the provider' };
  if (c.state === 'CREATIVE_BLOCKED') return { ok: false, reason: 'creative blocked: ' + (c.blocked_reason || 'no eligible production creative') };
  if (!c.creative_id) return { ok: false, reason: 'no creative selected — a campaign may not run without an Owner-approved production asset' };

  const pre = await preflight({ channel: c.channel, funnel: c.funnel, runner });
  if (!pre.ok) return { ok: false, reason: 'preflight refused', reasons: pre.reasons };

  // Re-verify the creative is still eligible at the moment of creation, not merely when planned.
  const asset = (await runner.query(
    'SELECT production_eligible, ineligible_reason, factual_requirements FROM marketing_production_creative WHERE id = $1',
    [c.creative_id])).rows[0];
  if (!asset || asset.production_eligible !== true) {
    return { ok: false, reason: 'creative is no longer production-eligible: ' + ((asset && asset.ineligible_reason) || 'unregistered') };
  }

  const idem = 'campaign:' + campaignKey;
  const reservation = await ledger.reserve({ campaignKey, amountCents: c.budget_cents, idempotencyKey: idem, note: c.objective });
  if (!reservation.ok) return { ok: false, reason: 'budget refused: ' + reservation.reason };

  const created = await meta.createCampaign({
    account: pre.account, name: 'ADV — ' + campaignKey, funnel: c.funnel,
    spendCapCents: c.budget_cents, idempotencyKey: idem,
  }, runner);

  if (!created.ok) {
    await ledger.release({ campaignKey, amountCents: c.budget_cents, idempotencyKey: idem + ':release', note: 'provider refused' });
    await runner.query(
      `UPDATE marketing_paid_campaigns SET state='FAILED', last_error=$2, updated_at=now() WHERE campaign_key=$1`,
      [campaignKey, String(created.reason).slice(0, 400)]);
    return { ok: false, reason: created.reason };
  }

  // Created PAUSED at the provider. It is READY, not ACTIVE — activation is a separate decision.
  const row = (await runner.query(
    `UPDATE marketing_paid_campaigns
        SET state='READY', provider_account_ref=$2, provider_campaign_id=$3, idempotency_key=$4, updated_at=now()
      WHERE campaign_key=$1 RETURNING *`,
    [campaignKey, pre.account, created.provider_campaign_id, idem])).rows[0];
  return { ok: true, campaign: row, provider_status: 'PAUSED' };
}

async function pauseCampaign({ campaignKey, reason = null, runner = db } = {}) {
  const c = (await runner.query('SELECT * FROM marketing_paid_campaigns WHERE campaign_key = $1', [campaignKey])).rows[0];
  if (!c) return { ok: false, reason: 'no campaign record for ' + campaignKey };
  if (!c.provider_campaign_id) {
    await runner.query(`UPDATE marketing_paid_campaigns SET state='PAUSED', paused_at=now(), updated_at=now() WHERE campaign_key=$1`, [campaignKey]);
    return { ok: true, note: 'no provider campaign existed; local state paused' };
  }
  const r = await meta.pause(c.provider_campaign_id, runner);
  if (!r.ok) return { ok: false, reason: r.reason };
  await runner.query(
    `UPDATE marketing_paid_campaigns SET state='PAUSED', paused_at=now(), last_error=NULL,
        evidence = evidence || $2::jsonb, updated_at=now() WHERE campaign_key=$1`,
    [campaignKey, JSON.stringify({ paused: { at: new Date().toISOString(), reason } })]);
  return { ok: true };
}

/** Stop for good and hand the unspent authority back. */
async function stopCampaign({ campaignKey, reason = null, runner = db } = {}) {
  const c = (await runner.query('SELECT * FROM marketing_paid_campaigns WHERE campaign_key = $1', [campaignKey])).rows[0];
  if (!c) return { ok: false, reason: 'no campaign record for ' + campaignKey };
  if (c.provider_campaign_id) {
    const r = await meta.stop(c.provider_campaign_id, runner);
    if (!r.ok) return { ok: false, reason: r.reason };
  }
  const spent = (await runner.query(
    `SELECT COALESCE(sum(amount_cents),0)::int n FROM marketing_paid_budget_ledger WHERE campaign_key=$1 AND kind='actual'`,
    [campaignKey])).rows[0].n;
  const unspent = Math.max(0, Number(c.budget_cents) - Number(spent));
  if (unspent > 0) {
    await ledger.release({ campaignKey, amountCents: unspent, idempotencyKey: 'campaign:' + campaignKey + ':stop-release', note: 'stopped' });
  }
  await runner.query(
    `UPDATE marketing_paid_campaigns SET state='STOPPED', stopped_at=now(),
        evidence = evidence || $2::jsonb, updated_at=now() WHERE campaign_key=$1`,
    [campaignKey, JSON.stringify({ stopped: { at: new Date().toISOString(), reason, released_cents: unspent } })]);
  return { ok: true, released_cents: unspent };
}

/**
 * The emergency stop. Sets the kill switch and pauses everything that could be spending.
 * Deliberately best-effort per campaign: one provider failure must not prevent the rest being
 * paused, and the switch itself is set FIRST so nothing new can be created meanwhile.
 */
async function emergencyKill({ reason = 'owner emergency stop', runner = db } = {}) {
  await configService.setPlatformConfig('marketing.paid.global_kill', true);
  const rows = (await runner.query(`SELECT campaign_key FROM marketing_paid_campaigns WHERE state IN ('ACTIVE','READY')`)).rows;
  const results = [];
  for (const r of rows) {
    const out = await pauseCampaign({ campaignKey: r.campaign_key, reason, runner }).catch((e) => ({ ok: false, reason: e.message }));
    results.push({ campaign_key: r.campaign_key, ok: out.ok, reason: out.reason || null });
  }
  return { ok: true, kill: true, paused: results, note: 'no campaign can be created while the kill switch is ON' };
}

async function clearKill() { await configService.setPlatformConfig('marketing.paid.global_kill', false); return { ok: true, kill: false }; }

/** Observed provider facts for the campaigns we created. Read-only; safe with ads_read alone. */
async function observe({ since = null, until = null, runner = db } = {}) {
  const resolved = await meta.resolveAdAccount(runner);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return meta.observe({ account: resolved.account, since, until }, runner);
}

module.exports = {
  CHANNEL_GATE, killed, preflight, buyerInventory,
  prepareCampaign, createCampaign, pauseCampaign, stopCampaign, emergencyKill, clearKill, observe,
};
