'use strict';

/**
 * taxAlerts - administrator alerts for the tax system (migration 231). One OPEN alert per alert_key: raising the same
 * condition again only refreshes last_seen_at, so a recurring check never floods the list. Never throws to its caller:
 * an alert that cannot be written is logged and the money path continues.
 */

const db = require('../../db');

async function raise({ key, type, severity = 'warning', message, detail = null }, runner = db) {
  try {
    const r = await runner.query(
      `INSERT INTO tax_alerts (alert_key, alert_type, severity, message, detail) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (alert_key) WHERE resolved_at IS NULL
       DO UPDATE SET last_seen_at = now(), message = EXCLUDED.message, detail = EXCLUDED.detail, severity = EXCLUDED.severity
       RETURNING id, (xmax = 0) AS created`,
      [String(key).slice(0, 300), String(type).slice(0, 60), severity, String(message).slice(0, 1000), detail ? JSON.stringify(detail) : null]);
    return r.rows[0] || null;
  } catch (e) {
    console.error('[tax-alerts] could not record alert', type, e.message);
    return null;
  }
}

async function resolveByKey(key, resolution = 'cleared automatically', runner = db) {
  try {
    await runner.query(`UPDATE tax_alerts SET resolved_at = now(), resolution = $2 WHERE alert_key = $1 AND resolved_at IS NULL`, [key, resolution]);
  } catch (e) { console.error('[tax-alerts] resolve failed', e.message); }
}

/** Close every open alert of a type whose key was not seen in this pass (the condition no longer holds). */
async function resolveStale(type, seenKeys, runner = db) {
  try {
    await runner.query(
      `UPDATE tax_alerts SET resolved_at = now(), resolution = 'cleared automatically: the condition no longer holds'
        WHERE alert_type = $1 AND resolved_at IS NULL AND NOT (alert_key = ANY($2::text[]))`, [type, seenKeys || []]);
  } catch (e) { console.error('[tax-alerts] resolveStale failed', e.message); }
}

async function resolveById(id, actorId, resolution) {
  const r = await db.query(
    `UPDATE tax_alerts SET resolved_at = now(), resolved_by = $2, resolution = $3 WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
    [id, actorId, String(resolution || '').trim().slice(0, 500) || 'resolved by an administrator']);
  return !!r.rowCount;
}

async function list({ open = true, limit = 200 } = {}) {
  return (await db.query(
    `SELECT id, alert_key, alert_type, severity, message, detail, created_at, last_seen_at, resolved_at, resolution
       FROM tax_alerts WHERE ${open ? 'resolved_at IS NULL' : 'resolved_at IS NOT NULL'}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT $1`, [Math.min(500, Math.max(1, Number(limit) || 200))])).rows;
}

module.exports = { raise, resolveByKey, resolveStale, resolveById, list };
