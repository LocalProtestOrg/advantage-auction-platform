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

// A session ended on the server (signed out, password reset, suspension, role change — src/lib/sessionTokens.js) is
// anonymous here too; the current database role is used. If the session state cannot be determined the token's
// identity is used as before.
const optionalAuthMiddleware = (req, res, next) => {
  let resolved, identity;
  try {
    resolved = resolveSession(req);
    identity = identityFrom(resolved.decoded);
  } catch (_) { identity = null; }
  if (!identity) return next();
  return require('../lib/sessionTokens').checkSession(resolved.decoded, resolved.token)
    .then((check) => {
      if (check.state === 'ok') req.user = { id: identity.id, role: check.role };
      else if (check.state === 'unknown') req.user = identity;
    })
    .catch(() => { req.user = identity; })
    .then(() => next());
};

module.exports = optionalAuthMiddleware;
