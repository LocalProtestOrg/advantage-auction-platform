// #20.1 Realized-price privacy — unit tests for the gating helper used by
// GET /api/lots/:lotId and GET /api/lots/auction/:auctionId.
const { redactRealizedPrice } = require('../src/lib/realizedPrice');

const closedLot = { id: 'l1', state: 'closed', winning_amount_cents: 4200, current_bid_cents: 4200, next_min_bid_cents: 4700, bid_count: 7, title: 'X' };
const openLot   = { id: 'l2', state: 'open',   winning_amount_cents: null, current_bid_cents: 3000, next_min_bid_cents: 3500, bid_count: 3, title: 'Y' };

describe('#20.1 realized-price gating', () => {
  test('anonymous + CLOSED lot → realized price hidden', () => {
    const r = redactRealizedPrice(closedLot, false);
    expect(r.winning_amount_cents).toBeNull();
    expect(r.current_bid_cents).toBeNull();
    expect(r.next_min_bid_cents).toBeNull();
    expect(r.realized_price_hidden).toBe(true);
    // non-price fields preserved (browsing still works)
    expect(r.title).toBe('X');
    expect(r.bid_count).toBe(7);
  });

  test('logged-in + CLOSED lot → realized price visible', () => {
    const r = redactRealizedPrice(closedLot, true);
    expect(r.winning_amount_cents).toBe(4200);
    expect(r.current_bid_cents).toBe(4200);
    expect(r.realized_price_hidden).toBeUndefined();
  });

  test('anonymous + OPEN lot → live current bid stays public', () => {
    const r = redactRealizedPrice(openLot, false);
    expect(r.current_bid_cents).toBe(3000);
    expect(r.next_min_bid_cents).toBe(3500);
    expect(r.realized_price_hidden).toBeUndefined();
  });

  test('logged-in + OPEN lot → unchanged', () => {
    const r = redactRealizedPrice(openLot, true);
    expect(r).toBe(openLot);
  });

  test('does not mutate the input row', () => {
    const copy = Object.assign({}, closedLot);
    redactRealizedPrice(closedLot, false);
    expect(closedLot).toEqual(copy);
  });
});
