'use strict';
/**
 * Phase 5F — seed the two production connector sources (idempotent upsert by key). Audited.
 *   • gsa-auctions : GSA Auctions API (kind=rest, connector=gsa). ACTIVE, auto_publish. Public-domain.
 *   • member-feeds : Member Feed Sync (kind=rss, connector=feed). PAUSED until the first member feed
 *                    URL is added (then flip status='active' and append to config.feeds).
 * Usage: node scripts/seed-connectors.js --apply   (omit --apply for a dry run)
 */
require('dotenv').config();
const db = require('../src/db');
const { writeAuditLog } = require('../src/lib/auditLog');

const APPLY = process.argv.includes('--apply');
const OWNER_ORG = 'a9a2f8c6-5929-4335-a453-ffef96270e5c';   // Advantage org (same as the csv sources)

const SOURCES = [
  {
    key: 'gsa-auctions', kind: 'rest', name: 'GSA Auctions (Federal Surplus)', status: 'active',
    auto_publish: true, weekly_cap: 75, media_policy: 'link_only', auth_env_var: 'GSA_API_KEY',
    terms_attested_url: 'https://catalog.data.gov/dataset/auctions-api',
    config: { connector: 'gsa', apiKeyEnv: 'GSA_API_KEY', timezone: 'America/New_York' },
  },
  {
    key: 'member-feeds', kind: 'rss', name: 'Member Feed Sync', status: 'paused',
    auto_publish: true, weekly_cap: 50, media_policy: 'link_only', auth_env_var: null,
    terms_attested_url: null,
    config: { connector: 'feed', feeds: [], defaults: { timezone: 'America/New_York' } },
  },
];

(async () => {
  const host = (() => { try { return new URL(process.env.DATABASE_URL).host; } catch { return '(local)'; } })();
  console.log(`DB host: ${host}  mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  for (const s of SOURCES) {
    const existing = (await db.query('SELECT id, status FROM import_sources WHERE key = $1', [s.key])).rows[0];
    if (!APPLY) { console.log(`  ~ ${s.key}: ${existing ? 'would UPDATE' : 'would INSERT'} (status=${s.status}, kind=${s.kind})`); continue; }
    if (existing) {
      await db.query(
        `UPDATE import_sources SET name=$2, kind=$3, status=$4, auto_publish=$5, weekly_cap=$6,
           media_policy=$7, auth_env_var=$8, terms_attested_url=$9, config=$10, updated_at=now() WHERE key=$1`,
        [s.key, s.name, s.kind, s.status, s.auto_publish, s.weekly_cap, s.media_policy, s.auth_env_var, s.terms_attested_url, JSON.stringify(s.config)]);
      console.log(`  ✓ ${s.key}: UPDATED`);
    } else {
      await db.query(
        `INSERT INTO import_sources (key, kind, name, status, owner_organization_id, auto_publish, weekly_cap,
           media_policy, auth_env_var, terms_attested_url, config)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [s.key, s.kind, s.name, s.status, OWNER_ORG, s.auto_publish, s.weekly_cap, s.media_policy, s.auth_env_var, s.terms_attested_url, JSON.stringify(s.config)]);
      console.log(`  ✓ ${s.key}: INSERTED`);
    }
    const sid = (await db.query('SELECT id FROM import_sources WHERE key = $1', [s.key])).rows[0].id;
    try {
      await writeAuditLog({ event_type: 'import_source_seeded', entity_type: 'import_source', entity_id: sid, actor_id: null,
        metadata: { key: s.key, kind: s.kind, connector: s.config.connector, status: s.status, phase: '5F', basis: s.key === 'gsa-auctions' ? 'public_domain' : 'member_consent' } });
    } catch (e) { console.log('   (audit skipped:', e.message, ')'); }
  }
  await db.pool?.end?.().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
