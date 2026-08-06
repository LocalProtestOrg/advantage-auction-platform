'use strict';
/**
 * Phase 5C — authorized manual PRODUCTION verification run.
 *
 * Executes the EXACT scheduler path (runScheduledCycle via runAllNow) against every active source,
 * apply=true, with gated auto-publish ON. writer.publishImported + publicationGate remain
 * authoritative per event: expired/duplicate/unqualified records are safely skipped or held.
 * Then prints the run summary, run-history rows, and a fresh inventory/health + next-scheduled-run
 * snapshot. Authorized even if it produces zero new events. Does NOT fabricate any data.
 *
 * Usage: node scripts/verify-import-run.js
 */
require('dotenv').config();
// Mirror the intended PRODUCTION schedule for the health/next-run snapshot (no email from local).
process.env.EVENT_IMPORT_WORKER_ENABLED = 'true';
process.env.EVENT_IMPORT_SCHEDULE_DAYS = process.env.EVENT_IMPORT_SCHEDULE_DAYS || '1,4';
process.env.EVENT_IMPORT_SCHEDULE_HOUR = process.env.EVENT_IMPORT_SCHEDULE_HOUR || '3';
process.env.EVENT_INVENTORY_ALERTS_ENABLED = 'false';

const db = require('../src/db');
const worker = require('../src/workers/eventImportWorker');

(async () => {
  const host = (() => { try { return new URL(process.env.DATABASE_URL).host; } catch { return '(local)'; } })();
  console.log('=== Phase 5C manual verification run ===');
  console.log('DB host:', host);
  const c = worker.cfg();
  console.log('Schedule:', JSON.stringify(worker.describeSchedule(c)));
  console.log('Next scheduled run:', JSON.stringify(worker.nextScheduledRun(c)));

  console.log('\n--- running the scheduler path (apply=true, gated auto-publish) ---');
  const summary = await worker.runAllNow({ apply: true, trigger: 'manual', autoPublish: true });
  console.log('SUMMARY counts:', JSON.stringify(summary.counts));
  console.log('sources_total:', summary.sources_total, 'sources_failed:', summary.sources_failed);
  for (const s of summary.sources) console.log('  source', s.source, '→', JSON.stringify(s.counters), s.error ? ('ERR:' + s.error) : '');

  console.log('\n--- run-history rows just written (import_runs) ---');
  const { rows: runs } = await db.query(
    `SELECT r.trigger, r.status, s.key AS source, r.fetched, r.eligible, r.created, r.updated,
            r.skipped_duplicate, r.skipped_quality, r.skipped_ambiguous, r.failed, r.started_at
       FROM import_runs r LEFT JOIN import_sources s ON s.id = r.source_id
      ORDER BY r.started_at DESC LIMIT 5`);
  for (const r of runs) console.log('  ', JSON.stringify(r));

  console.log('\n--- hold reasons (draft imported events, publish_held audit) ---');
  const { rows: holds } = await db.query(
    `SELECT metadata->>'reasons' AS reasons, count(*)::int n
       FROM audit_log
      WHERE event_type = 'event.publish_held' AND created_at > now() - interval '10 minutes'
      GROUP BY 1 ORDER BY n DESC`).catch(() => ({ rows: [] }));
  if (!holds.length) console.log('   (none in the last 10 min — expired/duplicate records are skipped before the publish step)');
  for (const h of holds) console.log('  ', h.n, '×', h.reasons);

  console.log('\n--- monitoring: inventory + health snapshot written ---');
  const health = await worker.runHealthCheck(new Date(), { afterCycle: true, summary, cfg: c });
  console.log('inventory:', JSON.stringify(health && health.snapshot));
  console.log('alerts:', JSON.stringify(health && health.alerts));

  await db.pool?.end?.().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
