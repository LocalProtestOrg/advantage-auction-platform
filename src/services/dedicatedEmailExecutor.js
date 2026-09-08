'use strict';

/**
 * dedicatedEmailExecutor — Phase 3O Wave 2, blocker 3. The SIGNATURE dedicated single-auction email, a SEPARATE
 * executor from the shared edition. Signature owes BOTH a shared-edition inclusion (sharedEmailExecutor) AND
 * this dedicated send.
 *
 * Scope ladder LOCAL → REGIONAL → CATEGORY_SHIPPABLE → NATIONWIDE. For each scope it resolves eligible
 * recipients through the send-time authority (consent + suppression + unsubscribe + bounce/complaint + frequency
 * caps + relevance + health), records the evaluated-eligible count, and STOPS at the first legitimate scope that
 * meets the configured useful-audience floor (default 300) AFTER exclusions. It never manufactures eligibility,
 * never widens for a bigger number, and never promises 300 recipients to the seller. If no scope safely
 * qualifies, it routes through the resilience ladder (never a silent completion).
 *
 * Configurable defaults preserved: normal max 2 per market/week, normal max 3/day globally, minimum 48h spacing
 * for materially overlapping audiences, useful floor 300, target window T-7 .. T-3. A7 OFF -> shadow (assembles,
 * evaluates scope, validates the queue payload; completes NO real obligation — dedicated_send is provider_verified).
 */

const db = require('../db');
const marketingConfig = require('./marketingConfigService');
const eligibility = require('./audienceEligibilityService');
const obligationEngine = require('./marketingObligationEngine');
const { runLadder } = require('./resilienceLadderService');

const SCOPES = ['LOCAL', 'REGIONAL', 'CATEGORY_SHIPPABLE', 'NATIONWIDE'];
const DEFAULTS = { floor: 300, maxPerMarketWeek: 2, maxPerDay: 3, spacingHours: 48 };

async function cfg() {
  return {
    floor: await marketingConfig.getInt('marketing.dedicated.audience_floor', DEFAULTS.floor),
    maxPerMarketWeek: await marketingConfig.getInt('marketing.dedicated.max_per_market_week', DEFAULTS.maxPerMarketWeek),
    maxPerDay: await marketingConfig.getInt('marketing.dedicated.max_per_day', DEFAULTS.maxPerDay),
    spacingHours: await marketingConfig.getInt('marketing.dedicated.spacing_hours', DEFAULTS.spacingHours),
  };
}
async function emailGateOn() { return marketingConfig.getBool('marketing.a7_send_enabled', false); }

/**
 * Evaluate one scope: run every candidate contact through the send-time eligibility authority and return the
 * count that survives ALL exclusions. Pure count — no side effects, no eligibility fabrication.
 */
async function evaluateScope(contacts, scope, runner) {
  const r = runner || db;
  let eligible = 0; const reasons = {};
  for (const c of contacts) {
    const v = await eligibility.evaluateContact({ contact: c, marketingClass: 'dedicated_auction', geoStrategy: c.geoStrategy || null }, r);
    if (v.eligible) eligible++; else reasons[v.reason] = (reasons[v.reason] || 0) + 1;
  }
  return { scope, eligible_after_exclusions: eligible, evaluated: contacts.length, exclusion_reasons: reasons };
}

