#!/usr/bin/env node
// PROD-only apply of 059_add_payments_refunded_amount.sql. Runs a partially_refunded
// pre-check and STOPS if count > 0 unless ALLOW_PARTIAL_REFUNDED=1. See prod-migrate-core.js.
// Run: railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-059.js
require('./prod-migrate-core').applyOne('059').then(code => process.exit(code)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
