// #2 Bidder status derivation — the shared logic behind the Winning/Outbid panel.
const { deriveBidderStatus } = require('../public/widgets/shared/bid-status');

const lot = (o = {}) => Object.assign({
  state: 'open', viewer_is_high_bidder: false, viewer_has_bid: false,
  viewer_max_bid_cents: null, next_min_bid_cents: 3500, extension_count: 0,
}, o);

describe('#2 deriveBidderStatus — live (open) lots', () => {
  test('winning → green ✓ Winning', () => {
    const s = deriveBidderStatus(lot({ viewer_is_high_bidder: true, viewer_has_bid: true }));
    expect(s.key).toBe('winning'); expect(s.tone).toBe('win'); expect(/Winning/.test(s.label)).toBe(true);
  });
  test('has a bid but not leading → red Outbid', () => {
    const s = deriveBidderStatus(lot({ viewer_has_bid: true, viewer_is_high_bidder: false }));
    expect(s.key).toBe('outbid'); expect(s.tone).toBe('lose'); expect(s.label).toBe('Outbid');
  });
  test('no bid → neutral Watching', () => {
    const s = deriveBidderStatus(lot());
    expect(s.key).toBe('watching'); expect(s.tone).toBe('neutral');
  });
  test('surfaces my max bid + next acceptable bid', () => {
    const s = deriveBidderStatus(lot({ viewer_has_bid: true, viewer_max_bid_cents: 5000, next_min_bid_cents: 5500 }));
    expect(s.maxBidCents).toBe(5000); expect(s.nextMinCents).toBe(5500);
  });
  test('extended flag from extension_count', () => {
    expect(deriveBidderStatus(lot({ extension_count: 2 })).extended).toBe(true);
  });
  test('closingSoon when within 60s of close', () => {
    const soon = new Date(Date.now() + 30000).toISOString();
    const later = new Date(Date.now() + 600000).toISOString();
    expect(deriveBidderStatus(lot({ closes_at: soon })).closingSoon).toBe(true);
    expect(deriveBidderStatus(lot({ closes_at: later })).closingSoon).toBe(false);
  });
});

describe('#2 deriveBidderStatus — closed lots', () => {
  test('viewer won → ✓ You won (green)', () => {
    const s = deriveBidderStatus(lot({ state: 'closed', viewer_is_high_bidder: true, winning_amount_cents: 5000 }));
    expect(s.key).toBe('won'); expect(s.tone).toBe('win');
  });
  test('sold to someone else → Sold', () => {
    const s = deriveBidderStatus(lot({ state: 'closed', viewer_is_high_bidder: false, viewer_has_bid: true, winning_amount_cents: 5000 }));
    expect(s.key).toBe('sold'); expect(s.label).toBe('Sold');
  });
  test('closed with no sale → Closed', () => {
    const s = deriveBidderStatus(lot({ state: 'closed', winning_amount_cents: null }));
    expect(s.key).toBe('closed'); expect(s.label).toBe('Closed');
  });
});
