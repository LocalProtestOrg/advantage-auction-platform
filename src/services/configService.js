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

async function setPlatformConfig(key, value) {
  await db.query(
    `INSERT INTO platform_config (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]);
}

module.exports = { get, getAll, setOrgConfig, setPlatformConfig };
