'use strict';

/**
 * Part A — server-side seller-agreement review acknowledgment in signAgreement.
 * Signing requires reviewed===true; the signature INSERT records it; consent+intent
 * still required; signed-PDF generation still invoked.
 */
jest.mock('../src/db/index');
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/agreementPdfService', () => ({
  generateAndStore: jest.fn().mockResolvedValue({ public_id: 'pid', sha256: 'deadbeef', buffer: Buffer.from('%PDF-') }),
}));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue({ skipped: true }) }));

const db = require('../src/db/index');
const pdfService = require('../src/services/agreementPdfService');
const agreementService = require('../src/services/agreementService');

const SIGNABLE = { id: 'ag1', seller_user_id: 'u1', status: 'sent', rendered_body: 'TERMS' };

function baseArgs(over) {
  return Object.assign({ userId: 'u1', typedName: 'Jane Seller', consent: true, intent: true, reviewed: true, ip: '1.2.3.4', userAgent: 'jest' }, over || {});
}

describe('signAgreement — review acknowledgment', () => {
  let insertSql = null;
  beforeEach(() => {
    insertSql = null;
    db.query = jest.fn(async (sql) => {
      if (/SELECT \* FROM agreements WHERE id/.test(sql)) return { rows: [{ ...SIGNABLE }] };
      if (/INSERT INTO agreement_signatures/.test(sql)) { insertSql = sql; return { rows: [{ id: 'sig1' }] }; }
      if (/UPDATE agreements SET status='signed'/.test(sql)) return { rows: [{ ...SIGNABLE, status: 'signed' }] };
      if (/UPDATE agreements SET signed_pdf_public_id/.test(sql)) return { rows: [{ ...SIGNABLE, status: 'signed', pdf_status: 'stored' }] };
      return { rows: [], rowCount: 0 };
    });
  });

  test('rejects when reviewed is not true (REVIEW_REQUIRED) and writes no signature', async () => {
    await expect(agreementService.signAgreement('ag1', baseArgs({ reviewed: false })))
      .rejects.toMatchObject({ code: 'REVIEW_REQUIRED', status: 400 });
    expect(insertSql).toBeNull();
  });

  test('rejects when reviewed is omitted', async () => {
    const args = baseArgs(); delete args.reviewed;
    await expect(agreementService.signAgreement('ag1', args)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
  });

  test('still requires consent + intent (existing behavior) even with reviewed=true', async () => {
    await expect(agreementService.signAgreement('ag1', baseArgs({ consent: false })))
      .rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await expect(agreementService.signAgreement('ag1', baseArgs({ intent: false })))
      .rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  test('succeeds with reviewed+consent+intent: records reviewed_acknowledged and generates signed PDF', async () => {
    const res = await agreementService.signAgreement('ag1', baseArgs());
    expect(res.agreement.status).toBe('signed');
    // signature INSERT must persist the review acknowledgment columns
    expect(insertSql).toMatch(/reviewed_acknowledged/);
    expect(insertSql).toMatch(/reviewed_acknowledged_at/);
    // signed-PDF generation still invoked
    expect(pdfService.generateAndStore).toHaveBeenCalled();
  });
});
