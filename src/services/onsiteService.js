'use strict';

/**
 * onsiteService — the controlled onsite personalization engine. Picks AT MOST ONE first-party treatment
 * per page view, or none (the page is always fully functional without it). Rules: conversion state
 * suppresses acquisition treatments; existing sellers never see seller-acquisition; a category treatment
 * requires MATCHING live inventory; no surveillance copy ("we noticed…"); no invented relevance; never on
 * checkout/payment/legal/bidding-critical flows; every treatment is logged with version/audience/reason.
 *
 * The pure core `chooseTreatment(ctx)` is unit-tested without a DB.
 */
const db = require('../db');
const { isCleanLink } = require('./marketingCtaService');

const VERSION = 'v1';
// Pages where personalization must NEVER appear.
const EXCLUDED_PATH = /(checkout|payment|billing|add-card|sign-agreement|lot\.html|bid|login|reset)/i;

// Playbooks in PRIORITY order. Each: guard(ctx) → boolean; build(ctx) → treatment. First match wins.
const PLAYBOOKS = [
  {
    key: 'abandoned_seller_resume', audience_key: 'abandoned_individual_seller_signup',
    guard: (c) => c.signals.has('SELLER_SIGNUP_ABANDONMENT') && !c.isExistingSeller,
    build: () => ({ headline: 'Pick up where you left off', body: 'Continue setting up your seller account whenever you are ready.', cta_label: 'Continue', cta_href: '/start-selling.html', reason: 'abandoned seller signup signal' }),
  },
  {
    key: 'buyer_seller_cta', audience_key: 'buyer_showing_seller_intent',
    guard: (c) => c.signals.has('BUYER_SHOWING_SELLER_INTENT') && !c.isExistingSeller,
    build: () => ({ headline: 'Thinking about selling?', body: 'Turn what you know as a buyer into a great sale with Advantage.Bid.', cta_label: 'Sell with Advantage.Bid', cta_href: '/start-selling.html', reason: 'buyer showing seller intent' }),
  },
  {
    key: 'professional_tools', audience_key: 'professional_seller_prospect',
    guard: (c) => c.signals.has('PRO_SELLER_INTENT') && !c.isExistingSeller,
    build: () => ({ headline: 'Tools for professional sellers', body: 'See how auction houses and estate-sale companies grow with Advantage.Bid.', cta_label: 'Explore professional tools', cta_href: '/professional-sellers.html', reason: 'professional seller intent' }),
  },
  {
    key: 'category_relevance', audience_key: 'category_interest_buyer',
    guard: (c) => c.signals.has('CATEGORY_INTEREST') && c.hasCategoryInventory,   // NO live inventory → no treatment
    build: (c) => ({ headline: 'More in the categories you follow', body: 'Fresh lots matching your interests are up for auction now.', cta_label: 'Browse matching lots', cta_href: '/search.html?mode=lots', reason: 'observed category interest + matching live inventory' }),
  },
  {
    key: 'estate_local_event', audience_key: 'estate_sale_browser',
    guard: (c) => c.signals.has('ESTATE_SALE_INTEREST') && c.hasEventInventory,    // NO current event → no treatment
    build: () => ({ headline: 'Estate sales near you', body: 'Upcoming estate sales in your area are listed now.', cta_label: 'See estate sales', cta_href: '/events.html', reason: 'estate-sale interest + upcoming local events' }),
  },
  {
    key: 'registered_non_bidder_edu', audience_key: null,
    guard: (c) => c.pageIntent === 'event_interest' && c.isRegisteredNonBidder,
    build: () => ({ headline: 'How bidding works', body: 'A quick guide to placing your first bid with confidence.', cta_label: 'How to bid', cta_href: '/how-to-buy.html', reason: 'registered, no bid yet' }),
  },
  {
    key: 'contextual_subscribe', audience_key: null,
    guard: (c) => c.isAnonymous && ['auction_interest', 'estate_sale_interest', 'event_interest'].includes(c.pageIntent),
    build: (c) => ({ headline: c.pageIntent === 'estate_sale_interest' ? 'Get local estate sale alerts' : 'Get alerts for auctions like this', body: 'Tell us where you are and we will keep you posted.', cta_label: 'Get alerts', cta_href: '/events.html', reason: 'engaged anonymous visitor, contextual subscribe ask' }),
  },
];

