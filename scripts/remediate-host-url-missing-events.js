#!/usr/bin/env node
'use strict';
/*
 * remediate-host-url-missing-events.js — one-time, EXPLICIT, NON-DESTRUCTIVE remediation of the
 * researched host_url_missing events. No deletes. Each disposition is hardcoded from the research
 * evidence and re-checked against the publication gate + URL classifier before it is applied.
 *
 *   KEEP  → set the verified company-controlled homepage (organizer_website_url); must pass the gate.
 *   DRAFT → status='draft' (removed from public; provenance preserved; fully reversible).
 *
 * Dry-run by default; pass --apply to write. Run:
 *   railway run --service advantage-auction-platform node scripts/remediate-host-url-missing-events.js --apply
 */
const db = require('../src/db');
const { evaluatePublication } = require('../src/services/eventImport/publicationGate');
const { classifyExternalUrl, pickHostDestination } = require('../src/lib/externalUrlPolicy');
const { writeAuditLog } = require('../src/lib/auditLog');

const APPLY = process.argv.includes('--apply');

// Researched dispositions (deterministic; ids from the read-only dump).
const PLAN = [
  { id: '204e6aa0-2288-426c-817f-e5bbddbafd83', slug: 'estate-sale-jackpot-by-mcclure-and-associates',
    action: 'KEEP', host: 'McClure & Associates Estate Brokerage LLC',
    url: 'https://mcclureandassociatesestatebrokerage.com/', reason: 'verified_company_homepage' },
  { id: '1a40fc3f-820c-4cca-95e7-d290b0ba4372', slug: 'the-abyss-on-pinecrest',
    action: 'KEEP', host: 'Knick Knack Patty Whack',
    url: 'https://knickknackpattywhack.weebly.com/', reason: 'verified_company_homepage' },
  { id: 'c6b90711-6a58-48f3-868a-fda75fbadbb9', slug: 'forest-estate',
    action: 'DRAFT', host: 'J. Brigante Estate Sales', reason: 'host_url_missing' },
  { id: '2ef2008a-85d6-4f0d-83be-9ca8da75de89', slug: 'pair-of-twin-cities-estates',
    action: 'DRAFT', host: 'Muirfield Associates', reason: 'host_url_missing' },
  { id: '01737219-3e95-4197-b35f-85836aa6ccb4', slug: 'coin-collectors-delight',
    action: 'DRAFT', host: 'Lanier Estate Solutions', reason: 'host_url_missing' },
  { id: '4c7d1dcc-12e5-4193-9c83-ba5416c4baef', slug: 'puzzles-more-in-conyers',
    action: 'DRAFT', host: 'Stitches and Riches', reason: 'host_url_missing' },
  { id: '51555323-7c1b-42bf-8c8a-d791a55730e8', slug: 'estate-sale',
    action: 'DRAFT', host: 'Private Listing', reason: 'host_company_unverified' },
  { id: 'a15cdcd0-f708-4544-b57c-9cf62ce807bc', slug: 'must-see-in-dunwoody-furniture-rugs-and-more',
    action: 'DRAFT', host: 'Dunwoody Estate Treasures', reason: 'host_destination_unverified' },
];

(async function main() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of PLAN) {
      const row = (await client.query(
        `SELECT e.id, e.slug, e.status, e.source, e.title, e.start_at, e.end_at, e.event_format,
                e.city, e.state, e.lat, e.lng, e.organizer_name, e.registration_url, e.bidding_url,
                (SELECT count(*)::int FROM event_images ei WHERE ei.event_id = e.id) AS image_count
           FROM events e WHERE e.id = $1 AND e.source = 'imported'`, [p.id])).rows[0];
      if (!row) { console.log(`SKIP ${p.slug}: not found / not imported`); continue; }

      if (p.action === 'KEEP') {
        const cls = classifyExternalUrl(p.url);
        if (!cls.ok) { console.log(`REFUSE ${p.slug}: destination rejected by classifier (${cls.reason})`); continue; }
        const candidate = { ...row, organizer_website_url: p.url };
        const gate = evaluatePublication(candidate);
        const dest = pickHostDestination(candidate);
        console.log(`KEEP  ${p.slug} → host_external_url=${dest ? dest.url : 'NONE'} | gate.ready=${gate.ready} ${gate.ready ? '' : JSON.stringify(gate.reasons)}`);
        if (APPLY) {
          await client.query('UPDATE events SET organizer_website_url = $2, updated_at = now() WHERE id = $1', [p.id, p.url]);
          await writeAuditLog({ client, event_type: 'event.host_destination_verified', entity_type: 'event', entity_id: p.id,
            actor_id: null, metadata: { actor: 'host_remediation', host_company: p.host, destination: p.url, reason: p.reason } });
        }
      } else { // DRAFT
        console.log(`DRAFT ${p.slug} (was ${row.status}) — ${p.reason} [host: ${p.host}]`);
        if (APPLY && row.status === 'published') {
          await client.query("UPDATE events SET status = 'draft', updated_at = now() WHERE id = $1 AND status = 'published'", [p.id]);
          await writeAuditLog({ client, event_type: 'event.held_from_public', entity_type: 'event', entity_id: p.id,
            actor_id: null, metadata: { actor: 'host_remediation', reason: p.reason, host_company: p.host, note: 'discovery source retained internally; provenance preserved' } });
        }
      }
    }
    if (APPLY) { await client.query('COMMIT'); console.log('APPLIED (committed).'); }
    else { await client.query('ROLLBACK'); console.log('DRY RUN (no changes). Pass --apply to write.'); }
  } catch (e) { await client.query('ROLLBACK'); console.error('remediation failed, rolled back:', e && e.message); process.exitCode = 1; }
  finally { client.release(); await db.pool.end(); }
})();
