'use strict';

/**
 * blockClassifier — why did a website answer the way it did? Pure; reads only the response itself.
 *
 *   classifyResponse({ status, headers, text, url, requestedUrl }) → { class, transient, reason, evidence }
 *   describe(class, audience)  → plain-English sentence ('seller' is vendor-neutral; 'admin' may be technical)
 *
 * Classes: ok · bot_challenge · host_firewall_refusal · rate_limited · unreachable · login_required ·
 * not_found · other. A 2xx can still be a challenge page. A refusal or challenge is a recorded fact; the
 * importer never answers it with a different identity or a solved challenge.
 */

const CLASSES = Object.freeze(['ok', 'bot_challenge', 'host_firewall_refusal', 'rate_limited', 'unreachable', 'login_required', 'not_found', 'other']);

// Response headers that identify the edge in front of a site (kept as evidence, never acted on).
const EDGE_HEADERS = ['server', 'x-amz-cf-id', 'x-amz-cf-pop', 'x-amzn-waf-action', 'cf-ray', 'cf-mitigated', 'x-iinfo', 'x-cdn', 'akamai-grn', 'x-akamai-transformed', 'x-sucuri-id'];

function lower(h) { const o = {}; for (const k of Object.keys(h || {})) o[k.toLowerCase()] = String(h[k]); return o; }

function edgeMarker(h) {
  const found = [];
  for (const k of EDGE_HEADERS) if (h[k] != null && h[k] !== '') found.push(k + ': ' + String(h[k]).slice(0, 80));
  return found.length ? found.join('; ') : undefined;
}

function pathOf(u) { try { return new URL(String(u)).pathname.toLowerCase(); } catch (_) { return ''; } }
const LOGIN_RE = /(^|\/)(login|log-in|signin|sign-in|wp-login\.php|account)(\/|$|\.|\?)/;

function classifyResponse({ status, headers, text, url, requestedUrl } = {}) {
  const h = lower(headers);
  const body = String(text || '');
  const evidence = { status, url: url || requestedUrl || null };
  const marker = edgeMarker(h);
  if (marker) evidence.header = marker;
  const out = (cls, transient, reason) => ({ class: cls, transient, reason, evidence });

  if (status === 'network') return out('unreachable', true, 'the site could not be reached');

  const waf = String(h['x-amzn-waf-action'] || '').toLowerCase();
  if (waf === 'challenge' || waf === 'captcha') return out('bot_challenge', false, 'the host requires a browser challenge (' + waf + ')');
  if (String(h['cf-mitigated'] || '').toLowerCase() === 'challenge') return out('bot_challenge', false, 'the host requires a browser challenge');
  if (/_Incapsula_Resource|Incapsula incident/i.test(body)) return out('bot_challenge', false, 'the host requires a browser challenge');
  if (/Just a moment\.\.\.|cf-chl|challenge-platform/i.test(body) && (status === 403 || status === 503 || status === 429 || (status >= 200 && status < 300))) {
    return out('bot_challenge', false, 'the host requires a browser challenge');
  }
  if (status === 202 && !body.trim() && waf) return out('bot_challenge', false, 'the host requires a browser challenge');

  if ([401, 403, 407, 451].includes(status)) return out('host_firewall_refusal', false, 'the host refused automated access (HTTP ' + status + ')');
  if (status === 429) return out('rate_limited', true, 'the host asked us to slow down (HTTP 429)');
  if (typeof status === 'number' && status >= 500) return out('unreachable', true, 'the site answered with a server error (HTTP ' + status + ')');
  if (status === 404 || status === 410) return out('not_found', false, 'the page does not exist (HTTP ' + status + ')');

  if (typeof status === 'number' && status >= 200 && status < 400) {
    const finalPath = pathOf(url);
    const reqPath = pathOf(requestedUrl);
    if (url && LOGIN_RE.test(finalPath) && !(requestedUrl && LOGIN_RE.test(reqPath)) && requestedUrl && finalPath !== reqPath) {
      return out('login_required', false, 'the page requires signing in');
    }
    if (status < 300) return out('ok', false, null);
  }
  return out('other', false, 'unexpected response (HTTP ' + status + ')');
}

const SELLER_TEXT = {
  ok: 'Your website can be read automatically.',
  bot_challenge: 'Your website\'s host does not allow automated reading.',
  host_firewall_refusal: 'Your website\'s host does not allow automated reading.',
  rate_limited: 'Your website asked us to slow down. We will try again automatically.',
  unreachable: 'We could not reach your website. We will try again automatically.',
  login_required: 'Your events page requires signing in, so it cannot be read automatically.',
  not_found: 'We could not find that page on your website.',
  other: 'Your website answered in a way we could not read.',
};
const ADMIN_TEXT = {
  ok: 'Readable.',
  bot_challenge: 'Edge bot challenge (browser JavaScript/CAPTCHA required). Not attempted.',
  host_firewall_refusal: 'Edge firewall refused the honest importer identity.',
  rate_limited: 'Rate limited (429); bounded retry.',
  unreachable: 'Network error or server error; bounded retry.',
  login_required: 'Redirected to a login page.',
  not_found: 'Not found (404/410).',
  other: 'Unexpected response.',
};

function describe(cls, audience = 'seller') {
  const t = audience === 'admin' ? ADMIN_TEXT : SELLER_TEXT;
  return t[cls] || t.other;
}

module.exports = { CLASSES, classifyResponse, describe, EDGE_HEADERS };
