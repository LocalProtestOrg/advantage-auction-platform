'use strict';

/**
 * rbac.js — the single, code-owned source of truth for internal staff Role-Based Access Control.
 *
 * Model (owner-approved):
 *   • Super Admin / Owner: a user whose marketplace role is 'admin' OR whose staff_role is
 *     'super_admin'. Bypasses every permission check (unrestricted). The Owner account
 *     (tylerwitt2015@gmail.com) is role='admin' AND staff_role='super_admin'.
 *   • Other staff roles are composed of explicit PERMISSIONS. Enforcement checks PERMISSIONS, never
 *     a bare role string, so roles stay maintainable and territory/override extension is easy later.
 *
 * This module is pure (no DB). requirePermission middleware resolves the user's staff_role +
 * overrides from the DB and calls hasPermission() here.
 */

// ── Permission catalog (grounded in the real Admin surface) ─────────────────────
const PERMISSIONS = [
  // Staff administration (Super Admin only in practice)
  'staff.view', 'staff.manage',
  // Sales / Marketing
  'sales.view', 'sales.manage_prospects', 'sales.edit_scripts', 'sales.view_demo',
  // Auction operations
  'auctions.view', 'auctions.create', 'auctions.edit', 'auctions.manage_catalog', 'auctions.submit',
  // Auction approval
  'auctions.approve', 'auctions.publish', 'auctions.reject',
  // Finance
  'finance.view', 'settlements.view', 'settlements.manage', 'payouts.view', 'payouts.manage', 'invoices.view',
  // Seller / member administration
  'sellers.view', 'sellers.manage', 'members.view', 'members.manage',
  // Sensitive financial configuration
  'seller_platform_fee.view', 'seller_platform_fee.manage',
  // System
  'system.manage', 'diagnostics.view',
];

// ── Staff roles → permission bundles ────────────────────────────────────────────
// '*' means all permissions (Super Admin). Keep bundles minimal and job-scoped.
const ROLES = {
  super_admin: {
    label: 'Super Admin / Owner',
    permissions: '*',
  },
  marketing: {
    label: 'Marketing / Sales',
    permissions: ['sales.view', 'sales.manage_prospects', 'sales.edit_scripts', 'sales.view_demo'],
  },
  auction_ops: {
    label: 'Auction Operations',
    permissions: ['auctions.view', 'auctions.create', 'auctions.edit', 'auctions.manage_catalog', 'auctions.submit', 'sellers.view'],
  },
  auction_approver: {
    label: 'Auction Approver / Manager',
    permissions: ['auctions.view', 'auctions.approve', 'auctions.publish', 'auctions.reject'],
  },
  finance: {
    label: 'Finance',
    permissions: ['finance.view', 'settlements.view', 'settlements.manage', 'payouts.view', 'payouts.manage', 'invoices.view', 'seller_platform_fee.view'],
  },
};

const STAFF_ROLE_KEYS = Object.keys(ROLES);

// A user object shape (from DB): { role, staff_role, staff_active, overrides?: [{permission, effect}] }
function isSuperAdmin(user) {
  if (!user) return false;
  return user.role === 'admin' || user.staff_role === 'super_admin';
}

// The effective permission SET for a user. Super admins get everything. Deactivated staff get none
// (unless they are a role='admin' Super Admin, which is never gated by staff_active).
function permissionsForUser(user) {
  if (!user) return new Set();
  if (isSuperAdmin(user)) return new Set(PERMISSIONS);
  // A non-admin staff member must be active and carry a known staff_role.
  if (user.staff_active === false) return new Set();
  const role = ROLES[user.staff_role];
  const base = role ? (role.permissions === '*' ? PERMISSIONS : role.permissions) : [];
  const set = new Set(base);
  // Apply per-user overrides (grant adds, deny removes).
  for (const o of Array.isArray(user.overrides) ? user.overrides : []) {
    if (!o || !o.permission) continue;
    if (o.effect === 'grant') set.add(o.permission);
    else if (o.effect === 'deny') set.delete(o.permission);
  }
  return set;
}

function hasPermission(user, permission) {
  if (isSuperAdmin(user)) return true; // unrestricted
  return permissionsForUser(user).has(permission);
}

// Is this user internal staff at all (Super Admin via role, or any staff_role)?
function isStaff(user) {
  return isSuperAdmin(user) || (!!user && !!user.staff_role);
}

module.exports = {
  PERMISSIONS, ROLES, STAFF_ROLE_KEYS,
  isSuperAdmin, isStaff, permissionsForUser, hasPermission,
};
