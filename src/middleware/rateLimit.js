// Split rate limiting middleware
const rateLimit = require('express-rate-limit');

// Rate limiting is enforced only in production.
// In development/test the limits are noise and cause flaky E2E tests when
// multiple test suites share the same server process within a 60-second window.
const isProduction = process.env.NODE_ENV === 'production';

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  skip: () => !isProduction,
  message: { error: 'Too many requests, please try again later.' }
});

const normalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  skip: () => !isProduction,
  message: { error: 'Too many requests, please try again later.' }
});

module.exports = { strictLimiter, normalLimiter };
