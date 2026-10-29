#!/usr/bin/env node
'use strict';
/* migrate-member-feeds-to-discovery.js — consent unification (provider-neutral discovery, 2026-10-29).
   Moves every Member Feed Sync feed (import_sources 'member-feeds', config.feeds[]) onto the ONE authorization
   record (authorized_event_sources) and a collection channel, then retires the shared source with its history.

   Consent is MOVED, never re-dated: authorized_at = the feed's recorded consent.granted_at, and the original
   { granted_by, granted_at, evidence } is kept verbatim in authorization_evidence.member_feed_consent.
   A feed without complete consent, or revoked, creates no authorization (it is listed and left as history).

   Dry run by default:  node scripts/migrate-member-feeds-to-discovery.js        (report)
                        node scripts/migrate-member-feeds-to-discovery.js --apply (one transaction) */

const { hasMemberConsent } = require('../src/services/eventImport/connectors/feedConnector');

function kindOf(feed) {
  if (feed.type === 'ical' || /\.ics(\?|$)/i.test(feed.url || '')) return 'ical';
  if (feed.type === 'rss') return 'rss';
  if (feed.type === 'jsonld') return 'jsonld';
  return feed.url ? 'rss' : 'linked_pages';
}
function domainOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return null; } }

async function plan(db) {
  const src = (await db.query(`SELECT id, status, config FROM import_sources WHERE key = 'member-feeds'`)).rows[0];
  if (!src) return { source: null, moves: [], skipped: [] };
  const feeds = Array.isArray((src.config || {}).feeds) ? src.config.feeds : [];
  const moves = []; const skipped = [];
  for (const f of feeds) {
    const url = f.url || f.site;
    if (f.revoked_at) { skipped.push({ feed: url, reason: 'revoked ' + String(f.revoked_at).slice(0, 10) }); continue; }
    if (!hasMemberConsent(f)) { skipped.push({ feed: url, reason: 'no complete consent recorded' }); continue; }
    const domain = domainOf(f.organizer_website_url || url);
    if (!domain) { skipped.push({ feed: url, reason: 'no usable domain' }); continue; }
    moves.push({ organization_id: f.organization_id, company_name: f.organizer_name, domain, url, kind: kindOf(f), sale_type: f.sale_type || null,
      timezone: f.timezone || null, consent: f.consent });
  }
  return { source: { id: src.id, status: src.status, retired: !!(src.config || {}).retired_reason }, moves, skipped };
}

async function apply(db, p, { actorId = null } = {}) {
  if (!p.source) return { moved: 0 };
  const client = await db.connect();
  let moved = 0;
  try {
    await client.query('BEGIN');
    for (const m of p.moves) {
      let auth = (await client.query(
        `SELECT * FROM authorized_event_sources WHERE organization_id = $1 AND authorized_domain = $2 AND status IN ('authorized','source_configured','collecting','paused')`,
        [m.organization_id, m.domain])).rows[0];
      if (!auth) {
        auth = (await client.query(
          `INSERT INTO authorized_event_sources (organization_id, company_name, authorized_domain, authorized_source_url, status, authorization_method,
              authorized_at, authorization_statement_version, authorization_evidence, created_by)
           VALUES ($1,$2,$3,$4,'authorized','admin_recorded',$5,'member-feed-consent',$6::jsonb,$7) RETURNING *`,
          [m.organization_id, m.company_name || m.domain, m.domain, 'https://' + m.domain + '/', m.consent.granted_at,
            JSON.stringify({ method: 'admin_recorded', member_feed_consent: m.consent, migrated_from: 'member-feeds', migrated_at: new Date().toISOString() }), actorId])).rows[0];
      }
      await client.query(
        `INSERT INTO event_collection_channels (authorization_id, organization_id, kind, url, sale_type_hint, timezone, status, access_basis, access_evidence)
         VALUES ($1,$2,$3,$4,$5,$6,'previewed','robots_and_terms_permit',$7::jsonb)
         ON CONFLICT (authorization_id, kind, COALESCE(url, '')) DO NOTHING`,
        [auth.id, m.organization_id, m.kind, m.url, m.sale_type, m.timezone, JSON.stringify({ migrated_from: 'member-feeds', note: 're-checked by the next discovery probe before collecting' })]);
      await client.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ('event_partner.consent_migrated','authorized_event_source',$1,$2,$3::jsonb)`,
        [auth.id, actorId, JSON.stringify({ from: 'member-feeds', feed: m.url, granted_at: m.consent.granted_at })]);
      moved++;
    }
    await client.query(
      `UPDATE import_sources SET status = 'disabled', health_state = 'RETIRED', health_reason = 'consent unified into authorized_event_sources; history kept',
          config = config || jsonb_build_object('retired_reason', 'Member Feed Sync unified into provider-neutral discovery (2026-10-29)', 'retired_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
          updated_at = now()
        WHERE id = $1 AND NOT (config ? 'retired_reason')`, [p.source.id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { if (client.release) client.release(); }
  return { moved };
}

module.exports = { plan, apply, kindOf };

if (require.main === module) {
  (async () => {
    const db = require('../src/db');
    const p = await plan(db);
    if (!p.source) { console.log('No member-feeds source; nothing to migrate.'); process.exit(0); }
    console.log('member-feeds source: ' + p.source.status + (p.source.retired ? ' (already retired)' : ''));
    for (const m of p.moves) console.log('  MOVE  ' + m.company_name + ' ' + m.url + ' (' + m.kind + '), consent granted ' + m.consent.granted_at + ' by ' + m.consent.granted_by);
    for (const s of p.skipped) console.log('  KEEP AS HISTORY  ' + s.feed + ': ' + s.reason);
    console.log(p.moves.length + ' to move, ' + p.skipped.length + ' left as history; the shared source is then retired.');
    if (!process.argv.includes('--apply')) { console.log('DRY RUN: nothing written.'); process.exit(0); }
    console.log('APPLIED: ' + (await apply(db, p)).moved + ' moved; member-feeds retired.');
    process.exit(0);
  })().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
}
