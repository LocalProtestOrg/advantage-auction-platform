#!/usr/bin/env node
// PROD-only apply of 061_create_terms.sql (terms_versions + terms_acceptances + seed v1).
// Run: railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-061.js
require('./prod-migrate-core').applyOne('061').then(code => process.exit(code)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
