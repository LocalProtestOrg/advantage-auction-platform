const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db/index');
const auth = require('../middleware/authMiddleware');
const { normalLimiter, strictLimiter } = require('../middleware/rateLimit');
const { requestReset, resetPassword } = require('../services/passwordResetService');
const emailVerificationService = require('../services/emailVerificationService');
const { setSessionCookie, clearSessionCookie, readSessionToken } = require('../lib/sessionCookie');
const { bdMemberAdminUrl } = require('../lib/bridgeConfig');
const agreementService = require('../services/agreementService');
const { isProfessional } = require('../services/sellerTypeRules');
const { maskEmailForLog } = require('../lib/logSafe');
const sessionTokens = require('../lib/sessionTokens');
const accountEmail = require('../lib/accountEmail');
const loginThrottle = require('../lib/loginThrottle');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

// Login timing equalizer: every password login performs exactly one bcrypt comparison, so the
// response time does not reveal whether the account exists or has a local password. The hash is of
// random bytes generated in-process (never a credential, never persisted).
let TIMING_HASH = null;
async function timingHash() {
  if (!TIMING_HASH) TIMING_HASH = await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10);
  return TIMING_HASH;
}

// Register
// Exactly ONE plain address: the welcome/verification email is sent to this string, and a list ("a@x.com, b@y.com")
// would mail every recipient from our domain (security audit 2026-10-15).
const SINGLE_EMAIL = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/;

router.post('/register', normalLimiter, async (req, res) => {
  const { password } = req.body;
  // Stored lower-case and trimmed; an address that differs only by letter case is the same account (security audit
  // 2026-10-15). Existing accounts are never changed or merged.
  const email = accountEmail.normalizeEmail(req.body.email);
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password required' });
  }
  if (email.length > 254 || !SINGLE_EMAIL.test(email)) {
    return res.status(400).json({ success: false, error: 'Please enter a single valid email address' });
  }
  if (typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  }
  try {
    if (await accountEmail.findUserByEmail(email, 'id')) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, role',
      [email, hashedPassword, 'buyer']
    );
    const user = result.rows[0];
    const token = sessionTokens.issueToken(user);
    // Launch: professional welcome email + OPTIONAL (non-blocking) email verification.
    // Fire-and-forget — registration must never fail because email delivery did, and
    // nothing downstream gates on verification.
    emailVerificationService.sendWelcome(user.id, email).catch(() => {});
    setSessionCookie(res, token); // server-side session for the HTML gate (same JWT)
    // First-party conversion ledger (fire-and-forget; never affects registration). visitor_id is the anonymous
    // first-party token from the page; the user id is server-derived.
    require('../services/conversionService').emit('buyer_registered', { ...require('../services/conversionService').ctxFromReq(req), userId: user.id, visitorId: typeof (req.body || {}).visitor_id === 'string' ? req.body.visitor_id.slice(0, 64) : null, subjectType: 'user', subjectId: user.id });
    res.json({ success: true, token, data: { user: { id: user.id } } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'An account with this email already exists' });
    }
    console.error('[auth] register failed:', { email: maskEmailForLog(email), error: err.message });
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
  // Per-account throttle (all addresses), on top of the per-IP limiter; same response whether or not the account exists.
  if (loginThrottle.lockedFor(email) > 0) {
    return res.status(429).json(loginThrottle.LOCKED_BODY);
  }
  try {
    const user = await accountEmail.findUserByEmail(String(email), '*');   // case-insensitive, never ambiguous
    // A local password is required for the email/password path. An account without one (e.g. a
    // future Google/Facebook-only account) can NEVER authenticate here just because password_hash is
    // NULL. Unknown account, no local password, malformed hash and wrong password all return the
    // identical generic 401 after one bcrypt comparison — nothing reveals existence or auth source.
    const hash = user && typeof user.password_hash === 'string' && user.password_hash.length ? user.password_hash : null;
    let validPassword = false;
    try {
      validPassword = await bcrypt.compare(String(password), hash || await timingHash());
    } catch (_) { validPassword = false; }
    if (!user || !hash || validPassword !== true) {
      loginThrottle.recordFailure(email);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    loginThrottle.recordSuccess(email);
    // OPS-3: suspended accounts cannot log in. is_active defaults true; admin
    // toggles it via /api/admin/sellers/:id/{suspend,unsuspend}. We return 403
    // (not 401) with a clear message so the user knows the account exists but
    // is locked, not that their password is wrong.
    if (user.is_active === false) {
      return res.status(403).json({ success: false, error: 'Account suspended. Contact Advantage.Bid support.' });
    }
    const token = sessionTokens.issueToken(user); // carries users.session_version + a new sign-in id
    setSessionCookie(res, token); // server-side session for the HTML gate (same JWT)
    // Best-effort last-login stamp (used by Staff & Permissions). Never blocks or fails the login.
    db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]).catch(() => {});
    res.json({ success: true, token });
  } catch (err) {
    console.error('[auth] login failed:', { email: maskEmailForLog(email), error: err.message });
    return res.status(500).json({ success: false, error: 'Login failed. Please try again.' }); // never echo internals
  }
});

// POST /api/auth/session — establish/refresh the server-side session cookie from a valid Bearer
// token. Used by the login page to seed the cookie for pre-existing localStorage-only sessions so
// the HTML gate authenticates their next navigation (auth middleware already sets the cookie).
router.post('/session', auth, (req, res) => {
  res.json({ success: true });
});

