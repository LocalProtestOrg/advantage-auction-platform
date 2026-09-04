'use strict';

/**
 * marketingEmailContract — the ONE approved, safe description of what the Premium email deliverable
 * promises, plus the A7 dormant-contract constants. Kept in one place so seller-facing copy and the A7
 * runtime cannot drift apart.
 *
 * SAFETY: the Premium email deliverable promises a "Dedicated Advantage.Bid email campaign to eligible
 * subscribers." It NEVER promises a list size, a recipient count, or reach to a fixed number of people
 * (e.g. no "10,000 subscribers"). Eligibility is computed at send time by audienceEligibilityService, so
 * the achievable audience is whatever is genuinely eligible — never a guaranteed number.
 */

// Seller-facing deliverable copy (no AI wording, no vendor names, no numeric reach promise).
const PREMIUM_EMAIL_DELIVERABLE = 'Dedicated Advantage.Bid email campaign to eligible subscribers';

// A7 (autonomous marketing email) contract flags — mirrors platform_config marketing.* (all OFF at 4C).
const A7_CONTRACT = {
  sendEnabledConfigKey: 'a7_send_enabled',            // marketing.a7_send_enabled (false)
  receivesAudienceSpecNotRawList: true,               // A7 gets a spec + must re-check per address at send
  eligibilityComputedAtSendTime: true,
  sourceIsNotPermission: true,                        // provenance never grants permission
  emailGeoSeparateFromPaidRadius: true,               // marketing.email.* != paid 30-mile radius
  cannotWeakenGrowthLabEligibility: true,             // underpowered email must not relax 4B rules
};

// Guard used by tests and by any copy generator: reject a phrase that promises a fixed reach/list size.
function promisesFixedReach(text) {
  if (!text) return false;
  return /\b\d[\d,]{2,}\s*(subscribers|recipients|contacts|people|inboxes|emails?)\b/i.test(String(text))
    || /\b(entire|whole|our full)\s+(list|database|mailing list)\b/i.test(String(text));
}

module.exports = { PREMIUM_EMAIL_DELIVERABLE, A7_CONTRACT, promisesFixedReach };
