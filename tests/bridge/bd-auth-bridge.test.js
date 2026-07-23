'use strict';

/**
 * BD identity bridge (Option 2, JWT-seed) — security unit tests. Pure logic with injected fakes; no
 * network, no DB, no Express. Proves the guarantees the flow must uphold before any deployment.
 */

const handlers = require('../../src/services/bridgeHandlers');
const codeSvc = require('../../src/services/bridgeCodeService');
const identity = require('../../src/services/bridgeIdentityService');
const bridgeConfig = require('../../src/lib/bridgeConfig');
const fs = require('fs');
const path = require('path');

const SECRET = 'noprod-bridge-secret-long-enough-xx';
const APP = 'https://nonprod.example';
const EMAIL = 'member367@example.com';

function exchange(body, opts) {
  const o = opts || {};
  let minted = null;
  const mintCode = async (id, dest, claims) => { minted = { id, dest, claims }; return 'OPAQUE-CODE-XYZ'; };
  return handlers.handleExchange(
    { bridgeKeyHeader: o.key === undefined ? SECRET : o.key, body },
    { secret: SECRET, publicAppUrl: APP, mintCode }
  ).then((r) => ({ r, minted }));
}

// A return run with an injected atomic redeem+provision fake; records the signed JWT claims.
function returnRun({ provisioned }) {
  const calls = { signed: null };
  const deps = {
    redeemAndProvision: async () => provisioned,          // {dest,userId,role} or null
    signJwt: (p) => { calls.signed = p; return 'JWT.' + p.role + '.' + p.id; },
    buildSeed: handlers.buildSeed,
  };
  return handlers.handleReturn({ query: { code: 'whatever' } }, deps).then((out) => ({ out, calls }));
}

describe('exchange — issuance, auth, validation', () => {
  test('valid → 200 with a redirect_url carrying ONLY the opaque code (no jwt, no member id, no email)', async () => {
    const { r, minted } = await exchange({ bd_user_id: '367', dest: 'dashboard', email: EMAIL, first_name: 'Ada', last_name: 'Lovelace' });
    expect(r.status).toBe(200);
    expect(r.json.redirect_url).toBe(APP + '/auth/bd/return?code=OPAQUE-CODE-XYZ');
    expect(r.json.redirect_url).not.toContain('367');
    expect(r.json.redirect_url).not.toContain(EMAIL);
    expect(JSON.stringify(r.json)).not.toContain(SECRET);
    // identity claims are captured server-side to travel with the code — never exposed to the browser
    expect(minted).toEqual({ id: '367', dest: 'dashboard', claims: { email: EMAIL, firstName: 'Ada', lastName: 'Lovelace' } });
  });
  test('invalid bridge secret → 401 and NO code minted', async () => {
    const { r, minted } = await exchange({ bd_user_id: '367', dest: 'dashboard', email: EMAIL }, { key: 'wrong' });
    expect(r.status).toBe(401);
    expect(minted).toBeNull();
  });
  test('missing secret → 401', async () => {
    const { r } = await exchange({ bd_user_id: '367', dest: 'dashboard', email: EMAIL }, { key: '' });
    expect(r.status).toBe(401);
  });
  test('missing fields / bad member id → 400', async () => {
    expect((await exchange({ dest: 'dashboard', email: EMAIL })).r.status).toBe(400);
    expect((await exchange({ bd_user_id: '367', email: EMAIL })).r.status).toBe(400);
    expect((await exchange({ bd_user_id: 'abc', dest: 'dashboard', email: EMAIL })).r.status).toBe(400);
  });
  test('a real member email is REQUIRED (guarantees a deliverable contact address)', async () => {
    expect((await exchange({ bd_user_id: '367', dest: 'dashboard' })).r.status).toBe(400);          // missing
    expect((await exchange({ bd_user_id: '367', dest: 'dashboard', email: 'not-an-email' })).r.status).toBe(400);
    const { r, minted } = await exchange({ bd_user_id: '367', dest: 'dashboard', email: '  MEMBER367@Example.com ' });
    expect(r.status).toBe(200);
    expect(minted.claims.email).toBe('member367@example.com'); // normalized (trimmed + lowercased)
  });
  test('arbitrary destination injection is rejected (400); resolveDest never yields a URL', async () => {
    expect((await exchange({ bd_user_id: '367', dest: 'https://evil.example', email: EMAIL })).r.status).toBe(400);
    expect((await exchange({ bd_user_id: '367', dest: 'admin', email: EMAIL })).r.status).toBe(400);
    expect(codeSvc.resolveDest('https://evil.example')).toBe('/dashboard.html');
    expect(codeSvc.resolveDest('anything-else')).toBe('/dashboard.html');
  });
});

