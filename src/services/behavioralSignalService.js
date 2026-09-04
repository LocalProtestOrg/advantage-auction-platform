'use strict';

/**
 * behavioralSignalService — turns RAW first-party events (analytics_events) into DERIVED, EXPLAINABLE
 * marketing signals. No black-box scores: every signal carries a human-readable `reason`, an evidence
 * count, recency, and an explicit decay (expires_at). Strength reflects recency + frequency + depth +
 * sequence + conversion state. Converted intents EXIT (signal deactivated). Category interest is OBSERVED
 * (counted lot/category views) — never an inferred/sensitive trait.
 *
 * Pure core (`deriveSignals`) is unit-tested without a DB; `deriveAndStore`/`refreshRecent` persist.
 */
const db = require('../db');
const { VALID_KEYS } = require('../constants/lotCategories');

const VERSION = 'v1';

// Page-intent → contributing signal. Weights already encoded in pageIntentRegistry; we re-tier here.
const SELLER_INTENTS = new Set(['seller_intent_high', 'seller_consideration_high', 'seller_consideration', 'seller_education']);
const PRO_INTENTS = new Set(['professional_seller_intent']);
const BUYER_INTENTS = new Set(['buyer_discovery', 'auction_interest', 'estate_sale_interest', 'event_interest', 'marketplace_interest', 'buyer_education']);

// Authoritative conversion / funnel event types (recognized when emitted as behavioral events).
const CONV = {
  seller_completed: new Set(['seller_signup_completed', 'auction_submitted', 'auction_draft_created']),
  pro_completed: new Set(['professional_application_completed']),
  seller_started: new Set(['seller_signup_started']),
  pro_started: new Set(['professional_application_started']),
  buyer_action: new Set(['watchlist_add', 'seller_follow', 'bid_placed', 'auction_won', 'purchase_completed']),
  purchase: new Set(['purchase_completed', 'auction_won']),
  bid: new Set(['bid_placed']),
};

function daysBetween(a, b) { return Math.abs(new Date(a) - new Date(b)) / 86400000; }

/**
 * Pure signal derivation from a scope's events.
 * @param {Array} events [{ event_type, page_intent, category_key, received_at }]
 * @param {object} opts { now, ttlDays }
 * @returns {Array} signal descriptors { signal_type, level, evidence_count, reason, observed_categories?, first_observed_at, last_observed_at, expires_at, active }
 */
