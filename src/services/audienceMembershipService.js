'use strict';

/**
 * audienceMembershipService — computes behavioral AUDIENCE membership from derived marketing_signals +
 * the behavioralAudiences definitions, and maintains the lifecycle: ENTER when qualified, EXIT when a
 * member no longer qualifies (conversion/decay/negative signal), EXPIRE past the recency window.
 *
 * Conversion suppression (§13) is automatic: when someone converts, the signal engine deactivates the
 * qualifying intent signal, so the next refresh exits them from the acquisition audience. Email use is
 * ALWAYS re-checked by audienceEligibilityService — a behavioral audience never overrides permission,
 * suppression, bounce, frequency, or scope.
 */
const db = require('../db');
const audiences = require('../lib/behavioralAudiences');
const eligibility = require('./audienceEligibilityService');

// Refresh ONE audience's membership. Returns { audience_key, qualified, entered, exited }.
async function refreshAudience(audienceKey, runner) {
  const r = runner || db;
  const def = audiences.get(audienceKey);
  if (!def) throw new Error('unknown audience: ' + audienceKey);
  const driver = def.qualifying[0];
  const extra = def.qualifying.slice(1);
  const params = [driver.signal, driver.minLevel || 1];
  let excludeClause = '';
  if (def.exclude_signals && def.exclude_signals.length) {
    params.push(def.exclude_signals);
    excludeClause = `AND NOT EXISTS (SELECT 1 FROM marketing_signals x
      WHERE x.scope_type = s.scope_type AND x.scope_id = s.scope_id AND x.active AND x.signal_type = ANY($${params.length}::text[]))`;
  }
  let extraClause = '';
  for (const q of extra) {
    params.push(q.signal); const si = params.length;
    params.push(q.minLevel || 1); const li = params.length;
    extraClause += ` AND EXISTS (SELECT 1 FROM marketing_signals y WHERE y.scope_type=s.scope_type AND y.scope_id=s.scope_id AND y.active AND y.signal_type=$${si} AND y.level>=$${li} AND (y.expires_at IS NULL OR y.expires_at>now()))`;
  }
  const { rows: qualified } = await r.query(
    `SELECT s.scope_type, s.scope_id, s.level, s.reason, s.observed_categories, s.last_observed_at
       FROM marketing_signals s
      WHERE s.signal_type = $1 AND s.active = true AND s.level >= $2
        AND (s.expires_at IS NULL OR s.expires_at > now()) ${excludeClause} ${extraClause}`, params);

  const windowDays = def.recency_window_days || 45;
  let entered = 0;
  const qualifiedKeys = new Set();
  for (const q of qualified) {
    qualifiedKeys.add(q.scope_type + '|' + q.scope_id);
    const ins = await r.query(
      `INSERT INTO marketing_audience_members
         (audience_key, scope_type, scope_id, last_qualified_at, expires_at, evidence, definition_version)
       VALUES ($1,$2,$3, now(), now() + ($4 || ' days')::interval, $5::jsonb, $6)
       ON CONFLICT (audience_key, scope_type, scope_id) DO UPDATE SET
         last_qualified_at = now(), expires_at = now() + ($4 || ' days')::interval,
         evidence = EXCLUDED.evidence, exited_at = NULL, exit_reason = NULL
       RETURNING (xmax = 0) AS inserted`,
      [audienceKey, q.scope_type, q.scope_id, String(windowDays),
        JSON.stringify({ reason: q.reason, level: q.level, observed_categories: q.observed_categories || undefined }), audiences.VERSION]);
    if (ins.rows[0] && ins.rows[0].inserted) entered++;
  }

  // EXIT active members who no longer qualify (conversion/decay/negative signal), and EXPIRE past-window.
  const { rows: active } = await r.query(
    `SELECT scope_type, scope_id, expires_at FROM marketing_audience_members
      WHERE audience_key = $1 AND exited_at IS NULL`, [audienceKey]);
  let exited = 0;
  for (const m of active) {
    const stillQualifies = qualifiedKeys.has(m.scope_type + '|' + m.scope_id);
    const expired = m.expires_at && new Date(m.expires_at) <= new Date();
    if (!stillQualifies || expired) {
      await r.query(
        `UPDATE marketing_audience_members SET exited_at = now(), exit_reason = $3
          WHERE audience_key = $1 AND scope_type = $2::text AND scope_id = $4 AND exited_at IS NULL`,
        [audienceKey, m.scope_type, expired ? 'expired' : 'no_longer_qualified', m.scope_id]);
      exited++;
    }
  }
  return { audience_key: audienceKey, qualified: qualified.length, entered, exited };
}

async function refreshAll(runner) {
  const r = runner || db;
  const out = [];
  for (const key of audiences.KEYS) out.push(await refreshAudience(key, r));
  return out;
}

// Active membership counts per audience (real data only).
async function counts(runner) {
  const r = runner || db;
  const { rows } = await r.query(
    `SELECT audience_key, count(*)::int AS n FROM marketing_audience_members
      WHERE exited_at IS NULL GROUP BY audience_key`);
  const map = {};
  rows.forEach((x) => { map[x.audience_key] = x.n; });
  return map;
}

// Members of an audience (active). Read-only, bounded.
async function members(audienceKey, { limit = 200, offset = 0 } = {}, runner) {
  const r = runner || db;
  const { rows } = await r.query(
    `SELECT m.scope_type, m.scope_id, m.entered_at, m.last_qualified_at, m.expires_at, m.evidence
       FROM marketing_audience_members m
      WHERE m.audience_key = $1 AND m.exited_at IS NULL
      ORDER BY m.last_qualified_at DESC LIMIT $2 OFFSET $3`, [audienceKey, limit, offset]);
  return rows;
}

/**
 * EMAIL eligibility for an audience — proves behavior NEVER overrides permission. Resolves each member to
 * a marketing_contact (user→contact, contact→contact; anonymous visitors are NOT email-eligible) and runs
 * the authoritative audienceEligibilityService.evaluateContact. Returns { candidates, eligible }.
 */
async function emailEligibleCount(audienceKey, { marketingClass = 'local_event_alert', geoStrategy = null } = {}, runner) {
  const r = runner || db;
  const def = audiences.get(audienceKey);
  if (!def || !def.allowed_channels.includes('a7_email')) return { candidates: 0, eligible: 0, reason: 'email_not_allowed' };
  const { rows: contacts } = await r.query(
    `SELECT DISTINCT mc.id, mc.normalized_email, mc.address_state, mc.city, mc.zip, mc.latitude, mc.longitude,
            mc.is_demo, mc.permission_basis, mc.permission_scope
       FROM marketing_audience_members m
       JOIN marketing_contacts mc
         ON (m.scope_type = 'contact' AND mc.id::text = m.scope_id)
         OR (m.scope_type = 'user' AND mc.user_id::text = m.scope_id)
      WHERE m.audience_key = $1 AND m.exited_at IS NULL`, [audienceKey]);
  let eligible = 0;
  for (const c of contacts) {
    const d = await eligibility.evaluateContact({ contact: c, marketingClass, geoStrategy }, r);
    if (d.eligible) eligible++;
  }
  return { candidates: contacts.length, eligible };
}

module.exports = { refreshAudience, refreshAll, counts, members, emailEligibleCount };
