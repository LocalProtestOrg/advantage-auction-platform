'use strict';
/**
 * Marketplace Integrity Suite — runner + DEPLOYMENT GATE (Phase 6A).
 *
 * Verifies the canonical DB tally equals every canonical public API and that SEO/structured-data
 * surfaces are intact. Prints the Marketplace Integrity Report and exits NON-ZERO on FAIL so it can
 * gate a deployment (CI / pre-promote / post-deploy smoke).
 *
 * Usage:
 *   node scripts/marketplace-integrity.js                         # probe PUBLIC_BASE_URL (or localhost)
 *   node scripts/marketplace-integrity.js --base https://bid.advantage.bid
 *   node scripts/marketplace-integrity.js --db-only               # canonical DB tally only (no HTTP)
 *   node scripts/marketplace-integrity.js --strict                # WARNING also fails the gate
 *   node scripts/marketplace-integrity.js --json                  # machine-readable output
 */
require('dotenv').config();
const db = require('../src/db');
const { verify, formatReport } = require('../src/services/marketplaceIntegrity');

function arg(name, def) { const i = process.argv.indexOf(name); return i > -1 ? (process.argv[i + 1] || true) : def; }

(async () => {
  const dbOnly = process.argv.includes('--db-only');
  const strict = process.argv.includes('--strict');
  const asJson = process.argv.includes('--json');
  const base = dbOnly ? null : (arg('--base') || process.env.PUBLIC_BASE_URL || 'https://bid.advantage.bid');

  const result = await verify({ db, baseUrl: base, live: !dbOnly });

  if (asJson) console.log(JSON.stringify(result, null, 2));
  else { console.log(formatReport(result)); if (base) console.log(`\nProbed: ${base}`); }

  await db.pool && db.pool.end && db.pool.end().catch(() => {});
  const bad = result.overall === 'FAIL' || (strict && result.overall === 'WARNING');
  if (bad) { console.error(`\n✗ Marketplace Integrity: ${result.overall} — DEPLOYMENT GATE FAILED`); process.exit(1); }
  console.log(`\n✓ Marketplace Integrity: ${result.overall}`);
  process.exit(0);
})().catch((e) => { console.error('INTEGRITY RUNNER ERROR', e.message); process.exit(2); });
