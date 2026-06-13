// #1 Real-time dispatch — verifies the privacy-safe socket fan-out contract:
// public room broadcast (no identity) + targeted per-user winning/outbid.
const { dispatch, publicLotPayload } = require('../src/lib/realtime');

function mockIO() {
  const emits = [];
  return {
    emits,
    to(room) {
      return { emit: (event, payload) => { emits.push({ room, event, payload }); } };
    },
  };
}
const find = (io, room, event) => io.emits.find(e => e.room === room && e.event === event);

const lotEvent = (over = {}) => ({
  auction_id: 'A', lot_id: 'L', lot_number: 12, title: 'Fenton Glass',
  current_bid_cents: 5000, next_min_bid_cents: 5500, effective_bid_increment_cents: 500,
  bid_count: 7, state: 'open', closes_at: '2026-07-01T00:00:00Z', extension_count: 1,
  winner_user_id: 'u-new', prev_winner_user_id: 'u-old', ...over,
});

describe('#1 publicLotPayload', () => {
  test('open lot exposes live prices, never bidder identity', () => {
    const p = publicLotPayload(lotEvent());
    expect(p.current_bid_cents).toBe(5000);
    expect(p.next_min_bid_cents).toBe(5500);
    expect(p.effective_bid_increment_cents).toBe(500);
    expect(p.bid_count).toBe(7);
    expect(p.lot_number).toBe(12);
    expect(p.closes_at).toBe('2026-07-01T00:00:00Z');
    expect(p).not.toHaveProperty('winner_user_id');
    expect(p).not.toHaveProperty('prev_winner_user_id');
  });
  test('closed lot withholds realized price (gated by REST)', () => {
    const p = publicLotPayload(lotEvent({ state: 'closed' }));
    expect(p.state).toBe('closed');
    expect(p.current_bid_cents).toBeNull();
    expect(p.next_min_bid_cents).toBeNull();
    expect(p.bid_count).toBeNull();
    expect(p.lot_number).toBe(12); // non-price metadata still public
  });
});

describe('#1 dispatch — lot events', () => {
  test('broadcasts public lot:update to the auction room with NO identity', () => {
    const io = mockIO();
    dispatch(io, 'lot', lotEvent());
    const up = find(io, 'auction:A', 'lot:update');
    expect(up).toBeTruthy();
    expect(up.payload.current_bid_cents).toBe(5000);
    expect(up.payload).not.toHaveProperty('winner_user_id');
    expect(up.payload).not.toHaveProperty('prev_winner_user_id');
  });

  test('targeted lot:winning to the new winner, lot:outbid to the previous winner', () => {
    const io = mockIO();
    dispatch(io, 'lot', lotEvent());
    expect(find(io, 'user:u-new', 'lot:winning')).toBeTruthy();
    expect(find(io, 'user:u-old', 'lot:outbid')).toBeTruthy();
  });

  test('first bid (no previous winner) → winning only, no outbid', () => {
    const io = mockIO();
    dispatch(io, 'lot', lotEvent({ prev_winner_user_id: null }));
    expect(find(io, 'user:u-new', 'lot:winning')).toBeTruthy();
    expect(io.emits.some(e => e.event === 'lot:outbid')).toBe(false);
  });

  test('same bidder raises own max (prev === winner) → no self-outbid', () => {
    const io = mockIO();
    dispatch(io, 'lot', lotEvent({ prev_winner_user_id: 'u-new' }));
    expect(find(io, 'user:u-new', 'lot:winning')).toBeTruthy();
    expect(io.emits.some(e => e.event === 'lot:outbid')).toBe(false);
  });

  test('lot close: winner notified, broadcast withholds realized price', () => {
    const io = mockIO();
    dispatch(io, 'lot', lotEvent({ state: 'closed', prev_winner_user_id: null }));
    expect(find(io, 'auction:A', 'lot:update').payload.current_bid_cents).toBeNull();
    expect(find(io, 'user:u-new', 'lot:winning')).toBeTruthy();
  });
});

describe('#1 dispatch — auction events & safety', () => {
  test('auction:update broadcast to the auction room', () => {
    const io = mockIO();
    dispatch(io, 'auction', { auction_id: 'A', state: 'closed' });
    expect(find(io, 'auction:A', 'auction:update')).toBeTruthy();
  });
  test('null io does not throw', () => {
    expect(() => dispatch(null, 'lot', lotEvent())).not.toThrow();
  });
});
