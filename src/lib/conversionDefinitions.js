'use strict';

/**
 * conversionDefinitions — the ONE shared definition of every Advantage.Bid conversion / behavioural event (Phase 3P.2
 * measurement readiness). First-party truth is the authority; Meta and Google are destinations that receive the SAME
 * keys (mapped here) only when the Owner activates a channel and the visitor's advertising consent allows it.
 *
 * kind: 'conversion' (a first-party outcome that may be a paid success signal) | 'behaviour' (an intent event)
 * emitter: where the first-party record is written (server-side unless noted). Existing event names are reused where
 * an equivalent already exists (page_view / auction_view / bid_placed / seller_signup_started / purchase).
 */
const DEFS = {
  // seller funnel
  seller_landing_view:      { kind: 'behaviour', funnel: 'seller', label: 'Seller landing page view', emitter: 'analytics page_view with server page_intent seller_* (behavior-tracker)', source_event: 'page_view', meta_event: 'ViewContent', google_action: null },
  seller_signup_started:    { kind: 'behaviour', funnel: 'seller', label: 'Seller signup started', emitter: 'existing seller onboarding event', source_event: 'seller_signup_started', meta_event: 'InitiateCheckout', google_action: null },
  seller_registered:        { kind: 'conversion', funnel: 'seller', label: 'Seller registered', emitter: 'POST /api/sellers/enroll', meta_event: 'CompleteRegistration', google_action: 'seller_registered', success_signal: true },
  auction_draft_created:    { kind: 'conversion', funnel: 'seller', label: 'Auction draft created', emitter: 'POST /api/auctions (seller create)', meta_event: 'StartTrial', google_action: 'auction_draft_created', success_signal: true },
  auction_published:        { kind: 'conversion', funnel: 'seller', label: 'Auction published', emitter: 'auction state → published (admin publish or verified auto-publish)', meta_event: 'SubmitApplication', google_action: 'auction_published', success_signal: true, value: 'none' },
  seller_inquiry:           { kind: 'conversion', funnel: 'seller', label: 'Professional seller inquiry', emitter: 'POST professional application / free business listing', meta_event: 'Lead', google_action: 'seller_inquiry', success_signal: true },
  assisted_service_inquiry: { kind: 'conversion', funnel: 'seller', label: 'Assisted / full-service inquiry', emitter: 'POST /api/public/assisted-service-inquiry', meta_event: 'Lead', google_action: 'assisted_service_inquiry', success_signal: true, note: 'its own outcome — higher intent than a self-service draft; pricing is never stated' },
  // buyer funnel
  buyer_landing_view:       { kind: 'behaviour', funnel: 'buyer', label: 'Buyer landing page view', emitter: 'analytics page_view with server page_intent (marketplace / auction / event pages)', source_event: 'page_view', meta_event: 'PageView', google_action: null },
  buyer_registered:         { kind: 'conversion', funnel: 'buyer', label: 'Buyer registered', emitter: 'POST /api/auth/register', meta_event: 'CompleteRegistration', google_action: 'buyer_registered', success_signal: true },
  auction_view:             { kind: 'behaviour', funnel: 'buyer', label: 'Auction view', emitter: 'existing analytics auction_view', source_event: 'auction_view', meta_event: 'ViewContent', google_action: null },
  lot_view:                 { kind: 'behaviour', funnel: 'buyer', label: 'Lot view', emitter: 'analytics page_view with page_intent lot (behavior-tracker)', source_event: 'page_view', meta_event: 'ViewContent', google_action: null },
  search:                   { kind: 'behaviour', funnel: 'buyer', label: 'Search', emitter: 'existing analytics radius_search / search page views', source_event: 'radius_search', meta_event: 'Search', google_action: null },
  watch_lot:                { kind: 'conversion', funnel: 'buyer', label: 'Lot watched (favourite)', emitter: 'POST favorites (watchlist add)', meta_event: 'AddToWishlist', google_action: 'watch_lot', success_signal: true },
  bid:                      { kind: 'conversion', funnel: 'buyer', label: 'Bid placed', emitter: 'bid service (after a bid is accepted)', source_event: 'bid_placed', meta_event: 'AddToCart', google_action: 'bid', success_signal: true },
  purchase:                 { kind: 'conversion', funnel: 'buyer', label: 'Purchase (invoice paid)', emitter: 'invoice paid (Stripe webhook)', source_event: 'purchase', meta_event: 'Purchase', google_action: 'purchase', success_signal: true, value: 'invoice total cents' },
  email_signup:             { kind: 'conversion', funnel: 'buyer', label: 'Email signup', emitter: 'POST /api/public/subscribers', meta_event: 'Subscribe', google_action: 'email_signup', success_signal: true },
};

const KEYS = Object.keys(DEFS);
const SUCCESS_SIGNALS = KEYS.filter((k) => DEFS[k].success_signal);
function get(key) { return DEFS[key] || null; }
function metaEventFor(key) { return (DEFS[key] || {}).meta_event || null; }

module.exports = { DEFS, KEYS, SUCCESS_SIGNALS, get, metaEventFor };
