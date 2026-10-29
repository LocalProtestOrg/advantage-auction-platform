#!/usr/bin/env node
'use strict';
/* fix-org-website-encoding.js — one-time correction of organization website addresses that the directory
   sync stored form-encoded ("https%3A%2F%2Fexample.com%2F"). The sync now decodes them
   (bdDirectoryService.cleanWebsite), and the daily sync rewrites UNCLAIMED listings by itself; a CLAIMED
   organization (e.g. Lewis & Maese) is never overwritten by the sync, so it needs this correction.

   Dry run by default: prints every change and writes nothing.
     node scripts/fix-org-website-encoding.js            # report
     node scripts/fix-org-website-encoding.js --apply    # decode + audit each row ('organization.website_url_decoded')
   Only rows whose stored value is still the encoded one are changed; a value that does not decode to a
   real http(s) address is reported and left alone. */

const { cleanWebsite } = require('../src/services/bdDirectoryService');

async function plan(db) {
  const rows = (await db.query(
    `SELECT id, name, lifecycle_state, website_url FROM organizations WHERE website_url ~* '^https?%3A%2F%2F' ORDER BY name`)).rows;
  return rows.map((r) => ({ id: r.id, name: r.name, lifecycle_state: r.lifecycle_state, from: r.website_url, to: cleanWebsite(r.website_url) }));
}

async function apply(db, changes, { actorId = null } = {}) {
  const client = await db.connect();
  const done = [];
  try {
    await client.query('BEGIN');
    for (const c of changes.filter((x) => x.to)) {
      const r = await client.query(
        `UPDATE organizations SET website_url = $2, updated_at = now() WHERE id = $1 AND website_url = $3 RETURNING id`, [c.id, c.to, c.from]);
      if (!r.rows.length) continue;   // changed since the plan was read: leave it
      await client.query(
        `INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ('organization.website_url_decoded', 'organization', $1, $2, $3::jsonb)`,
        [c.id, actorId, JSON.stringify({ from: c.from, to: c.to, reason: 'directory sync stored the address form-encoded' })]);
      done.push(c.id);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { if (client.release) client.release(); }
  return done;
}

module.exports = { plan, apply };

if (require.main === module) {
  (async () => {
    const db = require('../src/db');
    const changes = await plan(db);
    for (const c of changes) console.log((c.to ? 'DECODE ' : 'SKIP   ') + c.name + ' [' + c.lifecycle_state + ']: ' + c.from + ' -> ' + (c.to || '(not a valid address; left alone)'));
    console.log(changes.length + ' encoded address(es) found.');
    if (!process.argv.includes('--apply')) { console.log('DRY RUN: nothing written. Re-run with --apply to correct.'); process.exit(0); }
    const done = await apply(db, changes);
    console.log('APPLIED: ' + done.length + ' corrected and audited.');
    process.exit(0);
  })().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
}
