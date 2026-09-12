'use strict';

/**
 * webhookSignature — proves a provider callback really came from the provider.
 *
 * Closes the Phase 2 audit finding: the SES/SNS feedback receiver authenticated only with a shared
 * secret in the query string. That was tolerable for delivery receipts. It is not tolerable once
 * inbound company correspondence arrives the same way, because a forged callback could fabricate a
 * reply — and a fabricated reply is an input to classification, suppression and link re-sending.
 *
 * Two providers, two mechanisms, because they genuinely differ:
 *
 *   AWS SNS  — cryptographically signs every message. We rebuild the canonical string-to-sign exactly
 *              as documented, fetch the signing certificate from a HOST-VALIDATED AWS URL, and verify
 *              RSA-SHA1 (SignatureVersion 1) or RSA-SHA256 (SignatureVersion 2). Real verification.
 *
 *   Postmark — does not sign payloads. Its documented practice is a secret in the webhook URL, HTTP
 *              Basic auth, and/or source-IP allowlisting. We support all three and require at least
 *              the secret, so an attacker needs the secret even to be considered.
 *
 * FAIL-CLOSED vs FAIL-OPEN, stated explicitly because the distinction is the whole design:
 *   - A signature that is PRESENT and WRONG is always rejected. No configuration can change that.
 *   - A failure to FETCH a signing certificate is an infrastructure fault, not evidence of forgery.
 *     It returns `verify_unavailable`, which the caller records as such — never as `verified`. The
 *     caller decides, and for the live SES feedback pipeline it accepts rather than dropping real
 *     bounce and complaint data, because losing suppression signals is itself a compliance harm.
 */

const crypto = require('crypto');
const https = require('https');

// SNS signs these fields, in this exact order, for these message types.
const SNS_SIGN_FIELDS = Object.freeze({
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
});

// Only an AWS-owned host may serve a signing certificate. This is what stops an attacker pointing
// SigningCertURL at their own server and signing whatever they like.
const AWS_CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i;

const certCache = new Map();          // url → { pem, at }
const CERT_TTL_MS = 24 * 60 * 60 * 1000;
const CERT_CACHE_MAX = 20;

/** Validate the certificate URL before it is ever fetched. */
function isAwsCertUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && AWS_CERT_HOST.test(u.hostname) && /\.pem$/i.test(u.pathname);
  } catch (_) { return false; }
}

/** Fetch (and cache) an SNS signing certificate. Rejects any non-AWS URL outright. */
function fetchCertificate(url, opts) {
  opts = opts || {};
  if (!isAwsCertUrl(url)) return Promise.reject(new Error('SigningCertURL is not an AWS SNS URL'));
  const hit = certCache.get(url);
  if (hit && (Date.now() - hit.at) < CERT_TTL_MS) return Promise.resolve(hit.pem);
  if (typeof opts.fetchImpl === 'function') {
    return Promise.resolve(opts.fetchImpl(url)).then((pem) => {
      if (certCache.size >= CERT_CACHE_MAX) certCache.clear();
      certCache.set(url, { pem, at: Date.now() });
      return pem;
    });
  }
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('cert fetch HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 64 * 1024) req.destroy(new Error('cert too large')); });
      res.on('end', () => {
        if (!/-----BEGIN CERTIFICATE-----/.test(body)) return reject(new Error('not a PEM certificate'));
        if (certCache.size >= CERT_CACHE_MAX) certCache.clear();
        certCache.set(url, { pem: body, at: Date.now() });
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('cert fetch timeout')));
    req.on('error', reject);
  });
}

/**
 * The canonical string AWS signed: for each signed field present in the message, the field name and
 * its value, each followed by a newline. Absent fields are skipped (Subject often is).
 */
function buildStringToSign(msg) {
  const fields = SNS_SIGN_FIELDS[msg && msg.Type];
  if (!fields) return null;
  let s = '';
  for (const f of fields) {
    if (msg[f] === undefined || msg[f] === null) continue;
    s += f + '\n' + String(msg[f]) + '\n';
  }
  return s;
}

