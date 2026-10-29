#!/usr/bin/env node
'use strict';
/* attribute-retired-source-events.js — record which company actually held the events that a RETIRED import
   source brought in, so their history is attributed to that company (events.host_organization_id).
   Example: the retired Lewis & Maese connector stored its events under the importing organization with no
   host, so they do not show as Lewis & Maese's own.

   Uses the existing audited attribution service (hostAttributionService.attribute, method 'admin_verified',
   with the evidence stated). It never changes the event's operating organization, its content or status,
   and never overwrites a different host. Only sources that are retired (config.retired_reason) qualify.

   Dry run by default:
     node scripts/attribute-retired-source-events.js --source lmauction-lewis-maese --org <organization uuid> \
       --evidence "Imported from Lewis & Maese's own site by the retired Lewis & Maese connector" [--actor <admin user uuid>] [--apply] */

const hostAttribution = require('../src/services/eventPartners/hostAttributionService');

async function plan(db, { source, org }) {
  const src = (await db.query(`SELECT id, key, name, config FROM import_sources WHERE key = $1`, [source])).rows[0];
  if (!src) return { ok: false, reason: 'unknown source ' + source };
  if (!(src.config && src.config.retired_reason)) return { ok: false, reason: source + ' is not a retired source; live sources attribute their own events' };
  const o = (await db.query(`SELECT id, name FROM organizations WHERE id = $1`, [org])).rows[0];
  if (!o) return { ok: false, reason: 'unknown organization ' + org };
  const events = (await db.query(
    `SELECT DISTINCT e.id, e.title, e.start_at, e.organizer_name, e.host_organization_id
       FROM events e JOIN event_sources es ON es.event_id = e.id
      WHERE es.source_id = $1 ORDER BY e.start_at`, [src.id])).rows;
  return { ok: true, source: { key: src.key, name: src.name }, organization: o,
    to_attribute: events.filter((e) => !e.host_organization_id),
    already_this_host: events.filter((e) => e.host_organization_id === o.id),
    other_host: events.filter((e) => e.host_organization_id && e.host_organization_id !== o.id) };
}

async function apply(p, { evidence, actorId = null, attribute = hostAttribution.attribute } = {}) {
  if (!String(evidence || '').trim()) throw new Error('--evidence is required (it is stored with each attribution)');
  const done = [];
  for (const e of p.to_attribute) {
    await attribute(e.id, p.organization.id, { method: 'admin_verified', evidence: String(evidence).trim(), actorId });
    done.push(e.id);
  }
  return done;
}

module.exports = { plan, apply };

if (require.main === module) {
  const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
  (async () => {
    const db = require('../src/db');
    const p = await plan(db, { source: arg('source'), org: arg('org') });
    if (!p.ok) { console.error('REFUSE: ' + p.reason); process.exit(1); }
    console.log('Source: ' + p.source.name + ' (' + p.source.key + ')  ->  host: ' + p.organization.name);
    for (const e of p.to_attribute) console.log('  ATTRIBUTE ' + e.id + '  ' + String(e.start_at && e.start_at.toISOString ? e.start_at.toISOString() : e.start_at).slice(0, 10) + '  ' + e.title);
    for (const e of p.other_host) console.log('  LEFT ALONE (different host recorded) ' + e.id + '  ' + e.title);
    console.log(p.to_attribute.length + ' to attribute, ' + p.already_this_host.length + ' already attributed, ' + p.other_host.length + ' with another host.');
    if (!process.argv.includes('--apply')) { console.log('DRY RUN: nothing written. Re-run with --apply (and --evidence) to record.'); process.exit(0); }
    const done = await apply(p, { evidence: arg('evidence'), actorId: arg('actor') });
    console.log('APPLIED: ' + done.length + ' attributed (admin_verified, audited).');
    process.exit(0);
  })().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
}
