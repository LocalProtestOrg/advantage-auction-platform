'use strict';

/**
 * emailVerificationService — professional welcome email + OPTIONAL email verification.
 *
 * Sent immediately after registration. The verification link records status. It gates nothing by itself; when the
 * buyers.require_verified_email_to_bid switch is ON (buyerEmailGate, ships OFF), auction registration and bidding
 * need a verified address, with a grace period for established buyers. Mirrors the security
 * model of passwordResetService: raw token = 32 random bytes; only its SHA-256 hash is
 * stored; single-use + expiring. Touches only users(email_verified*) and
 * email_verification_tokens. No Stripe / payments / settlement behavior.
 */
const crypto = require('crypto');
const db = require('../db');
const { sendEmail } = require('./emailService');
const { resolveUserContactEmail } = require('./recipientService');

const VERIFY_TTL_MINUTES = parseInt(process.env.EMAIL_VERIFY_TTL_MINUTES || '10080', 10); // 7 days

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function buildWelcomeEmail(link) {
  const subject = 'Welcome to Advantage.Bid: please confirm your email';
  const text =
    'Welcome to Advantage.Bid.\n\n' +
    'Your account is ready. You can browse auctions, save favorites, add a card, and bid right away.\n\n' +
    'When you have a moment, confirm your email address (optional, but it helps secure your account):\n' +
    link + '\n\nAdvantage.Bid';
  const html = `
      <h1 style="font-size:1.2rem;margin:0 0 0.75rem;">Welcome to Advantage.Bid</h1>
      <p style="font-size:0.92rem;line-height:1.6;color:#374151;margin:0 0 1rem;">
        Your account is ready. You can browse auctions, save favorites, add a payment card, and place bids
        right away. There is nothing you need to do first.
      </p>
      <p style="font-size:0.92rem;line-height:1.6;color:#374151;margin:0 0 1.1rem;">
        When it is convenient, please confirm your email address. It is optional and does not affect bidding
        or checkout. It simply helps keep your account secure and lets us reach you about your auctions.
      </p>`;
  return { subject, html: wrapHtml(html, link), text };
}

// Shown when buyers.require_verified_email_to_bid is ON: the confirmation is needed before bidding.
function buildRequiredWelcomeEmail(link) {
  const subject = 'Welcome to Advantage.Bid: please confirm your email';
  const text =
    'Welcome to Advantage.Bid.\n\n' +
    'Your account is ready. Please confirm your email address before you register for an auction or place a bid:\n' +
    link + '\n\nAdvantage.Bid';
  const html = `
      <h1 style="font-size:1.2rem;margin:0 0 0.75rem;">Welcome to Advantage.Bid</h1>
      <p style="font-size:0.92rem;line-height:1.6;color:#374151;margin:0 0 1.1rem;">
        Your account is ready. You can browse auctions and save favorites now. Please confirm your email address
        before you register for an auction or place a bid. It keeps your account secure and lets us reach you about
        your auctions.
      </p>`;
  return { subject, html: wrapHtml(html, link), text };
}

// A new link requested from the Confirm Your Email page.
function buildConfirmEmail(link) {
  const subject = 'Confirm your Advantage.Bid email address';
  const text = 'Please confirm your email address for Advantage.Bid:\n' + link +
    '\n\nIf you did not ask for this email, you can ignore it.\n\nAdvantage.Bid';
  const html = `
      <h1 style="font-size:1.2rem;margin:0 0 0.75rem;">Confirm your email address</h1>
      <p style="font-size:0.92rem;line-height:1.6;color:#374151;margin:0 0 1.1rem;">
        You asked for a new confirmation link. Select the button below to confirm this email address for your
        Advantage.Bid account. If you did not ask for this email, you can ignore it.
      </p>`;
  return { subject, html: wrapHtml(html, link), text };
}

