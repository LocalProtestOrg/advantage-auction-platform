'use strict';
/**
 * Phase 5C — arm gated auto-publish on active import sources.
 *
 * Sets auto_publish=true on every ACTIVE import source so that qualifying imports flow through the
 * HARD publicationGate on each scheduled run. This does NOT make the source authoritative for
 * publication: writer.publishImported still evaluates every event (title/dates/not-expired/location/
 * image/verified organizer/direct host URL/privacy/duplicate/type) and holds anything that fails.
 * Idempotent + audited. Read the source list first with inspect-import-sources.js.
 *
 * Usage:  node scripts/enable-source-autopublish.js --apply    (omit --apply for a dry run)
 */
require('dotenv').config();
const db = require('../src/db');
const { writeAuditLog } = require('../src/lib/auditLog');

const APPLY = process.argv.includes('--apply');

(async () => {
  const host = (() => { try { return new URL(process.env.DATABASE_URL).host; } catch { return '(local)'; } })();
  console.log(`DB host: ${host}  mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const { rows } = await db.query(
    `SELECT id, key, name, auto_publish FROM import_sources WHERE status = 'active' ORDER BY name`);
  for (const s of rows) {
    if (s.auto_publish === true) { console.log(`  = ${s.key}: already auto_publish=true (no change)`); continue; }
    if (!APPLY) { console.log(`  ~ ${s.key}: would set auto_publish=true`); continue; }
    await db.query('UPDATE import_sources SET auto_publish = true WHERE id = $1', [s.id]);
    await writeAuditLog({
      event_type: 'import_source_autopublish_enabled',
      entity_type: 'import_source', entity_id: s.id, actor_id: null,
      metadata: { key: s.key, name: s.name, from: s.auto_publish, to: true, phase: '5C',
        note: 'Gated: publicationGate remains authoritative per event; expired/duplicate/unqualified stay held.' },
    });
    console.log(`  ✓ ${s.key}: auto_publish=true (audited)`);
  }
  await db.pool?.end?.().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
