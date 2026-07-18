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

// Public feedback: tight per-IP cap to blunt spam/abuse. Unlike the others this stays ACTIVE
// on staging + production (only skipped in dev/test) so spam protection can be validated
// pre-production. 5 submissions / 10 minutes is generous for a genuine user.
const feedbackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  skip: () => ['test', 'development'].includes(process.env.NODE_ENV),
  message: { error: 'You have sent several messages recently. Please wait a few minutes and try again.' },
});

module.exports = { strictLimiter, normalLimiter, feedbackLimiter };