// POST /api/auth/logout — clear the server-side session cookie. The client also clears its
// localStorage token; the GET /logout page route (server.js) does both + redirects. Unauthenticated
// callers are fine — clearing an absent cookie is a no-op.
// The sign-in presented (Bearer and/or cookie) is also ended on the server (revoked_sessions), so a copy of the token
// stops working too. Best-effort: signing out in the browser always succeeds.
router.post('/logout', async (req, res) => {
  const { resolveSession } = require('../lib/sessionAuth');
  const tokens = new Set([String((req.headers.authorization || '').split(' ')[1] || ''), String(readSessionToken(req) || '')]);
  for (const t of tokens) {
    if (!t) continue;
    const decoded = resolveSession({ headers: { authorization: 'Bearer ' + t } }).decoded;
    if (decoded) await sessionTokens.endSession(decoded, t, 'logout').catch(() => {});
  }
  clearSessionCookie(res);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true });
});

// GET /api/auth/session-status — MINIMAL cross-origin session probe for the Advantage.Bid public
// header on BD (www.advantage.bid). Reads the host-only aap_session cookie (a same-site subrequest,
// so the SameSite=Lax cookie IS sent), verifies the JWT, and returns ONLY a boolean. No id, email,
// role, or token ever leaves here. Credentialed CORS is locked to the approved Advantage.Bid hosts;
// any other origin gets no Access-Control-Allow-Origin and cannot read the response. It is a simple
// GET (no custom request headers) so browsers send it WITHOUT a CORS preflight. Fails safe: any
// error → { authenticated: false }, never throws to the caller, never blocks the page.
const SESSION_STATUS_ORIGINS = new Set([
  'https://www.advantage.bid',
  'https://advantage.bid',
]);
router.get('/session-status', async (req, res) => {
  const origin = req.headers.origin;
  if (origin && SESSION_STATUS_ORIGINS.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);      // exact origin (never '*' with credentials)
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
  }
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  let authenticated = false;
  try {
    const token = readSessionToken(req);
    if (token && process.env.JWT_SECRET) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded && decoded.id && decoded.role) {
        const check = await sessionTokens.checkSession(decoded, token);
        authenticated = check.state === 'ok' || check.state === 'unknown';
      }
    }
  } catch (_) { authenticated = false; }
  return res.json({ authenticated });
});

// GET /api/auth/me
// Returns the authenticated user's id, email, and role. Lightweight
// alternative to /api/sellers/me for surfaces that need identity but not
// seller-specific data (e.g., admin dashboard identity banner). The JWT
// only carries id + role; email is fetched fresh from the users table.
router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, role, full_name, phone,
              (phone_verified_at IS NOT NULL AND phone_verified_e164 IS NOT NULL AND phone = phone_verified_e164) AS phone_verified,
              EXISTS (SELECT 1 FROM external_identities ei
                       WHERE ei.user_id = users.id AND ei.provider = 'brilliant_directories') AS bd_member,
              EXISTS (SELECT 1 FROM organization_members m
                        JOIN organization_capabilities c ON c.organization_id = m.organization_id
                       WHERE m.user_id = users.id AND m.status = 'active'
                         AND c.capability = 'events' AND c.enabled = true) AS event_organizer
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    // seller_ready: Marketplace seller setup complete — a seller_profile AND a satisfied agreement gate
    // (signed, admin-waived, or grandfathered). Single server-authoritative signal; the client never
    // re-derives entitlement. Drives the three-state seller CTA + the "Create/Manage Online Auction" nav.
    // storefront_eligible: online Storefronts (My Storefront / Add Item / Store Orders) are for
    // Professional Sellers only — the SAME canonical isProfessional rule the storefront services enforce.
    // Individual Sellers (private / business / other / untyped) and accounts without a seller profile
    // (admins included) are not eligible. Drives nav visibility only; the services remain authoritative.
    let sellerReady = false, storefrontEligible = false;
    try {
      const sp = (await db.query('SELECT id, seller_type FROM seller_profiles WHERE user_id = $1', [req.user.id])).rows[0];
      if (sp) {
        storefrontEligible = isProfessional(sp.seller_type);
        sellerReady = (await agreementService.dashboardAccess(sp.id)).access === true;
      }
    } catch (_) { sellerReady = false; }
    // Business Administration (BD member area) is offered only to members who actually came from BD;
    // native buyers/sellers have no BD dashboard to return to. The URL is server-authoritative.
    // event_organizer drives the My Events / Create Event marketplace nav (org member + events capability).
    const bdMember = rows[0].bd_member === true;
    return res.json({ success: true, data: Object.assign(rows[0], {
      bd_member: bdMember,
      event_organizer: rows[0].event_organizer === true,
      seller_ready: sellerReady,
      storefront_eligible: storefrontEligible,
      business_admin_url: bdMember ? bdMemberAdminUrl() : null,
    }) });
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
    // A VERIFIED phone can only be replaced through the verified-phone flow (password + a code to the new number). An
    // unverified free-text phone can still be edited here as before; saving the same verified number is a no-op.
    if (req.body && 'phone' in req.body) {
      const cur = (await db.query('SELECT phone, phone_verified_at, phone_verified_e164 FROM users WHERE id = $1', [req.user.id])).rows[0];
      const phoneSvc = require('../services/accountPhoneService');
      if (phoneSvc.isVerified(cur)) {
        const next = require('../lib/phoneNumber').normalizeUsPhone(req.body.phone);
        if (next.e164 !== cur.phone_verified_e164) {
          return res.status(409).json({ success: false, code: 'VERIFIED_PHONE_CHANGE', error: 'To change your verified phone number, use Verify phone so we can confirm the new number.' });
        }
        params[sets.findIndex((x) => x.startsWith('phone='))] = cur.phone;   // keep the exact verified value
      }
    }
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