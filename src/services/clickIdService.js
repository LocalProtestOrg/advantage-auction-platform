'use strict';

/**
 * clickIdService — provider-neutral, first-party, SERVER-SIDE capture of ad click IDs (gclid/gbraid/
 * wbraid/fbclid) on landing. Capture is prospective ONLY (missing click IDs can't be reconstructed later)
 * and does NOT authorize provider use — export/reporting is separately gated on advertising consent +
 * provider enablement (both OFF this phase). Click IDs are NEVER placed in public UI or re-appended to
 * Advantage.Bid canonical links. Dedup-safe; retention-bounded.
 */
const db = require('../db');

const TYPES = ['gclid', 'gbraid', 'wbraid', 'fbclid'];

// Capture whatever click IDs are present. `params` is a plain object (e.g. parsed query string).
// Returns the list of captured types.
async function capture({ scopeId, params = {}, consentState = null, source = null } = {}, runner) {
  const r = runner || db;
  const vid = scopeId && String(scopeId).trim();
  if (!vid) return [];
  const captured = [];
  for (const t of TYPES) {
    const val = params[t];
    if (!val || typeof val !== 'string') continue;
    const clean = val.trim().slice(0, 512);
    if (!clean) continue;
    await r.query(
      `INSERT INTO marketing_click_ids (scope_type, scope_id, click_type, click_value, source, consent_state)
       VALUES ('visitor',$1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (scope_id, click_type, click_value) DO UPDATE SET last_seen_at = now()`,
      [vid, t, clean, source ? String(source).slice(0, 120) : null, consentState ? JSON.stringify(consentState) : null]);
    captured.push(t);
  }
  return captured;
}

// Link captured click IDs to a known user on an authoritative action (login/register). Dedup-safe.
async function linkToUser(visitorId, userId, runner) {
  const r = runner || db;
  if (!visitorId || !userId) return 0;
  const res = await r.query('UPDATE marketing_click_ids SET user_id = $2 WHERE scope_id = $1 AND user_id IS NULL', [visitorId, userId]);
  return res.rowCount;
}

// Retention purge (call from a maintenance path; not a live worker in this phase).
async function purgeExpired(retentionDays = 180, runner) {
  const r = runner || db;
  const res = await r.query(`DELETE FROM marketing_click_ids WHERE last_seen_at < now() - ($1 || ' days')::interval`, [String(retentionDays)]);
  return res.rowCount;
}

module.exports = { capture, linkToUser, purgeExpired, TYPES };
