'use strict';

/**
 * H-1 launch support (Part A) — Professional Seller BUSINESS verification.
 * Reuses verification_requests / verification_documents / secure private storage. Mocked DB + storage.
 * The 8 required Part-A assertions are labelled [#n].
 */
const fs = require('fs');

jest.mock('../src/db/index', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue({ messageId: 'm' }) }));
jest.mock('../src/services/cloudinaryService', () => ({ uploadBuffer: jest.fn().mockResolvedValue({ public_id: 'vdoc-1', format: 'pdf', bytes: 10 }) }));
jest.mock('cloudinary', () => ({ v2: { utils: { private_download_url: jest.fn(() => 'https://signed/example') } } }));
jest.mock('../src/lib/uploadValidation', () => ({
  validateDocumentUpload: jest.fn(() => ({ safeFilename: 'ein.pdf', mime: 'application/pdf' })),
  ALLOWED: { 'application/pdf': ['pdf'] },
}));

const db = require('../src/db/index');
const cloud = require('../src/services/cloudinaryService');
const v = require('../src/services/verificationService');

const SP = 'sp-1', REQ = 'req-1', DOC = 'doc-1', USER = 'u-1';
beforeEach(() => { db.query.mockReset(); cloud.uploadBuffer.mockClear(); });

// Route the DB by distinctive lowercased SQL substrings (order = specific first).
function routeBusinessSubmit({ sellerType = 'auction_house', existingRequest = null } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql).toLowerCase();
    if (s.includes('from seller_profiles where user_id')) return { rows: [{ id: SP }], rowCount: 1 };
    if (s.includes('insert into seller_identity')) return { rows: [], rowCount: 1 };
    if (s.includes('from verification_requests vr') && s.includes('limit 1')) return { rows: existingRequest ? [existingRequest] : [], rowCount: existingRequest ? 1 : 0 };
    if (s.includes('insert into verification_requests')) return { rows: [{ id: REQ, seller_profile_id: SP, status: 'open' }], rowCount: 1 };
    if (s.includes('insert into verification_request_categories')) return { rows: [], rowCount: 1 };
    if (s.includes('select * from verification_requests where id')) return { rows: [{ id: REQ, seller_profile_id: SP, status: 'open' }], rowCount: 1 };
    if (s.includes('insert into verification_documents')) return { rows: [{ id: DOC, category: 'ein_verification', status: 'submitted', uploaded_at: 't' }], rowCount: 1 };
    if (s.includes('update verification_requests set status')) return { rows: [], rowCount: 1 };
    if (s.includes('from seller_profiles sp left join seller_identity')) return { rows: [{ seller_type: sellerType, legal_name: 'Acme LLC', dba_name: null, ein: '12-3456789', address_line1: '1 A St', city: 'X', state: 'TX', postal_code: '70000', country: 'US' }], rowCount: 1 };
    if (s.includes('verification_required_before_publication from seller_profiles')) return { rows: [{ verification_required_before_publication: sellerType === 'private' ? false : true }], rowCount: 1 };
    if (s.includes("status='approved'")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
}

