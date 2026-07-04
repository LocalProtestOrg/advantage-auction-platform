'use strict';

/**
 * Route-level error helpers for the organizations/events API.
 *
 * The global errorHandler only exposes `err.publicMessage`, so these routes map their
 * own service errors (which carry `status`/`code`/`expose`) into a consistent JSON shape
 * `{ success:false, code, message }`. 5xx are logged and never leak internals.
 */

/** Build a structured, client-facing error. */
function svcErr(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code; e.expose = true;
  return e;
}

/** Send an error response, mapping status/code/expose; logs 5xx. */
function sendErr(res, err) {
  const status = err && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error('[events-api]', (err && err.stack) || err);
  return res.status(status).json({
    success: false,
    code: (err && err.code) || 'INTERNAL',
    message: err && err.expose ? err.message : 'Something went wrong.',
  });
}

/** Wrap an async route so thrown/rejected service errors become clean JSON responses. */
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => sendErr(res, e));
}

module.exports = { svcErr, sendErr, asyncRoute };
