'use strict';

/**
 * Auction image enrichment + 3-tier fallback hierarchy.
 * Preserves: publication is NEVER blocked by a missing GSA image (placeholder), auth is never
 * defeated (login-gated/401 → skip), enrichment failure never throws into ingestion.
 */
const gsp = require('../src/lib/govSurplusPlaceholder');
const enrich = require('../src/services/eventImport/imageEnrichment');

describe('3-tier image fallback (govSurplusPlaceholder.eventImage)', () => {
  test('tier 1: a real, publicly-usable image wins', () => {
    expect(gsp.eventImage('https://cdn.example.com/a.jpg', 'https://co.com/x', 'auction')).toBe('https://cdn.example.com/a.jpg');
  });
  test('tier 2: gov-surplus placeholder for gsaauctions.gov events with no usable image', () => {
    expect(gsp.eventImage(null, 'https://www.gsaauctions.gov/x', 'auction')).toBe(gsp.GOV_SURPLUS_PLACEHOLDER);
    expect(gsp.eventImage('https://www.ppms.gov/i.jpg', 'https://www.gsaauctions.gov/x', 'auction')).toBe(gsp.GOV_SURPLUS_PLACEHOLDER);
  });
  test('tier 3: generic auction placeholder for non-gov AUCTION events with no image', () => {
    expect(gsp.eventImage(null, 'https://someauctioneer.com/x', 'auction')).toBe(gsp.AUCTION_PARTNER_PLACEHOLDER);
  });
  test('estate sales are NOT given the auction placeholder (no mislabeling)', () => {
    expect(gsp.eventImage(null, 'https://someco.com/x', 'estate_sale')).toBeNull();
  });
  test('coverImageSql: 2-tier by default; 3-tier only when a sale_type column is supplied', () => {
    expect(gsp.coverImageSql('img')).not.toMatch(/auction-partner-placeholder/);
    expect(gsp.coverImageSql('img', 'e.external_url', 'e.sale_type')).toMatch(/auction-partner-placeholder\.svg/);
    // login-gated ppms is always nulled before fallback
    expect(gsp.coverImageSql('img', 'e.external_url', 'e.sale_type')).toMatch(/ppms\.gov.*THEN NULL/);
  });
});

describe('imageEnrichment — never defeats auth, never breaks ingestion', () => {
  const ev = { id: 'e1', sale_type: 'auction', external_url: 'https://www.gsaauctions.gov/x' };
  const noImages = { query: async () => ({ rows: [] }) };

  test('GSA event → no publicly-available image (login-gated source) → placeholder kept', async () => {
    const r = await enrich.enrichEvent(ev, { db: noImages });
    expect(r.enriched).toBe(false);
    expect(r.reason).toBe('no_public_image_available');
  });

  test('a login-gated (401) candidate is rejected, not stored', async () => {
    const r = enrich.isUsableImageResponse({ status: 401, ctype: 'application/json', body: Buffer.from('{"message":"Please login again"}') });
    expect(r.ok).toBe(false); expect(r.reason).toBe('login_gated');
  });
  test('a 200 that is actually a JSON login error (not an image) is rejected', () => {
    const r = enrich.isUsableImageResponse({ status: 200, ctype: 'application/json;charset=ISO-8859-1', body: Buffer.alloc(600) });
    expect(r.ok).toBe(false); expect(r.reason).toBe('not_an_image');
  });
  test('a genuine public image (200 + image/*) is accepted', () => {
    const r = enrich.isUsableImageResponse({ status: 200, ctype: 'image/jpeg', body: Buffer.alloc(2048) });
    expect(r.ok).toBe(true);
  });
  test('a real public candidate is fetched, re-hosted to managed storage, and stored with provenance', async () => {
    const inserts = [];
    const db = { query: async (sql, params) => { if (/INSERT INTO event_images/.test(sql)) { inserts.push({ sql, params }); return { rows: [] }; } return { rows: [] }; } };
    const r = await enrich.enrichEvent(
      { id: 'e2', sale_type: 'auction', external_url: 'https://auctioneer.com/x', candidate_image_url: 'https://cdn.auctioneer.com/photo.jpg' },
      {
        db,
        fetchImage: async () => ({ status: 200, ctype: 'image/jpeg', body: Buffer.alloc(4096) }),
        uploadBuffer: async () => ({ secure_url: 'https://res.cloudinary.com/x/event-images/abc.jpg' }),
      });
    expect(r.enriched).toBe(true);
    const ins = inserts[0];
    expect(ins.sql).toMatch(/source_url, source_host, retrieved_at/);
    expect(ins.params).toContain('https://res.cloudinary.com/x/event-images/abc.jpg'); // re-hosted URL stored
    expect(ins.params).toContain('https://cdn.auctioneer.com/photo.jpg');             // provenance source_url
  });
  test('enrichment errors never throw (best-effort) — returns a reason instead', async () => {
    const db = { query: async () => { throw new Error('db boom'); } };
    const r = await enrich.enrichEvent(ev, { db });
    expect(r.enriched).toBe(false);
    expect(r.reason).toMatch(/^error:/);
  });
});

describe('publication remains unblocked by missing GSA image (regression guard)', () => {
  const { evaluatePublication } = require('../src/services/eventImport/publicationGate');
  test('GSA future auction with no image still publishes (placeholder)', () => {
    const r = evaluatePublication({
      source: 'imported', title: 'X', start_at: new Date(Date.now() - 864e5).toISOString(),
      end_at: new Date(Date.now() + 7 * 864e5).toISOString(), event_format: 'online', city: 'DC', state: 'DC',
      lat: 1, lng: 1, organizer_name: 'GSA', external_url: 'https://www.gsaauctions.gov/x',
    });
    expect(r.ready).toBe(true);
  });
});
