'use strict';

/**
 * Marketplace privacy regression (Requirement 5).
 *
 * The public Marketplace must never expose private contact/address PII. Individual/private
 * sellers are NOT directory companies — the marketplace feed queries only source='bd_import'
 * public business listings, and returns a fixed safe field allowlist. Event (auction) markers
 * are a separate, live-queried layer that disappears when an auction is unpublished.
 *
 * This is a source-level guard: it fails if the /marketplace handler ever starts selecting or
 * returning private fields (email, phone, street address, contact_*). It complements the live
 * API checks in the staging validation run.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'public.js'), 'utf8');

// Extract the GET /marketplace handler body (up to the next route definition).
function handlerBody(marker) {
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const after = src.slice(start);
  const end = after.indexOf("router.get('/marketplace/:orgId/auctions'");
  return after.slice(0, end > -1 ? end : 4000);
}

describe('public marketplace feed exposes no private PII', () => {
  const body = handlerBody("router.get('/marketplace'");

  test('queries only the public directory mirror (source = bd_import)', () => {
    expect(body).toMatch(/source\s*=\s*'bd_import'/);
  });

  test('does not select or return contact PII', () => {
    // guard against email / phone / raw street address / contact_* creeping into the feed
    expect(body).not.toMatch(/contact_email|contact_phone/);
    expect(body).not.toMatch(/\bemail\b/i);
    expect(body).not.toMatch(/phone_number|\bphone\b/i);
    expect(body).not.toMatch(/street_address|address1|address_line/i);
  });

  test('the returned card object is limited to safe, public fields', () => {
    // the response mapping must not add PII keys
    expect(body).not.toMatch(/email:\s*r\./);
    expect(body).not.toMatch(/phone:\s*r\./);
    expect(body).not.toMatch(/street:\s*r\./);
  });
});