function deriveSignals(events, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const ttlDays = opts.ttlDays || 45;
  const list = Array.isArray(events) ? events.slice() : [];
  if (!list.length) return [];
  list.sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
  const firstAt = list[0].received_at;
  const lastAt = list[list.length - 1].received_at;
  const has = (set) => list.some((e) => set.has(e.event_type));
  const out = [];
  const mk = (signal_type, level, evidence_count, reason, extra) => out.push(Object.assign({
    signal_type, level, evidence_count, reason,
    first_observed_at: firstAt, last_observed_at: lastAt,
    expires_at: new Date(new Date(lastAt).getTime() + ttlDays * 86400000).toISOString(),
    active: true,
  }, extra || {}));

  // Distinct visit days = a proxy for "return visit" (sequence/frequency).
  const days = new Set(list.map((e) => String(e.received_at).slice(0, 10)));
  const returnVisitor = days.size > 1;

  // ── SELLER intent ──
  const sellerEvents = list.filter((e) => SELLER_INTENTS.has(e.page_intent));
  const sellerHigh = sellerEvents.some((e) => e.page_intent === 'seller_intent_high' || e.page_intent === 'seller_consideration_high');
  const sellerStarted = has(CONV.seller_started);
  const sellerCompleted = has(CONV.seller_completed);
  if (!sellerCompleted && (sellerEvents.length || sellerStarted)) {
    let level = 1; const reasons = [];
    if (sellerEvents.length) { reasons.push(sellerEvents.length + ' seller-page view(s)'); level = sellerHigh ? 2 : 1; }
    const distinctIntents = new Set(sellerEvents.map((e) => e.page_intent));
    if (distinctIntents.size >= 2) { level = Math.max(level, 3); reasons.push('multiple seller topics'); }
    if (returnVisitor && sellerEvents.length) { level = Math.max(level, 3); reasons.push('return visit'); }
    if (sellerStarted) { level = 4; reasons.push('seller signup started (not completed)'); }
    mk('SELLER_INTENT', level, sellerEvents.length + (sellerStarted ? 1 : 0), reasons.join('; ') || 'seller interest');
    if (sellerStarted) mk('SELLER_SIGNUP_ABANDONMENT', 4, 1, 'seller signup started but not completed');
  }

  // ── PROFESSIONAL seller intent ──
  const proEvents = list.filter((e) => PRO_INTENTS.has(e.page_intent));
  const proStarted = has(CONV.pro_started);
  const proCompleted = has(CONV.pro_completed);
  if (!proCompleted && (proEvents.length || proStarted)) {
    let level = proEvents.length >= 2 || returnVisitor ? 3 : 2;
    if (proStarted) level = 4;
    mk('PRO_SELLER_INTENT', level, proEvents.length + (proStarted ? 1 : 0),
      (proStarted ? 'professional application started; ' : '') + proEvents.length + ' professional-seller view(s)');
    if (proStarted) mk('PRO_SIGNUP_ABANDONMENT', 4, 1, 'professional application started but not completed');
  }

  // ── BUYER activity ──
  const buyerViews = list.filter((e) => BUYER_INTENTS.has(e.page_intent));
  const buyerActions = list.filter((e) => CONV.buyer_action.has(e.event_type));
  if (buyerViews.length || buyerActions.length) {
    let level = 1;
    if (buyerViews.length >= 3 || returnVisitor) level = 2;
    if (buyerActions.length) level = 3;
    if (has(CONV.bid)) level = 4;
    mk('BUYER_ACTIVE', level, buyerViews.length + buyerActions.length,
      buyerViews.length + ' browse view(s)' + (buyerActions.length ? ', ' + buyerActions.length + ' action(s)' : ''));
    // Narrower interest signals
    const auctionViews = list.filter((e) => e.page_intent === 'auction_interest' || e.page_intent === 'event_interest').length;
    const estateViews = list.filter((e) => e.page_intent === 'estate_sale_interest').length;
    if (auctionViews) mk('AUCTION_INTEREST', auctionViews >= 3 ? 3 : (auctionViews >= 2 ? 2 : 1), auctionViews, auctionViews + ' auction view(s)');
    if (estateViews) mk('ESTATE_SALE_INTEREST', estateViews >= 3 ? 3 : (estateViews >= 2 ? 2 : 1), estateViews, estateViews + ' estate-sale view(s)');
  }

  // ── CATEGORY interest (OBSERVED only) ──
  const catCounts = {};
  list.forEach((e) => { const k = e.category_key; if (k && VALID_KEYS.has(k)) catCounts[k] = (catCounts[k] || 0) + 1; });
  const observed = Object.keys(catCounts).filter((k) => catCounts[k] >= 3);   // >=3 views = observed interest
  if (observed.length) {
    const obj = {}; observed.forEach((k) => { obj[k] = catCounts[k]; });
    const total = observed.reduce((s, k) => s + catCounts[k], 0);
    mk('CATEGORY_INTEREST', total >= 8 ? 3 : 2, total,
      'observed interest: ' + observed.map((k) => k + '×' + catCounts[k]).join(', '), { observed_categories: obj });
  }

  // ── BUYER SHOWING SELLER INTENT (composite; requires REAL seller-intent evidence) ──
  const buyerActive = buyerActions.length > 0 || buyerViews.length >= 3;
  if (buyerActive && sellerEvents.length > 0 && !sellerCompleted) {
    mk('BUYER_SHOWING_SELLER_INTENT', sellerHigh ? 3 : 2, sellerEvents.length,
      'active buyer also viewing seller pages (' + sellerEvents.length + ')');
  }

  // ── RECENT vs DORMANT buyer (recency of the last buyer action) ──
  if (buyerActions.length) {
    const lastAction = buyerActions[buyerActions.length - 1].received_at;
    const age = daysBetween(now, lastAction);
    if (age <= 14) mk('RECENT_BUYER', 2, buyerActions.length, 'buyer action within 14 days');
    else if (age >= 60) mk('DORMANT_BUYER', 2, buyerActions.length, 'no buyer action for 60+ days');
  }

  return out;
}

