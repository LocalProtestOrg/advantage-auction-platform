#!/usr/bin/env node
'use strict';
/*
 * dump-host-url-missing-events.js — READ-ONLY. Dumps the full internal record + retained provenance for
 * every currently-public imported event that FAILS the publication gate with host_url_missing, so an
 * admin can research the actual host company. Writes NOTHING. Run:
 *   railway run --service advantage-auction-platform node scripts/dump-host-url-missing-events.js
 */
const db = require('../src/db');
const { evaluatePublication } = require('../src/services/eventImport/publicationGate');
const { pickHostDestination } = require('../src/lib/externalUrlPolicy');

(async function main() {
  const { rows } = await db.query(
    `SELECT e.id, e.slug, e.title, e.source, e.status, e.start_at, e.end_at, e.event_format, e.sale_type,
            e.address, e.city, e.state, e.zip, e.lat, e.lng, e.organizer_name, e.organizer_website_url,
            e.registration_url, e.bidding_url, e.external_url,
            (SELECT count(*)::int FROM event_images ei WHERE ei.event_id = e.id) AS image_count,
            (SELECT url FROM event_images ei WHERE ei.event_id = e.id ORDER BY is_cover DESC, position ASC LIMIT 1) AS cover_url,
            es.source_url AS discovery_url, es.source_event_id, es.raw_payload
       FROM events e
       LEFT JOIN event_sources es ON es.event_id = e.id AND es.sync_status = 'active'
      WHERE e.source = 'imported' AND e.status = 'published'
        AND (e.end_at IS NULL OR e.end_at >= now())
      ORDER BY e.state, e.city`);

  const out = [];
  for (const r of rows) {
    if (pickHostDestination(r)) continue;          // has a company destination → not our target
    const g = evaluatePublication(r);
    if (g.ready || !g.reasons.includes('host_url_missing')) continue;
    const rp = r.raw_payload || {};
    const org = rp.organizer || {};
    out.push({
      id: r.id, slug: r.slug, title: r.title,
      organizer_name: r.organizer_name, organizer_website_url: r.organizer_website_url,
      registration_url: r.registration_url, bidding_url: r.bidding_url,
      city: r.city, state: r.state, zip: r.zip, address: r.address,
      start_at: r.start_at, end_at: r.end_at, event_format: r.event_format, sale_type: r.sale_type,
      image_count: r.image_count, cover_url: r.cover_url,
      // retained provenance (INTERNAL only — for research, never public):
      discovery_url: r.discovery_url || r.external_url,
      raw_organizer: { name: org.name, url: org.url, telephone: org.telephone || rp.telephone, email: org.email },
      gate_reasons: g.reasons,
    });
  }
  console.log('HOST_URL_MISSING_COUNT:', out.length);
  console.log(JSON.stringify(out, null, 2));
  await db.pool.end();
})().catch((e) => { console.error('dump failed:', e && e.message); process.exitCode = 1; });
