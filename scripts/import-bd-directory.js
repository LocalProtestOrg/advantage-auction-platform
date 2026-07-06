#!/usr/bin/env node
/*
 * import-bd-directory.js — one-way BD -> Railway directory import (Phase 3B).
 * DEFAULT = DRY-RUN (no writes). Flags: --apply (write), --state=XX, --limit=N.
 * Production import requires CONFIRM_PROD_IMPORT=YES (and owner approval).
 *   node scripts/import-bd-directory.js                       # dry-run, all
 *   node scripts/import-bd-directory.js --state=TX            # dry-run, Texas only
 *   railway run --service advantage-staging node scripts/import-bd-directory.js --state=TX --limit=5 --apply
 */
require('dotenv').config();
const bd = require('../src/services/bdDirectoryService');
const importer = require('../src/services/directoryImportService');

(async () => {
  const args = process.argv.slice(2);
  const doApply = args.includes('--apply');
  const stateArg = args.find((a) => a.startsWith('--state='));
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const state = stateArg ? stateArg.split('=')[1].toUpperCase() : null;
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

  console.log('Fetching BD listings via ' + bd.transportName + ' transport...');
  let { total, pages, listings } = await bd.listListings();
  console.log('normalized ' + listings.length + ' of ' + total + ' (' + pages + ' pages)');
  if (state) listings = listings.filter((l) => l.state === state);
  if (limit) listings = listings.slice(0, limit);
  console.log('scope: ' + listings.length + ' listings' + (state ? ' state=' + state : '') + (limit ? ' limit=' + limit : ''));

  const plan = await importer.plan(listings);
  console.log('PLAN → create=' + plan.create + ' update=' + plan.update + ' link=' + plan.link + ' skip_ambiguous=' + plan.skip_ambiguous);

  if (!doApply) { console.log('DRY-RUN (no writes). Re-run with --apply to write inactive shells.'); return 0; }

  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-proud-leaf-an8pzkib') && process.env.CONFIRM_PROD_IMPORT !== 'YES') {
    console.error('REFUSE: production import needs CONFIRM_PROD_IMPORT=YES + owner approval.'); return 2;
  }
  const res = await importer.apply(listings, { limit });
  console.log('APPLIED → created=' + res.created + ' updated=' + res.updated + ' linked=' + res.linked + ' skipped=' + res.skipped);
  return 0;
})().then((c) => process.exit(c || 0)).catch((e) => { console.error('ERR', e.message); process.exit(1); });
