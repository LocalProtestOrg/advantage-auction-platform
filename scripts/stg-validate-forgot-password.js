#!/usr/bin/env node
/*
 * stg-validate-forgot-password.js — STAGING-guarded end-to-end validation of the
 * forgot/reset-password flow against the REAL staging DB + migration 075.
 *
 * Sends NO email: emailService.sendEmail is stubbed BEFORE the service loads, so the
 * reset link is captured in-process instead of delivered. Creates a throwaway user +
 * tokens and DELETES them at the end. Refuses to run against the production endpoint.
 *
 * Run: railway run --service advantage-staging node scripts/stg-validate-forgot-password.js
 */
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';

// Stub email BEFORE loading the service so requestReset never delivers. Capture link.
let captured = [];
const emailService = require('../src/services/emailService');
emailService.sendEmail = async (msg) => { captured.push(msg); return { messageId: 'stub' }; };
const svc = require('../src/services/passwordResetService');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint'); process.exit(2); }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not STAGING (${STG_EP})`); process.exit(2); }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const STAMP = Date.now();
  const email = `reset-stg-${STAMP}@validation.test`;
  let userId;
  try {
    const reg = await pool.query("SELECT to_regclass('public.password_reset_tokens') AS t");
    check('migration 075 applied (password_reset_tokens exists)', reg.rows[0].t === 'password_reset_tokens');

    const u = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'buyer') RETURNING id",
      [email, await bcrypt.hash('OldPassw0rd', 10)]);
    userId = u.rows[0].id;

    // requestReset → token issued, link captured (no email sent)
    captured = [];
    await svc.requestReset(email, { ip: '127.0.0.1', baseUrl: 'https://bid.advantage.bid' });
    const blob = captured[0] ? (captured[0].html + '\n' + captured[0].text) : '';
    const m = blob.match(/reset-password\.html\?token=([a-f0-9]{64})/);
    check('requestReset issued a token + built a reset link', !!m, captured[0] && captured[0].subject);
    check('link uses bid.advantage.bid host', blob.includes('https://bid.advantage.bid/reset-password.html'));
    const rawToken = m && m[1];

    const stored = (await pool.query('SELECT token_hash FROM password_reset_tokens WHERE user_id=$1', [userId])).rows[0];
    check('token persisted as SHA-256 HASH (not raw)', stored && stored.token_hash === svc.hashToken(rawToken) && stored.token_hash !== rawToken);

    // consume → password changed
    const r1 = await svc.resetPassword(rawToken, 'NewPassw0rd!');
    check('resetPassword success', r1.ok === true);
    const after = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [userId])).rows[0];
    check('password updated (bcrypt verifies new password)', await bcrypt.compare('NewPassw0rd!', after.password_hash));

    // single-use
    const r2 = await svc.resetPassword(rawToken, 'Another1!');
    check('single-use enforced (reuse → TOKEN_USED)', r2.ok === false && r2.code === 'TOKEN_USED');

    // expired
    const rawExp = crypto.randomBytes(32).toString('hex');
    await pool.query("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() - interval '1 hour')", [userId, svc.hashToken(rawExp)]);
    const r3 = await svc.resetPassword(rawExp, 'Another1!');
    check('expired token rejected (TOKEN_EXPIRED)', r3.ok === false && r3.code === 'TOKEN_EXPIRED');

    // invalid + weak
    const r4 = await svc.resetPassword('not-a-real-token', 'Another1!');
    check('invalid token rejected (INVALID_TOKEN)', r4.ok === false && r4.code === 'INVALID_TOKEN');
    const r5 = await svc.resetPassword(crypto.randomBytes(32).toString('hex'), 'short');
    check('weak password rejected (WEAK_PASSWORD)', r5.ok === false && r5.code === 'WEAK_PASSWORD');

    // no enumeration: unknown email → ok, no email
    captured = [];
    const r6 = await svc.requestReset(`nobody-${STAMP}@validation.test`, {});
    check('unknown email → ok, NO email sent (no enumeration)', r6.ok === true && captured.length === 0);
  } catch (e) {
    check('run without fatal error', false, e.message);
  } finally {
    try {
      if (userId) {
        await pool.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [userId]);
        await pool.query('DELETE FROM users WHERE id=$1', [userId]);
      }
      console.log('CLEANUP: removed throwaway user + tokens.');
    } catch (e) { console.error('CLEANUP WARN', e.message); }
    await pool.end();
  }
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nRESULT_JSON=${JSON.stringify({ total: results.length, passed, failed })}`);
  process.exit(failed ? 1 : 0);
})();
