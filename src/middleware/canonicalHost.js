'use strict';

/**
 * canonicalHost — permanent redirect of the www.bid.advantage.bid alias to the canonical
 * bid.advantage.bid, preserving path + query (308 preserves method + body too).
 *
 * One canonical host keeps the aap_session cookie (host-only to bid.advantage.bid), sessions, and
 * canonical URLs consistent. Mount FIRST in server.js — before any auth gate, CORS, or static — so it
 * runs before anything else. Inert unless Railway actually routes that hostname to this app (owner adds
 * the custom domain + DNS CNAME); harmless for every other host (only the exact alias is affected, and
 * the canonical host never matches, so there is no redirect loop).
 */
module.exports = function canonicalHost(req, res, next) {
  if (req.hostname === 'www.bid.advantage.bid') {
    return res.redirect(308, 'https://bid.advantage.bid' + req.originalUrl);
  }
  next();
};
