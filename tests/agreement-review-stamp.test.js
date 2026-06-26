'use strict';

/**
 * Seller agreement download/print + timestamp-protection (launch-stabilization).
 * Proves the printable/downloadable copy carries version + effective date +
 * generated timestamp/timezone + seller + "current version controls" disclaimer,
 * and that the unsigned review PDF generates.
 */
const svc = require('../src/services/agreementPdfService');

const AGREEMENT = {
  version_int: 3,
  party_snapshot: { legal_name: 'Jane Q. Seller', company_name: 'Estate Co' },
  resolved_variables: { effective_date: '2026-06-25' },
  rendered_body: 'These are the seller agreement terms.',
};
const FIXED_NOW = new Date('2026-06-25T14:30:00Z');

describe('agreementStampLines — version/timestamp protection', () => {
  const lines = svc.agreementStampLines(AGREEMENT, FIXED_NOW);
  const text = lines.join('\n');

  test('includes the agreement version', () => {
    expect(text).toMatch(/Agreement version: v3/);
  });
  test('includes the effective date when available', () => {
    expect(text).toMatch(/Effective date: 2026-06-25/);
  });
  test('includes a generated timestamp with timezone (UTC, deterministic)', () => {
    expect(text).toMatch(/Copy generated: 2026-06-25 14:30:00 UTC \(timezone: UTC\)/);
  });
  test('includes the seller name/account', () => {
    expect(text).toMatch(/Prepared for: Jane Q\. Seller \/ Estate Co/);
  });
  test('states current active version controls future acceptances', () => {
    expect(text).toMatch(/current active agreement version controls/i);
  });

  test('degrades gracefully when version/effective/seller are missing', () => {
    const t = svc.agreementStampLines({ rendered_body: 'x' }, FIXED_NOW).join('\n');
    expect(t).toMatch(/Agreement version: current version/);
    expect(t).not.toMatch(/Effective date:/);   // omitted when absent
    expect(t).toMatch(/Copy generated: .* UTC/); // timestamp always present
    expect(t).toMatch(/current active agreement version controls/i);
  });

  test('accepts version under either version_int or version', () => {
    expect(svc.agreementStampLines({ version: 7 }, FIXED_NOW).join('\n')).toMatch(/Agreement version: v7/);
  });
});

describe('unsigned review PDF', () => {
  test('generates a valid PDF buffer (downloadable before acceptance)', async () => {
    const buf = await svc.buildUnsignedPdfBuffer(AGREEMENT);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(800);
  });
  test('generates even when optional metadata is absent', async () => {
    const buf = await svc.buildUnsignedPdfBuffer({ rendered_body: 'terms only' });
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });
});
