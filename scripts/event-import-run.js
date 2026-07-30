#!/usr/bin/env node
'use strict';

/**
 * event-import-run.js — operator CLI for the Event Import Framework (service-level manual runs;
 * the admin UI trigger is Commit 15). Wraps the scheduled worker's runNow/runAllNow so a manual
 * run uses the EXACT same governed engine as the scheduler: transactional writer, dedupe,
 * provenance, audit, run ledger, weekly cap, and ALWAYS draft-only (never auto-publishes).
 *
 * Usage:
 *   node scripts/event-import-run.js --source <key>            # DRY RUN one source (writes nothing)
 *   node scripts/event-import-run.js --source <key> --apply    # APPLY one source (creates DRAFTS)
 *   node scripts/event-import-run.js --all                     # DRY RUN every active source
 *   node scripts/event-import-run.js --all --apply             # APPLY every active source (DRAFTS)
 *
 * Even with --apply, imported events land in DRAFT and wait in the Admin Review Queue. This tool
 * never publishes, never deletes, and never writes Brilliant Directories records.
 */

const worker = require('../src/workers/eventImportWorker');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

(async () => {
  const apply = !!arg('apply');
  const all = !!arg('all');
  const source = arg('source');
  if (!all && !source) {
    console.error('Provide --source <key> or --all. Add --apply to persist (default is a dry run).');
    process.exit(2);
  }
  console.log('[event-import-run] ' + (apply ? 'APPLY' : 'DRY RUN') + (all ? ' (all active sources)' : ' source=' + source) + ' - draft-only, review-queue gated');
  const result = all
    ? await worker.runAllNow({ apply, trigger: 'manual' })
    : await worker.runNow({ sourceKey: String(source), apply, trigger: 'manual' });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e && e.message ? e.message : e); process.exit(1); });
