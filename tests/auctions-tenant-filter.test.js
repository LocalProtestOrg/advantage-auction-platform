'use strict';

/**
 * Canonical Auction Distribution — tenant-scoped auction filter (company-specific widgets).
 *
 * Guards the CLAUDE.md rule: company/organization widgets must filter by a STABLE UUID
 * (organization or seller id), NEVER by company-name text, and must never be able to expose
 * another organization's auctions. Source-level guard on the GET /api/public/auctions handler
 * (route-level SQL; behavior is exercised live in the staging validation run).
 */

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'public.js'), 'utf8');

// Extract the GET /api/public/auctions handler (up to the next route).
function auctionsHandler() {
  const start = src.indexOf("router.get('/auctions'");
  expect(start).toBeGreaterThan(-1);
  const after = src.slice(start);
  const end = after.indexOf("router.get('/auctions/near'");
  return after.slice(0, end > -1 ? end : 6000);
}

describe('GET /api/public/auctions tenant filter', () => {
  const body = auctionsHandler();

  test('accepts organization_id and seller_id filters', () => {
    expect(body).toMatch(/q\.organization_id/);
    expect(body).toMatch(/q\.seller_id/);
  });

  test('both tenant ids are UUID-validated (never raw name text)', () => {
    expect(body).toMatch(/validUuid\(q\.organization_id\)/);
    expect(body).toMatch(/validUuid\(q\.seller_id\)/);
  });

  test('organization_id resolves through the stable marketplace link, not a name match', () => {
    expect(body).toMatch(/linked_seller_profile_id\s+FROM\s+organizations\s+WHERE\s+id\s*=/i);
    // must NOT filter auctions by company/organization NAME text
    expect(body).not.toMatch(/organizations?\s+.*name\s+ILIKE/i);
  });

  test('still enforces public visibility (syndicated, not archived)', () => {
    expect(body).toMatch(/marketplace_status\s*=\s*'syndicated'/);
    expect(body).toMatch(/is_archived IS NOT TRUE/);
  });
});