/**
 * verifySns(msg, opts) → { ok, status, reason }
 *   status: 'verified' | 'rejected_signature' | 'verify_unavailable'
 *
 * `rejected_signature` means the message is not authentic — a real signature check failed, or the
 * certificate URL was not AWS-owned, or required fields were missing. Always refuse these.
 * `verify_unavailable` means we could not complete the check for infrastructure reasons.
 */
async function verifySns(msg, opts) {
  opts = opts || {};
  if (!msg || typeof msg !== 'object') return { ok: false, status: 'rejected_signature', reason: 'no message' };
  if (!SNS_SIGN_FIELDS[msg.Type]) return { ok: false, status: 'rejected_signature', reason: 'unknown SNS Type' };
  if (!msg.Signature || !msg.SigningCertURL) return { ok: false, status: 'rejected_signature', reason: 'missing Signature/SigningCertURL' };
  if (!isAwsCertUrl(msg.SigningCertURL)) return { ok: false, status: 'rejected_signature', reason: 'SigningCertURL host not AWS' };

  const stringToSign = buildStringToSign(msg);
  if (!stringToSign) return { ok: false, status: 'rejected_signature', reason: 'cannot build string to sign' };

  let pem;
  try {
    pem = await fetchCertificate(msg.SigningCertURL, opts);
  } catch (e) {
    // Infrastructure, not forgery. Never reported as verified.
    return { ok: false, status: 'verify_unavailable', reason: 'certificate unavailable: ' + e.message };
  }

  // SignatureVersion 1 = RSA-SHA1, 2 = RSA-SHA256. Default to 1 when absent (AWS's own default).
  const version = String(msg.SignatureVersion || '1');
  const algo = version === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  try {
    const v = crypto.createVerify(algo);
    v.update(stringToSign, 'utf8');
    const ok = v.verify(pem, Buffer.from(String(msg.Signature), 'base64'));
    return ok
      ? { ok: true, status: 'verified', reason: algo }
      : { ok: false, status: 'rejected_signature', reason: algo + ' signature mismatch' };
  } catch (e) {
    return { ok: false, status: 'rejected_signature', reason: 'verify error: ' + e.message };
  }
}

/**
 * verifyPostmark(req, opts) → { ok, status, reason }
 *   status: 'verified' | 'rejected_secret' | 'rejected_source'
 *
 * Postmark sends no signature, so authenticity rests on a secret only we and Postmark know, and
 * optionally on the source address. The secret is compared in constant time.
 */
function verifyPostmark(req, opts) {
  opts = opts || {};
  const expected = opts.expectedSecret;
  if (!expected) return { ok: false, status: 'rejected_secret', reason: 'no webhook secret configured' };

  const q = (req && req.query) || {};
  const h = (req && req.headers) || {};
  let presented = q.token || h['x-webhook-secret'] || null;

  // HTTP Basic auth is Postmark's other documented option.
  if (!presented && typeof h.authorization === 'string' && /^basic /i.test(h.authorization)) {
    try {
      const decoded = Buffer.from(h.authorization.slice(6).trim(), 'base64').toString('utf8');
      presented = decoded.slice(decoded.indexOf(':') + 1);
    } catch (_) { presented = null; }
  }
  if (!presented) return { ok: false, status: 'rejected_secret', reason: 'no secret presented' };

  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 'rejected_secret', reason: 'secret mismatch' };
  }

  // Optional source-address allowlist (Postmark publishes its outbound webhook ranges).
  const allow = opts.allowedIps;
  if (Array.isArray(allow) && allow.length) {
    const remote = String(opts.remoteIp || '').split(',')[0].trim();
    const permitted = allow.some((entry) => {
      const e = String(entry).trim();
      if (!e) return false;
      // Exact address, or a simple dotted prefix such as "3.134." — no CIDR maths, no surprises.
      return remote === e || (e.endsWith('.') && remote.indexOf(e) === 0);
    });
    if (!permitted) return { ok: false, status: 'rejected_source', reason: 'source address not allowlisted' };
  }
  return { ok: true, status: 'verified', reason: 'secret match' };
}

/** Stable digest of a raw payload — replay protection and tamper-evident evidence. */
function payloadDigest(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw == null ? null : raw);
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = {
  verifySns, verifyPostmark, payloadDigest,
  isAwsCertUrl, buildStringToSign, fetchCertificate,
  SNS_SIGN_FIELDS, _certCache: certCache,
};
