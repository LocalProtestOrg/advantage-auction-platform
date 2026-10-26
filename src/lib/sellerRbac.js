'use strict';

/**
 * sellerRbac.js — the code-owned permission catalog for a Professional Seller's OWN company (owner-approved design,
 * 2026-10-16; see docs/projects/seller-staff-permissions-design-2026-10-16.md).
 *
 * This is deliberately a SEPARATE namespace from the platform staff RBAC (src/lib/rbac.js):
 *   • every permission here is scoped to ONE seller organization (the seller_profile the person belongs to);
 *   • no seller role can ever produce a platform permission or Super Admin (the two catalogs share no names, and
 *     platform authorization never reads this module);
 *   • enforcement is server-side: routes call requireSellerPermission(), services still verify the row belongs to the
 *     resolved seller (defense in depth).
 * Pure (no DB). Today only the company OWNER (the seller_profile's own user) is resolved; staff membership is
 * activated after owner approval of the design.
 */

const SELLER_PERMISSIONS = [
  'company.storefront.manage',        // storefront page, branding, default pickup location
  'company.staff.manage',             // invite / change / remove company staff (owner only)
  'company.inventory.view', 'company.inventory.edit',            // listings, descriptions, photos, prices
  'company.orders.view',              // the company's orders (no buyer contact)
  'company.orders.fulfil',            // paid orders needing fulfilment + the buyer contact needed to ship or arrange pickup
  'company.issues.view', 'company.issues.respond',               // buyer issues on the company's own orders
  'company.messages.view', 'company.messages.respond',           // buyer questions about the company's items (owner only until the owner assigns staff roles)
  'company.finance.view',             // fees, proceeds, settlement reports
  'company.payout.manage',            // payout destination — additionally requires step-up verification (never a plain role grant)
];

const SELLER_ROLES = {
  owner: { label: 'Seller Owner', permissions: SELLER_PERMISSIONS.slice() },
  inventory_manager: { label: 'Inventory Manager', permissions: ['company.inventory.view', 'company.inventory.edit', 'company.orders.view'] },
  fulfillment: { label: 'Fulfillment Staff', permissions: ['company.orders.view', 'company.orders.fulfil', 'company.issues.view'] },
  finance: { label: 'Finance Manager', permissions: ['company.orders.view', 'company.finance.view', 'company.issues.view'] },
};

// Permissions that are never satisfied by a role alone: the caller must also present a fresh step-up verification.
const STEP_UP_REQUIRED = new Set(['company.payout.manage', 'company.staff.manage']);

function permissionsForRole(role) {
  const r = SELLER_ROLES[role];
  return new Set(r ? r.permissions : []);
}

function hasSellerPermission(ctx, permission) {
  if (!ctx || !ctx.sellerId || !SELLER_PERMISSIONS.includes(permission)) return false;
  return permissionsForRole(ctx.role).has(permission);
}

module.exports = { SELLER_PERMISSIONS, SELLER_ROLES, STEP_UP_REQUIRED, permissionsForRole, hasSellerPermission };
