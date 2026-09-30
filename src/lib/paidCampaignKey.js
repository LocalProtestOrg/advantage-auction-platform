'use strict';

/**
 * paidCampaignKey — the ONE canonical campaign identity used to join paid cost ↔ first-party outcomes ↔ the
 * paid budget ledger ↔ marketing_paid_campaigns.
 *
 * The canonical key is the bare campaign_key (e.g. "2026-10-individual-seller-houston"), exactly as stored in
 * marketing_paid_campaigns and marketing_paid_budget_ledger. Historic rows carry other spellings of the same
 * campaign, and they must still join:
 *   cost facts  "facebook:adv_—_2026-10-individual-seller-houston"  (utm_source + provider campaign name "ADV — <key>")
 *   touches     "meta:2026-10-individual-seller-houston"            (utm_source + utm_campaign)
 *   names       "ADV — 2026-10-individual-seller-houston"           (provider campaign name)
 * normalizeCampaignKey() maps every one of them to the bare key. Pure; safe on null.
 */

// A leading "<utm_source>:" is a source label, not part of the campaign identity.
const SOURCE_PREFIX = /^(?:facebook|meta|meta_ads|fb|instagram|ig|google|google_ads|gads|adwords|bing|microsoft|tiktok|linkedin)\s*:\s*/;
// Our provider-side names start "ADV — " (legacy, em dash) or "ADV - " / "ADV | "; after lower-casing and
// whitespace folding that is "adv_—_", "adv_-_", "adv_|_" …
const ADV_PREFIX = /^adv(?:[\s_\-—–|:]+)(?=\S)/;

function normalizeCampaignKey(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(SOURCE_PREFIX, '');
  s = s.replace(/\s+/g, '_');
  s = s.replace(ADV_PREFIX, '');
  s = s.replace(/[—–]/g, '-')           // em / en dash → hyphen (never keep a dash character we don't type)
    .replace(/_*-_*/g, '-')                        // "a_-_b" → "a-b"
    .replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  return s ? s.slice(0, 160) : null;
}

/** Provider-side display name for a campaign/ad set/ad we create. Plain ASCII separators; never an em dash. */
function providerName(...parts) {
  return ['ADV', ...parts.filter((p) => p != null && String(p).trim() !== '').map((p) => String(p).replace(/[—–]/g, '-').trim())].join(' | ');
}

module.exports = { normalizeCampaignKey, providerName };
