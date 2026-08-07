'use strict';

/**
 * H-1 launch support (Part B) — Buyer sales-tax exemption. Reuses the secure private document stack.
 * Uploading a certificate never grants exemption — only admin approval does. Mocked DB + storage.
 * The 8 required Part-B assertions are labelled [#n]. Does NOT enable sales tax globally.
 */
const fs = require('fs');

jest.mock('../src/db/index', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/cloudinaryService', () => ({ uploadBuffer: jest.fn().mockResolvedValue({ public_id: 'taxexempt-1' }) }));
jest.mock('cloudinary', () => ({ v2: { utils: { private_download_url: jest.fn(() => 'https://signed/cert') } } }));
jest.mock('../src/lib/uploadValidation', () => ({
  validateDocumentUpload: jest.fn(() => ({ safeFilename: 'cert.pdf', mime: 'application/pdf' })),
  ALLOWED: { 'application/pdf': ['pdf'] },
}));

const db = require('../src/db/index');
const cloud = require('../src/services/cloudinaryService');
const svc = require('../src/services/taxExemptionService');

const USER = 'buyer-1', EX = 'ex-1';
beforeEach(() => { db.query.mockReset(); db.connect.mockReset(); cloud.uploadBuffer.mockClear(); });

// A mock transaction client for reviewExemption.
function mockClient(routes) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      calls.push([String(sql), params]);
      const s = String(sql).toLowerCase();
      for (const [kw, val] of routes) if (s.includes(kw)) return typeof val === 'function' ? val(params) : val;
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  return { client, calls };
}

describe('Buyer submits an exemption', () => {
  test('[#9] buyer can submit an exemption certificate document (stored privately)', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql).toLowerCase();
      if (s.includes('insert into buyer_tax_exemptions')) return { rows: [{ id: EX, status: 'under_review' }], rowCount: 1 };
      if (s.includes('update users set tax_exempt')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await svc.submitExemption(USER, { exemption_type: 'resale', jurisdiction_state: 'TX', certificate_number: 'C1', filename: 'cert.pdf', contentType: 'application/pdf', dataBase64: 'Zm9v' });
    expect(out.status).toBe('under_review');
    const opts = cloud.uploadBuffer.mock.calls[0][1];
    expect(opts.type).toBe('private');
    expect(opts.resource_type).toBe('raw');
    expect(opts.folder).toBe('tax-exemption-documents');
  });

  test('[#10] uploading a certificate does NOT mark the buyer tax-exempt', async () => {
    const seen = [];
    db.query.mockImplementation(async (sql, params) => {
      const s = String(sql).toLowerCase(); seen.push([s, params]);
      if (s.includes('insert into buyer_tax_exemptions')) return { rows: [{ id: EX, status: 'under_review' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await svc.submitExemption(USER, { filename: 'c.pdf', contentType: 'application/pdf', dataBase64: 'Zm9v' });
    expect(out.status).toBe('under_review');                 // never 'approved' on submit
    // users.tax_exempt is explicitly set FALSE on submission.
    const flagWrite = seen.find(([s]) => s.includes('update users set tax_exempt'));
    expect(flagWrite).toBeTruthy();
    expect(flagWrite[1]).toEqual([USER]);                    // the false-setting query (no boolean param → literal false)
  });

  test('a submission with no document is rejected', async () => {
    await expect(svc.submitExemption(USER, { exemption_type: 'resale' })).rejects.toThrow(/certificate document is required/i);
  });
});

describe('Admin review is authoritative', () => {
  test('[#11] admin approval marks the authoritative tax-exempt status true', async () => {
    const { client, calls } = mockClient([
      ['select id from buyer_tax_exemptions', { rows: [{ id: EX }], rowCount: 1 }],
      ['update buyer_tax_exemptions set', { rows: [{ id: EX, status: 'approved', jurisdiction_state: 'TX' }], rowCount: 1 }],
    ]);
    db.connect.mockResolvedValue(client);
    const out = await svc.reviewExemption(USER, 'admin-1', { status: 'approved', jurisdiction_state: 'TX', effective_date: '2026-01-01' });
    expect(out.tax_exempt).toBe(true);
    const flag = calls.find(([s]) => s.toLowerCase().includes('update users set tax_exempt'));
    expect(flag[1]).toEqual([USER, true]);                   // mirror set TRUE only on approval
  });

  test('[#12] admin rejection leaves the buyer taxable (tax_exempt false)', async () => {
    const { client, calls } = mockClient([
      ['select id from buyer_tax_exemptions', { rows: [{ id: EX }], rowCount: 1 }],
      ['update buyer_tax_exemptions set', { rows: [{ id: EX, status: 'rejected' }], rowCount: 1 }],
    ]);
    db.connect.mockResolvedValue(client);
    const out = await svc.reviewExemption(USER, 'admin-1', { status: 'rejected' });
    expect(out.tax_exempt).toBe(false);
    const flag = calls.find(([s]) => s.toLowerCase().includes('update users set tax_exempt'));
    expect(flag[1]).toEqual([USER, false]);
  });

  test('[#13] state/jurisdiction and expiration date can be recorded on review', async () => {
    const { client, calls } = mockClient([
      ['select id from buyer_tax_exemptions', { rows: [{ id: EX }], rowCount: 1 }],
      ['update buyer_tax_exemptions set', { rows: [{ id: EX, status: 'approved', jurisdiction_state: 'CA' }], rowCount: 1 }],
    ]);
    db.connect.mockResolvedValue(client);
    await svc.reviewExemption(USER, 'admin-1', { status: 'approved', jurisdiction_state: 'CA', expiration_date: '2027-12-31', exemption_type: 'state_exemption' });
    const upd = calls.find(([s]) => s.toLowerCase().includes('update buyer_tax_exemptions set'));
    // params: [userId, status, admin_notes, effective_date, expiration_date, jurisdiction_state, exemption_type, actorId]
    expect(upd[1]).toEqual([USER, 'approved', null, null, '2027-12-31', 'CA', 'state_exemption', 'admin-1']);
  });

  test('rejects an invalid review status', async () => {
    await expect(svc.reviewExemption(USER, 'admin-1', { status: 'bogus' })).rejects.toThrow(/status must be/i);
  });
});

describe('Privacy + unaffected normal flow', () => {
  test('[#14] the private certificate is never exposed in buyer/admin record bodies', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql).toLowerCase();
      if (s.includes('from buyer_tax_exemptions where buyer_user_id')) return { rows: [{ id: EX, status: 'approved', jurisdiction_state: 'TX', original_filename: 'cert.pdf' }] };
      if (s.includes('select tax_exempt from users')) return { rows: [{ tax_exempt: true }] };
      if (s.includes('join users u on u.id = e.buyer_user_id')) return { rows: [{ id: EX, status: 'approved', has_document: true, tax_exempt: true }] };
      return { rows: [], rowCount: 0 };
    });
    const buyerView = await svc.getForBuyer(USER);
    expect(buyerView).not.toHaveProperty('storage_public_id');
    const adminView = await svc.getForAdmin(USER);
    expect(adminView).not.toHaveProperty('storage_public_id');
    expect(adminView.has_document).toBe(true);             // presence only, not the id
    // No PUBLIC route or SEO surface references the table.
    const publicPages = ['../src/routes/marketplace', '../src/routes/publicApi'].map(p => { try { return fs.readFileSync(require.resolve(p), 'utf8'); } catch (e) { return ''; } }).join('');
    expect(publicPages).not.toMatch(/buyer_tax_exemptions/);
  });

  test('[#15] a normal buyer with no request is simply not_submitted / not exempt', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql).toLowerCase();
      if (s.includes('from buyer_tax_exemptions where buyer_user_id')) return { rows: [] };
      if (s.includes('select tax_exempt from users')) return { rows: [{ tax_exempt: false }] };
      return { rows: [] };
    });
    const view = await svc.getForBuyer(USER);
    expect(view).toEqual({ status: 'not_submitted', tax_exempt: false });
  });
});

