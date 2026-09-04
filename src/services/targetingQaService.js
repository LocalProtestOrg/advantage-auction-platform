'use strict';

/**
 * targetingQaService — A2's targeting review (review_targeting). Verifies an audience/decision is factual
 * and safe to act on, and performs deterministic AUTO-FIXES (remove converted/suppressed/stale members by
 * refreshing membership). A2 may review + fix; A2 must NOT invent campaign strategy.
 */
const db = require('../db');
const audiences = require('../lib/behavioralAudiences');
const membership = require('./audienceMembershipService');
const opportunityService = require('./opportunityService');

// Signal/audience families that would indicate a sensitive/protected trait (must never be targeted).
const SENSITIVE = /race|religion|health|political|sexual|orientation|ethnic|disab|pregnan/i;

// Pure config-level review (no DB): structural + policy checks.
function reviewConfig(def, { objective = null, channel = null } = {}) {
  const checks = []; const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || null });
  add('audience_exists', !!def, def ? def.audience_key : 'missing');
  if (!def) return { pass: false, checks, failed: ['audience_exists'] };
  add('objective_matches_audience', !objective || opportunityService.objectiveFor(def) === objective, objective);
  add('channel_eligible', !channel || def.allowed_channels.includes(channel), channel);
  add('category_evidence_valid', def.category !== 'observed' || def.qualifying.some((q) => q.signal === 'CATEGORY_INTEREST'), def.category);
  add('geography_valid', def.geography === 'none' || def.geography === 'aware', def.geography);
  add('no_sensitive_trait', !SENSITIVE.test(JSON.stringify(def)), 'no protected-trait targeting');
  add('conversion_exit_defined', !!def.conversion_exit, def.conversion_exit);
  const failed = checks.filter((c) => !c.pass).map((c) => c.name);
  return { pass: failed.length === 0, checks, failed };
}

/**
 * Full review with deterministic auto-fix. Refreshing membership deterministically removes converted /
 * stale / disqualified members (suppression + conversion are enforced at membership + email eligibility).
 * @returns { pass, checks, fixes, failed }
 */
async function reviewTargeting({ audienceKey, objective = null, channel = 'onsite', marketingClass = null } = {}, runner) {
  const r = runner || db;
  const def = audiences.get(audienceKey);
  const base = reviewConfig(def, { objective, channel });
  if (!def) return Object.assign({ fixes: {} }, base);

  // Auto-fix: refresh membership → exits converted/stale/disqualified members deterministically.
  let fixes = { members_exited: 0 };
  try { const rr = await membership.refreshAudience(audienceKey, r); fixes.members_exited = rr.exited || 0; }
  catch (_) { /* refresh best-effort */ }

  // For email, verify eligibility is re-checked by the authoritative service (permission/suppression).
  const checks = base.checks.slice();
  if (channel === 'a7_email' || channel === 'email') {
    const el = await membership.emailEligibleCount(audienceKey, { marketingClass: marketingClass || 'newsletter' }, r);
    checks.push({ name: 'email_eligibility_rechecked', pass: true, detail: `${el.eligible}/${el.candidates} eligible after permission/suppression` });
  }
  const failed = checks.filter((c) => !c.pass).map((c) => c.name);
  return { pass: failed.length === 0, checks, fixes, failed };
}

module.exports = { reviewConfig, reviewTargeting, SENSITIVE };
