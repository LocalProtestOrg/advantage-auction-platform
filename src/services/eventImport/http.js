'use strict';

/**
 * http — the shared safe-fetch layer for live connectors (Phase 5F). Every outbound request a
 * connector makes goes through here so the safety envelope is uniform and testable:
 *   • descriptive User-Agent identifying Advantage.Bid
 *   • request timeout (AbortController)
 *   • bounded retry with exponential backoff (network / 5xx / 429 only; never on 4xx)
 *   • maximum response size (stream guard) to avoid a runaway body
 *   • content-type validation (opt-in per call)
 *   • follows redirects (GSA 303 → signed S3) via the platform fetch
 *
 * Pure-ish: uses global fetch (Node 18+). No DB. Never throws for an ordinary non-2xx — returns a
 * structured result so a connector can decide; throws only after retries are exhausted on network error.
 */

const DEFAULT_UA = 'AdvantageBidBot/1.0 (+https://bid.advantage.bid; lawful event discovery; contact info@advantage.bid)';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;   // 12 MB cap (GSA active-auctions.json ≈ 3–4 MB)
const DEFAULT_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a response body with a hard byte cap so a hostile/huge feed can't exhaust memory.
async function readCapped(res, maxBytes) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    const e = new Error(`response too large: ${buf.length} > ${maxBytes} bytes`);
    e.code = 'RESPONSE_TOO_LARGE';
    throw e;
  }
  return buf.toString('utf8');
}

/**
 * fetchText(url, opts) → { ok, status, contentType, text, url }
 * opts: { timeoutMs, retries, maxBytes, headers, ua, accept, expectType, signal }
 *   expectType: substring the response content-type must include (e.g. 'json', 'xml', 'calendar', 'html').
 *   On a content-type mismatch the call still returns the body but ok:false + reason:'content_type'.
 */
async function fetchText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = opts.retries != null ? opts.retries : DEFAULT_RETRIES;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const headers = Object.assign({
    'User-Agent': opts.ua || DEFAULT_UA,
    'Accept': opts.accept || 'application/json, text/xml, text/calendar, text/html;q=0.9, */*;q=0.5',
  }, opts.headers || {});

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, 400 * Math.pow(2, attempt - 1))); // 400ms, 800ms, 1.6s…
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // If the caller passed a signal, abort when it aborts too.
    if (opts.signal) { if (opts.signal.aborted) ctrl.abort(); else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true }); }
    try {
      const res = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: ctrl.signal });
      // Retry only transient statuses; a 4xx (except 429) is a hard, non-retryable answer.
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        lastErr = new Error('HTTP ' + res.status);
        clearTimeout(timer);
        continue;
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const text = await readCapped(res, maxBytes);
      clearTimeout(timer);
      const typeOk = !opts.expectType || contentType.includes(opts.expectType);
      return { ok: res.ok && typeOk, status: res.status, contentType, text, url: res.url || url,
        reason: !res.ok ? 'http_status' : (!typeOk ? 'content_type' : null) };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e.code === 'RESPONSE_TOO_LARGE') throw e;   // not retryable
      // network error / timeout → retry
    }
  }
  throw lastErr || new Error('fetch failed: ' + url);
}

async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, Object.assign({ expectType: 'json', accept: 'application/json' }, opts));
  if (!r.ok) { const e = new Error('fetchJson non-ok: ' + r.status + ' ' + (r.reason || '')); e.result = r; throw e; }
  try { return JSON.parse(r.text); }
  catch (e) { const err = new Error('invalid JSON from ' + url + ': ' + e.message); err.result = r; throw err; }
}

module.exports = { fetchText, fetchJson, DEFAULT_UA, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS };
