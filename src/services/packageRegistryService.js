'use strict';

/**
 * packageRegistryService — the VERSIONED Marketing Package registry (locked identities
 * INCLUDED/FEATURED/PREMIUM/SIGNATURE). Package NAMES define the product; price + deliverables + policy are
 * versioned DATA (never hard-coded into business logic). Owner/Super Admin can create, preview, schedule,
 * activate, retire, and inspect future versions without deployment. Historical purchases are NEVER rewritten
 * when a definition changes (purchases freeze their own snapshot — see marketingPackagePurchaseService).
 */

const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');

const PACKAGE_KEYS = ['included', 'featured', 'premium', 'signature'];
const PAID_KEYS = ['featured', 'premium', 'signature'];

class PackageRegistryError extends Error {
  constructor(message, status = 400, code = 'PACKAGE_REGISTRY_ERROR') { super(message); this.status = status; this.code = code; }
}

function isValidKey(k) { return PACKAGE_KEYS.indexOf(String(k || '').toLowerCase()) !== -1; }

// The ACTIVE version for a package at a given time: latest active row with effective_from <= at and
// (effective_to IS NULL OR effective_to > at). Deterministic by version desc.
async function activeVersion(packageKey, at, runner) {
  const r = runner || db;
  const when = at ? new Date(at) : new Date();
  const row = (await r.query(
    `SELECT * FROM marketing_package_versions
      WHERE package_key = $1 AND is_active = true AND effective_from <= $2
        AND (effective_to IS NULL OR effective_to > $2)
      ORDER BY effective_from DESC, version DESC LIMIT 1`, [packageKey, when])).rows[0];
  return row || null;
}

async function listActive(at, runner) {
  const out = [];
  for (const k of PACKAGE_KEYS) { const v = await activeVersion(k, at, runner); if (v) out.push(v); }
  return out;
}

async function listVersions(packageKey, runner) {
  const r = runner || db;
  return (await r.query(`SELECT * FROM marketing_package_versions WHERE package_key = $1 ORDER BY version DESC`, [packageKey])).rows;
}

async function getById(id, runner) {
  const r = runner || db;
  return (await r.query(`SELECT * FROM marketing_package_versions WHERE id = $1`, [id])).rows[0] || null;
}

// Create a NEW version of a package (never mutates existing versions). effective_from may be future-dated
// (schedule). Audited. Returns the new row.
async function createVersion(input, actorId, runner) {
  const r = runner || db;
  const key = String(input.package_key || '').toLowerCase();
  if (!isValidKey(key)) throw new PackageRegistryError('Invalid package_key', 400, 'INVALID_KEY');
  const price = Math.trunc(Number(input.price_cents));
  if (!Number.isFinite(price) || price < 0) throw new PackageRegistryError('price_cents must be >= 0', 400, 'INVALID_PRICE');
  const maxV = (await r.query(`SELECT COALESCE(MAX(version),0) AS v FROM marketing_package_versions WHERE package_key = $1`, [key])).rows[0].v;
  const version = Number(maxV) + 1;
  const row = (await r.query(
    `INSERT INTO marketing_package_versions
       (package_key, version, effective_from, effective_to, is_active, seller_name, seller_description,
        seller_benefits, guaranteed_deliverables, discretionary_tools, price_cents, economic_policy_version, capacity_ref, created_by)
     VALUES ($1,$2,COALESCE($3, now()),$4,COALESCE($5,true),$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14)
     RETURNING *`,
    [key, version, input.effective_from || null, input.effective_to || null, input.is_active,
     input.seller_name || key, input.seller_description || null,
     JSON.stringify(input.seller_benefits || []), JSON.stringify(input.guaranteed_deliverables || []),
     JSON.stringify(input.discretionary_tools || []), price, input.economic_policy_version || 'v1',
     JSON.stringify(input.capacity_ref || {}), actorId || null])).rows[0];
  await writeAuditLog({ event_type: 'marketing_package_version_created', entity_type: 'marketing_package_version', entity_id: row.id,
    actor_id: actorId || null, metadata: { package_key: key, version, price_cents: price, effective_from: row.effective_from } });
  return row;
}

// Activate / retire a specific version (schedule state). Never edits price/deliverables of an existing row —
// a real change is a NEW version. Audited.
async function setActive(id, isActive, actorId, runner) {
  const r = runner || db;
  const row = (await r.query(`UPDATE marketing_package_versions SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, !!isActive])).rows[0];
  if (!row) throw new PackageRegistryError('Version not found', 404, 'NOT_FOUND');
  await writeAuditLog({ event_type: isActive ? 'marketing_package_version_activated' : 'marketing_package_version_retired',
    entity_type: 'marketing_package_version', entity_id: id, actor_id: actorId || null, metadata: { package_key: row.package_key, version: row.version } });
  return row;
}

// Retire the currently-active version by stamping effective_to (schedule a cutover). Audited.
async function retireAt(id, effectiveTo, actorId, runner) {
  const r = runner || db;
  const row = (await r.query(`UPDATE marketing_package_versions SET effective_to = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, effectiveTo])).rows[0];
  if (!row) throw new PackageRegistryError('Version not found', 404, 'NOT_FOUND');
  await writeAuditLog({ event_type: 'marketing_package_version_scheduled_retire', entity_type: 'marketing_package_version', entity_id: id,
    actor_id: actorId || null, metadata: { package_key: row.package_key, version: row.version, effective_to: effectiveTo } });
  return row;
}

// Seller-facing view of an active version — ONLY seller-safe fields (never economic policy).
function sellerView(v) {
  if (!v) return null;
  return {
    package_key: v.package_key, version: v.version, name: v.seller_name, description: v.seller_description,
    benefits: v.seller_benefits, price_cents: v.price_cents,
    // deliverables shown as seller-facing labels only (guaranteed vs discretionary distinction is fine to show)
    guaranteed: (v.guaranteed_deliverables || []).map((d) => d.label).filter(Boolean),
    also_may_include: (v.discretionary_tools || []).map((d) => d.label).filter(Boolean),
  };
}

module.exports = {
  PACKAGE_KEYS, PAID_KEYS, isValidKey,
  activeVersion, listActive, listVersions, getById, createVersion, setActive, retireAt, sellerView,
  PackageRegistryError,
};
