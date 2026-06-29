'use strict';

/**
 * passwordResetService — secure "forgot password" / reset flow.
 *
 * Security properties:
 *   - Raw token = 32 random bytes (hex, 64 chars); only its SHA-256 hash is persisted,
 *     so a database read never yields a usable token.
 *   - Single-use: consuming a token atomically sets used_at inside a row-locked txn.
 *   - Expiring: TTL = RESET_TTL_MINUTES (default 60).
 *   - No account enumeration: requestReset() returns an identical result whether the
 *     email exists, is unknown, or is suspended, and never sends a signal to the caller.
 *   - Passwords hashed with bcrypt (cost 10), matching src/routes/auth.js register/login.
 *
 * Touches only: users (password_hash) and password_reset_tokens. No Stripe / payments /
 * buyer-premium / settlement / tax behavior is involved.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const { sendEmail } = require('./emailService');

const RESET_TTL_MINUTES = parseInt(process.env.RESET_TTL_MINUTES || '60', 10);
const MIN_PASSWORD_LEN = 8;
const BCRYPT_COST = 10;

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function buildResetEmail(link) {
  const subject = 'Reset your Advantage.Bid password';
  const text =
    'We received a request to reset your Advantage.Bid password.\n\n' +
    `Reset it here (link expires in ${RESET_TTL_MINUTES} minutes):\n${link}\n\n` +
    'If you did not request this, you can safely ignore this email — your password ' +
    'will not change.\n\n— Advantage Auction Company';
  const html = `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#111;">
    <div style="background:#111;color:#fff;padding:1rem 1.25rem;border-radius:10px 10px 0 0;font-weight:700;">Advantage.Bid</div>
    <div style="border:1px solid #e4e4e7;border-top:none;border-radius:0 0 10px 10px;padding:1.5rem 1.25rem;">
      <h1 style="font-size:1.15rem;margin:0 0 0.75rem;">Reset your password</h1>
      <p style="font-size:0.9rem;line-height:1.55;color:#374151;margin:0 0 1.1rem;">
        We received a request to reset the password for your Advantage.Bid account.
        Click the button below to choose a new one. This link expires in
        ${RESET_TTL_MINUTES} minutes.
      </p>
      <p style="margin:0 0 1.25rem;">
        <a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:700;padding:0.7rem 1.25rem;border-radius:7px;font-size:0.9rem;">Reset password</a>
      </p>
      <p style="font-size:0.8rem;line-height:1.5;color:#71717a;margin:0 0 0.5rem;">
        Or paste this link into your browser:<br><a href="${link}" style="color:#111;word-break:break-all;">${link}</a>
      </p>
      <p style="font-size:0.8rem;line-height:1.5;color:#71717a;margin:0.75rem 0 0;">
        If you did not request this, you can safely ignore this email — your password will not change.
      </p>
      <p style="font-size:0.8rem;color:#71717a;margin:1rem 0 0;">— Advantage Auction Company</p>
    </div>
  </div>`;
  return { subject, html, text };
}

/**
 * Request a password reset. Always resolves to { ok: true } regardless of whether the
 * email maps to an active account (no enumeration). Sends an email only when it does.
 */
async function requestReset(email, { ip, baseUrl } = {}) {
  const normalized = String(email || '').trim();
  if (!normalized) return { ok: true };

  const { rows } = await db.query(
    'SELECT id, email, is_active FROM users WHERE email = $1',
    [normalized]
  );
  const user = rows[0];
  // Identical outcome whether the user is missing or suspended — no enumeration.
  if (!user || user.is_active === false) return { ok: true };

  // One live token per user: drop any prior unused tokens before issuing a new one.
  await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL', [user.id]);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);
  await db.query(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES ($1, $2, $3, $4)',
    [user.id, hashToken(rawToken), expiresAt, ip || null]
  );

  const base = String(baseUrl || process.env.PUBLIC_APP_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
  const link = `${base}/reset-password.html?token=${rawToken}`;
  const { subject, html, text } = buildResetEmail(link);
  try {
    await sendEmail({ to: user.email, subject, html, text });
  } catch (err) {
    // Never surface email failures to the caller (avoids both enumeration and abuse signal).
    console.error('[passwordReset] email send failed:', err.message);
  }
  return { ok: true };
}

/**
 * Consume a reset token and set a new password. Single-use + expiry are enforced inside
 * a row-locked transaction. Returns { ok: true } or { ok: false, code } where code is one
 * of WEAK_PASSWORD | INVALID_TOKEN | TOKEN_EXPIRED | TOKEN_USED.
 */
async function resetPassword(rawToken, newPassword) {
  if (!rawToken) return { ok: false, code: 'INVALID_TOKEN' };
  if (!newPassword || String(newPassword).length < MIN_PASSWORD_LEN) {
    return { ok: false, code: 'WEAK_PASSWORD' };
  }

  const tokenHash = hashToken(rawToken);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE',
      [tokenHash]
    );
    const t = rows[0];
    if (!t)        { await client.query('ROLLBACK'); return { ok: false, code: 'INVALID_TOKEN' }; }
    if (t.used_at) { await client.query('ROLLBACK'); return { ok: false, code: 'TOKEN_USED' }; }
    if (new Date(t.expires_at).getTime() < Date.now()) {
      await client.query('ROLLBACK'); return { ok: false, code: 'TOKEN_EXPIRED' };
    }

    const passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_COST);
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, t.user_id]);
    await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [t.id]);
    // Invalidate any other outstanding tokens for this user.
    await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL', [t.user_id]);
    await client.query('COMMIT');
    return { ok: true, userId: t.user_id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { requestReset, resetPassword, hashToken, RESET_TTL_MINUTES, MIN_PASSWORD_LEN };
