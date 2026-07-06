const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db/index');
const auth = require('../middleware/authMiddleware');
const { normalLimiter, strictLimiter } = require('../middleware/rateLimit');
const { requestReset, resetPassword } = require('../services/passwordResetService');
const emailVerificationService = require('../services/emailVerificationService');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

// Register
router.post('/register', normalLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, role',
      [email, hashedPassword, 'buyer']
    );
    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );
    // Launch: professional welcome email + OPTIONAL (non-blocking) email verification.
    // Fire-and-forget — registration must never fail because email delivery did, and
    // nothing downstream gates on verification.
    emailVerificationService.sendWelcome(user.id, email).catch(() => {});
    res.json({ success: true, token, data: { user: { id: user.id } } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'An account with this email already exists' });
    }
    console.error('[auth] register failed:', { email, error: err.message });
    return res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// GET /api/auth/verify-email?token=... — OPTIONAL, non-blocking email confirmation.
// Clicked from the welcome email. Records verification; never gates any flow. Returns a
// friendly branded page (a token already used reads as success — the email is verified).
router.get('/verify-email', async (req, res) => {
  let ok = false;
  try {
    const result = await emailVerificationService.verifyEmail(req.query.token);
    ok = result.ok || result.code === 'TOKEN_USED';
  } catch (err) {
    console.error('[auth] verify-email failed:', err.message);
  }
  const home = (process.env.PUBLIC_APP_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
  const heading = ok ? 'Email confirmed' : 'Link expired or invalid';
  const msg = ok
    ? 'Thank you — your email address is confirmed. You can close this tab and return to Advantage.Bid.'
    : 'This confirmation link is no longer valid. Confirming your email is optional — your account already works for bidding and checkout.';
  res.status(ok ? 200 : 400).type('html').send(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading} — Advantage.Bid</title></head>` +
    `<body style="font-family:system-ui,-apple-system,sans-serif;background:#fafafa;margin:0;padding:2.5rem 1rem;color:#111;">` +
    `<div style="max-width:460px;margin:0 auto;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;background:#fff;">` +
    `<div style="background:#111;color:#fff;padding:1rem 1.25rem;font-weight:700;">Advantage.Bid</div>` +
    `<div style="padding:1.75rem 1.35rem;"><h1 style="font-size:1.2rem;margin:0 0 .6rem;">${heading}</h1>` +
    `<p style="font-size:.92rem;line-height:1.6;color:#374151;margin:0 0 1.25rem;">${msg}</p>` +
    `<a href="${home}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:700;padding:.65rem 1.25rem;border-radius:7px;font-size:.9rem;">Go to Advantage.Bid</a>` +
    `</div></div></body></html>`
  );
});

// Login
router.post('/login', strictLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password required' });
  }
  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    // OPS-3: suspended accounts cannot log in. is_active defaults true; admin
    // toggles it via /api/admin/sellers/:id/{suspend,unsuspend}. We return 403
    // (not 401) with a clear message so the user knows the account exists but
    // is locked, not that their password is wrong.
    if (user.is_active === false) {
      return res.status(403).json({ success: false, error: 'Account suspended. Contact Advantage Auction support.' });
    }
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );
    res.json({ success: true, token });
  } catch (err) {
    console.error('[auth] login failed:', { email, error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/me
// Returns the authenticated user's id, email, and role. Lightweight
// alternative to /api/sellers/me for surfaces that need identity but not
// seller-specific data (e.g., admin dashboard identity banner). The JWT
// only carries id + role; email is fetched fresh from the users table.
router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, email, role, full_name, phone FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[auth] /me failed:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to load user' });
  }
});

// PATCH /api/auth/me — authenticated user edits their OWN profile contact fields
// (full_name, phone). Self-scoped only; email/role/status are NOT editable here.
// (ACCOUNT/BUYER OPS — buyer account/profile editing.)
router.patch('/me', auth, async (req, res) => {
  try {
    const sets = [], params = [];
    if (req.body && 'full_name' in req.body) { params.push(req.body.full_name == null ? null : String(req.body.full_name).slice(0, 200)); sets.push(`full_name=$${params.length}`); }
    if (req.body && 'phone' in req.body)     { params.push(req.body.phone == null ? null : String(req.body.phone).slice(0, 40));      sets.push(`phone=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, error: 'No editable fields (full_name, phone)' });
    params.push(req.user.id);
    const { rows } = await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id, email, role, full_name, phone`, params);
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[auth] PATCH /me failed:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update profile' });
  }
});

// POST /api/auth/forgot-password — request a reset link.
// Always returns 200 with a generic message (no account enumeration), even on error.
// strictLimiter (10/min/IP in prod) curbs abuse/scraping.
router.post('/forgot-password', strictLimiter, async (req, res) => {
  const GENERIC = 'If an account exists for that email, a password reset link is on its way.';
  try {
    const { email } = req.body || {};
    const baseUrl = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
    await requestReset(email, { ip: req.ip, baseUrl });
    return res.json({ success: true, message: GENERIC });
  } catch (err) {
    // Return the same generic message on internal failure — never leak existence or errors.
    console.error('[auth] forgot-password failed:', err.message);
    return res.json({ success: true, message: GENERIC });
  }
});

// POST /api/auth/reset-password — set a new password from a single-use, expiring token.
router.post('/reset-password', strictLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const result = await resetPassword(token, password);
    if (result.ok) {
      return res.json({ success: true, message: 'Your password has been updated. You can now sign in.' });
    }
    const messages = {
      WEAK_PASSWORD: 'Password must be at least 8 characters.',
      TOKEN_EXPIRED: 'This reset link has expired. Please request a new one.',
      TOKEN_USED:    'This reset link has already been used. Please request a new one.',
      INVALID_TOKEN: 'This reset link is invalid. Please request a new one.',
    };
    return res.status(400).json({ success: false, error: messages[result.code] || messages.INVALID_TOKEN });
  } catch (err) {
    console.error('[auth] reset-password failed:', err.message);
    return res.status(500).json({ success: false, error: 'Could not reset your password. Please try again.' });
  }
});

module.exports = router;