'use strict';

/** imageEnrichment.fetchImage: a public CDN that answers 403 to the enrichment UA is retried ONCE with a browser UA. */
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

test('403 to the enrichment UA → retried with a browser UA → 200 usable image (ua_fallback flagged)', async () => {
  const { requestImpl, seen } = fakeRequest((ua) => (/AdvantageBid-ImageEnrichment/.test(ua) ? 403 : 200));
  const r = await fetchImage('https://image.invaluable.com/privatelabel/x.jpg', { requestImpl });
  expect(r.status).toBe(200); expect(r.ua_fallback).toBe(true); expect(isUsableImageResponse(r).ok).toBe(true);
  expect(seen.length).toBe(2); expect(seen[0]).toMatch(/AdvantageBid-ImageEnrichment/); expect(seen[1]).toMatch(/Mozilla/);
});
test('200 on the first try → no retry', async () => {
  const { requestImpl, seen } = fakeRequest(() => 200);
  const r = await fetchImage('https://x/y.jpg', { requestImpl });
  expect(r.status).toBe(200); expect(r.ua_fallback).toBeUndefined(); expect(seen.length).toBe(1);
});
test('403 on both tries → original 403 reported (login/robot gated stays unusable); 401 never retried', async () => {
  const both = fakeRequest(() => 403);
  const r = await fetchImage('https://x/y.jpg', { requestImpl: both.requestImpl });
  expect(r.status).toBe(403); expect(both.seen.length).toBe(2); expect(isUsableImageResponse(r).ok).toBe(false);
  const gated = fakeRequest(() => 401);
  const g = await fetchImage('https://x/y.jpg', { requestImpl: gated.requestImpl });
  expect(g.status).toBe(401); expect(gated.seen.length).toBe(1); expect(isUsableImageResponse(g).reason).toBe('login_gated');
});