/** Frequency/spacing guards from prior dedicated sends. Returns which caps (if any) are currently violated. */
async function frequencyGuards({ market, referenceDate, audienceKey }, runner) {
  const r = runner || db;
  const ref = new Date(referenceDate);
  const dayStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate())).toISOString();
  const weekAgo = new Date(ref.getTime() - 7 * 86400000).toISOString();
  const c = await cfg();
  const perDay = (await r.query(
    `SELECT count(*)::int n FROM marketing_dedicated_sends WHERE sent_at >= $1 AND status IN ('sent_shadow','queued_shadow','reconciled')`,
    [dayStart])).rows[0].n;
  const perMarketWeek = market ? (await r.query(
    `SELECT count(*)::int n FROM marketing_dedicated_sends d
       JOIN marketing_obligations o ON o.id=d.obligation_id
      WHERE d.sent_at >= $1 AND d.status IN ('sent_shadow','queued_shadow','reconciled')`,
    [weekAgo])).rows[0].n : 0;
  // Spacing: a materially-overlapping audience sent within spacingHours.
  const spacingWindow = new Date(ref.getTime() - c.spacingHours * 3600000).toISOString();
  const overlapping = (await r.query(
    `SELECT count(*)::int n FROM marketing_dedicated_sends WHERE sent_at >= $1 AND status IN ('sent_shadow','queued_shadow','reconciled')`,
    [spacingWindow])).rows[0].n;
  return {
    perDayOk: perDay < c.maxPerDay,
    perMarketWeekOk: perMarketWeek < c.maxPerMarketWeek,
    spacingOk: overlapping === 0 || !audienceKey, // if audiences materially overlap, require spacing clear
    perDay, perMarketWeek, overlapping, caps: c,
  };
}

/**
 * Execute a Signature dedicated send. audiencePools: { LOCAL:[contacts], REGIONAL:[...], ... }. Walks the ladder
 * in order; stops at the first scope meeting the floor after exclusions. If none qualifies (or a frequency guard
 * blocks), routes through resilience — never completes silently, never manufactures reach.
 */
async function execute(obligation, { auctionId, market, referenceDate, audiencePools = {}, audienceKey }, runner) {
  const r = runner || db;
  const c = await cfg();
  const shadow = !(await emailGateOn());

  const guards = await frequencyGuards({ market, referenceDate, audienceKey }, r);
  const evaluated = [];
  let chosen = null;
  if (guards.perDayOk && guards.perMarketWeekOk && guards.spacingOk) {
    for (const scope of SCOPES) {
      const pool = audiencePools[scope] || [];
      const ev = await evaluateScope(pool, scope, r);
      evaluated.push({ scope: ev.scope, eligible_after_exclusions: ev.eligible_after_exclusions });
      if (ev.eligible_after_exclusions >= c.floor) { chosen = ev; break; } // STOP at first qualifying scope
    }
  }

  const ins = await r.query(
    `INSERT INTO marketing_dedicated_sends
       (obligation_id, auction_id, chosen_scope, scopes_evaluated, recipient_count, audience_floor, status, shadow, sent_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING *`,
    [obligation.id || null, auctionId, chosen ? chosen.scope : 'NONE', JSON.stringify(evaluated),
     chosen ? chosen.eligible_after_exclusions : 0, c.floor,
     chosen ? (shadow ? 'sent_shadow' : 'queued_shadow') : 'no_scope', shadow,
     chosen && shadow ? referenceDate : null]);

  if (!chosen) {
    const ladder = runLadder('L_dedicated',
      { readiness: shadow ? 'SHADOW_CERTIFIED' : 'ACTIVE', audience_floor: 'BELOW_FLOOR',
        frequency: (guards.perDayOk && guards.perMarketWeekOk && guards.spacingOk) ? 'OK' : 'CAPPED' },
      { shadow });
    if (obligation.id) await obligationEngine.block(obligation.id,
      { reason: 'dedicated_no_qualifying_scope', retryAfter: '1 day' }, r).catch(() => {});
    return { ok: false, reason: 'no_scope_qualifies', evaluated, floor: c.floor, guards, ladder, send: ins.rows[0], shadow };
  }

  return {
    ok: true, shadow, chosen_scope: chosen.scope, recipient_count: chosen.eligible_after_exclusions,
    floor: c.floor, evaluated, guards, send: ins.rows[0],
    completes_real_obligation: false, // provider_verified — only a real delivery completes; shadow never does
    format: 'dedicated',
  };
}

module.exports = { SCOPES, DEFAULTS, cfg, evaluateScope, frequencyGuards, execute };
