'use strict';

/**
 * socialDestinationService — the multi-market social account registry + deterministic geographic resolver.
 *
 * Campaign logic NEVER hard-codes a Page identity. Given an event's geography, resolveDestination() picks the
 * active + ready STATE destination for that platform, else falls back to the active + ready NATIONAL
 * destination, else returns none (caller BLOCKS / routes to resilience — never guesses). Adding a future state
 * Page is a single admin row (same shared token) — no new code, no new env var per state.
 *
 * Secrets are never stored or returned: a destination references the NAME of the env var holding its token
 * (credential_ref); the token itself is read only at publish time and never logged or exposed to Admin.
 */

const db = require('../db');

const SELECT_COLS = `id, platform, scope, state_code, market_key, label, provider, provider_account_id,
  linked_facebook_page_id, credential_ref, priority, active, readiness_status, readiness_detail, updated_at`;

function norm(state) { return state ? String(state).trim().toUpperCase().slice(0, 2) : null; }

async function list(runner) {
  const r = runner || db;
  return (await r.query(`SELECT ${SELECT_COLS} FROM marketing_social_destinations ORDER BY platform, scope, priority, label`)).rows;
}
async function getById(id, runner) {
  const r = runner || db;
  return (await r.query(`SELECT ${SELECT_COLS} FROM marketing_social_destinations WHERE id=$1`, [id])).rows[0] || null;
}

/**
 * Deterministic geographic resolution for ONE platform. Returns { destination, reason } where reason is
 * 'state_override' | 'national_fallback' | 'none'. Only ACTIVE + 'ready' destinations are eligible; a
 * broken/not-configured state Page is skipped so it never disables the national fallback.
 */
async function resolveDestination({ platform, stateCode }, runner) {
  const r = runner || db;
  const st = norm(stateCode);
  if (st) {
    const state = (await r.query(
      `SELECT ${SELECT_COLS} FROM marketing_social_destinations
        WHERE platform=$1 AND scope='state' AND state_code=$2 AND active=true AND readiness_status='ready'
        ORDER BY priority ASC LIMIT 1`, [platform, st])).rows[0];
    if (state) return { destination: state, reason: 'state_override' };
  }
  const national = (await r.query(
    `SELECT ${SELECT_COLS} FROM marketing_social_destinations
      WHERE platform=$1 AND scope='national' AND active=true AND readiness_status='ready'
      ORDER BY priority ASC LIMIT 1`, [platform])).rows[0];
  if (national) return { destination: national, reason: 'national_fallback' };
  return { destination: null, reason: 'none' };
}

/** Admin upsert of a destination (never accepts a token — only the credential_ref env-var NAME + non-secret IDs). */
async function upsert({ id, platform, scope = 'national', stateCode = null, marketKey = null, label, providerAccountId = null,
  linkedFacebookPageId = null, credentialRef = 'META_SYSTEM_USER_TOKEN', priority = 100, active = false }, runner) {
  const r = runner || db;
  if (/token|secret|password|key/i.test(String(credentialRef)) && /^[A-Za-z0-9_]+$/.test(String(credentialRef)) === false) {
    throw new Error('credential_ref must be an ENV VAR NAME, not a value');
  }
  if (id) {
    return (await r.query(
      `UPDATE marketing_social_destinations SET platform=$2, scope=$3, state_code=$4, market_key=$5, label=$6,
              provider_account_id=$7, linked_facebook_page_id=$8, credential_ref=$9, priority=$10, active=$11, updated_at=now()
        WHERE id=$1 RETURNING ${SELECT_COLS}`,
      [id, platform, scope, norm(stateCode), marketKey, label, providerAccountId, linkedFacebookPageId, credentialRef, priority, !!active])).rows[0];
  }
  return (await r.query(
    `INSERT INTO marketing_social_destinations (platform, scope, state_code, market_key, label, provider_account_id,
       linked_facebook_page_id, credential_ref, priority, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (platform, scope, COALESCE(state_code, '')) DO UPDATE SET label=EXCLUDED.label,
       provider_account_id=EXCLUDED.provider_account_id, linked_facebook_page_id=EXCLUDED.linked_facebook_page_id,
       credential_ref=EXCLUDED.credential_ref, priority=EXCLUDED.priority, active=EXCLUDED.active, updated_at=now()
     RETURNING ${SELECT_COLS}`,
    [platform, scope, norm(stateCode), marketKey, label, providerAccountId, linkedFacebookPageId, credentialRef, priority, !!active])).rows[0];
}

async function setReadiness(id, status, detail, runner) {
  const r = runner || db;
  await r.query(`UPDATE marketing_social_destinations SET readiness_status=$2, readiness_detail=$3::jsonb, updated_at=now() WHERE id=$1`,
    [id, status, JSON.stringify(detail || {})]);
}

/**
 * Admin-safe view of a destination: NO token, and the credential is reported only as its env-var name + a
 * boolean of whether that env var is currently present in the environment (never the value).
 */
function toAdminView(dest) {
  if (!dest) return null;
  const credName = dest.credential_ref || null;
  return {
    id: dest.id, platform: dest.platform, scope: dest.scope, state_code: dest.state_code, market_key: dest.market_key,
    label: dest.label, provider: dest.provider, provider_account_id: dest.provider_account_id || null,
    linked_facebook_page_id: dest.linked_facebook_page_id || null,
    credential_env_name: credName, credential_present: credName ? !!process.env[credName] : false, // boolean only — never the token
    priority: dest.priority, active: dest.active, readiness_status: dest.readiness_status,
    readiness_detail: dest.readiness_detail || {}, updated_at: dest.updated_at,
  };
}

module.exports = { list, getById, resolveDestination, upsert, setReadiness, toAdminView, norm };