/**
 * Pure treatment chooser.
 * @param {object} ctx { pagePath, pageIntent, signals:Set<string>, isExistingSeller, hasMatchingInventory,
 *   isAnonymous, isRegisteredNonBidder }
 * @returns {object|null} treatment or null (fallback: no treatment)
 */
function chooseTreatment(ctx = {}) {
  const c = Object.assign({ signals: new Set(), pagePath: '', pageIntent: null }, ctx);
  if (!(c.signals instanceof Set)) c.signals = new Set(c.signals || []);
  if (EXCLUDED_PATH.test(c.pagePath || '')) return null;   // never on critical flows
  for (const pb of PLAYBOOKS) {
    let ok = false;
    try { ok = pb.guard(c); } catch (_) { ok = false; }
    if (!ok) continue;
    const t = pb.build(c);
    if (!isCleanLink(t.cta_href)) return null;   // never emit a dirty link
    return Object.assign({ playbook_key: pb.key, audience_key: pb.audience_key, treatment_version: VERSION }, t);
  }
  return null;   // sane fallback: no personalization
}

// Resolve a visitor's active signal types (+ linked-user existing-seller flag) and choose one treatment.
async function treatmentFor({ scopeType = 'visitor', scopeId, pagePath, pageIntent }, runner) {
  const r = runner || db;
  if (!scopeId) return null;
  const { rows: sigRows } = await r.query(
    `SELECT signal_type FROM marketing_signals WHERE scope_type = $1 AND scope_id = $2 AND active = true
       AND (expires_at IS NULL OR expires_at > now())`, [scopeType, scopeId]);
  const signals = new Set(sigRows.map((x) => x.signal_type));
  // Existing-seller check: only when the visitor is linked to a user who has a seller_profile.
  let isExistingSeller = false; let userId = null;
  const link = (await r.query('SELECT user_id FROM behavioral_identity_links WHERE visitor_id = $1 AND user_id IS NOT NULL LIMIT 1', [scopeId])).rows[0];
  if (link) { userId = link.user_id; const sp = await r.query('SELECT 1 FROM seller_profiles WHERE user_id = $1', [userId]); isExistingSeller = sp.rowCount > 0; }
  const isAnonymous = !userId;
  // LIVE inventory context (§10): a category/estate treatment only fires when real open inventory / a
  // current event actually exists. No matching inventory → those playbooks are skipped (fallback).
  let hasCategoryInventory = false; let hasEventInventory = false;
  if (signals.has('CATEGORY_INTEREST')) {
    hasCategoryInventory = (await r.query(`SELECT 1 FROM lots WHERE state IN ('open','active') LIMIT 1`)).rowCount > 0;
  }
  if (signals.has('ESTATE_SALE_INTEREST')) {
    hasEventInventory = (await r.query(`SELECT 1 FROM events WHERE status='published' AND (end_at IS NULL OR end_at >= now()) LIMIT 1`)).rowCount > 0;
  }
  const treatment = chooseTreatment({ pagePath, pageIntent, signals, isExistingSeller, hasCategoryInventory, hasEventInventory, isAnonymous });
  if (treatment) {
    await r.query(
      `INSERT INTO marketing_onsite_treatments (playbook_key, scope_type, scope_id, page_path, audience_key, treatment_version, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [treatment.playbook_key, scopeType, scopeId, pagePath, treatment.audience_key, treatment.treatment_version, treatment.reason]).catch(() => {});
  }
  return treatment;
}

module.exports = { chooseTreatment, treatmentFor, PLAYBOOKS, VERSION, EXCLUDED_PATH };
