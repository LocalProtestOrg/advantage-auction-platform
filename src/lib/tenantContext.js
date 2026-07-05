'use strict';

/**
 * tenantContext — resolves the tenant (Organization = Partner) for the platform.
 *
 * Phase 1 (Platform Foundation): a single active tenant — Advantage Auction Company,
 * the platform tenant (organizations.is_platform_tenant = true). `resolveTenant(req)`
 * currently returns the platform tenant regardless of host.
 *
 * Phase 5 (Partner Network): `resolveTenant` will resolve by incoming Host header
 * (organizations.primary_domain / custom_domains). This module is the single seam for
 * that change — no caller needs to know how the tenant is resolved.
 *
 * Capabilities are organization-scoped (organization_capabilities). Authorization asks
 * "does this tenant have capability X?" (see middleware/requireCapability), never
 * "what plan/user type is this?" — per Constitution §11 (Capability-Based Platform).
 *
 * NOTE: not yet wired into existing routes — additive infrastructure only.
 */

const db = require('../db');

let _platformTenant = null; // cached; the platform tenant is immutable at runtime

async function getPlatformTenant() {
  if (_platformTenant) return _platformTenant;
  const { rows } = await db.query(
    'SELECT * FROM organizations WHERE is_platform_tenant = true ORDER BY created_at ASC LIMIT 1');
  _platformTenant = rows[0] || null;
  return _platformTenant;
}

/**
 * Resolve the tenant Organization for a request.
 * Phase 1: always the platform tenant. Phase 5: resolve by req host.
 */
async function resolveTenant(req) {
  // Future: const host = (req && req.headers && req.headers.host || '').toLowerCase();
  //         look up organizations by primary_domain / custom_domains; fall back to platform.
  return getPlatformTenant();
}

/** Set of enabled capability keys for an organization. */
async function getCapabilities(organizationId) {
  const { rows } = await db.query(
    'SELECT capability FROM organization_capabilities WHERE organization_id = $1 AND enabled = true',
    [organizationId]);
  return new Set(rows.map((r) => r.capability));
}

/** True if the organization has the given capability enabled. */
async function hasCapability(organizationId, capability) {
  const { rows } = await db.query(
    'SELECT 1 FROM organization_capabilities WHERE organization_id = $1 AND capability = $2 AND enabled = true LIMIT 1',
    [organizationId, capability]);
  return rows.length > 0;
}

module.exports = {
  getPlatformTenant,
  resolveTenant,
  getCapabilities,
  hasCapability,
  _reset() { _platformTenant = null; }, // test hook
};
