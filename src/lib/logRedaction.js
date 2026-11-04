'use strict';

/**
 * logRedaction — every line the app writes through console.log / info / warn / error / debug has credential-shaped
 * values (src/lib/secretPatterns.js) replaced by [REDACTED:<kind>] before it reaches the log, so an API key, token,
 * password or database address with a password can never end up in the hosting provider's logs by accident.
 * Installed once at the top of server.js and of the background worker. The request logger's own query-parameter
 * redaction (src/middleware/logger.js) stays as it is; this is the general safety net beneath it.
 */

const util = require('util');
const { redact } = require('./secretPatterns');

const METHODS = ['log', 'info', 'warn', 'error', 'debug'];
let installed = false;

function install(target = console) {
  if (installed && target === console) return;
  for (const m of METHODS) {
    const original = target[m];
    if (typeof original !== 'function' || original.__redacting) continue;
    const wrapped = function redactingLog(...args) {
      if (!args.length) return original.call(this);
      let line;
      try { line = util.format(...args); } catch (_) { return original.apply(this, args); }
      const safe = redact(line);
      return safe === line ? original.apply(this, args) : original.call(this, safe);
    };
    wrapped.__redacting = true;
    target[m] = wrapped;
  }
  if (target === console) installed = true;
}

module.exports = { install };
