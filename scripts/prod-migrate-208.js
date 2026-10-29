#!/usr/bin/env node
/* prod-migrate-208.js — PRODUCTION-guarded apply of ONLY 208_event_discovery.sql (provider-neutral, consent-based event
   discovery). Additive; moves no money; changes no existing row (no event, source, authorization or consent value).

   --check    READ-ONLY: 207 applied, 208 not recorded, new objects absent, prerequisite tables present.
   --dry-run  applies inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies in one transaction, then verifies the objects and that events, sources, authorizations, runs,
              orders, payments, invoices, payouts and users are unchanged.
   Usage: railway run node scripts/prod-migrate-208.js [--check | --dry-run] */
const fs = require('fs'); const path = require('path');
const FILE = '208_event_discovery.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry-run');
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const one = async (sql, p) => (await c.query(sql, p || [])).rows[0];
    const has = async (sql, p) => !!(await one(sql, p));
    const h = async (sql) => (await one(sql)).h;
    const pre = async () => ({
      migration_207_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '207_storefront_bulk_import.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      new_objects_present: Number((await one(`SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('event_collection_channels','event_discovery_probes','partner_intake_keys'))
        + (SELECT count(*) FROM information_schema.columns WHERE (table_name = 'event_sources' AND column_name = 'channel_id') OR (table_name = 'authorized_event_sources' AND column_name = 'events_page_url')) AS n`)).n),
      prerequisites: Number((await one(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name IN ('authorized_event_sources','import_sources','event_sources','import_runs','organizations','users')`)).n),
      authorizations: Number((await one('SELECT count(*)::int n FROM authorized_event_sources')).n),
      unknown_methods: Number((await one(`SELECT count(*)::int n FROM authorized_event_sources WHERE authorization_method IS NOT NULL
        AND authorization_method NOT IN ('one_click_email','admin_recorded','written_agreement','inbound_request','member_account')`)).n),
      unknown_triggers: Number((await one(`SELECT count(*)::int n FROM import_runs WHERE trigger NOT IN ('scheduled','manual','backfill','retry','push')`)).n),
    });
    const snap = async () => ({
      events: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(host_organization_id::text,'') || ':' || coalesce(start_at::text,''), ',' ORDER BY id), '')) h FROM events`),
      sources: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || config::text, ',' ORDER BY id), '')) h FROM import_sources`),
      authorizations: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(authorization_method,'') || ':' || authorization_evidence::text, ',' ORDER BY id), '')) h FROM authorized_event_sources`),
      event_sources: await h(`SELECT md5(count(*)::text || ':' || coalesce(max(last_synced_at)::text, '')) h FROM event_sources`),
      runs: await h(`SELECT md5(count(*)::text) h FROM import_runs`),
      money: await h(`SELECT md5(((SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM seller_payouts)
        || ':' || (SELECT count(*) FROM marketplace_orders) || ':' || (SELECT count(*) FROM users))::text) h`),
    });
    if (CHECK) {
      await c.query('BEGIN READ ONLY'); const p = await pre(); await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = p.migration_207_applied && !p.already_recorded && p.new_objects_present === 0 && p.prerequisites === 6 && p.unknown_methods === 0 && p.unknown_triggers === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (!p.migration_207_applied) { console.error('REFUSE: migration 207 must be applied first'); return 1; }
    if (p.unknown_methods || p.unknown_triggers) { console.error('REFUSE: existing rows would violate the widened rules'); return 1; }
    const before = await snap();
    const verify = async () => {
      const methodRule = (await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'authorized_event_sources_authorization_method_check'`) || {}).d || '';
      const triggerRule = (await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'import_runs_trigger_check'`) || {}).d || '';
      const after = await snap();
      return {
        channels_table: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'event_collection_channels'`),
        probes_table: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'event_discovery_probes'`),
        intake_keys_table: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'partner_intake_keys'`),
        channel_unique_index: await has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_event_collection_channels_kind_url'`),
        event_sources_channel_id: await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'event_sources' AND column_name = 'channel_id'`),
        events_page_url: await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'authorized_event_sources' AND column_name = 'events_page_url'`),
        method_rule_has_member_account: /member_account/.test(methodRule) && /one_click_email/.test(methodRule),
        trigger_rule_has_push: /'push'/.test(triggerRule) && /'retry'/.test(triggerRule),
        no_channels_probes_or_keys_yet: Number((await one(`SELECT (SELECT count(*) FROM event_collection_channels) + (SELECT count(*) FROM event_discovery_probes) + (SELECT count(*) FROM partner_intake_keys) AS n`)).n) === 0,
        events_unchanged: before.events === after.events,
        import_sources_unchanged: before.sources === after.sources,
        authorizations_unchanged: before.authorizations === after.authorizations,
        event_sources_unchanged: before.event_sources === after.event_sources,
        import_runs_unchanged: before.runs === after.runs,
        payments_invoices_payouts_orders_users_unchanged: before.money === after.money,
      };
    };
    let checks;
    if (p.already_recorded && !DRY) { console.log('SKIP (already recorded).'); checks = await verify(); }
    else {
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '10s'`);
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        checks = await verify();
        if (DRY) { await c.query('ROLLBACK'); console.log('DRY RUN: applied and verified inside a transaction, then rolled back.'); }
        else { await c.query('COMMIT'); console.log('APPLIED', FILE); }
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(', ') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