describe('Tax calculation honors an approved exemption', () => {
  const approvedTX = { status: 'approved', jurisdiction_state: 'TX', effective_date: '2026-01-01', expiration_date: null };

  test('[#16] an approved applicable exemption produces ZERO sales tax; others compute normally', () => {
    // Approved + applicable state → 0.
    expect(svc.salesTaxCents({ taxableCents: 10000, rateBps: 825, exemption: approvedTX, state: 'TX', date: '2026-08-01' })).toBe(0);
    // Not approved (pending) → normal tax.
    expect(svc.salesTaxCents({ taxableCents: 10000, rateBps: 825, exemption: { status: 'under_review' }, state: 'TX' })).toBe(825);
    // No exemption → normal tax.
    expect(svc.salesTaxCents({ taxableCents: 10000, rateBps: 825, exemption: null, state: 'TX' })).toBe(825);
    // Approved but WRONG state → normal (never assumed nationwide).
    expect(svc.salesTaxCents({ taxableCents: 10000, rateBps: 825, exemption: approvedTX, state: 'CA', date: '2026-08-01' })).toBe(825);
    // Approved but EXPIRED → normal.
    const expired = { status: 'approved', jurisdiction_state: 'TX', effective_date: '2026-01-01', expiration_date: '2026-06-01' };
    expect(svc.salesTaxCents({ taxableCents: 10000, rateBps: 825, exemption: expired, state: 'TX', date: '2026-08-01' })).toBe(825);
  });

  test('sales tax is NOT globally enabled by this work (invoice path still hard-zeroes tax)', () => {
    const combined = fs.readFileSync(require.resolve('../src/services/combinedInvoiceService'), 'utf8');
    expect(combined).toMatch(/const salesTaxCents = 0;/);   // unchanged stub — no global tax activation
  });
});
