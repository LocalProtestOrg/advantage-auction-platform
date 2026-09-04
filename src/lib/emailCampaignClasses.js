'use strict';

/**
 * emailCampaignClasses — the authoritative per-class rulebook for every email Advantage.Bid sends.
 * Pure data + helpers (no I/O). Transactional and marketing classes are NOT treated identically:
 * transactional never inherits marketing opt-out; marketing NEVER bypasses marketing suppression.
 *
 * Fields per class:
 *   permissionRequired      does sending require an affirmative marketing permission basis?
 *   suppressionScope        which suppression applies ('none' | 'marketing')
 *   honorsMarketingUnsub    does a marketing unsubscribe stop this class?
 *   geographyAllowed        may geography narrow the audience?
 *   frequencyCapped         subject to marketing frequency caps?
 *   mailStream              'transactional' | 'marketing' (selects sender pool + config set)
 *   a7Eligible              may A7 autonomously send this class (still gated by a7_send_enabled)?
 *   unsubscribeScope        what an unsubscribe from this class means
 */
const CLASSES = {
  TRANSACTIONAL: {
    permissionRequired: false, suppressionScope: 'none', honorsMarketingUnsub: false,
    geographyAllowed: false, frequencyCapped: false, mailStream: 'transactional', a7Eligible: false,
    unsubscribeScope: 'none', note: 'Operational/account/bidding/payment mail. Never blocked by marketing opt-out.',
  },
  FOLLOW_SELLER: {
    permissionRequired: false, suppressionScope: 'marketing', honorsMarketingUnsub: false,
    geographyAllowed: false, frequencyCapped: false, mailStream: 'marketing', a7Eligible: false,
    unsubscribeScope: 'follower', note: 'Buyer explicitly follows a seller; own unsubscribe (seller_followers / follower_emails_enabled).',
  },
  LOCAL_EVENT_ALERT: {
    permissionRequired: true, suppressionScope: 'marketing', honorsMarketingUnsub: true,
    geographyAllowed: true, frequencyCapped: true, mailStream: 'marketing', a7Eligible: true,
    unsubscribeScope: 'marketing', note: 'First-party subscribers told about eligible nearby auctions/estate sales.',
  },
  NEWSLETTER: {
    permissionRequired: true, suppressionScope: 'marketing', honorsMarketingUnsub: true,
    geographyAllowed: true, frequencyCapped: true, mailStream: 'marketing', a7Eligible: true,
    unsubscribeScope: 'marketing', note: 'Broader Advantage.Bid updates to eligible first-party subscribers.',
  },
  PREMIUM_PACKAGE_CAMPAIGN: {
    permissionRequired: true, suppressionScope: 'marketing', honorsMarketingUnsub: true,
    geographyAllowed: true, frequencyCapped: true, mailStream: 'marketing', a7Eligible: false,
    unsubscribeScope: 'marketing', note: 'Dedicated Advantage.Bid email campaign to ELIGIBLE subscribers (no count guarantee).',
  },
  MARKETING_EXPERIMENT: {
    permissionRequired: true, suppressionScope: 'marketing', honorsMarketingUnsub: true,
    geographyAllowed: true, frequencyCapped: true, mailStream: 'marketing', a7Eligible: true,
    unsubscribeScope: 'marketing', note: 'Growth Lab experiment variants; same safety gates as any marketing class.',
  },
};

function get(name) { return CLASSES[name] || null; }
function isMarketing(name) { const c = get(name); return !!c && c.mailStream === 'marketing'; }
function isTransactional(name) { const c = get(name); return !!c && c.mailStream === 'transactional'; }

module.exports = { CLASSES, get, isMarketing, isTransactional, NAMES: Object.keys(CLASSES) };
