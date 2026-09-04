'use strict';

/**
 * behavioralAudiences — the compact, config-driven library of retargeting audience DEFINITIONS. Pure data
 * (no I/O), so audiences can be added/tuned without a migration. Membership state lives in
 * marketing_audience_members; eligibility for a specific channel (esp. email) is ALWAYS re-checked by the
 * authoritative services (audienceEligibilityService) — a behavioral audience never overrides permission
 * or suppression.
 *
 * Each definition:
 *   audience_key            stable id
 *   family                  seller | professional | buyer | interest | local
 *   purpose                 human sentence
 *   qualifying              [{ signal, minLevel }] — ALL must be active (post-decay, post-conversion-exit)
 *   exclude_signals         signals whose presence disqualifies (defense-in-depth; converted intents also
 *                           auto-deactivate in the signal engine)
 *   conversion_exit         plain description of what removes a member (for admin display / audit)
 *   recency_window_days     membership expiry when no longer re-qualified
 *   geography               'none' | 'aware'   (reuses Phase 4D geo; email geo independent of paid 30mi)
 *   category                'none' | 'observed'
 *   allowed_channels        channel classes this audience may be used for (still gated per provider)
 *   success_outcome         the marketplace outcome that defines success
 *   version, active
 */
const VERSION = 'v1';