function wrapHtml(inner, link) {
  return `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#111;">
    <div style="background:#111;color:#fff;padding:1rem 1.25rem;border-radius:10px 10px 0 0;font-weight:700;font-size:1.05rem;">Advantage.Bid</div>
    <div style="border:1px solid #e4e4e7;border-top:none;border-radius:0 0 10px 10px;padding:1.5rem 1.25rem;">${inner}
      <p style="margin:0 0 1.25rem;">
        <a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:700;padding:0.7rem 1.35rem;border-radius:7px;font-size:0.9rem;">Confirm my email</a>
      </p>
      <p style="font-size:0.8rem;line-height:1.5;color:#71717a;margin:0 0 0.5rem;">
        Or paste this link into your browser:<br><a href="${link}" style="color:#111;word-break:break-all;">${link}</a>
      </p>
      <p style="font-size:0.8rem;color:#71717a;margin:1rem 0 0;">Advantage.Bid</p>
    </div>
  </div>`;
}

/**
 * Create a verification token and send the welcome email. Best-effort and never throws to
 * the caller: a registration must succeed even if the email cannot be sent. Call fire-and-forget.
 * The copy follows the buyers.require_verified_email_to_bid switch (optional vs needed before bidding).
 */
async function sendWelcome(userId, email, { baseUrl } = {}) {
  let required = false;
  try { required = (await require('./buyerEmailGate').config()).required; } catch (_e) { required = false; }
  return issueAndSend(userId, email, required ? buildRequiredWelcomeEmail : buildWelcomeEmail, { baseUrl, label: 'welcome' });
}

/** A new confirmation link (Confirm Your Email page). Same token model; any earlier unused link stops working. */
async function sendVerification(userId, email, { baseUrl } = {}) {
  return issueAndSend(userId, email, buildConfirmEmail, { baseUrl, label: 'confirmation' });
}

async function issueAndSend(userId, email, build, { baseUrl, label } = {}) {
  try {
    if (!userId || !email) return { ok: false };
    await db.query('DELETE FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL', [userId]);
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MINUTES * 60 * 1000);
    await db.query(
      'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [userId, hashToken(rawToken), expiresAt]
    );
    const base = String(baseUrl || process.env.PUBLIC_APP_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
    const link = `${base}/api/auth/verify-email?token=${rawToken}`;
    const { subject, html, text } = build(link);
    // Route through the central resolver so a bridge account (namespaced users.email) would receive
    // at its real contact_email; native registrations resolve to the same typed address as before.
    const to = (await resolveUserContactEmail(userId)) || email;
    await sendEmail({ to, subject, html, text });
    return { ok: true };
  } catch (err) {
    console.error('[emailVerification] ' + (label || 'email') + ' send failed:', err.message);
    return { ok: false };
  }
}

/**
 * Consume a verification token and mark the user's email verified. Single-use + expiry enforced
 * in a row-locked txn. Returns { ok:true } or { ok:false, code: INVALID_TOKEN|TOKEN_EXPIRED|TOKEN_USED }.
 * Idempotent-friendly: a token already used returns TOKEN_USED (the email is already verified).
 */
async function verifyEmail(rawToken) {
  if (!rawToken) return { ok: false, code: 'INVALID_TOKEN' };
  const tokenHash = hashToken(rawToken);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, user_id, expires_at, used_at FROM email_verification_tokens WHERE token_hash = $1 FOR UPDATE',
      [tokenHash]
    );
    const t = rows[0];
    if (!t)        { await client.query('ROLLBACK'); return { ok: false, code: 'INVALID_TOKEN' }; }
    if (t.used_at) { await client.query('ROLLBACK'); return { ok: false, code: 'TOKEN_USED' }; }
    if (new Date(t.expires_at).getTime() < Date.now()) {
      await client.query('ROLLBACK'); return { ok: false, code: 'TOKEN_EXPIRED' };
    }
    await client.query('UPDATE users SET email_verified = true, email_verified_at = now() WHERE id = $1', [t.user_id]);
    await client.query('UPDATE email_verification_tokens SET used_at = now() WHERE id = $1', [t.id]);
    await client.query('DELETE FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL', [t.user_id]);
    await client.query('COMMIT');
    return { ok: true, userId: t.user_id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { sendWelcome, sendVerification, verifyEmail, hashToken, VERIFY_TTL_MINUTES,
  _builders: { buildWelcomeEmail, buildRequiredWelcomeEmail, buildConfirmEmail } };
