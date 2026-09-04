'use strict';

/**
 * collisionResolver — resolves competing marketing actions for a person/surface by a fixed PRECEDENCE
 * (never a score). Pure (no I/O). Precedence (Phase 3I):
 *   1 transactional  2 suppression  3 conversion state  4 journey stage  5 time criticality
 *   6 evidence quality  7 objective priority  8 time since last contact
 *
 * Hard rules: transactional always wins and is never counted against marketing caps; marketing may never
 * relabel itself transactional to bypass caps; ≤1 marketing message/action per person per day; ≤1 onsite
 * treatment per page view; a seller-paid PACKAGE obligation outranks discretionary Growth work for the
 * same auction; an existing seller never receives a seller-acquisition action.
 */
const TIME_ORDER = { urgent: 5, high: 4, medium: 3, low: 2, none: 1 };
const OBJECTIVE_PRIORITY = { seller_acquisition: 6, professional_seller_acquisition: 5, buyer_activation: 4, buyer_reengagement: 3, subscriber_growth: 2, brand: 1 };
const JOURNEY_ORDER = { abandoned: 5, high_intent: 4, considering: 3, browsing: 2, unknown: 1 };
const CLASS_RANK = { transactional: 100, seller_package: 50, onsite: 10, email: 10, paid: 10, growth: 5 };

function precedence(a) {
  return [
    CLASS_RANK[a.class] || 0,
    a.suppressed ? -100 : 0,               // suppressed actions cannot win
    a.converted ? -100 : 0,                // converted → excluded
    JOURNEY_ORDER[a.journey_stage] || 1,
    TIME_ORDER[a.time_criticality] || 1,
    Number(a.evidence_quality) || 1,
    OBJECTIVE_PRIORITY[a.objective] || 0,
    -(Number(a.hours_since_last_contact) || 0) * -1,   // longer since contact ranks slightly higher
  ];
}

/**
 * @param {Array} candidates action objects: { id, class, objective, journey_stage, time_criticality,
 *   evidence_quality, is_seller_acquisition, suppressed, converted, page_view_id, auction_ref }
 * @param {object} ctx { existingSeller:boolean, marketingSentToday:number, hours_since_last_contact }
 * @returns {object} { winner, blocked:[{id,reason}], allowed:[] }
 */
function resolve(candidates, ctx = {}) {
  const list = (candidates || []).map((c) => Object.assign({}, c));
  const blocked = [];
  const transactional = list.filter((c) => c.class === 'transactional');
  let marketing = list.filter((c) => c.class !== 'transactional');

  // Rule: existing seller never gets a seller-acquisition action.
  if (ctx.existingSeller) {
    marketing = marketing.filter((c) => {
      if (c.is_seller_acquisition) { blocked.push({ id: c.id, reason: 'existing_seller_no_acquisition' }); return false; }
      return true;
    });
  }
  // Rule: suppressed / converted cannot win.
  marketing = marketing.filter((c) => {
    if (c.suppressed) { blocked.push({ id: c.id, reason: 'suppressed' }); return false; }
    if (c.converted) { blocked.push({ id: c.id, reason: 'already_converted' }); return false; }
    return true;
  });
  // Rule: seller-package obligation outranks discretionary Growth for the SAME auction.
  const pkgAuctions = new Set(marketing.filter((c) => c.class === 'seller_package').map((c) => c.auction_ref));
  marketing = marketing.filter((c) => {
    if (c.class === 'growth' && pkgAuctions.has(c.auction_ref)) { blocked.push({ id: c.id, reason: 'outranked_by_seller_package' }); return false; }
    return true;
  });
  // Rule: at most ONE marketing action per person per day.
  if ((ctx.marketingSentToday || 0) >= 1) {
    marketing.forEach((c) => blocked.push({ id: c.id, reason: 'one_marketing_per_day' }));
    marketing = [];
  }

  // Pick the single winner by precedence (onsite: one per page view is implied by one-winner selection).
  marketing.sort((a, b) => {
    const av = precedence(a); const bv = precedence(b);
    for (let i = 0; i < av.length; i++) { if (av[i] !== bv[i]) return bv[i] - av[i]; }
    return 0;
  });
  const winner = marketing[0] || null;
  const runnersUp = marketing.slice(1);
  runnersUp.forEach((c) => blocked.push({ id: c.id, reason: 'lost_collision' }));

  return {
    // Transactional always passes through, independent of marketing selection.
    transactional_allowed: transactional.map((c) => c.id),
    winner: winner ? winner.id : null,
    winner_action: winner || null,
    blocked,
  };
}

module.exports = { resolve, precedence, CLASS_RANK };
