'use strict';

/**
 * configService — configuration hierarchy (Constitution §9):
 *   Platform Defaults → Partner (Organization) Configuration.
 * Effective value = organization override ?? platform default. Values are JSONB.
 * Business-rule values (buyer_premium_pct, etc.) are stored here as data; they are NOT
 * yet consumed by the settlement engine (that wiring is a gated payment-architecture step).
 */

const db = require('../db');

/** Effective value for a key: org override, else platform default, else null. */
async function get(organizationId, key) {
  if (organizationId) {
    const { rows } = await db.query('SELECT value FROM organization_config WHERE organization_id = $1 AND key = $2', [organizationId, key]);
    if (rows.length) return rows[0].value;
  }
  const { rows } = await db.query('SELECT value FROM platform_config WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

/** All effective config for an org (defaults merged with overrides), optionally by category. */
async function getAll(organizationId, category) {
  const defaults = (await db.query(
    'SELECT key, value, category FROM platform_config' + (category ? ' WHERE category = $1' : ''),
    category ? [category] : [])).rows;
  const eff = {};
  for (const r of defaults) eff[r.key] = r.value;
  if (organizationId) {
    const overrides = (await db.query('SELECT key, value FROM organization_config WHERE organization_id = $1', [organizationId])).rows;
    for (const r of overrides) if (Object.prototype.hasOwnProperty.call(eff, r.key)) eff[r.key] = r.value;
  }
  return eff;
}

async function setOrgConfig(organizationId, key, value, userId) {
  await db.query(
    `INSERT INTO organization_config (organization_id, key, value, updated_by) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [organizationId, key, JSON.stringify(value), userId || null]);
}

/**
 * THE choke point for platform setting writes (owner decision 2026-11-06). Every write is audited (who, when, key,
 * previous and new value, secrets masked) and every change to a SENSITIVE key (src/lib/sensitiveConfig.js) notifies
 * the owner by email and text.
 *
 * opts:
 *   actor       the signed-in user making the change (req.user). Required for a sensitive key, and must be the
 *               platform owner (checked against the database, fail closed).
 *   system      a label for an automated writer (e.g. 'paid_spend_breach'). Allowed without an actor; still audited
 *               and, for a sensitive key, still notified.
 *   safetyStop  true when the write only turns something OFF or engages a kill switch. Any admin route that offers a
 *               stop may pass it; the value is checked, so it can never turn anything on.
 *   category    platform_config category for a NEW key (existing keys keep theirs).
 *   source      where the change came from (route or service), for the audit trail.
 *   adminPath   where the owner reviews the change (owner notice link).
 */
async function setPlatformConfig(key, value, opts = {}) {
  const runner = opts.runner || db;
  const sensitiveConfig = require('../lib/sensitiveConfig');
  const sensitive = sensitiveConfig.isSensitive(key);
  if (opts.safetyStop && !sensitiveConfig.isSafetyStopValue(key, value)) {
    const e = new Error('A safety stop can only turn a setting off.'); e.status = 400; e.code = 'NOT_A_STOP'; e.expose = true; throw e;
  }
  if (sensitive && !opts.system && !opts.safetyStop) {
    const owner = require('../lib/platformOwner');
    if (!opts.actor || !(await owner.isPlatformOwner(opts.actor, runner))) throw owner.ownerRequiredError(String(key));
  }
  const prev = (await runner.query('SELECT value FROM platform_config WHERE key = $1', [key])).rows[0];
  // The category is a fixed code-side word (validated, never user input), so it is written as a literal.
  const category = /^[a-z][a-z0-9_]{0,40}$/.test(String(opts.category || '')) ? opts.category : 'general';
  await runner.query(
    `INSERT INTO platform_config (key, value, category) VALUES ($1, $2::jsonb, '${category}')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value === undefined ? null : value)]);
  return recordPlatformConfigChange({ key, previous: prev ? prev.value : null, existed: !!prev, next: value, sensitive, ...opts, runner });
}

/**
 * Audit one platform setting change and, for a sensitive key whose value actually changed, notify the owner.
 * Exported for the few automated writers that update platform_config directly. Never throws: a failed audit or a
 * failed notice is logged loudly, and a notice is never treated as approval.
 */
async function recordPlatformConfigChange({ key, previous = null, existed = true, next, sensitive, actor = null, system = null,
  safetyStop = false, source = null, adminPath = null, notify = true, runner = db } = {}) {
  const sensitiveConfig = require('../lib/sensitiveConfig');
  const isSens = sensitive != null ? sensitive : sensitiveConfig.isSensitive(key);
  const actorId = actor && (actor.id || actor.userId) ? (actor.id || actor.userId) : null;
  const label = system ? String(system) : (safetyStop ? 'safety_stop' : (actorId ? null : 'unspecified'));
  const prevMasked = sensitiveConfig.maskValue(key, previous);
  const nextMasked = sensitiveConfig.maskValue(key, next === undefined ? null : next);
  let auditId = null;
  try {
    auditId = (await runner.query(
      `INSERT INTO platform_setting_audit (config_key, previous_value, new_value, sensitive, actor_user_id, actor_kind, actor_label, source)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8) RETURNING id`,
      [key, existed ? JSON.stringify(prevMasked) : null, JSON.stringify(nextMasked), isSens, actorId, actorId ? 'user' : 'system', label, source ? String(source).slice(0, 200) : null])).rows[0].id;
  } catch (e) {
    console.error('[config-audit] AUDIT WRITE FAILED for ' + key + ':', e.message);
  }
  const changed = !existed || JSON.stringify(previous) !== JSON.stringify(next === undefined ? null : next);
  let notice = null;
  if (isSens && changed && notify !== false) {
    let who = actorId ? 'an admin account' : 'an automated process (' + (label || 'system') + ')';
    if (actorId) {
      try { const u = (await runner.query('SELECT email FROM users WHERE id = $1', [actorId])).rows[0]; if (u && u.email) who = u.email; } catch (_) { /* best effort */ }
    }
    notice = await require('./ownerNotifyService').notify({
      subject: 'Sensitive setting changed: ' + key,
      reason: 'The platform setting ' + key + ' was changed by ' + who + (safetyStop ? ' as a safety stop' : '') + '.',
      risk: 'Sensitive settings control pricing, paid advertising authority, outreach and automated messaging.',
      recommendation: 'If you did not expect this change, review it in Admin and change it back.',
      details: ['Previous value: ' + JSON.stringify(existed ? prevMasked : '(not set)'), 'New value: ' + JSON.stringify(nextMasked)],
      adminPath: adminPath || '/admin/',
    }, { runner }).catch((e) => { console.error('[config-audit] owner notice error:', e.message); return { ok: false, error: e.message }; });
    if (auditId) {
      await runner.query(`UPDATE platform_setting_audit SET owner_notified_at = CASE WHEN $2 THEN now() ELSE NULL END, owner_notify_result = $3::jsonb WHERE id = $1`,
        [auditId, !!(notice && notice.ok), JSON.stringify(notice || {})]).catch((e) => console.error('[config-audit] notice result not recorded:', e.message));
    }
  }
  return { audit_id: auditId, sensitive: isSens, changed, owner_notice: notice };
}

module.exports = { get, getAll, setOrgConfig, setPlatformConfig, recordPlatformConfigChange };