describe('Professional business verification', () => {
  test('[#1] professional can upload a business verification document', async () => {
    routeBusinessSubmit({ sellerType: 'auction_house' });
    const out = await v.submitBusinessVerification(USER, {
      businessInfo: { legal_business_name: 'Acme LLC', ein: '12-3456789' },
      category: 'ein_verification', filename: 'ein.pdf', contentType: 'application/pdf', dataBase64: 'Zm9v',
    });
    expect(out.status).toBe('submitted');
    expect(out.document.category).toBe('ein_verification');
    // A document row was inserted.
    expect(db.query.mock.calls.some(c => /insert into verification_documents/i.test(c[0]))).toBe(true);
  });

  test('[#3] the submitted business document is stored PRIVATELY (never public)', async () => {
    routeBusinessSubmit();
    await v.submitBusinessVerification(USER, { businessInfo: {}, category: 'business_registration', filename: 'reg.pdf', contentType: 'application/pdf', dataBase64: 'Zm9v' });
    const opts = cloud.uploadBuffer.mock.calls[0][1];
    expect(opts.type).toBe('private');
    expect(opts.resource_type).toBe('raw');
    expect(opts.folder).toBe('verification-documents');
  });

  test('only business categories are accepted for business verification', async () => {
    routeBusinessSubmit();
    await expect(v.submitBusinessVerification(USER, { category: 'government_id', filename: 'x.pdf', contentType: 'application/pdf', dataBase64: 'Zm9v' }))
      .rejects.toThrow(/business document category/i);
    expect(v.BUSINESS_DOCUMENT_CATEGORIES).toEqual(['ein_verification', 'business_registration', 'business_license']);
  });

  test('[#2] individual seller is NOT forced through business verification (gate open)', async () => {
    routeBusinessSubmit({ sellerType: 'private' });
    const status = await v.businessVerificationStatus(USER);
    expect(status.gate.blocked).toBe(false);       // individuals are never gated
    expect(status.status).toBe('not_submitted');
  });

  test('EIN is masked in seller-facing business info (never the raw value)', async () => {
    routeBusinessSubmit();
    const info = await v.getBusinessInfo(SP);        // seller-facing (default masks)
    expect(info.ein).toBe('**-***6789');
    expect(info.ein).not.toContain('12-3456789');
    const adminInfo = await v.getBusinessInfo(SP, { includeEin: true });
    expect(adminInfo.ein).toBe('12-3456789');        // admin review sees the full value
  });
});

describe('Publication gate + admin review (reused)', () => {
  function routeGate({ flag, approved }) {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql).toLowerCase();
      if (s.includes('verification_required_before_publication from seller_profiles')) return { rows: [{ verification_required_before_publication: flag }] };
      if (s.includes("status='approved'")) return { rows: approved ? [{ '?column?': 1 }] : [], rowCount: approved ? 1 : 0 };
      if (s.includes('update verification_requests set status')) return { rows: [{ id: REQ, status: 'approved', seller_profile_id: SP }], rowCount: 1 };
      if (s.includes('from verification_requests where id')) return { rows: [{ id: REQ, seller_profile_id: SP, status: 'approved' }], rowCount: 1 };
      if (s.includes('from verification_request_categories')) return { rows: [] };
      if (s.includes('from verification_documents')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
  }

  test('[#4] admin can review (approve) a verification request', async () => {
    routeGate({ flag: true, approved: true });
    const out = await v.reviewRequest(REQ, 'admin-1', { status: 'approved' });
    expect(out.status).toBe('approved');
  });

  test('[#5]/[#7] admin approval opens the publication gate (approved professional can publish)', async () => {
    routeGate({ flag: true, approved: true });
    expect(await v.publicationGate(SP)).toEqual({ blocked: false, reason: 'verified' });
  });

  test('[#6] a pending/rejected professional cannot publish the first sale', async () => {
    routeGate({ flag: true, approved: false });
    expect(await v.publicationGate(SP)).toEqual({ blocked: true, reason: 'verification_required' });
  });

  test('[#8] building an auction/catalog is not gated (gate lives only in the publish path)', () => {
    const src = fs.readFileSync(require.resolve('../src/services/auctionService'), 'utf8');
    // Gate lives only in the publish path (publishAuction) + the auto-publish eligibility read — never in
    // the build/edit (updateAuction) path.
    const updateBody = src.slice(src.indexOf('async function updateAuction'), src.indexOf('async function assessAuctionDeletable'));
    expect(updateBody).not.toMatch(/publicationGate/);
    expect(src.slice(src.indexOf('async function publishAuction'))).toMatch(/publicationGate/);
    const lots = fs.readFileSync(require.resolve('../src/services/lotService'), 'utf8');
    expect(lots).not.toMatch(/publicationGate/);
  });
});
