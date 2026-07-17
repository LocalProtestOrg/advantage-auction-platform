#!/usr/bin/env node
/*
 * import-bd-directory.js — one-way BD -> Railway directory mirror.
 * DEFAULT = DRY-RUN (no writes). Production writes require CONFIRM_PROD_IMPORT=YES.
 *
 * Modes:
 *   (legacy import) create/fill inactive shells; fill-null-only on existing.
 *     node scripts/import-bd-directory.js [--state=XX] [--limit=N] [--apply]
 *   (--sync) HARDENED one-way sync: eligibility filter, geocoding backfill, TRUE-sync of
 *            BD-owned public fields on unclaimed shells, removal reconciliation, freshness
 *            stamp. Never touches the verified company->seller link, logos, or claimed orgs.
 *     node scripts/import-bd-directory.js --sync              # full dry-run (recommended first)
 *     node scripts/import-bd-directory.js --sync --limit=50   # batch dry-run
 *     CONFIRM_PROD_IMPORT=YES node scripts/import-bd-directory.js --sync --apply
 */
require('dotenv').config();
const bd = require('../src/services/bdDirectoryService');
const importer = require('../src/services/directoryImportService');

(async () => {
  const args = process.argv.slice(2);
  const doApply = args.includes('--apply');
  const doSync = args.includes('--sync');
  const noGeocode = args.includes('--no-geocode');
  const stateArg = args.find((a) => a.startsWith('--state='));
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const state = stateArg ? stateArg.split('=')[1].toUpperCase() : null;
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

  const prodGuard = () => {
    const raw = process.env.DATABASE_URL || '';
    if (raw.includes('ep-proud-leaf-an8pzkib') && process.env.CONFIRM_PROD_IMPORT !== 'YES') {
      console.error('REFUSE: production write needs CONFIRM_PROD_IMPORT=YES + owner approval.'); return false;
    }
    return true;
  };

  if (doSync) {
    if (doApply && !prodGuard()) return 2;
    console.log('HARDENED SYNC via ' + bd.transportName + ' (apply=' + doApply + ', geocode=' + !noGeocode + (limit ? ', limit=' + limit : ', full') + ')');
    const s = await importer.syncFromBD({ apply: doApply, geocode: !noGeocode, limit });
    console.log('SYNC ' + (s.dryRun ? '(DRY-RUN) ' : '') + JSON.stringify(s, null, 2));
    if (s.dryRun) console.log('Re-run with --apply (+ CONFIRM_PROD_IMPORT=YES on prod) to write.');
    return 0;
  }

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