describe('return — atomic redeem+provision → transparent seed', () => {
  test('valid provisioned member receives the standard JWT in the seed (buyer role by default)', async () => {
    const { out, calls } = await returnRun({ provisioned: { dest: 'dashboard', userId: 'user-367', role: 'buyer' } });
    expect(out.status).toBe(200);
    expect(calls.signed).toEqual({ id: 'user-367', role: 'buyer' });
    expect(out.html).toContain('JWT.buyer.user-367');
  });
  test('a standard member cannot gain seller/admin — a NEW member always provisions as buyer', async () => {
    expect(identity.decideProvisioning({ existingLink: null })).toEqual({ action: 'create', role: 'buyer' });
    const { calls } = await returnRun({ provisioned: { dest: 'dashboard', userId: 'user-999', role: 'buyer' } });
    expect(calls.signed.role).toBe('buyer');
    expect(['seller', 'admin', 'staff', 'owner']).not.toContain(calls.signed.role);
  });
  test('email match never triggers linking — decideProvisioning links ONLY on an existing subject link', () => {
    // No link (a same-email existing account is irrelevant here) → always a fresh buyer, never a merge.
    expect(identity.decideProvisioning({ existingLink: null })).toEqual({ action: 'create', role: 'buyer' });
    // A link exists (keyed on BD subject, resolved elsewhere) → reuse that same user, unchanged role.
    expect(identity.decideProvisioning({ existingLink: { userId: 'u-1', role: 'buyer' } }))
      .toEqual({ action: 'link', userId: 'u-1', role: 'buyer' });
  });
  test('expired / replayed / malformed / unknown code → 400 error page, NO JWT ever issued', async () => {
    const { out, calls } = await returnRun({ provisioned: null }); // redeemAndProvision returns null for all of these
    expect(out.status).toBe(400);
    expect(calls.signed).toBeNull();
    expect(out.html).not.toMatch(/JWT\./);
    expect(out.html.toLowerCase()).not.toContain('token');
  });
  test('the seed response has no-store headers and no Location header (JWT never in a redirect)', async () => {
    const { out } = await returnRun({ provisioned: { dest: 'dashboard', userId: 'user-367', role: 'buyer' } });
    expect(out.headers['Cache-Control']).toBe('no-store, no-cache, must-revalidate, private');
    expect(out.headers.Pragma).toBe('no-cache');
    expect(out.headers.Expires).toBe('0');
    expect(out.headers.Location).toBeUndefined();
    for (const v of Object.values(out.headers)) expect(String(v)).not.toMatch(/JWT\./);
  });
  test('the seed uses location.replace("/dashboard.html") and shows no technical success UI', async () => {
    const { out } = await returnRun({ provisioned: { dest: 'dashboard', userId: 'user-367', role: 'buyer' } });
    expect(out.html).toContain('location.replace("/dashboard.html")');
    expect(out.html).toContain('localStorage.setItem("token"');
    expect(out.html.toLowerCase()).not.toMatch(/success|welcome|signed in|you are now|authenticated/);
  });
});

describe('buildSeed — CSP + no-store + nonce, JWT confined to the inline script', () => {
  test('nonce CSP, no-store headers, and JWT absent from headers', () => {
    const seed = handlers.buildSeed('JWT.buyer.u1', '/dashboard.html');
    expect(seed.headers['Content-Security-Policy']).toContain("script-src 'nonce-");
    expect(seed.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(seed.headers['Referrer-Policy']).toBe('no-referrer');
    expect(seed.html).toContain('nonce="' + seed.nonce + '"');
    expect(seed.html).toContain('JWT.buyer.u1');
    for (const v of Object.values(seed.headers)) expect(String(v)).not.toContain('JWT.buyer.u1');
  });
});

describe('feature flag + existing auth untouched', () => {
  test('bridge is OFF unless IDENTITY_BRIDGE_ENABLED === "true"', () => {
    const prev = process.env.IDENTITY_BRIDGE_ENABLED;
    delete process.env.IDENTITY_BRIDGE_ENABLED; expect(bridgeConfig.bridgeEnabled()).toBe(false);
    process.env.IDENTITY_BRIDGE_ENABLED = 'false'; expect(bridgeConfig.bridgeEnabled()).toBe(false);
    process.env.IDENTITY_BRIDGE_ENABLED = 'TRUE'; expect(bridgeConfig.bridgeEnabled()).toBe(true);
    if (prev === undefined) delete process.env.IDENTITY_BRIDGE_ENABLED; else process.env.IDENTITY_BRIDGE_ENABLED = prev;
  });
  test('server.js mounts the bridge ONLY behind the flag', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    expect(server).toMatch(/if \(require\('\.\/src\/lib\/bridgeConfig'\)\.bridgeEnabled\(\)\)/);
    expect(server).toMatch(/require\('\.\/src\/routes\/authBridge'\)/);
  });
  test('existing username/password login is unchanged (no bridge code in auth.js)', () => {
    const auth = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'auth.js'), 'utf8');
    expect(auth).not.toMatch(/bd\/exchange|bd\/return|bridge|external_identit/i);
    expect(auth).toMatch(/jwt\.sign/); // the login JWT the bridge reuses still lives here, untouched
  });
});

describe('production-safe diagnostics (no secret/code/email/raw-error logging)', () => {
  test('authBridge.js contains no temporary fingerprint/route-entry/raw-error diagnostics', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'authBridge.js'), 'utf8');
    expect(src).not.toMatch(/DEBUG/);
    expect(src).not.toMatch(/route entered/);
    expect(src).not.toMatch(/createHash|fingerprint|env_fp|hdr_fp/);
    expect(src).not.toMatch(/e\.message|e\.code/); // no verbose raw error surfaced to logs
  });
});

describe('constant-time secret comparison', () => {
  test('safeEqual: equal true, different false, length-mismatch false', () => {
    expect(codeSvc.safeEqual('abc', 'abc')).toBe(true);
    expect(codeSvc.safeEqual('abc', 'abd')).toBe(false);
    expect(codeSvc.safeEqual('abc', 'abcd')).toBe(false);
    expect(codeSvc.safeEqual(undefined, SECRET)).toBe(false);
  });
});
