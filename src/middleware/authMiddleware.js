// Authentication middleware (JWT-based, hardened)
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not configured');
}

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    console.warn('[auth] missing token:', req.method, req.path);
    return res.status(401).json({ error: 'Authentication required' });
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      console.warn('[auth] token verification failed:', err.name, req.method, req.path);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (!decoded.id || !decoded.role) {
      console.warn('[auth] invalid token payload:', req.method, req.path);
      return res.status(401).json({ error: 'Invalid token payload' });
    }
    req.user = {
      id: decoded.id,
      role: decoded.role
    };
    // Sliding session renewal: when more than half the token's lifetime has
    // elapsed, mint a fresh token and return it in a response header. The client
    // fetch wrapper (public/widgets/shared/auth-refresh.js) swaps it into
    // localStorage, so an active bidder never silently expires mid-auction and a
    // page refresh no longer logs them out. Best-effort — never blocks the request.
    try {
      if (decoded.exp && decoded.iat) {
        const nowSec   = Math.floor(Date.now() / 1000);
        const lifetime = decoded.exp - decoded.iat;
        if (lifetime > 0 && (nowSec - decoded.iat) > lifetime / 2) {
          const fresh = jwt.sign(
            { id: decoded.id, role: decoded.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
          );
          res.set('X-Refreshed-Token', fresh);
        }
      }
    } catch (_) { /* renewal is best-effort; ignore */ }
    next();
  });
};

module.exports = authMiddleware;
