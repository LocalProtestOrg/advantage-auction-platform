'use strict';

/**
 * /auth/bd/* — BD → Advantage.Bid identity bridge (Option B). Mounted by server.js ONLY when
 * IDENTITY_BRIDGE_ENABLED === 'true' (non-production). Reuses the existing login JWT + users table;
 * does NOT modify existing auth. Identity only — never grants seller/org-owner/admin.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
let rateLimit; try { rateLimit = require('express-rate-limit'); } catch (e) { rateLimit = null; }

const router = express.Router();
const { bridgeSecret, publicAppUrl } = require('../lib/bridgeConfig');
const codeService = require('../services/bridgeCodeService');
const identityService = require('../services/bridgeIdentityService');
const handlers = require('./../services/bridgeHandlers');

const limiter = rateLimit
  ? rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false })
  : (req, res, next) => next();

// Reuse the EXACT login JWT: same secret, same {id, role} claims, same expiry. No second JWT format.
function signJwt(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });
}

// Server-to-server. BD calls this with X-Bridge-Key; the browser is never trusted here.
router.post('/api/auth/bd/exchange', express.json({ limit: '8kb' }), limiter, async (req, res) => {
  try {
    const out = await handlers.handleExchange(
      { bridgeKeyHeader: req.get('X-Bridge-Key'), body: req.body },
      { secret: bridgeSecret(), publicAppUrl: publicAppUrl(), mintCode: codeService.mint }
    );
    console.log('[identity-bridge] exchange:', out.status === 200 ? 'issued' : ('rejected — ' + (out.json && out.json.error)));
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error('[identity-bridge] exchange error');
    return res.status(500).json({ ok: false, error: 'bridge error' });
  }
});

// Browser lands with ONLY the opaque code → transparent seed page (JWT in the inline script only).
router.get('/auth/bd/return', limiter, async (req, res) => {
  try {
    const out = await handlers.handleReturn(
      { query: req.query },
      { redeemCode: codeService.redeem, linkOrCreate: identityService.linkOrCreate, signJwt, buildSeed: handlers.buildSeed }
    );
    console.log('[identity-bridge] return:', out.status === 200 ? 'seeded (identity verified)' : 'rejected');
    return res.set(out.headers).status(out.status).send(out.html);
  } catch (e) {
    console.error('[identity-bridge] return error');
    return res.set(handlers.ERROR_HEADERS).status(500).send(handlers.errorPage());
  }
});

module.exports = router;
