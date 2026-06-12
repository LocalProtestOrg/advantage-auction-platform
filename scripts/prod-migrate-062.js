#!/usr/bin/env node
// PROD-only apply of 062_extend_auction_buyers_registration.sql. (Requires 061 first.)
// Run: railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-062.js
require('./prod-migrate-core').applyOne('062').then(code => process.exit(code)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
