'use strict';

/**
 * audienceDestinations — the provider-NEUTRAL destination contract. The behavioral audience engine is the
 * authoritative source of truth; providers are DESTINATIONS. This module declares the abstract adapter
 * contract + per-provider readiness models. NOTHING here connects a provider, holds credentials, or
 * fabricates an audience id. Every external destination is OFF until the Owner connects it.
 *
 * Provider sync STATE is tracked separately (marketing_audience_destinations); membership is never coupled
 * to a provider's sync status.
 */

// The abstract adapter shape every future destination must implement (documented, not invoked here).
const ADAPTER_CONTRACT = {
  methods: ['describe', 'validateConsent', 'buildExport', 'sync', 'status'],
  note: 'sync() is never called in this phase. buildExport() emits a provider-neutral spec; a real adapter '
      + 'maps it to the provider API only after the Owner connects credentials + consent is satisfied.',
};

// Readiness requirement lists — what the Owner must provide before a destination can be enabled.
const DESTINATIONS = {
  a7_email: {
    label: 'Advantage.Bid Email (A7)', kind: 'first_party',
    consent_required: 'marketing permission (permission_basis) + suppression + deliverability (Phase 4C/4E)',
    readiness: ['A7 readiness gate READY', 'marketing.a7_send_enabled = true (Owner)'],
    enabled_config_key: 'marketing.a7_send_enabled',
  },
  google_ads: {
    label: 'Google Ads (Customer Match / remarketing)', kind: 'external_paid',
    consent_required: 'external ad-retargeting consent (public consent banner NOT yet built — readiness gap)',
    readiness: [
      'Google Ads account + Customer Match eligibility',
      'OAuth credentials (Owner) — NOT stored here',
      'remarketing audience mappings + conversion mappings',
      'hashed-contact export policy (SHA-256 normalized email) confirmed lawful',
      'server-side conversion (Enhanced Conversions) mapping',
      'public consent mechanism for external retargeting',
    ],
    export_shape: { user_list_ref: null, members: 'hashed_email[] (never raw)', inclusion: true, consent_flag: true },
    enabled_config_key: 'marketing.destinations.google_ads_enabled',
  },
  meta: {
    label: 'Meta (Custom Audiences / Conversions API)', kind: 'external_paid',
    consent_required: 'external ad-retargeting consent (public consent banner NOT yet built — readiness gap)',
    readiness: [
      'Meta Business + Custom Audience terms accepted',
      'Pixel id + Conversions API token (Owner) — NOT stored here',
      'Pixel event mapping + CAPI server-event mapping',
      'Custom Audience mapping + hashed-contact export policy',
      'public consent mechanism for external retargeting',
    ],
    export_shape: { custom_audience_ref: null, members: 'hashed_email[] (never raw)', inclusion: true, consent_flag: true },
    enabled_config_key: 'marketing.destinations.meta_enabled',
  },
  onsite: {
    label: 'Onsite personalization (first-party)', kind: 'first_party',
    consent_required: 'first-party behavioral use (no external transfer)',
    readiness: ['onsite surface to personalize'], enabled_config_key: null,
  },
};

function get(type) { return DESTINATIONS[type] || null; }

// Build a provider-neutral export SPEC for an audience (what a real adapter would receive). Emits NO
// member data and NO provider id — it is a description used for readiness/audit only.
function buildExportSpec(audienceDef, destinationType) {
  const dest = get(destinationType);
  if (!dest) return null;
  return {
    kind: 'audience_export_spec',
    audience_key: audienceDef.audience_key,
    destination_type: destinationType,
    inclusion: true,
    exclusion_rule: audienceDef.conversion_exit,
    member_identity: dest.kind === 'external_paid' ? 'hashed_email' : 'contact_id/user_id',
    consent_required: dest.consent_required,
    enabled: false,
    note: 'No members are materialized and no provider is contacted. sync() is not called in this phase.',
  };
}

module.exports = { ADAPTER_CONTRACT, DESTINATIONS, get, buildExportSpec, TYPES: Object.keys(DESTINATIONS) };
