'use strict';

/**
 * agreementPdfService.buildUnsignedPdfBuffer — produces a valid, unsigned review
 * PDF from the frozen rendered_body (no signature block). Mirrors the signed-PDF
 * buffer test.
 */
const { buildUnsignedPdfBuffer } = require('../src/services/agreementPdfService');

describe('buildUnsignedPdfBuffer', () => {
  test('returns a valid PDF buffer with the agreement body', async () => {
    const agreement = {
      id: 'a-1',
      party_snapshot: { legal_name: 'Jane Seller', company_name: 'Estate LLC' },
      rendered_body: 'This is the rendered seller agreement body for review.',
    };
    const buf = await buildUnsignedPdfBuffer(agreement);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-'); // PDF magic header
    expect(buf.length).toBeGreaterThan(500);
  });

  test('tolerates a missing/empty body without throwing', async () => {
    const buf = await buildUnsignedPdfBuffer({ id: 'a-2', party_snapshot: {}, rendered_body: '' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
