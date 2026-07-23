'use strict';

/**
 * Option B bridge PoC — security unit tests (NON-PRODUCTION logic in scripts/poc/bd-bridge-poc-lib.js).
 *
 * Covers: valid issuance, invalid shared secret, missing/invalid fields, expiry, one-time redemption,
 * replay rejection, malformed code, no-privilege-elevation, and safe response contents. No network,
 * no DB — `now` is injected so expiry/replay are deterministic.
 */

const lib = require('../../scripts/poc/bd-bridge-poc-lib');

const SECRET = 'test-bridge-secret-please-be-long-enough';
const BASE = 'https://poc.example';
function newStore(ttlMs) { return new lib.CodeStore({ ttlMs: ttlMs || 120000 }); }
function exchange(body, opts) {
  const o = opts || {};
  return lib.handleExchange(
    { bridgeKeyHeader: o.key === undefined ? SECRET : o.key, body },
    { store: o.store, secret: SECRET, now: o.now, publicBaseUrl: BASE }
  );
}

describe('constant-time secret comparison', () => {
  test('safeEqual: equal true, different false, length-mismatch false', () => {
    expect(lib.safeEqual('abc', 'abc')).toBe(true);
    expect(lib.safeEqual('abc', 'abd')).toBe(false);
    expect(lib.safeEqual('abc', 'abcd')).toBe(false);
    expect(lib.safeEqual('', '')).toBe(true);
    expect(lib.safeEqual(undefined, SECRET)).toBe(false);
  });
});

describe('handleExchange — issuance + auth + validation', () => {
  test('valid issuance returns an opaque code + redirect_url', () => {
    const store = newStore();
    const out = exchange({ bd_user_id: '367', dest: 'create-event' }, { store });
    expect(out.status).toBe(200);
    expect(out.json.ok).toBe(true);
    expect(typeof out.json.code).toBe('string');
    expect(out.json.code.length).toBeGreaterThanOrEqual(40); // 256-bit base64url
    expect(out.json.redirect_url).toBe(BASE + '/auth/bd/return?code=' + encodeURIComponent(out.json.code));
    expect(store.size).toBe(1);
  });

  test('invalid shared secret → 401, no code issued', () => {
    const store = newStore();
    const out = exchange({ bd_user_id: '367', dest: 'dashboard' }, { store, key: 'wrong-secret' });
    expect(out.status).toBe(401);
    expect(out.json.ok).toBe(false);
    expect(store.size).toBe(0);
  });

  test('missing shared secret header → 401', () => {
    const out = exchange({ bd_user_id: '367', dest: 'dashboard' }, { store: newStore(), key: '' });
    expect(out.status).toBe(401);
  });

  test('missing required fields → 400', () => {
    expect(exchange({ dest: 'dashboard' }, { store: newStore() }).status).toBe(400);
    expect(exchange({ bd_user_id: '367' }, { store: newStore() }).status).toBe(400);
    expect(exchange({ dest: 'dashboard' }, { store: newStore() }).json.error).toMatch(/missing/i);
  });

  test('non-numeric / malformed member id → 400', () => {
    expect(exchange({ bd_user_id: 'abc', dest: 'dashboard' }, { store: newStore() }).status).toBe(400);
    expect(exchange({ bd_user_id: "367';DROP", dest: 'dashboard' }, { store: newStore() }).status).toBe(400);
    expect(exchange({ bd_user_id: '', dest: 'dashboard' }, { store: newStore() }).status).toBe(400);
  });

  test('destination not on the allowlist → 400 (open-redirect protection)', () => {
    expect(exchange({ bd_user_id: '367', dest: 'https://evil.example' }, { store: newStore() }).status).toBe(400);
    expect(exchange({ bd_user_id: '367', dest: 'admin-panel' }, { store: newStore() }).status).toBe(400);
  });
});

describe('handleReturn — redemption, single-use, expiry, replay', () => {
  test('successful one-time redemption returns verified identity only', () => {
    const store = newStore();
    const code = exchange({ bd_user_id: '367', dest: 'manage-events' }, { store }).json.code;
    const out = lib.handleReturn({ query: { code } }, { store });
    expect(out.status).toBe(200);
    expect(out.result.ok).toBe(true);
    expect(out.result.bd_user_id).toBe('367');
    expect(out.result.dest_path).toBe('/org/events.html');
    expect(out.result.authenticated_identity_only).toBe(true);
  });

  test('replay is rejected — a code works once, then never again', () => {
    const store = newStore();
    const code = exchange({ bd_user_id: '367', dest: 'dashboard' }, { store }).json.code;
    expect(lib.handleReturn({ query: { code } }, { store }).result.ok).toBe(true);
    const second = lib.handleReturn({ query: { code } }, { store });
    expect(second.status).toBe(400);
    expect(second.result.reason).toBe('used');
  });

  test('expired code is rejected', () => {
    const store = newStore(1000); // 1s TTL
    const code = exchange({ bd_user_id: '367', dest: 'dashboard' }, { store, now: 0 }).json.code;
    const out = lib.handleReturn({ query: { code } }, { store, now: 5000 });
    expect(out.status).toBe(400);
    expect(out.result.reason).toBe('expired');
  });

  test('unknown / malformed / empty code is rejected', () => {
    const store = newStore();
    expect(lib.handleReturn({ query: { code: 'not-a-real-code' } }, { store }).result.reason).toBe('unknown');
    expect(lib.handleReturn({ query: { code: '' } }, { store }).result.reason).toBe('unknown');
    expect(lib.handleReturn({ query: {} }, { store }).result.reason).toBe('unknown');
  });
});

describe('no privilege elevation + safe response contents', () => {
  test('redemption result carries NO role/token/authority — identity only', () => {
    const store = newStore();
    const code = exchange({ bd_user_id: '367', dest: 'dashboard' }, { store }).json.code;
    const out = lib.handleReturn({ query: { code } }, { store });
    const keys = Object.keys(out.result).sort();
    expect(keys).toEqual(['authenticated_identity_only', 'bd_user_id', 'dest_path', 'ok']);
    for (const forbidden of ['role', 'is_admin', 'isAdmin', 'is_seller', 'seller', 'admin', 'token', 'jwt', 'session', 'claims', 'organization', 'owner']) {
      expect(out.result[forbidden]).toBeUndefined();
    }
  });

  test('the opaque code contains no member id, and the browser URL leaks no secret/id/claims', () => {
    const store = newStore();
    const out = exchange({ bd_user_id: '367', dest: 'dashboard' }, { store });
    expect(out.json.code).not.toContain('367');
    expect(out.json.redirect_url).not.toContain('367');
    expect(out.json.redirect_url).not.toContain(SECRET);
    expect(out.json.redirect_url).not.toMatch(/role|token|secret|email/i);
    // the issuance response itself never echoes the secret
    expect(JSON.stringify(out.json)).not.toContain(SECRET);
  });

  test('two issues produce different opaque codes (randomness)', () => {
    const store = newStore();
    const a = exchange({ bd_user_id: '367', dest: 'dashboard' }, { store }).json.code;
    const b = exchange({ bd_user_id: '367', dest: 'dashboard' }, { store }).json.code;
    expect(a).not.toBe(b);
  });
});
