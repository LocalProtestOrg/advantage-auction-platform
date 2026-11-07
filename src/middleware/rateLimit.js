// Split rate limiting middleware
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

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

// ── Bid placement (POST /api/lots/:lotId/bids), per ACCOUNT, not per address ──────────────────────────────────────
// Mounted AFTER authMiddleware, so the key is the signed-in account: a household or office sharing one address is
// never limited together, and one account cannot spread a flood across addresses.
//   burst:     20 bids per 10 seconds  (2 a second, a pace no person keeps up by hand: a buyer racing several lots
//              through the final soft-close minutes places a bid every few seconds at most)
//   sustained: 120 bids per minute     (still 2 a second for a full minute; stops scripted floods only)
// Only bid REQUESTS are counted. Proxy (maximum) bidding is resolved inside one request on the server, so automatic
// bids, soft-close extensions and staggered closing are untouched. Administrators are exempt (admin override).
// Like the other limiters it is skipped outside production (tests and local runs), unless BID_RATE_LIMIT_ENABLED=true
// (used by the tests to exercise it); BID_RATE_LIMIT_ENABLED=false is an emergency off switch in production.
// The store is in memory, per server instance.
const BID_LIMITS = { burst: { windowMs: 10 * 1000, max: 20 }, sustained: { windowMs: 60 * 1000, max: 120 } };
const BID_RATE_MESSAGE = 'You are placing bids very quickly. Please wait a few seconds and try again.';

function bidLimitSkipped(req) {
  const flag = process.env.BID_RATE_LIMIT_ENABLED;
  if (flag === 'false') return true;
  if (process.env.NODE_ENV !== 'production' && flag !== 'true') return true;
  return !!(req.user && req.user.role === 'admin');
}

function makeBidLimiter({ windowMs, max }) {
  return rateLimit({
    windowMs, limit: max,
    standardHeaders: 'draft-7', legacyHeaders: false,
    skip: bidLimitSkipped,
    keyGenerator: (req) => (req.user && req.user.id ? 'user:' + req.user.id : 'ip:' + ipKeyGenerator(req.ip || '')),
    handler: (req, res) => res.status(429).json({ success: false, code: 'BID_RATE_LIMITED', message: BID_RATE_MESSAGE }),
  });
}
const bidBurstLimiter = makeBidLimiter(BID_LIMITS.burst);
const bidSustainedLimiter = makeBidLimiter(BID_LIMITS.sustained);
const bidRateLimit = [bidBurstLimiter, bidSustainedLimiter];

module.exports = { strictLimiter, normalLimiter, feedbackLimiter, bidRateLimit, bidBurstLimiter, bidSustainedLimiter,
  makeBidLimiter, bidLimitSkipped, BID_LIMITS, BID_RATE_MESSAGE };
