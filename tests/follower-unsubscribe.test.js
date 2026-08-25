'use strict';

/** Public one-click unsubscribe: valid token → unfollow (or opt-out-all); invalid token → no-op. */
jest.mock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 1 })) }));
const db = require('../src/db');
const token = require('../src/lib/followerEmailToken');
const { applyUnsubscribe } = require('../src/routes/publicFollowerEmails');

const U = '11111111-1111-4111-8111-111111111111';
const S = '22222222-2222-4222-8222-222222222222';

beforeEach(() => { db.query.mockClear(); db.query.mockImplementation(async () => ({ rows: [], rowCount: 1 })); });

describe('applyUnsubscribe', () => {
  test('default scope UNFOLLOWS that specific seller (deletes the seller_followers row)', async () => {
    const r = await applyUnsubscribe(token.sign(U, S), 'seller');
    expect(r.ok).toBe(true);
    const del = db.query.mock.calls.find((c) => /DELETE FROM seller_followers/.test(c[0]));
    expect(del).toBeTruthy();
    expect(del[1]).toEqual([U, S]);
  });
  test('scope=all opts the user out of ALL follower marketing (never deletes a follow)', async () => {
    const r = await applyUnsubscribe(token.sign(U, S), 'all');
    expect(r.scope).toBe('all');
    const upd = db.query.mock.calls.find((c) => /notification_preferences/.test(c[0]));
    expect(upd[0]).toMatch(/follower_emails_enabled = false/);
    expect(db.query.mock.calls.find((c) => /DELETE FROM seller_followers/.test(c[0]))).toBeFalsy();
  });
  test('an invalid/forged token is rejected and touches nothing', async () => {
    const r = await applyUnsubscribe('forged.token', 'seller');
    expect(r.ok).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
});
