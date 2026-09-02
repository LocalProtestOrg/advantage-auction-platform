'use strict';

/**
 * demoGuard — SERVER-AUTHORITATIVE protection for the sales demo. Designated demo accounts (users.is_demo
 * = true) may freely explore the real seller/buyer UI, but must NEVER cause a real external side effect.
 * This middleware blocks demo accounts from the real-side-effect endpoints (payments, payout/Connect
 * onboarding, bulk follower email). It relies on the authoritative users.is_demo flag — never on a
 * client-supplied field — so a normal user can never be treated as demo and a demo user can never escape
 * the guard by tampering with the request. Demo-safe endpoints (browsing, creating/editing demo auctions,
 * catalog, storefront, widget preview) are intentionally NOT blocked.
 */

const db = require('../db');

// Small TTL cache — the demo accounts are few and is_demo rarely changes. Read-only; per-instance is fine.
const _cache = new Map(); // userId -> { isDemo, at }
const TTL_MS = 60 * 1000;

async function isDemoUser(userId) {
  if (!userId) return false;
  const hit = _cache.get(userId);
  const now = Date.now();
  if (hit && (now - hit.at) < TTL_MS) return hit.isDemo;
  let isDemo = false;
  try {
    const row = (await db.query('SELECT is_demo FROM users WHERE id = $1', [userId])).rows[0];
    isDemo = !!(row && row.is_demo === true);
  } catch (e) { isDemo = false; } // fail-open to false: never accidentally mark a real user "demo"
  _cache.set(userId, { isDemo, at: now });
  return isDemo;
}

// Express middleware: reject a demo account from a real-side-effect action with a friendly, safe message.
// Requires an upstream auth middleware to have set req.user.id. Non-demo users pass straight through.
function blockDemoSideEffects(req, res, next) {
  const uid = req.user && req.user.id;
  if (!uid) return next(); // auth layer decides; this guard only concerns authenticated demo accounts
  isDemoUser(uid).then((demo) => {
    if (!demo) return next();
    return res.status(403).json({
      success: false,
      code: 'DEMO_ACTION_BLOCKED',
      message: 'This is a demo account — no real charges, payouts, or messages are sent here. Everything else in the demo works normally.',
    });
  }).catch(() => next()); // on lookup error, do not hard-fail the request path
}

module.exports = { isDemoUser, blockDemoSideEffects, _cache };
