#!/usr/bin/env node
// PROD-only apply of 058_extend_stripe_webhook_events.sql. See prod-migrate-core.js.
// Run: railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-058.js
require('./prod-migrate-core').applyOne('058').then(code => process.exit(code)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
