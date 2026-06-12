#!/usr/bin/env node
// PROD-only apply of 064_add_auction_archive.sql.
// Run: railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-064.js
require('./prod-migrate-core').applyOne('064').then(code => process.exit(code)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
