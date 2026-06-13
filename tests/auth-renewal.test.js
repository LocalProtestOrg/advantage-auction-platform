// #4 Sliding-session renewal — unit tests for authMiddleware's half-life refresh.
// An active bidder's token is re-minted into the X-Refreshed-Token header once it
// passes half its lifetime, so a page refresh no longer logs them out mid-auction.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-auth-renewal';
const jwt = require('jsonwebtoken');
const authMiddleware = require('../src/middleware/authMiddleware');

const SECRET = process.env.JWT_SECRET;
const nowSec = () => Math.floor(Date.now() / 1000);

function makeRes() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    body: null,
    set: (k, v) => { headers[k] = v; },
    status(code) { this.statusCode = code; return { json: (b) => { this.body = b; return this; } }; },
  };
}
const reqWith = (token) => ({ headers: token ? { authorization: 'Bearer ' + token } : {} });

describe('#4 authMiddleware sliding renewal', () => {
  test('token past half its lifetime → fresh token in X-Refreshed-Token header', () => {
    const t = jwt.sign({ id: 'u1', role: 'buyer', iat: nowSec() - 5000, exp: nowSec() + 3000 }, SECRET);
    const res = makeRes(); const next = jest.fn();
    authMiddleware(reqWith(t), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.headers['X-Refreshed-Token']).toBeTruthy();
    const decoded = jwt.verify(res.headers['X-Refreshed-Token'], SECRET);
    expect(decoded.id).toBe('u1');
    expect(decoded.role).toBe('buyer');
    expect(decoded.exp).toBeGreaterThan(nowSec() + 3000); // strictly later expiry
  });

  test('fresh token (under half-life) → no refresh header', () => {
    const t = jwt.sign({ id: 'u2', role: 'buyer', iat: nowSec() - 60, exp: nowSec() + 86340 }, SECRET);
    const res = makeRes(); const next = jest.fn();
    authMiddleware(reqWith(t), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.headers['X-Refreshed-Token']).toBeUndefined();
  });

  test('missing token → 401, no next', () => {
    const res = makeRes(); const next = jest.fn();
    authMiddleware(reqWith(null), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test('expired token → 401, no next, no refresh', () => {
    const t = jwt.sign({ id: 'u3', role: 'buyer', iat: nowSec() - 100, exp: nowSec() - 10 }, SECRET);
    const res = makeRes(); const next = jest.fn();
    authMiddleware(reqWith(t), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers['X-Refreshed-Token']).toBeUndefined();
  });
});
