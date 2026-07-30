'use strict';

/**
 * rateLimit — outbound token-bucket throttle + exponential backoff with jitter (§11 of the plan).
 * The platform has no outbound limiter today; imports must never hammer a source or a geocoder.
 *
 * Both primitives accept injectable `now`/`sleep`/`rand` so they are fully deterministic under test.
 */

const realSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * createTokenBucket({ ratePerMin, burst, now, sleep }) → { take, tokens }.
 * `take()` resolves as soon as a token is available, waiting the minimum time otherwise.
 */
function createTokenBucket(opts) {
  opts = opts || {};
  const ratePerMin = opts.ratePerMin > 0 ? opts.ratePerMin : 60;
  const ratePerMs = ratePerMin / 60000;
  const capacity = opts.burst > 0 ? opts.burst : Math.max(1, Math.ceil(ratePerMin / 10)); // ~6s of burst
  const now = opts.now || Date.now;
  const sleep = opts.sleep || realSleep;

  let tokens = capacity;
  let last = now();
  function refill() { const t = now(); tokens = Math.min(capacity, tokens + (t - last) * ratePerMs); last = t; }

  async function take() {
    refill();
    if (tokens >= 1) { tokens -= 1; return; }
    const waitMs = Math.ceil((1 - tokens) / ratePerMs);
    await sleep(waitMs);
    refill();
    tokens = Math.max(0, tokens - 1);
  }
  return { take, capacity, _state: () => ({ tokens, last }) };
}

/**
 * withBackoff(fn, opts) — run fn(attempt); retry on a retryable RESULT (opts.isRetryable) or a thrown
 * error, up to opts.retries, with exponential backoff + jitter. Returns the last result (or rethrows
 * the last error). now/sleep/rand injectable.
 */
async function withBackoff(fn, opts) {
  opts = opts || {};
  const retries = Number.isInteger(opts.retries) ? opts.retries : 3;
  const base = opts.baseMs > 0 ? opts.baseMs : 200;
  const factor = opts.factor > 0 ? opts.factor : 2;
  const cap = opts.capMs > 0 ? opts.capMs : 30000;
  const sleep = opts.sleep || realSleep;
  const rand = opts.rand || Math.random;
  const isRetryable = typeof opts.isRetryable === 'function' ? opts.isRetryable : () => false;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let result, threw = false, err;
    try { result = await fn(attempt); }
    catch (e) { threw = true; err = e; }

    if (!threw && !isRetryable(result)) return result;
    if (attempt >= retries) { if (threw) throw err; return result; }

    const backoff = Math.min(cap, base * Math.pow(factor, attempt));
    const delay = backoff * (0.5 + rand()); // full-ish jitter in [0.5x, 1.5x]
    await sleep(delay);
    attempt += 1;
  }
}

module.exports = { createTokenBucket, withBackoff, realSleep };
