// Optional authentication: if a valid Advantage.Bid session is present — via the Authorization
// Bearer header OR the aap_session HttpOnly cookie — populate req.user; otherwise continue as
// anonymous. NEVER rejects. Used by public endpoints that reveal more to logged-in users (e.g.
// realized/sold prices after close, #20.1).
//
// Uses the SAME resolver as the mandatory authMiddleware (src/lib/sessionAuth.js): identical
// carriers, precedence (a verified Bearer wins; otherwise a verified cookie), signature and expiry
// checks, and payload shape ({ id, role }). An invalid or expired credential is anonymous — never
// authenticated. Read-only: unlike the mandatory middleware it never renews or sets the cookie, so a
// public response carries no Set-Cookie.
const { resolveSession, identityFrom } = require('../lib/sessionAuth');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not configured');
}

const optionalAuthMiddleware = (req, res, next) => {
  try {
    const identity = identityFrom(resolveSession(req).decoded);
    if (identity) req.user = identity;
  } catch (_) { /* optional auth never blocks a public request */ }
  next();
};

module.exports = optionalAuthMiddleware;
