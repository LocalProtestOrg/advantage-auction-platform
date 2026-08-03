#!/usr/bin/env node
'use strict';
/*
 * audit-imported-event-publication.js — READ-ONLY audit of currently-public imported events against the
 * new publication gate + host-attribution policy. Writes NOTHING. Reports counts so the Product Owner can
 * decide remediation. Run against prod:
 *   railway run --service advantage-auction-platform node scripts/audit-imported-event-publication.js
 */
const db = require('../src/db');
const { evaluatePublication } = require('../src/services/eventImport/publicationGate');
const { pickHostDestination } = require('../src/lib/externalUrlPolicy');

(async function main() {
  const { rows } = await db.query(
    `SELECT e.id, e.slug, e.title, e.source, e.status, e.start_at, e.end_at, e.event_format,
            e.city, e.state, e.lat, e.lng, e.organizer_name, e.organizer_website_url,
            e.registration_url, e.bidding_url, e.external_url,
            (SELECT count(*)::int FROM event_images ei WHERE ei.event_id = e.id) AS image_count
       FROM events e
      WHERE e.source = 'imported' AND e.status = 'published'
        AND (e.end_at IS NULL OR e.end_at >= now())`);

  const total = rows.length;
  let ready = 0, held = 0, haveHostDest = 0, haveOrganizer = 0;
  const reasonTally = {};
  for (const r of rows) {
    if (r.organizer_name && String(r.organizer_name).trim()) haveOrganizer++;
    if (pickHostDestination(r)) haveHostDest++;
    const g = evaluatePublication(r);
    if (g.ready) ready++; else { held++; g.reasons.forEach((x) => { reasonTally[x] = (reasonTally[x] || 0) + 1; }); }
  }

  console.log('=== Imported PUBLIC events — publication-gate audit (read-only) ===');
  console.log('total published imported (active):', total);
  console.log('have an identified host company (organizer_name):', haveOrganizer);
  console.log('have a company-controlled destination (classifier-approved):', haveHostDest);
  console.log('WOULD PASS the new gate (ready):', ready);
  console.log('WOULD BE HELD (fail):', held);
  console.log('held reasons:', JSON.stringify(reasonTally));
  console.log('(all imported events are currently attributed to the AAC owner org; none link a verified host org.)');
  await db.pool.end();
})().catch((e) => { console.error('audit failed:', e && e.message); process.exitCode = 1; });
