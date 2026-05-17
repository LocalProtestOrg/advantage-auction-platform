'use strict';

/**
 * Analytics ingestion API — /api/analytics/*
 *
 * Public endpoints — no authentication required.
 * Rate-limited to 100 requests per IP per minute.
 *
 * POST /api/analytics/events  — single event or batch (array, max 20)
 *
 * Always returns 202 Accepted immediately.
 * DB writes are fire-and-forget — this endpoint never blocks on the insert.
 * If analytics storage fails, the 202 is still returned. Callers (widgets,
 * frontend pages) must never depend on analytics succeeding.
 *
 * Privacy guarantees:
 *   - IP addresses are hashed in the service layer before storage
 *   - PII fields (email, password, card, etc.) are stripped by the service
 *   - No authentication tokens are accepted or stored
 *   - session_id is a random non-identifying client token
 */

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { insertEvent, insertBatch } = require('../services/analyticsService');

const router = express.Router();

// 100 events per IP per 60-second window
// Burst protection — bots trying to flood the table get a 429 before they
// can affect throughput. Legitimate BD pages emit at most a few events per
// page load.
// No custom keyGenerator — trust proxy: 1 in server.js makes req.ip correct,
// and the default keyGenerator handles IPv6 safely (no ERR_ERL_KEY_GEN_IPV6).
const analyticsLimiter = rateLimit({
  windowMs:             60 * 1000,
  max:                  100,
  standardHeaders:      true,
  legacyHeaders:        false,
  skipSuccessfulRequests: false,
  message:              { error: 'Too many events — rate limit exceeded' },
});

// ── POST /api/analytics/events ────────────────────────────────────────────────
router.post('/events', analyticsLimiter, (req, res) => {
  const body = req.body;
  const ip   = req.headers['x-forwarded-for'] || req.ip || '';

  // Respond immediately — writes are non-blocking
  res.status(202).json({ accepted: true });

  // Fire-and-forget after response is sent
  if (Array.isArray(body)) {
    insertBatch(body, ip);
  } else if (body && typeof body === 'object') {
    insertEvent(body, ip);
  }
});

module.exports = router;
