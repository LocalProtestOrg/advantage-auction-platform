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
    next();
  });
};

module.exports = authMiddleware;
