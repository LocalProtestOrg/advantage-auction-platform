// Optional authentication: if a valid Bearer token is present, populate req.user;
// otherwise continue as anonymous. NEVER rejects. Used by public endpoints that
// reveal more to logged-in users (e.g. realized/sold prices after close, #20.1).
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not configured');
}

const optionalAuthMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next(); // anonymous
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (!err && decoded && decoded.id && decoded.role) {
      req.user = { id: decoded.id, role: decoded.role };
    }
    next(); // proceed regardless — invalid/expired token is treated as anonymous
  });
};

module.exports = optionalAuthMiddleware;
