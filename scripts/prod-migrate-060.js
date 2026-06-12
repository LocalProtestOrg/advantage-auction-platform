#!/usr/bin/env node
// PROD-only apply of 060_add_users_password_hash.sql (no-op column on prod; records ledger).
// Run: railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-060.js
require('./prod-migrate-core').applyOne('060').then(code => process.exit(code)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
