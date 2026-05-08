// Centralized logger — consistent structured output across all modules
// Usage: const log = require('../lib/logger');
//        log.info('payments', 'intent created', { userId, lotId });

const isDev    = process.env.NODE_ENV !== 'production';
const startedAt = new Date().toISOString();

function fmt(level, ctx, msg, meta) {
  const ts      = new Date().toISOString();
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  return `[${ts}] ${level.padEnd(5)} [${ctx}] ${msg}${metaStr}`;
}

const log = {
  info:  (ctx, msg, meta) => console.log(fmt('INFO',  ctx, msg, meta)),
  warn:  (ctx, msg, meta) => console.warn(fmt('WARN',  ctx, msg, meta)),
  error: (ctx, msg, meta) => console.error(fmt('ERROR', ctx, msg, meta)),
  debug: (ctx, msg, meta) => { if (isDev) console.log(fmt('DEBUG', ctx, msg, meta)); },
  startedAt,
};

module.exports = log;
