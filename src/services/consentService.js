'use strict';

/**
 * consentService — first-class, append-only consent (distinct from email marketing permission). Categories:
 * essential (always granted), analytics, personalization, advertising (defaults DENIED until explicitly
 * granted). Every change is an immutable row; current state = most recent row per (scope, category).
 * Auditable, withdrawable, no dark patterns. Wired into event write, onsite eligibility, and external
 * destination readiness. Never infers consent for historical rows.
 */
const db = require('../db');

const CATEGORIES = ['essential', 'analytics', 'personalization', 'advertising'];
const STATES = ['granted', 'denied', 'withdrawn'];
const POLICY_VERSION = 'v1';

// Record one or more category decisions (append-only). Returns the number of rows written.
async function record({ scopeType, scopeId, categories, source = 'banner', policyVersion = POLICY_VERSION, reason = null } = {}, runner) {
  const r = runner || db;
  if (scopeType !== 'visitor' && scopeType !== 'user') return 0;
  if (!scopeId || typeof scopeId !== 'string') return 0;
  const entries = Object.entries(categories || {}).filter(([cat, st]) => CATEGORIES.includes(cat) && STATES.includes(st));
  let n = 0;
  for (const [category, state] of entries) {
    // essential can never be denied (it is required for the site to function).
    const eff = category === 'essential' ? 'granted' : state;
    await r.query(
      `INSERT INTO consent_records (scope_type, scope_id, category, state, source, policy_version, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [scopeType, scopeId, category, eff, source, policyVersion, reason]);
    n++;
  }
  return n;
}

// Current consent state per category for a scope (most recent row wins). Advertising/analytics/
// personalization default to DENIED when never recorded; essential defaults granted.
async function current(scopeType, scopeId, runner) {
  const r = runner || db;
  const out = { essential: 'granted', analytics: 'denied', personalization: 'denied', advertising: 'denied' };
  if (!scopeId) return out;
  const { rows } = await r.query(
    `SELECT DISTINCT ON (category) category, state FROM consent_records
      WHERE scope_type = $1 AND scope_id = $2
      ORDER BY category, created_at DESC`, [scopeType, scopeId]);
  rows.forEach((row) => { out[row.category] = row.state; });
  return out;
}

// Booleans an onsite/external gate can read: granted (not denied/withdrawn).
function allows(state) { return state === 'granted'; }

async function withdraw(scopeType, scopeId, category, runner) {
  return record({ scopeType, scopeId, categories: { [category]: 'withdrawn' }, source: 'preferences', reason: 'user withdrawal' }, runner);
}

// A compact snapshot suitable for stamping onto an event at write time.
function snapshot(currentState) {
  return {
    analytics: allows(currentState.analytics),
    personalization: allows(currentState.personalization),
    advertising: allows(currentState.advertising),
    policy_version: POLICY_VERSION,
  };
}

module.exports = { record, current, withdraw, allows, snapshot, CATEGORIES, STATES, POLICY_VERSION };
