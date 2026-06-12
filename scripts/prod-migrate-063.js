#!/usr/bin/env node
// PROD-only apply of 063_add_stripe_customer_and_pm.sql.
// Run: railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-063.js
require('./prod-migrate-core').applyOne('063').then(code => process.exit(code)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
