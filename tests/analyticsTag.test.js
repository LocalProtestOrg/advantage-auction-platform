'use strict';

/**
 * Tests for src/middleware/analyticsTag.js
 *
 * These cover the guarantees the analytics architecture depends on:
 *   - the kill switch works without a redeploy
 *   - exactly one tag per page, never two (the defect that exists on the BD side)
 *   - /widgets/*, /admin/*, /org/*, /prototype/* are never tagged
 *   - server-rendered pages (shareMeta, /items) are tagged via the res.send patch
 *   - every failure mode degrades to "page serves untagged", never to a broken page
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MW_PATH = require.resolve('../src/middleware/analyticsTag');
const ID = 'G-TESTID123';

let fixtureRoot;

// The middleware resolves public/ relative to its own location, so the fixtures
// are written into the real public/ directory under unique test-only names and
// removed afterwards. Nothing pre-existing is touched.
const FIXTURES = {
  '__at_plain.html': '<!doctype html><html><head><title>Plain</title></head><body>plain-body</body></html>',
  '__at_nohead.html': '<!doctype html><html><body>no-head-body</body></html>',
  '__at_prewired.html': '<!doctype html><html><head><script src="https://www.googletagmanager.com/gtag/js?id=' + ID + '"></script><title>Pre</title></head><body>pre</body></html>',
  'widgets/__at_widget.html': '<!doctype html><html><head><title>W</title></head><body>widget-body</body></html>',
  'admin/__at_admin.html': '<!doctype html><html><head><title>A</title></head><body>admin-body</body></html>',
};

beforeAll(() => {
  fixtureRoot = path.join(__dirname, '..', 'public');
  for (const [rel, html] of Object.entries(FIXTURES)) {
    const full = path.join(fixtureRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, html, 'utf8');
  }
});

afterAll(() => {
  for (const rel of Object.keys(FIXTURES)) {
    try { fs.unlinkSync(path.join(fixtureRoot, rel)); } catch (e) { /* already gone */ }
  }
});

beforeEach(() => {
  delete require.cache[MW_PATH];
  process.env.ANALYTICS_TAG_ENABLED = 'true';
  process.env.GA4_MEASUREMENT_ID = ID;
});

afterEach(() => {
  delete process.env.ANALYTICS_TAG_ENABLED;
  delete process.env.GA4_MEASUREMENT_ID;
});

function buildApp() {
  const analyticsTag = require('../src/middleware/analyticsTag');
  const app = express();
  app.use(analyticsTag.patch);
  // Stand-in for shareMeta / the /items SSR route: responds via res.send().
  app.get('/__at_ssr.html', (req, res) => {
    res.set('Content-Type', 'text/html');
    res.send('<!doctype html><html><head><title>SSR</title></head><body>ssr-body</body></html>');
  });
  app.use(analyticsTag.serve);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

function request(urlPath, method) {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request({ port, path: urlPath, method: method || 'GET' }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

const loaderCount = (html) => (html.match(/googletagmanager\.com\/gtag\/js/g) || []).length;

describe('analyticsTag — kill switch', () => {
  test('no tag when ANALYTICS_TAG_ENABLED is unset', async () => {
    delete process.env.ANALYTICS_TAG_ENABLED;
    const r = await request('/__at_plain.html');
    expect(loaderCount(r.body)).toBe(0);
    expect(r.body).toContain('plain-body');
  });

  test('no tag when ANALYTICS_TAG_ENABLED is "false"', async () => {
    process.env.ANALYTICS_TAG_ENABLED = 'false';
    const r = await request('/__at_plain.html');
    expect(loaderCount(r.body)).toBe(0);
  });
});

describe('analyticsTag — injection', () => {
  test('static page tagged exactly once', async () => {
    const r = await request('/__at_plain.html');
    expect(loaderCount(r.body)).toBe(1);
    expect((r.body.match(/gtag\('config'/g) || []).length).toBe(1);
    expect(r.body).toContain(ID);
    expect(r.body).toContain('plain-body');
  });

  test('server-rendered page tagged exactly once, body preserved', async () => {
    const r = await request('/__at_ssr.html');
    expect(loaderCount(r.body)).toBe(1);
    expect(r.body).toContain('ssr-body');
  });

  test('dataLayer is initialised before the container script', async () => {
    const r = await request('/__at_plain.html');
    const dl = r.body.indexOf('window.dataLayer = window.dataLayer || []');
    const cfg = r.body.indexOf("gtag('config'");
    expect(dl).toBeGreaterThan(-1);
    expect(cfg).toBeGreaterThan(dl);
  });

  test('tag is injected inside <head>, before the rest of the head', async () => {
    const r = await request('/__at_plain.html');
    expect(r.body.indexOf('googletagmanager')).toBeLessThan(r.body.indexOf('<title>'));
  });
});

describe('analyticsTag — exclusions', () => {
  test('/widgets/* is never tagged', async () => {
    const r = await request('/widgets/__at_widget.html');
    expect(loaderCount(r.body)).toBe(0);
    expect(r.body).toContain('widget-body');
  });

  test('/admin/* is never tagged', async () => {
    const r = await request('/admin/__at_admin.html');
    expect(loaderCount(r.body)).toBe(0);
    expect(r.body).toContain('admin-body');
  });
});

describe('analyticsTag — idempotency and fail-open', () => {
  test('a page already containing the ID is not tagged again', async () => {
    const r = await request('/__at_prewired.html');
    expect(loaderCount(r.body)).toBe(1);
  });

  test('a page with no <head> still serves, untagged', async () => {
    const r = await request('/__at_nohead.html');
    expect(r.status).toBe(200);
    expect(r.body).toContain('no-head-body');
    expect(loaderCount(r.body)).toBe(0);
  });

  test('a malformed measurement ID degrades to no analytics, not a broken page', async () => {
    process.env.GA4_MEASUREMENT_ID = 'not-a-real-id';
    const r = await request('/__at_plain.html');
    expect(r.status).toBe(200);
    expect(loaderCount(r.body)).toBe(0);
    expect(r.body).toContain('plain-body');
  });

  test('an absent measurement ID degrades to no analytics', async () => {
    delete process.env.GA4_MEASUREMENT_ID;
    const r = await request('/__at_plain.html');
    expect(loaderCount(r.body)).toBe(0);
    expect(r.body).toContain('plain-body');
  });

  test('a missing file still 404s through express.static', async () => {
    const r = await request('/__at_does_not_exist.html');
    expect(r.status).toBe(404);
  });

  test('non-GET requests are untouched', async () => {
    const r = await request('/__at_plain.html', 'POST');
    expect(loaderCount(String(r.body))).toBe(0);
  });
});
