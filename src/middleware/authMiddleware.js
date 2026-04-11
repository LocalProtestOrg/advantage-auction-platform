// Authentication middleware (JWT-based, hardened)
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not configured');
}

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    if (!decoded.id || !decoded.role) {
      return res.status(403).json({ error: 'Invalid token payload' });
    }
    req.user = {
      id: decoded.id,
      role: decoded.role
    };
    next();
  });
};

module.exports = authMiddleware;
