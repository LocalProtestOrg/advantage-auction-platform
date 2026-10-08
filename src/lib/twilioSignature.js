'use strict';

/**
 * Twilio request signature checks (X-Twilio-Signature, HMAC-SHA1 with the account auth token over the URL plus any POST
 * parameters). Twilio signs the exact URL it requested, which behind Railway's proxy can differ from what Express sees,
 * so a small set of candidate URLs is tried: the canonical public base and the forwarded host, and for WebSocket
 * handshakes the wss:// form (with and without a trailing slash, as Twilio's guidance suggests). Nothing is logged.
 */

function httpCandidates({ originalUrl, host, publicBase }) {
  const urls = new Set();
  if (publicBase) urls.add(String(publicBase).replace(/\/+$/, '') + originalUrl);
  if (host) urls.add('https://' + host + originalUrl);
  return [...urls];
}

function wsCandidates({ originalUrl, host, publicBase }) {
  const out = new Set();
  const bases = [];
  if (publicBase) bases.push(String(publicBase).replace(/\/+$/, '').replace(/^https?:/, 'wss:'));
  if (host) bases.push('wss://' + host);
  for (const b of bases) {
    out.add(b + originalUrl);
    const [path, query] = originalUrl.split('?');
    if (!path.endsWith('/')) out.add(b + path + '/' + (query != null ? '?' + query : ''));
  }
  return [...out];
}

/** True when the signature matches one candidate URL. deps.validateRequest is injectable for tests. */
function valid({ signature, urls, params = {} }, deps = {}) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature || !urls || !urls.length) return false;
  const validate = deps.validateRequest || require('twilio').validateRequest;
  return urls.some((u) => { try { return validate(token, signature, u, params || {}); } catch (_e) { return false; } });
}

function publicBase() { try { return require('./publicUrls').publicBaseUrl(); } catch (_e) { return null; } }

/** Express request (form-encoded webhook). */
function validExpressRequest(req, deps = {}) {
  const host = req.get('x-forwarded-host') || req.get('host');
  return valid({ signature: req.get('x-twilio-signature'), urls: httpCandidates({ originalUrl: req.originalUrl, host, publicBase: publicBase() }), params: req.body || {} }, deps);
}

/** Node http.IncomingMessage of a WebSocket upgrade (no body). */
function validUpgradeRequest(req, deps = {}) {
  const h = req.headers || {};
  const host = h['x-forwarded-host'] || h.host;
  return valid({ signature: h['x-twilio-signature'], urls: wsCandidates({ originalUrl: req.url, host, publicBase: publicBase() }), params: {} }, deps);
}

module.exports = { valid, validExpressRequest, validUpgradeRequest, httpCandidates, wsCandidates };
