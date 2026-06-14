// Phase 1 (bid.advantage.bid cutover) — allowed-origin + public-base-URL logic.
const pu = require('../src/lib/publicUrls');

function withEnv(env, fn) {
  const keys = ['FRONTEND_URL', 'ALLOWED_ORIGINS', 'PUBLIC_BASE_URL'];
  const saved = {}; keys.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  try { Object.assign(process.env, env); return fn(); }
  finally { keys.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
}

describe('Phase 1 publicUrls', () => {
  test('splitList trims + drops empties', () => {
    expect(pu.splitList('a, b ,c,')).toEqual(['a', 'b', 'c']);
    expect(pu.splitList('')).toEqual([]);
    expect(pu.splitList(undefined)).toEqual([]);
  });

  test('allowedOrigins: single value', () => {
    withEnv({ FRONTEND_URL: 'https://bid.advantage.bid' }, () => {
      expect(pu.allowedOrigins()).toEqual(['https://bid.advantage.bid']);
    });
  });

  test('allowedOrigins: comma-list + ALLOWED_ORIGINS merged & deduped', () => {
    withEnv({ FRONTEND_URL: 'https://bid.advantage.bid, https://x.up.railway.app', ALLOWED_ORIGINS: 'https://x.up.railway.app,https://admin.advantage.bid' }, () => {
      expect(pu.allowedOrigins()).toEqual(['https://bid.advantage.bid', 'https://x.up.railway.app', 'https://admin.advantage.bid']);
    });
  });

  test('allowedOrigins: unset → dev origin', () => {
    withEnv({}, () => expect(pu.allowedOrigins()).toEqual(['http://localhost:3001']));
  });

  test('isOriginAllowed', () => {
    withEnv({ FRONTEND_URL: 'https://bid.advantage.bid,https://x.up.railway.app' }, () => {
      expect(pu.isOriginAllowed('https://bid.advantage.bid')).toBe(true);
      expect(pu.isOriginAllowed('https://x.up.railway.app')).toBe(true);
      expect(pu.isOriginAllowed('https://evil.example')).toBe(false);
      expect(pu.isOriginAllowed('')).toBe(false);
      expect(pu.isOriginAllowed(undefined)).toBe(false);
    });
  });

  test('publicBaseUrl: PUBLIC_BASE_URL wins', () => {
    withEnv({ PUBLIC_BASE_URL: 'https://bid.advantage.bid', FRONTEND_URL: 'https://other,https://x' }, () => {
      expect(pu.publicBaseUrl()).toBe('https://bid.advantage.bid');
    });
  });

  test('publicBaseUrl: else first FRONTEND_URL origin (never a comma-list)', () => {
    withEnv({ FRONTEND_URL: 'https://bid.advantage.bid, https://x.up.railway.app' }, () => {
      expect(pu.publicBaseUrl()).toBe('https://bid.advantage.bid');
    });
  });

  test('publicBaseUrl: else safe live default (unset)', () => {
    withEnv({}, () => expect(pu.publicBaseUrl()).toBe(pu.DEFAULT_BUYER_BASE));
  });
});
