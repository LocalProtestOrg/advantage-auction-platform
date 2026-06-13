// Email cluster — relevance (staleness guard) + enriched buyer templates.
const { relevance, lotRef, buildLotEmail } = require('../src/lib/notificationContent');

const NOW = new Date('2026-07-01T12:00:00Z');
const openLot = (o = {}) => Object.assign({
  id: 'lot-uuid-1', auction_id: 'auc-1', lot_number: 12, title: 'Vintage Fenton Glass Covered Compote',
  state: 'open', current_bid_cents: 4200, winning_amount_cents: null,
  closes_at: '2026-07-01T13:00:00Z', extended_until: null, thumbnail_url: 'https://img/x.jpg',
}, o);

describe('relevance (staleness guard)', () => {
  test('outbid on an OPEN, not-yet-closed lot → send', () => {
    expect(relevance('OUTBID', openLot(), NOW).send).toBe(true);
  });
  test('outbid on a CLOSED lot → dropped', () => {
    const r = relevance('OUTBID', openLot({ state: 'closed' }), NOW);
    expect(r.send).toBe(false); expect(r.reason).toMatch(/closed/);
  });
  test('closing-soon on a lot whose close time has PASSED → dropped', () => {
    expect(relevance('ENDING_SOON', openLot({ closes_at: '2026-07-01T11:59:00Z' }), NOW).send).toBe(false);
  });
  test('all act-now types are stale once closed', () => {
    for (const t of ['OUTBID', 'LEADING', 'ENDING_SOON', 'CLOSE_TO_WINNING', 'FINAL_SECONDS', 'EXTENDED_BIDDING']) {
      expect(relevance(t, openLot({ state: 'closed' }), NOW).send).toBe(false);
    }
  });
  test('WINNING (you won) is NOT dropped on a closed lot', () => {
    expect(relevance('WINNING', openLot({ state: 'closed' }), NOW).send).toBe(true);
  });
  test('missing lot → dropped (cannot enrich)', () => {
    expect(relevance('OUTBID', null, NOW).send).toBe(false);
  });
  test('non-lot type (e.g. NEW_AUCTION) → always relevant', () => {
    expect(relevance('NEW_AUCTION', null, NOW).send).toBe(true);
  });
});

describe('lotRef — human reference, never a UUID', () => {
  test('Lot # + Title', () => {
    expect(lotRef(openLot())).toBe('Lot #12 — Vintage Fenton Glass Covered Compote');
  });
  test('no lot number falls back gracefully', () => {
    expect(lotRef(openLot({ lot_number: null }))).toBe('Lot — Vintage Fenton Glass Covered Compote');
  });
});

describe('buildLotEmail — enriched, privacy-safe', () => {
  test('OUTBID: subject + body use Lot # + Title, link, image, price — no UUID label', () => {
    const m = buildLotEmail('OUTBID', { lot: openLot(), auction: { title: 'Spring Estate Sale' }, toAddress: 'b@x.com' });
    expect(m.to).toBe('b@x.com');
    expect(m.subject).toContain('Lot #12 — Vintage Fenton Glass Covered Compote');
    expect(m.html).toContain('Lot #12 — Vintage Fenton Glass Covered Compote');
    expect(m.html).toContain('Spring Estate Sale');               // auction title
    expect(m.html).toContain('/lot.html?lotId=lot-uuid-1');       // functional CTA link
    expect(m.html).toContain('https://img/x.jpg');                // lot image
    expect(m.html).toContain('$42.00');                           // current bid
    expect(m.html).not.toContain('Lot ID:');                      // never the old UUID label
    expect(m.text).toContain('Lot #12 — Vintage Fenton Glass Covered Compote');
  });

  test('WINNING: uses winning amount + Complete payment CTA', () => {
    const m = buildLotEmail('WINNING', { lot: openLot({ state: 'closed', winning_amount_cents: 5000 }), auction: { title: 'A' }, toAddress: 'b@x.com' });
    expect(m.subject).toContain('You won');
    expect(m.html).toContain('$50.00');
    expect(m.html).toContain('Complete payment');
  });

  test('title is HTML-escaped', () => {
    const m = buildLotEmail('OUTBID', { lot: openLot({ title: '<script>x</script>' }), auction: null, toAddress: 'b@x.com' });
    expect(m.html).not.toContain('<script>x</script>');
    expect(m.html).toContain('&lt;script&gt;');
  });
});