// Read a scope's recent events (visitor scope; includes events for linked visitors when scope is a user).
async function eventsForScope(scopeType, scopeId, runner, retentionDays) {
  const r = runner || db;
  const days = retentionDays || 180;
  if (scopeType === 'visitor') {
    const { rows } = await r.query(
      `SELECT event_type, page_intent, category_key, received_at FROM analytics_events
        WHERE visitor_id = $1 AND received_at > now() - ($2 || ' days')::interval
        ORDER BY received_at ASC LIMIT 2000`, [scopeId, String(days)]);
    return rows;
  }
  if (scopeType === 'user') {
    const { rows } = await r.query(
      `SELECT ae.event_type, ae.page_intent, ae.category_key, ae.received_at FROM analytics_events ae
        WHERE ae.visitor_id IN (SELECT visitor_id FROM behavioral_identity_links WHERE user_id = $1)
          AND ae.received_at > now() - ($2 || ' days')::interval
        ORDER BY ae.received_at ASC LIMIT 4000`, [scopeId, String(days)]);
    return rows;
  }
  return [];
}

async function deriveAndStore(scopeType, scopeId, runner, opts = {}) {
  const r = runner || db;
  const events = await eventsForScope(scopeType, scopeId, r, opts.retentionDays);
  const signals = deriveSignals(events, { ttlDays: opts.ttlDays });
  const activeTypes = new Set(signals.map((s) => s.signal_type));
  // Upsert current signals.
  for (const s of signals) {
    await r.query(
      `INSERT INTO marketing_signals
         (scope_type, scope_id, signal_type, level, evidence_count, first_observed_at, last_observed_at,
          expires_at, derived_by_version, active, reason, observed_categories)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11::jsonb)
       ON CONFLICT (scope_type, scope_id, signal_type) DO UPDATE SET
         level = EXCLUDED.level, evidence_count = EXCLUDED.evidence_count,
         last_observed_at = EXCLUDED.last_observed_at, expires_at = EXCLUDED.expires_at,
         active = true, reason = EXCLUDED.reason, observed_categories = EXCLUDED.observed_categories,
         derived_by_version = EXCLUDED.derived_by_version, updated_at = now()`,
      [scopeType, scopeId, s.signal_type, s.level, s.evidence_count, s.first_observed_at, s.last_observed_at,
        s.expires_at, VERSION, s.reason, s.observed_categories ? JSON.stringify(s.observed_categories) : null]);
  }
  // Deactivate previously-active signals that no longer derive (conversion exit / decay).
  await r.query(
    `UPDATE marketing_signals SET active = false, reason = COALESCE(reason,'') , updated_at = now()
      WHERE scope_type = $1 AND scope_id = $2 AND active = true
        AND NOT (signal_type = ANY($3::text[]))`,
    [scopeType, scopeId, Array.from(activeTypes)]);
  return signals;
}

// Derive for recent distinct visitors (bounded). Powers admin refresh + controlled tests.
async function refreshRecent({ sinceHours = 168, limit = 500 } = {}, runner) {
  const r = runner || db;
  const { rows } = await r.query(
    `SELECT DISTINCT visitor_id FROM analytics_events
      WHERE visitor_id IS NOT NULL AND received_at > now() - ($1 || ' hours')::interval
      LIMIT $2`, [String(sinceHours), limit]);
  let n = 0;
  for (const row of rows) { await deriveAndStore('visitor', row.visitor_id, r); n++; }
  return { refreshed: n };
}

module.exports = { deriveSignals, deriveAndStore, refreshRecent, eventsForScope, VERSION };
