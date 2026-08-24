'use strict';

/**
 * Staff RBAC — role/permission model, permission middleware behavior, and route/page authorization.
 *
 * Proves: Super Admin (Owner) is unrestricted; Marketing (Kym) can use Sales & Marketing but is
 * denied finance/settlements/payouts/platform-fee/staff/diagnostics; enforcement is server-side;
 * lockout + self-escalation protections exist; no marketplace member can self-grant staff access.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const rbac = require('../src/lib/rbac');

const OWNER = { role: 'admin', staff_role: 'super_admin', staff_active: true };
const KYM = { role: 'buyer', staff_role: 'marketing', staff_active: true };
const OPS = { role: 'buyer', staff_role: 'auction_ops', staff_active: true };
const APPROVER = { role: 'buyer', staff_role: 'auction_approver', staff_active: true };
const FINANCE = { role: 'buyer', staff_role: 'finance', staff_active: true };
const BUYER = { role: 'buyer', staff_role: null };
const SELLER = { role: 'seller', staff_role: null };

describe('Super Admin / Owner is unrestricted', () => {
  test('role=admin grants every permission (bypass)', () => {
    for (const p of rbac.PERMISSIONS) expect(rbac.hasPermission(OWNER, p)).toBe(true);
    expect(rbac.isSuperAdmin(OWNER)).toBe(true);
  });
  test('staff_role=super_admin (even without role=admin) is also unrestricted', () => {
    const su = { role: 'buyer', staff_role: 'super_admin' };
    expect(rbac.hasPermission(su, 'settlements.manage')).toBe(true);
    expect(rbac.hasPermission(su, 'staff.manage')).toBe(true);
  });
});

describe('Marketing / Sales (Kym) scope', () => {
  test('ALLOWED: sales toolbox + prospect management + scripts + demo', () => {
    ['sales.view', 'sales.manage_prospects', 'sales.edit_scripts', 'sales.view_demo']
      .forEach(p => expect(rbac.hasPermission(KYM, p)).toBe(true));
  });
  test('DENIED: finance, settlements, payouts, platform fee, staff admin, diagnostics, system', () => {
    ['finance.view', 'settlements.view', 'settlements.manage', 'payouts.view', 'payouts.manage',
     'invoices.view', 'seller_platform_fee.view', 'seller_platform_fee.manage',
     'staff.view', 'staff.manage', 'diagnostics.view', 'system.manage',
     'auctions.approve', 'auctions.publish']
      .forEach(p => expect(rbac.hasPermission(KYM, p)).toBe(false));
  });
});

describe('Future roles are scoped and ready for assignment', () => {
  test('Auction Operations: catalog/create/edit/submit yes; finance/payouts/staff no', () => {
    ['auctions.create', 'auctions.edit', 'auctions.manage_catalog', 'auctions.submit'].forEach(p => expect(rbac.hasPermission(OPS, p)).toBe(true));
    ['payouts.manage', 'settlements.manage', 'staff.manage', 'auctions.approve'].forEach(p => expect(rbac.hasPermission(OPS, p)).toBe(false));
  });
  test('Auction Approver: approve/publish/reject yes; finance/staff no', () => {
    ['auctions.approve', 'auctions.publish', 'auctions.reject'].forEach(p => expect(rbac.hasPermission(APPROVER, p)).toBe(true));
    ['settlements.manage', 'payouts.manage', 'staff.manage'].forEach(p => expect(rbac.hasPermission(APPROVER, p)).toBe(false));
  });
  test('Finance: settlements/payouts/invoices yes; marketing/staff/auction-edit no', () => {
    ['settlements.view', 'settlements.manage', 'payouts.view', 'payouts.manage', 'invoices.view'].forEach(p => expect(rbac.hasPermission(FINANCE, p)).toBe(true));
    ['sales.manage_prospects', 'staff.manage', 'auctions.edit'].forEach(p => expect(rbac.hasPermission(FINANCE, p)).toBe(false));
  });
});

describe('No marketplace member or deactivated staff can gain staff access', () => {
  test('plain buyer/seller have zero staff permissions and are not staff', () => {
    for (const p of rbac.PERMISSIONS) { expect(rbac.hasPermission(BUYER, p)).toBe(false); expect(rbac.hasPermission(SELLER, p)).toBe(false); }
    expect(rbac.isStaff(BUYER)).toBe(false);
    expect(rbac.isStaff(SELLER)).toBe(false);
  });
  test('a DEACTIVATED staff member loses all permissions', () => {
    const off = { role: 'buyer', staff_role: 'marketing', staff_active: false };
    expect(rbac.hasPermission(off, 'sales.view')).toBe(false);
  });
  test('overrides can grant/deny on top of the role bundle', () => {
    const withGrant = { role: 'buyer', staff_role: 'marketing', staff_active: true, overrides: [{ permission: 'invoices.view', effect: 'grant' }] };
    const withDeny = { role: 'buyer', staff_role: 'marketing', staff_active: true, overrides: [{ permission: 'sales.view', effect: 'deny' }] };
    expect(rbac.hasPermission(withGrant, 'invoices.view')).toBe(true);
    expect(rbac.hasPermission(withDeny, 'sales.view')).toBe(false);
  });
});

// ── Behavioral: requirePermission middleware (DB mocked) ─────────────────────────
describe('requirePermission middleware (server-side enforcement)', () => {
  jest.resetModules();
  jest.doMock('../src/db', () => ({ query: jest.fn() }));
  const db = require('../src/db');
  const requirePermission = require('../src/middleware/requirePermission');

  function mockUser(u) {
    db.query.mockReset();
    db.query.mockImplementation((sql) => {
      if (/FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [u] });
      if (/staff_permission_overrides/.test(sql)) return Promise.resolve({ rows: u.overrides || [] });
      return Promise.resolve({ rows: [] });
    });
  }
  const run = async (u, perm) => {
    mockUser(u);
    const req = { user: { id: u.id || 'x' } }; let code = 200; const res = { status: (c) => { code = c; return { json: () => {} }; } };
    let nexted = false; await requirePermission(perm)(req, res, () => { nexted = true; });
    return nexted ? 200 : code;
  };

  test('Owner passes any permission', async () => {
    expect(await run({ id: 'o', role: 'admin', staff_role: 'super_admin', staff_active: true }, 'settlements.manage')).toBe(200);
  });
  test('Kym passes sales.view but is 403 on staff.view and settlements.manage', async () => {
    expect(await run({ id: 'k', role: 'buyer', staff_role: 'marketing', staff_active: true }, 'sales.view')).toBe(200);
    expect(await run({ id: 'k', role: 'buyer', staff_role: 'marketing', staff_active: true }, 'staff.view')).toBe(403);
    expect(await run({ id: 'k', role: 'buyer', staff_role: 'marketing', staff_active: true }, 'settlements.manage')).toBe(403);
  });
  test('plain buyer is 403 on sales.view', async () => {
    expect(await run({ id: 'b', role: 'buyer', staff_role: null, staff_active: true }, 'sales.view')).toBe(403);
  });
});

// ── Source-level authorization guards ────────────────────────────────────────────
describe('route + page authorization wiring', () => {
  const sales = read('src/routes/adminSales.js');
  const staff = read('src/routes/adminStaff.js');
  const gate = read('src/middleware/htmlAuthGate.js');
  const server = read('server.js');

  test('Sales routes are permission-gated (read=sales.view, writes=sales.manage_prospects)', () => {
    expect(sales).toMatch(/router\.use\(auth, requirePermission\('sales\.view'\)\)/);
    expect((sales.match(/requirePermission\('sales\.manage_prospects'\)/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(sales).not.toMatch(/role\(\['admin'\]\)/); // no longer admin-only
  });
  test('Staff routes require staff.view/manage and are mounted', () => {
    expect(staff).toMatch(/requirePermission\('staff\.view'\)/);
    expect(staff).toMatch(/requirePermission\('staff\.manage'\)/);
    expect(server).toMatch(/app\.use\('\/api\/admin\/staff', adminStaffRoutes\)/);
  });
  test('finance/settlement/payout/platform-fee/diagnostics routes stay admin-only (Kym auto-denied)', () => {
    expect(read('src/routes/adminSettlements.js')).toMatch(/role\(\['admin'\]\)/);
    const admin = read('src/routes/admin.js');
    expect(admin).toMatch(/\/payouts.*role\(\['admin'\]\)|router\.get\('\/payouts', auth, role\(\['admin'\]\)/s);
    expect(admin).toMatch(/platform-fee', auth, role\(\['admin'\]\)/);
    expect(admin).toMatch(/diagnostics\/auctions', auth, role\(\['admin'\]\)/);
  });
  test('htmlAuthGate maps only sales.html + staff.html for non-admin staff; admins keep the fast path', () => {
    expect(gate).toMatch(/'\/admin\/sales\.html': 'sales\.view'/);
    expect(gate).toMatch(/'\/admin\/staff\.html': 'staff\.view'/);
    expect(gate).toMatch(/if \(roles\.includes\(decoded\.role\)\) return next\(\)/); // admin/role fast path
  });
});

describe('lockout + self-escalation protections', () => {
  const staff = read('src/routes/adminStaff.js');
  test('refuses to remove the last active Super Admin', () => {
    expect(staff).toMatch(/otherActiveSuperAdmins/);
    expect(staff).toMatch(/Refusing to remove the last active Super Admin/);
  });
  test('staff mutations require staff.manage (only Super Admin) — no self-escalation path', () => {
    expect(staff).toMatch(/router\.post\('\/', requirePermission\('staff\.manage'\)/);
    expect(staff).toMatch(/router\.patch\('\/:id', requirePermission\('staff\.manage'\)/);
  });
  test('migration adds staff_role/staff_active and constrains staff_role values', () => {
    const mig = read('db/migrations/113_staff_rbac.sql');
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS staff_role\s+TEXT/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS staff_active\s+BOOLEAN NOT NULL DEFAULT true/);
    expect(mig).toMatch(/chk_users_staff_role/);
  });
});
