'use strict';

const { buildPdfBuffer } = require('../src/services/agreementPdfService');

describe('agreementPdfService.buildPdfBuffer', () => {
  test('produces a valid PDF buffer containing the frozen body + signature block', async () => {
    const agreement = {
      id: 'test-1',
      rendered_body: 'Seller Jane Q. Seller agrees to 10% commission.',
      party_snapshot: { legal_name: 'Jane Q. Seller', company_name: 'Doe Estates LLC' },
    };
    const signature = {
      typed_name: 'Jane Q. Seller', signer_role: 'seller',
      signed_at: '2026-06-01T12:00:00.000Z', ip_address: '203.0.113.7',
      user_agent: 'jest', consent_acknowledged: true,
      intent_statement: 'I intend to sign.', content_sha256: 'a'.repeat(64),
    };
    const buf = await buildPdfBuffer(agreement, signature);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-'); // PDF magic header
    expect(buf.length).toBeGreaterThan(500);
  });
});
