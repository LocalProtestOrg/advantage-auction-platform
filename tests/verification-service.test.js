'use strict';

/**
 * verificationService — admin-requested documents, risk, publication gate, fraud
 * warnings. Keyword-dispatch db mock + mocked storage/email.
 */
jest.mock('../src/db/index', () => ({ query: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue({ messageId: 'm' }) }));
jest.mock('../src/services/cloudinaryService', () => ({ uploadBuffer: jest.fn().mockResolvedValue({ public_id: 'vdoc-1', format: 'pdf', bytes: 10 }) }));
jest.mock('cloudinary', () => ({ v2: { utils: { private_download_url: jest.fn(() => 'https://signed/example') } } }));

const db = require('../src/db/index');
const cloud = require('../src/services/cloudinaryService');
const v = require('../src/services/verificationService');

function route(routes) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql).toLowerCase();
    for (const [kw, rows] of routes) if (s.includes(kw)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  });
}
beforeEach(() => { db.query.mockReset(); cloud.uploadBuffer.mockClear(); });

describe('publicationGate (only blocks when flagged AND not approved)', () => {
  test('not flagged → not blocked', async () => {
    route([['verification_required_before_publication', [{ verification_required_before_publication: false }]]]);
    expect(await v.publicationGate('sp1')).toEqual({ blocked: false, reason: 'not_required' });
  });
  test('flagged + no approved verification → blocked', async () => {
    route([
      ['verification_required_before_publication', [{ verification_required_before_publication: true }]],
      ["status='approved'", []],
    ]);
    expect(await v.publicationGate('sp1')).toEqual({ blocked: true, reason: 'verification_required' });
  });
  test('flagged + approved verification → not blocked', async () => {
    route([
      ['verification_required_before_publication', [{ verification_required_before_publication: true }]],
      ["status='approved'", [{ '?column?': 1 }]],
    ]);
    expect(await v.publicationGate('sp1')).toEqual({ blocked: false, reason: 'verified' });
  });
});

describe('createRequest validation', () => {
  test('rejects empty categories', async () => {
    route([['from seller_profiles', [{ id: 'sp1' }]]]);
    await expect(v.createRequest('sp1', { categories: [] }, 'admin1')).rejects.toMatchObject({ code: 'CATEGORIES_REQUIRED' });
  });
  test('rejects invalid category', async () => {
    route([['from seller_profiles', [{ id: 'sp1' }]]]);
    await expect(v.createRequest('sp1', { categories: ['government_id', 'bogus'] }, 'admin1')).rejects.toMatchObject({ code: 'INVALID_CATEGORY' });
  });
  test('unknown seller → 404', async () => {
    route([]); // seller_profiles returns []
    await expect(v.createRequest('spX', { categories: ['passport'] }, 'admin1')).rejects.toMatchObject({ code: 'SELLER_NOT_FOUND', status: 404 });
  });
});

describe('setRisk validation', () => {
  test('rejects invalid risk_level', async () => {
    route([['from seller_profiles', [{ id: 'sp1' }]]]);
    await expect(v.setRisk('sp1', 'admin1', { risk_level: 'extreme' })).rejects.toMatchObject({ code: 'INVALID_RISK' });
  });
  test('requires at least one field', async () => {
    route([['from seller_profiles', [{ id: 'sp1' }]]]);
    await expect(v.setRisk('sp1', 'admin1', {})).rejects.toMatchObject({ code: 'NO_FIELDS' });
  });
});

describe('uploadDocument', () => {
  const ok = 'data:application/pdf;base64,' + Buffer.from('hello pdf').toString('base64');
  test('rejects upload to someone else\'s request (403)', async () => {
    route([
      ['from verification_requests', [{ id: 'r1', seller_profile_id: 'spOWNER', status: 'open' }]],
      ['where user_id', [{ id: 'spOTHER' }]],
    ]);
    await expect(v.uploadDocument('r1', 'user2', { category: 'passport', dataBase64: ok })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(cloud.uploadBuffer).not.toHaveBeenCalled();
  });
  test('stores a valid document privately and returns submitted', async () => {
    route([
      ['from verification_requests', [{ id: 'r1', seller_profile_id: 'sp1', status: 'open' }]],
      ['where user_id', [{ id: 'sp1' }]],
      ['insert into verification_documents', [{ id: 'd1', category: 'passport', status: 'submitted', uploaded_at: 'now' }]],
    ]);
    const out = await v.uploadDocument('r1', 'user1', { category: 'passport', filename: 'p.pdf', contentType: 'application/pdf', dataBase64: ok });
    expect(out).toMatchObject({ id: 'd1', category: 'passport', status: 'submitted' });
    expect(cloud.uploadBuffer).toHaveBeenCalledTimes(1);
    const opts = cloud.uploadBuffer.mock.calls[0][1];
    expect(opts.type).toBe('private');          // private storage
    expect(opts.resource_type).toBe('raw');
    expect(opts.folder).toBe('verification-documents');
  });
});

describe('duplicateWarnings (passive; never blocks)', () => {
  test('surfaces same_phone and same_name_address', async () => {
    route([
      ['left join seller_identity', [{ phone: '865-555-1212', legal_name: 'Jane Doe', address_line1: '1 Main St', postal_code: '37902', email: 'jane@x.com' }]],
      ['where phone =', [{ seller_profile_id: 'spDUP' }]],
      ['from users where lower(email)', []],
      ['lower(legal_name)', [{ seller_profile_id: 'spDUP2' }]],
    ]);
    const w = await v.duplicateWarnings('sp1');
    const types = w.map((x) => x.type).sort();
    expect(types).toEqual(['same_name_address', 'same_phone']);
  });
  test('no identity → no warnings', async () => {
    route([]); // identity row not found
    expect(await v.duplicateWarnings('sp1')).toEqual([]);
  });
});
