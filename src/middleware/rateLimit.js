// Split rate limiting middleware
const rateLimit = require('express-rate-limit');

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' }
});

const normalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' }
});

module.exports = { strictLimiter, normalLimiter };
