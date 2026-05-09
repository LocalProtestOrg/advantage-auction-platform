#!/usr/bin/env node
// One-shot Sentry connectivity test.
// Run after setting SENTRY_DSN:
//   node scripts/test-sentry.js
// Sends a single test exception and exits. Verify it appears in your Sentry dashboard.

require('dotenv').config();
const Sentry = require('@sentry/node');

if (!process.env.SENTRY_DSN) {
  console.error('SENTRY_DSN is not set. Add it to .env or export it before running.');
  process.exit(1);
}

Sentry.init({
  dsn:         process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
});

console.log('[sentry-test] Sending test exception...');
Sentry.captureException(new Error('[TEST] Phase 3 Sentry connectivity verification'));

// Flush gives the SDK time to deliver before process exits.
Sentry.flush(3000).then(() => {
  console.log('[sentry-test] Done. Check your Sentry dashboard for the test event.');
  process.exit(0);
}).catch(err => {
  console.error('[sentry-test] Flush failed:', err.message);
  process.exit(1);
});
