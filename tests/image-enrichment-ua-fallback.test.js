'use strict';

/**
 * imageEnrichment.fetchImage identity policy (2026-09-24).
 *
 * Previously a CDN that answered 403 to the enrichment client was retried ONCE with a browser
 * User-Agent. The Owner's import policy forbids evading anti-bot protections, so that retry was
 * removed: the image is fetched once, under Advantage.Bid's own declared identity, and a 403 is
 * recorded ('blocked_403') — the event keeps its source link / placeholder instead.
 */
const EventEmitter = require('events');
const { fetchImage, isUsableImageResponse } = require('../src/services/eventImport/imageEnrichment');

function fakeRequest(plan) {
  const seen = [];
  const requestImpl = (url, opts, cb) => {
    seen.push(opts.headers['User-Agent']);
    const status = plan(opts.headers['User-Agent']);
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {
      const resp = new EventEmitter(); resp.statusCode = status; resp.headers = { 'content-type': status === 200 ? 'image/jpeg' : 'text/html' };
      cb(resp);
      setImmediate(() => { resp.emit('data', Buffer.alloc(status === 200 ? 4096 : 10, 1)); resp.emit('end'); });
    };
    return req;
  };
  return { requestImpl, seen };
}

test('403 to the enrichment client → recorded as blocked_403; NEVER retried with a browser identity', async () => {
  const { requestImpl, seen } = fakeRequest((ua) => (/AdvantageBid-ImageEnrichment/.test(ua) ? 403 : 200));
  const r = await fetchImage('https://image.invaluable.com/privatelabel/x.jpg', { requestImpl });
  expect(r.status).toBe(403);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatch(/AdvantageBid-ImageEnrichment/);
  expect(isUsableImageResponse(r)).toEqual({ ok: false, reason: 'blocked_403' });
});
test('200 on the first try → used as-is, no second request', async () => {
  const { requestImpl, seen } = fakeRequest(() => 200);
  const r = await fetchImage('https://x/y.jpg', { requestImpl });
  expect(r.status).toBe(200); expect(seen).toHaveLength(1); expect(isUsableImageResponse(r).ok).toBe(true);
});
test('401 (login-gated) is never retried and stays unusable', async () => {
  const { requestImpl, seen } = fakeRequest(() => 401);
  const r = await fetchImage('https://www.ppms.gov/x.jpg', { requestImpl });
  expect(r.status).toBe(401); expect(seen).toHaveLength(1);
  expect(isUsableImageResponse(r)).toEqual({ ok: false, reason: 'login_gated' });
});