const AUDIENCES = {
  high_intent_individual_seller: {
    family: 'seller', purpose: 'Individuals showing strong intent to sell (repeat/deep seller-page behavior).',
    qualifying: [{ signal: 'SELLER_INTENT', minLevel: 3 }], exclude_signals: [],
    conversion_exit: 'Removed when they complete seller signup / submit an auction (SELLER_INTENT deactivates).',
    recency_window_days: 45, geography: 'none', category: 'none',
    allowed_channels: ['a7_email', 'google_ads', 'meta', 'onsite'], success_outcome: 'seller_signup_completed',
  },
  seller_information_explorer: {
    family: 'seller', purpose: 'Early-stage sellers reading seller info (weaker intent).',
    qualifying: [{ signal: 'SELLER_INTENT', minLevel: 1 }], exclude_signals: [],
    conversion_exit: 'Removed on seller signup completion.', recency_window_days: 45,
    geography: 'none', category: 'none', allowed_channels: ['a7_email', 'onsite'], success_outcome: 'seller_signup_started',
  },
  abandoned_individual_seller_signup: {
    family: 'seller', purpose: 'Started an individual seller signup but did not finish.',
    qualifying: [{ signal: 'SELLER_SIGNUP_ABANDONMENT', minLevel: 1 }], exclude_signals: [],
    conversion_exit: 'Removed IMMEDIATELY on signup completion.', recency_window_days: 21,
    geography: 'none', category: 'none', allowed_channels: ['a7_email', 'onsite'], success_outcome: 'seller_signup_completed',
  },
  buyer_showing_seller_intent: {
    family: 'seller', purpose: 'Active buyers who ALSO show real seller-intent evidence (Full-Circle).',
    qualifying: [{ signal: 'BUYER_SHOWING_SELLER_INTENT', minLevel: 2 }], exclude_signals: [],
    conversion_exit: 'Removed on seller signup completion.', recency_window_days: 45,
    geography: 'none', category: 'none', allowed_channels: ['a7_email', 'google_ads', 'meta', 'onsite'], success_outcome: 'seller_signup_started',
  },
  professional_seller_prospect: {
    family: 'professional', purpose: 'Prospective professional sellers viewing pro pages.',
    qualifying: [{ signal: 'PRO_SELLER_INTENT', minLevel: 2 }], exclude_signals: [],
    conversion_exit: 'Removed when they become a verified Pro / complete application.', recency_window_days: 60,
    geography: 'none', category: 'none', allowed_channels: ['a7_email', 'google_ads', 'meta', 'onsite'], success_outcome: 'professional_application_completed',
  },
  professional_signup_abandonment: {
    family: 'professional', purpose: 'Started a professional application but did not finish.',
    qualifying: [{ signal: 'PRO_SIGNUP_ABANDONMENT', minLevel: 1 }], exclude_signals: [],
    conversion_exit: 'Removed immediately on application completion.', recency_window_days: 30,
    geography: 'none', category: 'none', allowed_channels: ['a7_email', 'onsite'], success_outcome: 'professional_application_completed',
  },
  auction_browser: {
    family: 'buyer', purpose: 'Buyers browsing auctions.',
    qualifying: [{ signal: 'AUCTION_INTEREST', minLevel: 1 }], exclude_signals: [],
    conversion_exit: 'Transitions out on bid/purchase behavior (BUYER signals shift).', recency_window_days: 30,
    geography: 'aware', category: 'none', allowed_channels: ['a7_email', 'google_ads', 'meta', 'onsite'], success_outcome: 'bid_placed',
  },
  estate_sale_browser: {
    family: 'buyer', purpose: 'Buyers browsing estate sales.',
    qualifying: [{ signal: 'ESTATE_SALE_INTEREST', minLevel: 1 }], exclude_signals: [],
    conversion_exit: 'Transitions out on purchase behavior.', recency_window_days: 30,
    geography: 'aware', category: 'none', allowed_channels: ['a7_email', 'google_ads', 'meta', 'onsite'], success_outcome: 'purchase_completed',
  },
  category_interest_buyer: {
    family: 'interest', purpose: 'Buyers with OBSERVED category interest (controlled taxonomy; never inferred traits).',
    qualifying: [{ signal: 'CATEGORY_INTEREST', minLevel: 2 }], exclude_signals: [],
    conversion_exit: 'Transitions out on purchase in-category.', recency_window_days: 45,
    geography: 'aware', category: 'observed', allowed_channels: ['a7_email', 'google_ads', 'meta', 'onsite'], success_outcome: 'bid_placed',
  },
  recent_buyer: {
    family: 'buyer', purpose: 'Recently active buyers (repeat-engagement opportunity).',
    qualifying: [{ signal: 'RECENT_BUYER', minLevel: 1 }], exclude_signals: [],
    conversion_exit: 'Ages out of "recent" by decay.', recency_window_days: 21,
    geography: 'aware', category: 'none', allowed_channels: ['a7_email', 'onsite'], success_outcome: 'purchase_completed',
  },
  // ── Platform-FACT audiences (Phase 4H): computed from authoritative platform state, NOT page events ──
  registered_non_bidder: {
    family: 'buyer', platform_fact: true, purpose: 'Registered users who have never placed a qualifying bid.',
    qualifying: [{ signal: 'PLATFORM_FACT', minLevel: 1 }], exclude_signals: [],
    conversion_exit: 'Removed on first bid.', recency_window_days: 60,
    geography: 'none', category: 'none', allowed_channels: ['a7_email', 'onsite'], success_outcome: 'bid_placed',
  },
  watcher_no_bid: {
    family: 'buyer', platform_fact: true, purpose: 'Users watching a lot/auction they have not bid on (still actionable).',
    qualifying: [{ signal: 'PLATFORM_FACT', minLevel: 1 }], exclude_signals: [],
    conversion_exit: 'Removed on bid, or when the watched item closes/withdraws.', recency_window_days: 30,
    geography: 'none', category: 'none', allowed_channels: ['onsite'], success_outcome: 'bid_placed',
  },
  local_event_interest: {
    family: 'local', platform_fact: true, purpose: 'Permissioned subscribers within range of an upcoming event.',
    qualifying: [{ signal: 'PLATFORM_FACT', minLevel: 1 }], exclude_signals: [],
    conversion_exit: 'Expires with the event window.', recency_window_days: 21,
    geography: 'aware', category: 'none', allowed_channels: ['a7_email', 'onsite'], success_outcome: 'purchase_completed',
  },
  dormant_buyer: {
    family: 'buyer', purpose: 'Previously active buyers who have gone quiet (win-back).',
    qualifying: [{ signal: 'DORMANT_BUYER', minLevel: 1 }], exclude_signals: ['RECENT_BUYER'],
    conversion_exit: 'Removed when they become active again (RECENT_BUYER present).', recency_window_days: 90,
    geography: 'aware', category: 'none', allowed_channels: ['a7_email', 'google_ads', 'meta', 'onsite'], success_outcome: 'purchase_completed',
  },
};

function get(key) { return AUDIENCES[key] || null; }
function all() { return Object.keys(AUDIENCES).map((k) => Object.assign({ audience_key: k, version: VERSION, active: true }, AUDIENCES[k])); }

module.exports = { AUDIENCES, get, all, VERSION, KEYS: Object.keys(AUDIENCES) };
