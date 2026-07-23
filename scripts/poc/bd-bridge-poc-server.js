'use strict';

/**
 * bd-bridge-poc-server.js — STANDALONE, NON-PRODUCTION proof-of-concept ONLY.
 *
 * NOT part of the Advantage.Bid application: not imported by server.js, mounts no production routes,
 * touches no database, creates no session, reads/writes no user records. Run on a throwaway/non-prod
 * host to exercise the Option B (server-minted opaque code) handoff with the BD widget end-to-end.
 * All security logic lives in bd-bridge-poc-lib.js (also unit-tested).
 *
 * Run:
 *   POC_BRIDGE_SECRET="<24+ random chars>" POC_PUBLIC_URL="https://<this-host>" node scripts/poc/bd-bridge-poc-server.js
 *
 * Endpoints:
 *   POST /auth/bd/exchange  (server-to-server; BD calls this, authenticated by X-Bridge-Key)
 *   GET  /auth/bd/return    (browser lands here with ONLY the opaque code; single-use)
 *   GET  /healthz
 */

const express = require('express');
const lib = require('./bd-bridge-poc-lib');
let rateLimit; try { rateLimit = require('express-rate-limit'); } catch (e) { rateLimit = null; }

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8kb' }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));

const SECRET = process.env.POC_BRIDGE_SECRET || '';
const PUBLIC_URL = (process.env.POC_PUBLIC_URL || 'http://localhost:8080').replace(/\/+$/, '');
if (!SECRET || SECRET.length < 24) {
  console.error('Refusing to start: set POC_BRIDGE_SECRET to a random string of 24+ chars.');
  process.exit(1);
}

const store = new lib.CodeStore({ ttlMs: 120000 });
setInterval(() => store.purge(), 60000).unref();

// Rate limiting (falls back to a no-op if the dep is unavailable in this throwaway env).
const limiter = rateLimit
  ? rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false })
  : (req, res, next) => next();

app.post('/auth/bd/exchange', limiter, (req, res) => {
  const out = lib.handleExchange(
    { bridgeKeyHeader: req.get('X-Bridge-Key'), body: req.body },
    { store, secret: SECRET, now: Date.now(), publicBaseUrl: PUBLIC_URL }
  );
  // Safe logging only: never log the secret or the code.
  console.log('[poc] exchange:', out.status === 200 ? 'issued (member verified)' : ('rejected — ' + (out.json && out.json.error)));
  return res.status(out.status).json(out.json);
});

app.get('/auth/bd/return', limiter, (req, res) => {
  const out = lib.handleReturn({ query: req.query }, { store, now: Date.now() });
  console.log('[poc] return:', out.result && (out.result.ok ? 'ok (identity verified)' : ('rejected — ' + out.result.reason)));
  return res.status(out.status).type('html').send(renderPage(out.result));
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function renderPage(result) {
  const body = result && result.ok
    ? '<h1>✅ PoC OK</h1><p>Server-verified BD member <b>' + esc(result.bd_user_id)
      + '</b> → destination <b>' + esc(result.dest_path) + '</b>.</p>'
      + '<p>Single-use code consumed. Identity verified only — no session created, no privileges granted, no records touched.</p>'
    : '<h1>❌ Rejected</h1><p>Reason: <b>' + esc((result && result.reason) || 'error') + '</b>. The opaque code cannot be forged, guessed, replayed, or reused.</p>';
  return '<!doctype html><meta charset=utf-8><title>BD bridge PoC</title>'
    + '<body style="font:16px system-ui;max-width:640px;margin:60px auto;padding:0 20px">' + body + '</body>';
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('[bd-bridge-poc] listening on ' + PORT + '; public=' + PUBLIC_URL));
