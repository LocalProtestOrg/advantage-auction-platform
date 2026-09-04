'use strict';

/**
 * marketingAgents — the A1–A14 Marketing Agency roster + authority (pure; mirrors migration 129 seed).
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
});

function get(code) { return AGENTS[String(code || '').toUpperCase()] || null; }
function agentCan(code, capability) { const a = get(code); return !!(a && a.capabilities.indexOf(capability) !== -1); }
function canPublish(code) { const a = get(code); return !!(a && a.canPublish); }
function canSpend(code) { const a = get(code); return !!(a && a.canSpend); }
function canReview(code) { const a = get(code); return !!(a && a.canReview); }

module.exports = { AGENTS, get, agentCan, canPublish, canSpend, canReview };
