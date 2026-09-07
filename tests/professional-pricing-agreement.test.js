'use strict';

/**
 * Professional Seller Agreement + Negotiated Pricing Workflow.
 *
 * Covers: standard 4% pro, negotiated pro fee, SEPARATE processing, agreement create/issue/accept,
 * acceptance authorization + cross-seller isolation, immutable executed agreement, versioning +
 * supersession history, effective-date behavior, publish-time snapshot uses the applicable rate,
 * historical snapshot preservation (sitewide/negotiated changes never rewrite history), Storefront 11%
 * unchanged, Individual economics unchanged, admin RBAC, audit records, and legacy compatibility.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── Mocks: db (query + connect), audit, pricing config — no live DB ──────────────────
const auditCalls = [];
jest.doMock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async (row) => { auditCalls.push(row); }) }));
jest.doMock('../src/services/pricingConfigService', () => ({
  currentProPlatformBps: jest.fn(async () => 400),
  currentProcessingBps: jest.fn(async () => 300),
}));

// A programmable query router shared by db.query and the transaction client.
const mockState = {
  sellerProfile: { id: 'sp-1', user_id: 'user-1', seller_type: 'auction_house', platform_fee_bps: 400 },
  existingVersions: [],
  insertReturn: null,
  acceptAgreement: null,   // row returned by the FOR UPDATE select in accept()
  updates: [],
};
function route(sql, params) {
  const s = String(sql);
  if (/FROM seller_profiles WHERE id/.test(s) && /seller_type/.test(s)) return { rows: mockState.sellerProfile ? [mockState.sellerProfile] : [] };
  if (/SELECT version FROM professional_pricing_agreements/.test(s)) return { rows: mockState.existingVersions.map((v) => ({ version: v })) };
  if (/INSERT INTO professional_pricing_agreements/.test(s)) { mockState.insertReturn = { id: 'ag-new', version: params[1], agreement_ref: params[2], platform_fee_bps: params[3], status: 'pending', seller_profile_id: params[0], effective_date: params[7] }; return { rows: [mockState.insertReturn] }; }
  if (/FROM professional_pricing_agreements a\s+JOIN seller_profiles sp/.test(s) || /a\.\*, sp\.user_id AS seller_user_id/.test(s)) return { rows: mockState.acceptAgreement ? [mockState.acceptAgreement] : [] };
  if (/effective_date <= \$2/.test(s)) return { rows: mockState.effectiveRow ? [mockState.effectiveRow] : [] };
  if (/SELECT id, status, seller_profile_id, version FROM professional_pricing_agreements WHERE id/.test(s)) return { rows: mockState.revokeRow ? [mockState.revokeRow] : [] };
  if (/UPDATE /.test(s)) { mockState.updates.push(s.replace(/\s+/g, ' ').trim()); return { rows: [], rowCount: 1 }; }
  if (/^BEGIN|^COMMIT|^ROLLBACK/.test(s.trim())) return { rows: [] };
  return { rows: [] };
}
const fakeClient = { query: jest.fn(async (sql, params) => route(sql, params)), release: jest.fn() };
jest.doMock('../src/db', () => ({ query: jest.fn(async (sql, params) => route(sql, params)), connect: jest.fn(async () => fakeClient), pool: {} }));

const svc = require('../src/services/sellerPricingAgreementService');

beforeEach(() => {
  auditCalls.length = 0;
  mockState.sellerProfile = { id: 'sp-1', user_id: 'user-1', seller_type: 'auction_house', platform_fee_bps: 400 };
  mockState.existingVersions = [];
  mockState.insertReturn = null;
  mockState.acceptAgreement = null;
  mockState.effectiveRow = null;
  mockState.revokeRow = null;
  mockState.updates = [];
});

// ── 1. Pricing hierarchy (pure) ──────────────────────────────────────────────────────
describe('resolvePlatformFeeBps — SITEWIDE → OVERRIDE → AGREEMENT hierarchy', () => {
  test('standard: no override, no agreement → sitewide default (4%)', () => {
    expect(svc.resolvePlatformFeeBps({ agreementBps: null, sellerOverrideBps: null, sitewideDefaultBps: 400 })).toBe(400);
  });
  test('seller override wins over sitewide default', () => {
    expect(svc.resolvePlatformFeeBps({ agreementBps: null, sellerOverrideBps: 350, sitewideDefaultBps: 400 })).toBe(350);
  });
  test('executed agreement wins over override and default', () => {
    expect(svc.resolvePlatformFeeBps({ agreementBps: 300, sellerOverrideBps: 350, sitewideDefaultBps: 400 })).toBe(300);
  });
  test('zero is a valid negotiated rate (not treated as null)', () => {
    expect(svc.resolvePlatformFeeBps({ agreementBps: 0, sellerOverrideBps: 350, sitewideDefaultBps: 400 })).toBe(0);
  });
});

describe('isNegotiated / nextVersion / buildAgreementRef / normalizeBps / isEffective', () => {
  test('isNegotiated true only when it differs from standard', () => {
    expect(svc.isNegotiated(350, 400)).toBe(true);
    expect(svc.isNegotiated(400, 400)).toBe(false);
  });
  test('nextVersion is max+1, or 1 when none', () => {
    expect(svc.nextVersion([])).toBe(1);
    expect(svc.nextVersion([1, 2, 3])).toBe(4);
    expect(svc.nextVersion([2])).toBe(3);
  });
  test('agreement ref is PSA-<seller8>-v<version>', () => {
    expect(svc.buildAgreementRef('abcdef12-3456-7890-abcd-ef1234567890', 2)).toBe('PSA-abcdef12-v2');
  });
  test('normalizeBps accepts percent or bps and enforces the ceiling', () => {
    expect(svc.normalizeBps({ platform_fee_percent: 3.5 })).toBe(350);
    expect(svc.normalizeBps({ platform_fee_bps: 400 })).toBe(400);
    expect(() => svc.normalizeBps({ platform_fee_bps: 9999 })).toThrow();
    expect(() => svc.normalizeBps({ platform_fee_percent: -1 })).toThrow();
    expect(() => svc.normalizeBps({})).toThrow();
  });
  test('isEffective compares an effective date against now', () => {
    expect(svc.isEffective('2020-01-01', new Date('2026-01-01'))).toBe(true);
    expect(svc.isEffective('2099-01-01', new Date('2026-01-01'))).toBe(false);
  });
});

// ── 2. Standard pricing: 4% platform + 3% processing SEPARATE ─────────────────────────
describe('standardPricing — 4% platform / 3% processing, distinct', () => {
  test('returns separate platform and processing components', async () => {
    const p = await svc.standardPricing();
    expect(p.platform_fee_bps).toBe(400);
    expect(p.processing_fee_bps).toBe(300);
    expect(p).not.toHaveProperty('total_fee_bps'); // never a combined "7%"
  });
});

// ── 3. Issue a negotiated agreement ──────────────────────────────────────────────────
describe('issue() — negotiated pro fee, versioned, audited', () => {
  test('issues v1 pending with negotiated 3.5% and records processing separately + audit', async () => {
    mockState.existingVersions = [];
    const row = await svc.issue({ sellerProfileId: 'sp-1', platform_fee_percent: 3.5, effective_date: '2026-10-01', actorId: 'admin-1' });
    expect(row.status).toBe('pending');
    expect(row.version).toBe(1);
    expect(row.platform_fee_bps).toBe(350);
    expect(auditCalls.some((a) => a.event_type === 'pricing_agreement_issued' && a.metadata.platform_fee_bps === 350 && a.metadata.processing_fee_bps === 300 && a.metadata.is_negotiated === true)).toBe(true);
  });
  test('version increments over existing agreements', async () => {
    mockState.existingVersions = [1, 2];
    const row = await svc.issue({ sellerProfileId: 'sp-1', platform_fee_bps: 400, actorId: 'admin-1' });
    expect(row.version).toBe(3);
  });
  test('rejects a non-professional seller (individual economics never governed here)', async () => {
    mockState.sellerProfile = { id: 'sp-1', user_id: 'user-1', seller_type: 'private', platform_fee_bps: 0 };
    await expect(svc.issue({ sellerProfileId: 'sp-1', platform_fee_percent: 3.5, actorId: 'admin-1' })).rejects.toMatchObject({ code: 'NOT_PROFESSIONAL' });
  });
  test('rejects an out-of-range rate', async () => {
    await expect(svc.issue({ sellerProfileId: 'sp-1', platform_fee_bps: 9999, actorId: 'admin-1' })).rejects.toThrow();
  });
});

// ── 4. Acceptance authorization + isolation + immutability + sync ─────────────────────
describe('accept() — authorized seller only, cross-seller isolation, effective sync, audit', () => {
  test('the owning seller can accept a pending effective agreement; syncs override + audits', async () => {
    mockState.acceptAgreement = { id: 'ag-1', seller_profile_id: 'sp-1', seller_user_id: 'user-1', status: 'pending', platform_fee_bps: 350, effective_date: '2020-01-01', version: 1, agreement_ref: 'PSA-x-v1', expires_at: null };
    const out = await svc.accept('ag-1', { userId: 'user-1', ip: '1.2.3.4', userAgent: 'jest' });
    expect(out.status).toBe('accepted');
    expect(out.seller_override_synced).toBe(true); // effective now → seller_profiles synced
    expect(mockState.updates.some((u) => /UPDATE seller_profiles SET platform_fee_bps/.test(u))).toBe(true);
    expect(mockState.updates.some((u) => /status='superseded'/.test(u))).toBe(true); // prior accepted superseded
    expect(mockState.updates.some((u) => /status='accepted'/.test(u))).toBe(true);
    expect(auditCalls.some((a) => a.event_type === 'pricing_agreement_accepted')).toBe(true);
  });
  test('a DIFFERENT seller cannot accept (cross-seller isolation → 403)', async () => {
    mockState.acceptAgreement = { id: 'ag-1', seller_profile_id: 'sp-1', seller_user_id: 'user-1', status: 'pending', platform_fee_bps: 350, effective_date: '2020-01-01', version: 1, agreement_ref: 'r', expires_at: null };
    await expect(svc.accept('ag-1', { userId: 'user-999' })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
  test('a future-dated agreement accepts but does NOT sync the override yet', async () => {
    mockState.acceptAgreement = { id: 'ag-2', seller_profile_id: 'sp-1', seller_user_id: 'user-1', status: 'pending', platform_fee_bps: 300, effective_date: '2099-01-01', version: 1, agreement_ref: 'r', expires_at: null };
    const out = await svc.accept('ag-2', { userId: 'user-1' });
    expect(out.status).toBe('accepted');
    expect(out.seller_override_synced).toBe(false);
    expect(mockState.updates.some((u) => /UPDATE seller_profiles SET platform_fee_bps/.test(u))).toBe(false);
  });
  test('an already-accepted agreement cannot be re-accepted (immutable executed record)', async () => {
    mockState.acceptAgreement = { id: 'ag-1', seller_profile_id: 'sp-1', seller_user_id: 'user-1', status: 'accepted', platform_fee_bps: 350, effective_date: '2020-01-01', version: 1, agreement_ref: 'r', expires_at: null };
    await expect(svc.accept('ag-1', { userId: 'user-1' })).rejects.toMatchObject({ code: 'NOT_PENDING' });
  });
  test('an expired offer cannot be accepted', async () => {
    mockState.acceptAgreement = { id: 'ag-1', seller_profile_id: 'sp-1', seller_user_id: 'user-1', status: 'pending', platform_fee_bps: 350, effective_date: '2020-01-01', version: 1, agreement_ref: 'r', expires_at: '2000-01-01T00:00:00Z' };
    await expect(svc.accept('ag-1', { userId: 'user-1' })).rejects.toMatchObject({ code: 'EXPIRED' });
  });
});

// ── 5. Revoke: pending only; executed is immutable ───────────────────────────────────
describe('revoke() — pending only; executed agreements are immutable', () => {
  test('revokes a pending offer + audits', async () => {
    mockState.revokeRow = { id: 'ag-1', status: 'pending', seller_profile_id: 'sp-1', version: 1 };
    const out = await svc.revoke('ag-1', { reason: 'redo' }, 'admin-1');
    expect(out.status).toBe('revoked');
    expect(auditCalls.some((a) => a.event_type === 'pricing_agreement_revoked')).toBe(true);
  });
  test('refuses to revoke an ACCEPTED agreement (immutable → new version instead)', async () => {
    mockState.revokeRow = { id: 'ag-1', status: 'accepted', seller_profile_id: 'sp-1', version: 1 };
    await expect(svc.revoke('ag-1', {}, 'admin-1')).rejects.toMatchObject({ code: 'IMMUTABLE' });
  });
});

// ── 6. effectivePlatformFeeBps resolver (feeds the publish snapshot) ──────────────────
describe('effectivePlatformFeeBps — accepted+effective agreement or null', () => {
  test('returns the accepted effective rate', async () => {
    mockState.effectiveRow = { platform_fee_bps: 300 };
    expect(await svc.effectivePlatformFeeBps('sp-1', new Date('2027-01-01'))).toBe(300);
  });
  test('returns null when no accepted+effective agreement (caller falls back to override/default)', async () => {
    mockState.effectiveRow = null;
    expect(await svc.effectivePlatformFeeBps('sp-1', new Date())).toBeNull();
  });
});

// ── 7. Publish-time snapshot wiring (source) — applicable rate frozen, history immutable
describe('publish snapshot uses the agreement-aware resolver + preserves history', () => {
  const a = read('src', 'services', 'auctionService.js');
  test('publishAuction resolves via pricingAgreements.resolvePlatformFeeBps and effectivePlatformFeeBps', () => {
    expect(a).toMatch(/sellerPricingAgreementService/);
    expect(a).toMatch(/resolvePlatformFeeBps/);
    expect(a).toMatch(/effectivePlatformFeeBps/);
  });
  test('snapshot is still frozen exactly once (WHERE pricing_model IS NULL) — history never rewritten', () => {
    expect(a).toMatch(/pricing_model = 'v2_separated'/);
    expect(a).toMatch(/WHERE id = \$1 AND pricing_model IS NULL/);
  });
  test('settlement reads the FROZEN per-auction snapshot, not live config/agreement', () => {
    const b = read('src', 'services', 'billingTermsService.js');
    expect(b).toMatch(/a\.platform_fee_bps AS snap_platform_bps/);
    expect(b).toMatch(/FROZEN publish-time snapshot/i);
  });
});

// ── 8. Storefront (11%) + Individual economics unchanged ─────────────────────────────
describe('regression: Storefront 11% and Individual economics untouched', () => {
  test('storefront service still flat 1100 bps; no auction platform/processing added', () => {
    const mo = read('src', 'services', 'marketplaceOrderService.js');
    expect(mo).toMatch(/STOREFRONT_FEE_BPS = 1100/);
  });
  test('this workflow never reads/writes storefront or individual pricing config keys', () => {
    const s = read('src', 'services', 'sellerPricingAgreementService.js');
    expect(s).not.toMatch(/pricing\.storefront|pricing\.estate_sale|pricing\.appraiser|pricing\.auction\.individual/);
    expect(s).toMatch(/PROFESSIONAL_SELLER_TYPES/); // gated to professionals only
  });
  test('migration 137 does not alter auctions, seller_payouts, or any pricing config', () => {
    const mig = read('db', 'migrations', '137_professional_pricing_agreements.sql');
    expect(mig).not.toMatch(/ALTER TABLE auctions/);
    expect(mig).not.toMatch(/ALTER TABLE seller_payouts/);
    expect(mig).not.toMatch(/UPDATE |DROP /);
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS professional_pricing_agreements/);
  });
});

// ── 9. Admin RBAC + seller cannot modify pricing ─────────────────────────────────────
describe('RBAC — admin/finance authoring; sellers can only accept', () => {
  const adminR = read('src', 'routes', 'adminPricingAgreements.js');
  const sellerR = read('src', 'routes', 'pricingAgreements.js');
  test('admin view = seller_platform_fee.view; issue/revoke = seller_platform_fee.manage', () => {
    expect(adminR).toMatch(/requirePermission\('seller_platform_fee\.view'\)/);
    expect(adminR).toMatch(/requirePermission\('seller_platform_fee\.manage'\)/);
    expect(adminR).toMatch(/\/sellers\/:sellerProfileId\/issue/);
  });
  test('finance authority resolves correctly (view yes, manage Super-Admin only)', () => {
    const rbac = require('../src/lib/rbac');
    expect(rbac.hasPermission({ role: 'buyer', staff_role: 'finance', staff_active: true }, 'seller_platform_fee.view')).toBe(true);
    expect(rbac.hasPermission({ role: 'buyer', staff_role: 'finance', staff_active: true }, 'seller_platform_fee.manage')).toBe(false);
    expect(rbac.hasPermission({ role: 'admin', staff_role: 'super_admin' }, 'seller_platform_fee.manage')).toBe(true);
    expect(rbac.hasPermission({ role: 'seller', staff_role: null }, 'seller_platform_fee.manage')).toBe(false);
  });
  test('the seller route exposes ONLY view + accept (no pricing mutation/authoring)', () => {
    expect(sellerR).toMatch(/\/:id\/accept/);
    expect(sellerR).toMatch(/'\/mine'/);
    expect(sellerR).not.toMatch(/requirePermission|\.issue\(|\.revoke\(|setBps|platform_fee_bps\s*=/);
  });
  test('acceptance authorization is server-derived (req.user.id), not client-asserted', () => {
    expect(sellerR).toMatch(/userId: req\.user\.id/);
  });
});

// ── 10. Audit + immutability language present in the service ─────────────────────────
describe('audit + immutability', () => {
  const s = read('src', 'services', 'sellerPricingAgreementService.js');
  test('writes issued/accepted/revoked audit events', () => {
    expect(s).toMatch(/pricing_agreement_issued/);
    expect(s).toMatch(/pricing_agreement_accepted/);
    expect(s).toMatch(/pricing_agreement_revoked/);
  });
  test('accept only stamps lifecycle fields — never rewrites platform_fee_bps/effective_date/terms', () => {
    // The accept UPDATE sets status/accepted_* only; there is no UPDATE of the economic columns.
    expect(s).toMatch(/SET status='accepted', accepted_at=now\(\)/);
    expect(s).not.toMatch(/SET[^;]*platform_fee_bps=\$[0-9][^;]*WHERE id=\$1[^;]*status='accepted'/);
  });
});

// ── 11. Legacy compatibility ─────────────────────────────────────────────────────────
describe('legacy compatibility', () => {
  test('a seller with an existing platform_fee_bps override but NO agreement resolves to that override', () => {
    // agreementBps null (no agreement) → falls back to the seller override exactly as before.
    expect(svc.resolvePlatformFeeBps({ agreementBps: null, sellerOverrideBps: 200, sitewideDefaultBps: 400 })).toBe(200);
  });
  test('no fabricated acceptance: issue creates status=pending (never auto-accepted)', async () => {
    const row = await svc.issue({ sellerProfileId: 'sp-1', platform_fee_bps: 350, actorId: 'admin-1' });
    expect(row.status).toBe('pending');
  });
});
