// #2/#10 viewer_is_high_bidder — privacy-safe high-bidder flag on lot serializers.
const { annotateViewerBidState } = require('../src/lib/viewerBidState');
const { redactRealizedPrice } = require('../src/lib/realizedPrice');

const openLot = (over = {}) => ({
  id: 'lot-1', state: 'open',
  current_bid_cents: 3000, next_min_bid_cents: 3500, effective_bid_increment_cents: 500,
  bid_count: 4, closes_at: '2026-07-01T00:00:00Z',
  current_winner_user_id: 'u1', winning_buyer_user_id: null, winning_amount_cents: null,
  ...over,
});
const closedLot = (over = {}) => ({
  id: 'lot-2', state: 'closed',
  current_bid_cents: 5000, next_min_bid_cents: 5500, effective_bid_increment_cents: 500,
  bid_count: 9, closes_at: '2026-06-01T00:00:00Z',
  current_winner_user_id: 'u1', winning_buyer_user_id: 'u1', winning_amount_cents: 5000,
  ...over,
});

describe('#2/#10 annotateViewerBidState', () => {
  test('logged-out: viewer_is_high_bidder false and NO bidder identity leaked', () => {
    const r = annotateViewerBidState(openLot(), null);
    expect(r.viewer_is_high_bidder).toBe(false);
    expect(r).not.toHaveProperty('current_winner_user_id');
    expect(r).not.toHaveProperty('winning_buyer_user_id');
  });

  test('non-winning bidder → false (and UUIDs still stripped)', () => {
    const r = annotateViewerBidState(openLot(), 'u2');
    expect(r.viewer_is_high_bidder).toBe(false);
    expect(r).not.toHaveProperty('current_winner_user_id');
  });

  test('winning bidder on OPEN lot → true (compares live leader)', () => {
    const r = annotateViewerBidState(openLot(), 'u1');
    expect(r.viewer_is_high_bidder).toBe(true);
    expect(r).not.toHaveProperty('current_winner_user_id');
  });

  test('winning bidder on CLOSED lot → true (compares final winner)', () => {
    const r = annotateViewerBidState(closedLot({ current_winner_user_id: 'someone-stale' }), 'u1');
    expect(r.viewer_is_high_bidder).toBe(true);
    expect(r).not.toHaveProperty('winning_buyer_user_id');
    expect(r).not.toHaveProperty('current_winner_user_id');
  });

  test('non-winner on CLOSED lot → false', () => {
    expect(annotateViewerBidState(closedLot(), 'u2').viewer_is_high_bidder).toBe(false);
  });

  test('preserves the fields the later UI needs', () => {
    const r = annotateViewerBidState(openLot(), 'u1');
    for (const f of ['current_bid_cents', 'next_min_bid_cents', 'effective_bid_increment_cents', 'bid_count', 'state', 'closes_at']) {
      expect(r).toHaveProperty(f);
    }
  });

  test('viewer_has_bid + viewer_max_bid_cents reflect the viewer\'s own proxy max', () => {
    const r = annotateViewerBidState(openLot({ current_winner_user_id: 'u2' }), 'u1', 5000);
    expect(r.viewer_has_bid).toBe(true);
    expect(r.viewer_max_bid_cents).toBe(5000);
    expect(r.viewer_is_high_bidder).toBe(false); // has bid but not leading → Outbid
  });

  test('no proxy max → viewer_has_bid false, max null (Watching)', () => {
    const r = annotateViewerBidState(openLot(), 'u1', undefined);
    expect(r.viewer_has_bid).toBe(false);
    expect(r.viewer_max_bid_cents).toBeNull();
  });

  test('logged-out → has_bid false, max null even if a max is passed', () => {
    const r = annotateViewerBidState(openLot(), null, 5000);
    expect(r.viewer_has_bid).toBe(false);
    expect(r.viewer_max_bid_cents).toBeNull();
  });
});

describe('#2/#10 composition with realized-price privacy (#20.1)', () => {
  test('closed lot + anonymous: prices hidden AND no identity leaked', () => {
    const r = redactRealizedPrice(annotateViewerBidState(closedLot(), null), false);
    expect(r.viewer_is_high_bidder).toBe(false);
    expect(r.winning_amount_cents).toBeNull();
    expect(r.current_bid_cents).toBeNull();
    expect(r.realized_price_hidden).toBe(true);
    expect(r).not.toHaveProperty('current_winner_user_id');
    expect(r).not.toHaveProperty('winning_buyer_user_id');
  });

  test('closed lot + winning bidder logged-in: realized price visible, flag true', () => {
    const r = redactRealizedPrice(annotateViewerBidState(closedLot(), 'u1'), true);
    expect(r.viewer_is_high_bidder).toBe(true);
    expect(r.winning_amount_cents).toBe(5000);
    expect(r).not.toHaveProperty('winning_buyer_user_id');
  });
});
