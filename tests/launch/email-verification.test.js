'use strict';

/**
 * Launch Sprint 2 — email verification Tier-1 tests.
 * Welcome email + OPTIONAL verification (non-gating). Scratch-only (isolated Neon branch, ≤082).
 * Skips unless WELCOME_SCRATCH=1 + non-prod DATABASE_URL.
 */

const SCRATCH_OK = !!process.env.WELCOME_SCRATCH && !/ep-proud-leaf/.test(process.env.DATABASE_URL || '');
if (!SCRATCH_OK) console.warn('[email-verification] SKIPPED — WELCOME_SCRATCH=1 + non-prod DATABASE_URL required.');
const suite = SCRATCH_OK ? describe : describe.skip;

const crypto = require('crypto');
const db = require('../../src/db');
const svc = require('../../src/services/emailVerificationService');

let USER, EMAIL;
const insertToken = async (rawToken, { expiresInMin = 60, used = false } = {}) => db.query(
  'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, used_at) VALUES ($1,$2,$3,$4)',
  [USER, svc.hashToken(rawToken), new Date(Date.now() + expiresInMin * 60000), used ? new Date() : null]);
const userVerified = async () => (await db.query('SELECT email_verified, email_verified_at FROM users WHERE id=$1', [USER])).rows[0];

beforeAll(async () => {
  if (!SCRATCH_OK) return;
  EMAIL = 'verif-' + Date.now() + '@t.test';
  USER = (await db.query("INSERT INTO users (email, role, password_hash) VALUES ($1,'buyer','x') RETURNING id", [EMAIL])).rows[0].id;
});
afterAll(async () => { if (!SCRATCH_OK) return; await db.pool.end(); });

suite('migration 082', () => {
  test('columns + table present; new users default email_verified=false', async () => {
    expect((await db.query("SELECT to_regclass('public.email_verification_tokens') AS t")).rows[0].t).toBe('email_verification_tokens');
    expect((await db.query("SELECT count(*)::int c FROM information_schema.columns WHERE table_name='users' AND column_name IN ('email_verified','email_verified_at')")).rows[0].c).toBe(2);
    expect((await userVerified()).email_verified).toBe(false); // registration does not verify
  });
});

suite('sendWelcome', () => {
  test('creates a verification token and does not verify the user', async () => {
    await svc.sendWelcome(USER, EMAIL); // delivery is env-dependent on scratch; assert the deterministic token creation
    expect((await db.query('SELECT count(*)::int c FROM email_verification_tokens WHERE user_id=$1 AND used_at IS NULL', [USER])).rows[0].c).toBeGreaterThanOrEqual(1);
    expect((await userVerified()).email_verified).toBe(false);
  });
});

suite('verifyEmail', () => {
  test('valid token verifies the user (idempotent-friendly)', async () => {
    await db.query('DELETE FROM email_verification_tokens WHERE user_id=$1', [USER]);
    const raw = crypto.randomBytes(32).toString('hex');
    await insertToken(raw);
    const r = await svc.verifyEmail(raw);
    expect(r.ok).toBe(true);
    const u = await userVerified();
    expect(u.email_verified).toBe(true);
    expect(u.email_verified_at).toBeTruthy();
    // token consumed
    expect((await db.query('SELECT used_at FROM email_verification_tokens WHERE token_hash=$1', [svc.hashToken(raw)])).rows[0].used_at).toBeTruthy();
  });
  test('invalid / expired / used tokens are rejected with codes', async () => {
    expect(await svc.verifyEmail('bogus')).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
    const rawExp = crypto.randomBytes(32).toString('hex');
    await insertToken(rawExp, { expiresInMin: -5 });
    expect(await svc.verifyEmail(rawExp)).toMatchObject({ ok: false, code: 'TOKEN_EXPIRED' });
    const rawUsed = crypto.randomBytes(32).toString('hex');
    await insertToken(rawUsed, { used: true });
    expect(await svc.verifyEmail(rawUsed)).toMatchObject({ ok: false, code: 'TOKEN_USED' });
  });
});
