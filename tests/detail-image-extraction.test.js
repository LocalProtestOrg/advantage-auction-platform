'use strict';

/**
 * Detail-page image extraction engine + its use by the enrichment service.
 * Verifies discovery order, logo/icon/pixel rejection, absolutization, and that enrichment fetches
 * the ORIGINAL-host detail page, validates, re-hosts, and stores with provenance — never defeating
 * auth and never failing ingestion.
 */
const { extractImageCandidates, acceptable } = require('../src/services/eventImport/detailImage');
const enrich = require('../src/services/eventImport/imageEnrichment');

const BASE = 'https://auctioneer.example.com/sale/123';

describe('extractImageCandidates — discovery order + rejection', () => {
  test('JSON-LD image ranks first, then og:image, then hero content image', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Event","image":["https://cdn.ex.com/jsonld.jpg"]}</script>
      <meta property="og:image" content="https://cdn.ex.com/og.jpg">
      </head><body><img class="hero" src="https://cdn.ex.com/hero.jpg" width="900"></body></html>`;
    expect(extractImageCandidates(html, BASE)).toEqual([
      'https://cdn.ex.com/jsonld.jpg', 'https://cdn.ex.com/og.jpg', 'https://cdn.ex.com/hero.jpg',
    ]);
  });
  test('og:image works with reversed attribute order + relative URL is absolutized', () => {
    const html = '<meta content="/img/social.jpg" property="og:image">';
    expect(extractImageCandidates(html, BASE)).toEqual(['https://auctioneer.example.com/img/social.jpg']);
  });
  test('rejects logos, favicons, sprites, svg icons, ad/tracking pixels', () => {
    const html = `<body>
      <img src="/logo.png" width="140">
      <img src="/favicon.ico">
      <img src="/assets/sprite.png">
      <img src="/icons/cart.svg">
      <img src="https://track.co/pixel.gif" width="1" height="1">
      <img src="https://doubleclick.net/ad.jpg"></body>`;
    expect(extractImageCandidates(html, BASE)).toEqual([]);
  });
  test('drops tiny (<200px) images but keeps large content photos', () => {
    const html = '<img src="https://cdn.ex.com/thumb.jpg" width="80"><img src="https://cdn.ex.com/big.jpg" width="800">';
    expect(extractImageCandidates(html, BASE)).toEqual(['https://cdn.ex.com/big.jpg']);
  });
  test('de-dupes repeated candidates', () => {
    const html = '<meta property="og:image" content="https://cdn.ex.com/a.jpg"><img src="https://cdn.ex.com/a.jpg" width="600">';
    expect(extractImageCandidates(html, BASE)).toEqual(['https://cdn.ex.com/a.jpg']);
  });
  test('malformed JSON-LD block does not throw', () => {
    const html = '<script type="application/ld+json">{ not json </script><meta property="og:image" content="https://cdn.ex.com/ok.jpg">';
    expect(extractImageCandidates(html, BASE)).toEqual(['https://cdn.ex.com/ok.jpg']);
  });
  test('acceptable() guards protocol + rejects known-bad', () => {
    expect(acceptable('https://cdn.ex.com/p.jpg')).toBe(true);
    expect(acceptable('https://cdn.ex.com/logo.png')).toBe(false);
    expect(acceptable('ftp://x/p.jpg')).toBe(false);
  });
});

describe('enrichment via detail-page (original host) — end to end (mocked I/O)', () => {
  const dbNoImages = { query: async (sql, params) => { if (/INSERT INTO event_images/.test(sql)) { dbNoImages._ins = params; return { rows: [] }; } return { rows: [] }; } };

  test('fetches the original event page, extracts a real image, re-hosts, stores provenance', async () => {
    const ev = { id: 'e1', sale_type: 'auction', external_url: 'https://auctioneer.example.com/sale/9' };
    const r = await enrich.enrichEvent(ev, {
      db: dbNoImages,
      fetchText: async () => '<meta property="og:image" content="https://cdn.ex.com/real.jpg">',
      fetchImage: async () => ({ status: 200, ctype: 'image/jpeg', body: Buffer.alloc(4096) }),
      uploadBuffer: async () => ({ secure_url: 'https://res.cloudinary.com/x/event-images/real.jpg' }),
    });
    expect(r.enriched).toBe(true);
    expect(dbNoImages._ins).toContain('https://res.cloudinary.com/x/event-images/real.jpg'); // re-hosted stored
    expect(dbNoImages._ins).toContain('https://cdn.ex.com/real.jpg');                          // provenance source_url
  });

  test('login-gated / directory / gov-surplus hosts are NOT scraped for images', async () => {
    for (const url of ['https://www.gsaauctions.gov/x', 'https://www.estatesales.net/x', 'https://www.ppms.gov/i']) {
      const r = await enrich.enrichEvent({ id: 'g', sale_type: 'auction', external_url: url }, {
        db: { query: async () => ({ rows: [] }) },
        fetchText: async () => { throw new Error('should not fetch a skipped host'); },
      });
      expect(r.enriched).toBe(false);
      expect(r.reason).toBe('no_public_image_available');
    }
  });

  test('a detail page whose only images are logos → no image, placeholder kept (not a failure)', async () => {
    const r = await enrich.enrichEvent({ id: 'e2', sale_type: 'auction', external_url: 'https://co.example.com/s' }, {
      db: { query: async () => ({ rows: [] }) },
      fetchText: async () => '<img src="/logo.png"><img src="/favicon.ico">',
    });
    expect(r.enriched).toBe(false);
    expect(r.reason).toBe('no_public_image_available');
  });

  test('detail-page fetch failure never throws (best-effort)', async () => {
    const r = await enrich.enrichEvent({ id: 'e3', sale_type: 'auction', external_url: 'https://co.example.com/s' }, {
      db: { query: async () => ({ rows: [] }) },
      fetchText: async () => { throw new Error('network down'); },
    });
    expect(r.enriched).toBe(false); // resolves to no candidates, not a thrown error
  });

  test('a candidate that returns 401 is skipped; the next valid candidate is used', async () => {
    const ins = [];
    const db = { query: async (sql, params) => { if (/INSERT/.test(sql)) ins.push(params); return { rows: [] }; } };
    let call = 0;
    const r = await enrich.enrichEvent({ id: 'e4', sale_type: 'auction', external_url: 'https://co.example.com/s' }, {
      db,
      fetchText: async () => '<script type="application/ld+json">{"@type":"Event","image":["https://cdn.ex.com/gated.jpg","https://cdn.ex.com/good.jpg"]}</script>',
      fetchImage: async () => (++call === 1 ? { status: 401, ctype: 'application/json', body: Buffer.from('{"error":"login"}') } : { status: 200, ctype: 'image/jpeg', body: Buffer.alloc(4096) }),
      uploadBuffer: async () => ({ secure_url: 'https://res.cloudinary.com/x/good.jpg' }),
    });
    expect(r.enriched).toBe(true);
    expect(ins[0]).toContain('https://cdn.ex.com/good.jpg'); // provenance = the second (valid) candidate
  });
});
