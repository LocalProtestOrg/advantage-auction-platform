// Idempotency protection middleware (with response replay and memory cap)
const crypto = require('crypto');
const idempotencyCache = new Map();
const MAX_CACHE_SIZE = 5000;

const idempotencyMiddleware = (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key) return next();

  const hash = crypto.createHash('sha256')
    .update(key + req.originalUrl + JSON.stringify(req.body))
    .digest('hex');

  if (idempotencyCache.has(hash)) {
    const cached = idempotencyCache.get(hash);
    return res.status(cached.status).json(cached.response);
  }

  if (idempotencyCache.size > MAX_CACHE_SIZE) {
    idempotencyCache.clear(); // simple safety reset
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    idempotencyCache.set(hash, {
      status: res.statusCode,
      response: body
    });
    return originalJson(body);
  };

  next();
};

module.exports = idempotencyMiddleware;
