'use strict';

/**
 * HTTP request logger secret-safety: provider verification callbacks never log their query string (Meta sends
 * the verify token as BOTH hub.verify_token and hub_verify_token), sensitive query parameter values are
 * redacted on every route, ordinary route logging is unchanged, and headers/bodies (App Secret HMAC signature,
 * System User bearer tokens) are never logged.
 */
const EventEmitter = require('events');
const logger = require('../src/middleware/logger');

const VERIFY = 'sdX-verify-token-VALUE-9f8e7d';
const SIG = 'sha256=deadbeefcafe0123456789';
const SYSTEM_TOKEN = 'EAAB-system-user-token-VALUE';
const APP_SECRET = 'app-secret-VALUE-1234';

function capture(req, status = 200) {
  const lines = [];
  const orig = console.log; console.log = (l) => lines.push(String(l));
  try {
    const res = new EventEmitter(); res.statusCode = status;
    let nextCalled = false;
    logger(req, res, () => { nextCalled = true; });
    res.emit('finish');
    return { lines, nextCalled };
  } finally { console.log = orig; }
}
const mkReq = (method, url, extra = {}) => ({ method, originalUrl: url, url, path: url.split('?')[0], ...extra });

describe('http logger — Meta webhook verification never logs the verify token', () => {
  test('GET /api/meta/webhook with hub.verify_token AND hub_verify_token → path only, no query values', () => {
    const url = `/api/meta/webhook?hub.mode=subscribe&hub.challenge=563437009&hub.verify_token=${VERIFY}&hub_mode=subscribe&hub_challenge=563437009&hub_verify_token=${VERIFY}`;
    const { lines } = capture(mkReq('GET', url));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('GET /api/meta/webhook?[query-redacted] 200');
    expect(lines[0]).not.toContain(VERIFY);
    expect(lines[0]).not.toContain('hub.challenge'); expect(lines[0]).not.toContain('hub_challenge');
  });
  test('alternate spellings / casing / nested path under the webhook are all stripped', () => {
    for (const url of [`/api/meta/webhook?HUB_VERIFY_TOKEN=${VERIFY}`, `/api/meta/webhook?hub-verify-token=${VERIFY}`, `/api/meta/webhook/?verify_token=${VERIFY}`, `/api/meta/webhook/x?token=${VERIFY}`]) {
      const { lines } = capture(mkReq('GET', url));
      expect(lines[0]).not.toContain(VERIFY);
    }
  });
  test('loggedUrl helper: malformed query still yields no secret', () => {
    expect(logger.loggedUrl({ originalUrl: `/api/meta/webhook?%E0%A4%A&hub_verify_token=${VERIFY}` })).not.toContain(VERIFY);
  });
});

describe('http logger — sensitive query values redacted on every route; ordinary logging unchanged', () => {
  test('SES feedback ?token= (shared secret) is redacted but the path and other params remain', () => {
    const { lines } = capture(mkReq('POST', `/api/ses/feedback?token=${APP_SECRET}&source=sns`));
    expect(lines[0]).toContain('POST /api/ses/feedback?token=%5BREDACTED%5D&source=sns 200');
    expect(lines[0]).not.toContain(APP_SECRET);
  });
  test('access_token / api-key / signature / secret style names are redacted; limit/page/id are kept verbatim', () => {
    const { lines } = capture(mkReq('GET', `/api/public/marketplace/feed?limit=1&page=2&access_token=${SYSTEM_TOKEN}&api-key=${APP_SECRET}&X-Signature=${SIG}`));
    expect(lines[0]).not.toContain(SYSTEM_TOKEN); expect(lines[0]).not.toContain(APP_SECRET); expect(lines[0]).not.toContain(SIG);
    expect(lines[0]).toContain('limit=1'); expect(lines[0]).toContain('page=2');
  });
  test('ordinary route with no sensitive params logs the exact original URL, status and level', () => {
    const url = '/api/public/marketplace/feed?limit=1&state=TX';
    const ok = capture(mkReq('GET', url));
    expect(ok.lines[0]).toMatch(new RegExp(`INFO  \\[http\\] GET ${url.replace('?', '\\?')} 200 \\d+ms$`));
    const warn = capture(mkReq('GET', '/api/admin/director/social-performance'), 401);
    expect(warn.lines[0]).toContain('WARN  [http] GET /api/admin/director/social-performance 401');
    const err = capture(mkReq('POST', '/api/auctions'), 500);
    expect(err.lines[0]).toContain('ERROR [http] POST /api/auctions 500');
    expect(ok.nextCalled).toBe(true);
  });
  test('static assets are still skipped; /api paths always logged', () => {
    expect(capture(mkReq('GET', '/img/logo.png')).lines.length).toBe(0);
    expect(capture(mkReq('GET', '/api/health')).lines.length).toBe(1);
  });
});

describe('http logger — headers and bodies are never logged (App Secret HMAC, bearer tokens)', () => {
  test('signed webhook POST: signature header, bearer header, and body never appear in the log line', () => {
    const req = mkReq('POST', '/api/meta/webhook', {
      headers: { 'x-hub-signature-256': SIG, authorization: `Bearer ${SYSTEM_TOKEN}` },
      get: (h) => (h.toLowerCase() === 'x-hub-signature-256' ? SIG : `Bearer ${SYSTEM_TOKEN}`),
      body: Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: '449143945236360', changes: [{ field: 'feed', value: { message: 'secret-body-' + APP_SECRET } }] }] })),
    });
    const { lines } = capture(req);
    expect(lines[0]).toContain('POST /api/meta/webhook 200');
    for (const s of [SIG, SYSTEM_TOKEN, APP_SECRET, 'secret-body', '449143945236360']) expect(lines[0]).not.toContain(s);
  });
  test('logger source never references headers or body', () => {
    const src = require('fs').readFileSync(require.resolve('../src/middleware/logger'), 'utf8');
    expect(src).not.toMatch(/req\.headers|req\.body|req\.get\(/);
  });
});
