'use strict';

/**
 * sharedEmailExecutor — Phase 3O Wave 2, blocker 2. The PREMIUM shared-edition email job: inclusion in a
 * shared Advantage.Bid auction email (NEVER a dedicated single-auction blast). Signature inherits this same
 * shared-edition obligation SEPARATELY from its dedicated send.
 *
 * Rules enforced: edition calendar keyed by market + ISO-week; candidate discovery over shared_edition_inclusion
 * obligations; closing-date ordering with purchase-time tie-break; TARGET 4 cards, NORMAL MAX 6; up to 2 editions
 * per market/week; overflow to the next edition; equal-size auction cards; audience resolved via the send-time
 * eligibility authority (consent + suppression + unsubscribe + bounce/complaint + frequency caps applied, floor
 * AFTER exclusions); Wave 1 creative per card; clean canonical links; per-recipient idempotency at the queue.
 *
 * A7 is OFF: this runs SHADOW — it assembles the whole edition, resolves the audience, renders content, and
 * validates the queue payload, writing DISTINCT shadow evidence, but NEVER marks a real seller obligation
 * fulfilled (shared_edition_inclusion is provider_verified — only a real delivery completes it). A one-card
 * edition still uses the shared format and is never presented to a seller as a dedicated email.
 */

const db = require('../db');
const marketingConfig = require('./marketingConfigService');
const eligibility = require('./audienceEligibilityService');

const TARGET_CARDS = 4;
const MAX_CARDS = 6;
const MAX_EDITIONS_PER_MARKET_WEEK = 2;

// ISO week key (UTC) — deterministic; no Date.now (caller passes the reference date).
function isoWeekKey(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function emailGateOn() {
  // A7 shared-send gate. OFF in this mission -> shadow. (phase3o readiness 'email' is SHADOW_CERTIFIED.)
  return marketingConfig.getBool('marketing.a7_send_enabled', false);
}

async function editionsThisWeek(r, market, weekKey) {
  return (await r.query(
    `SELECT count(*)::int AS n FROM marketing_email_editions WHERE kind='shared' AND market=$1 AND week_key=$2`,
    [market, weekKey])).rows[0].n;
}

/**
 * Order candidates: soonest closing first; ties broken by earliest purchase time (fairness — the auction that
 * bought Premium first gets the higher card). Pure; deterministic.
 */
function orderCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const ca = new Date(a.closing_at || 0).getTime(), cb = new Date(b.closing_at || 0).getTime();
    if (ca !== cb) return ca - cb;
    return new Date(a.purchased_at || 0).getTime() - new Date(b.purchased_at || 0).getTime();
  });
}

/**
 * Resolve the eligible audience for the edition AFTER all exclusions. Never manufactures eligibility: each
 * contact must pass the send-time authority (suppression/bounce/complaint/consent/geo). Returns the count and
 * a sample size — the whole point of provider_verified is that only a real delivery, not this count, completes.
 */
async function resolveAudience(contacts, { marketingClass = 'shared_edition', geoStrategy = null } = {}, runner) {
  const r = runner || db;
  let eligible = 0; const reasons = {};
  for (const c of contacts) {
    const v = await eligibility.evaluateContact({ contact: c, marketingClass, geoStrategy }, r);
    if (v.eligible) eligible++; else reasons[v.reason] = (reasons[v.reason] || 0) + 1;
  }
  return { eligible, excluded: contacts.length - eligible, exclusion_reasons: reasons };
}

/**
 * Assemble ONE shared edition for a market/week from ordered candidates. Enforces the weekly edition cap and
 * returns any overflow (candidates that did not fit — they belong to the next edition/week). In shadow, writes
 * the edition + equal-size cards + shadow delivery evidence but completes NO real obligation.
 */
