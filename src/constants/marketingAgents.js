'use strict';

/**
 * marketingAgents — the A1–A15 Marketing Agency roster + authority (pure; mirrors the 129/154 seed).
 * Authority is checked here so an agent can never act outside its capabilities (e.g. a creator cannot
 * publish or spend; QA cannot author what it reviews; only A1/A8 may spend within authority).
 */

const AGENTS = Object.freeze({
  A1:  { code: 'A1',  key: 'a1_director',   name: 'Marketing Director',         tier: 'director', capabilities: ['plan', 'allocate', 'growth_spend', 'escalate', 'propose_experiment', 'decide_experiment'], canPublish: false, canSpend: true,  canReview: false },
  A2:  { code: 'A2',  key: 'a2_qa',         name: 'Independent Marketing QA',   tier: 'qa',       capabilities: ['review', 'approve_release', 'reject_release', 'mechanical_correct'], canPublish: false, canSpend: false, canReview: true },
  A3:  { code: 'A3',  key: 'a3_creative',   name: 'Creative',                   tier: 'creator',  capabilities: ['draft_creative'], canPublish: false, canSpend: false, canReview: false },
  A4:  { code: 'A4',  key: 'a4_copy',       name: 'Copy',                       tier: 'creator',  capabilities: ['draft_copy'], canPublish: false, canSpend: false, canReview: false },
  A5:  { code: 'A5',  key: 'a5_video',      name: 'Video',                      tier: 'creator',  capabilities: ['draft_video'], canPublish: false, canSpend: false, canReview: false },
  A6:  { code: 'A6',  key: 'a6_social',     name: 'Social',                     tier: 'creator',  capabilities: ['draft_social'], canPublish: false, canSpend: false, canReview: false },
  A7:  { code: 'A7',  key: 'a7_email',      name: 'Email',                      tier: 'creator',  capabilities: ['draft_email'], canPublish: false, canSpend: false, canReview: false },
  A8:  { code: 'A8',  key: 'a8_paid',       name: 'Paid Media',                 tier: 'growth',   capabilities: ['propose_paid', 'reserve_budget', 'propose_experiment'], canPublish: false, canSpend: true, canReview: false },
  A9:  { code: 'A9',  key: 'a9_seo',        name: 'SEO / Content',              tier: 'creator',  capabilities: ['draft_content', 'build_evidence', 'propose_experiment'], canPublish: false, canSpend: false, canReview: false },
  A10: { code: 'A10', key: 'a10_buyer',     name: 'Buyer Growth',               tier: 'growth',   capabilities: ['propose_experiment', 'propose_audience'], canPublish: false, canSpend: false, canReview: false },
  A11: { code: 'A11', key: 'a11_indiv',     name: 'Individual Seller Growth',   tier: 'growth',   capabilities: ['propose_experiment', 'propose_audience'], canPublish: false, canSpend: false, canReview: false },
  A12: { code: 'A12', key: 'a12_pro',       name: 'Professional Seller Growth', tier: 'growth',   capabilities: ['propose_experiment', 'propose_audience'], canPublish: false, canSpend: false, canReview: false },
  A13: { code: 'A13', key: 'a13_prospect',  name: 'Prospecting',                tier: 'growth',   capabilities: ['propose_outreach'], canPublish: false, canSpend: false, canReview: false },
  A14: { code: 'A14', key: 'a14_analytics', name: 'Analytics',                  tier: 'ops',      capabilities: ['read_metrics', 'evaluate_experiment'], canPublish: false, canSpend: false, canReview: false },
  // A15 Event Partner Outreach (Phase 1: identity + capability definition ONLY). It may draft and
  // propose, and read partner metrics. It has NO send verb, NO publish, NO spend, NO authority to
  // authorize a source or grant a claim, and no mailbox exists for it to use. Phase 2 will design the
  // agent-managed inbound/outbound channel; until then this agent cannot reach a company at all.
  A15: { code: 'A15', key: 'a15_event_partner', name: 'Event Partner Outreach', tier: 'growth',   capabilities: ['draft_partner_outreach', 'propose_partner_outreach', 'read_partner_metrics', 'classify_inbound_reply', 'record_reply_thread', 'draft_partner_reply'], canPublish: false, canSpend: false, canReview: false },
});

// Capabilities NO agent may hold in Phase 1, asserted here so a future edit that grants one to A15
// (or anyone) fails the roster test rather than silently shipping an agent that can contact a company.
const FORBIDDEN_PHASE1_CAPABILITIES = Object.freeze([
  'send_email', 'send_partner_outreach', 'authorize_source', 'grant_claim', 'publish_partner',
  // Phase 2A additions. A15 gained read-only classification, threading and drafting; it must still be
  // unable to reach a company, to widen permission, or to touch anything outside its own programme.
  'send_approved_outreach', 'send_templated_reply', 'grant_authorization', 'broaden_authorization',
  'change_authorized_domain', 'activate_collection_source', 'grant_listing_ownership',
  'answer_customer_service', 'answer_seller_inquiry',
]);

function get(code) { return AGENTS[String(code || '').toUpperCase()] || null; }
function agentCan(code, capability) { const a = get(code); return !!(a && a.capabilities.indexOf(capability) !== -1); }
function canPublish(code) { const a = get(code); return !!(a && a.canPublish); }
function canSpend(code) { const a = get(code); return !!(a && a.canSpend); }
function canReview(code) { const a = get(code); return !!(a && a.canReview); }

module.exports = { AGENTS, get, agentCan, canPublish, canSpend, canReview, FORBIDDEN_PHASE1_CAPABILITIES };