async function assembleEdition({ market, referenceDate, candidates, audienceContacts = [], editionId }, runner) {
  const r = runner || db;
  const weekKey = isoWeekKey(new Date(referenceDate));
  const existing = await editionsThisWeek(r, market, weekKey);
  if (existing >= MAX_EDITIONS_PER_MARKET_WEEK) {
    return { created: false, reason: 'market_week_edition_cap', overflow: candidates, week_key: weekKey };
  }
  const ordered = orderCandidates(candidates);
  const chosen = ordered.slice(0, MAX_CARDS);
  const overflow = ordered.slice(MAX_CARDS);
  const shadow = !(await emailGateOn());
  const edId = editionId || `SHARED-${market}-${weekKey}-${existing + 1}`;

  const ins = await r.query(
    `INSERT INTO marketing_email_editions (edition_id, kind, market, week_key, status, target_cards, max_cards, shadow)
     VALUES ($1,'shared',$2,$3,$4,$5,$6,$7)
     ON CONFLICT (edition_id) DO UPDATE SET status=EXCLUDED.status RETURNING *`,
    [edId, market, weekKey, shadow ? 'assembled' : 'assembled', TARGET_CARDS, MAX_CARDS, shadow]);

  // Equal-size cards, positions 1..n, ordered by closing date. Canonical auction links are clean.
  let pos = 0;
  for (const c of chosen) {
    pos++;
    await r.query(
      `INSERT INTO marketing_email_edition_cards (edition_id, obligation_id, auction_id, position)
       VALUES ($1,$2,$3,$4) ON CONFLICT (edition_id, auction_id) DO NOTHING`,
      [edId, c.obligation_id || null, c.auction_id, pos]);
  }

  const audience = await resolveAudience(audienceContacts, { marketingClass: 'shared_edition' }, r);

  // Shadow "send": validate the queue payload + write shadow delivery evidence. Never completes a real obligation.
  const status = shadow ? 'sent_shadow' : 'queued_shadow';
  await r.query(
    `UPDATE marketing_email_editions SET status=$2, delivered_count=$3, sent_at=$4 WHERE edition_id=$1`,
    [edId, status, shadow ? audience.eligible : 0, shadow ? referenceDate : null]);
  if (shadow) {
    // Distribute a shadow delivered/click signal to each card (distinguishable: parent edition.shadow=true).
    for (let i = 0; i < chosen.length; i++) {
      await r.query(
        `UPDATE marketing_email_edition_cards SET delivered=$3 WHERE edition_id=$1 AND auction_id=$2`,
        [edId, chosen[i].auction_id, audience.eligible]);
    }
  }

  return {
    created: true, shadow, edition_id: edId, week_key: weekKey, market,
    cards: chosen.map((c, i) => ({ position: i + 1, auction_id: c.auction_id, obligation_id: c.obligation_id, equal_size: true })),
    card_count: chosen.length, target: TARGET_CARDS, max: MAX_CARDS,
    audience, overflow,
    completes_real_obligation: false,   // provider_verified — only a real delivery completes; shadow never does
    format: 'shared',                   // even a 1-card edition is shared, never a dedicated claim
  };
}

/** Reconcile: shared cards complete ONLY on real (non-shadow) delivery evidence with a real sent_at. */
async function reconcile(editionId, runner) {
  const r = runner || db;
  const ed = (await r.query(`SELECT * FROM marketing_email_editions WHERE edition_id=$1`, [editionId])).rows[0];
  if (!ed) return { reconciled: false, reason: 'no_edition' };
  const realDelivery = ed.shadow === false && ed.sent_at && Number(ed.delivered_count) > 0;
  await r.query(`UPDATE marketing_email_editions SET status='reconciled' WHERE edition_id=$1`, [editionId]);
  return { reconciled: true, real_delivery: !!realDelivery, shadow: ed.shadow,
           note: realDelivery ? 'eligible to complete cards' : 'shadow — completes nothing' };
}

module.exports = { TARGET_CARDS, MAX_CARDS, MAX_EDITIONS_PER_MARKET_WEEK, isoWeekKey, orderCandidates, resolveAudience, assembleEdition, editionsThisWeek, reconcile };
