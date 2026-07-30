#!/usr/bin/env node
/* verify-import-owner.js — READ-ONLY. Confirms the owner-approved canonical organization that will own
 * imported events exists and is valid to use. No writes, no reconciliation. Run before wiring any
 * import_sources row's owner_organization_id.
 *
 * The importer's APPLICATION code hardcodes NO organization UUID — it resolves its owner at runtime via
 * import_sources.owner_organization_id. This UUID lives here only as the operational verification target
 * approved by the owner on 2026-07-30 (see docs/event-import-framework-plan.md §3 and
 * docs/data-governance/aac-organization-reconciliation.md). */
const { Pool } = require('pg');
const OWNER_ORG_ID = 'a9a2f8c6-5929-4335-a453-ffef96270e5c'; // Advantage Auction Company (approved canonical owner)
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  const pool = new Pool({ connectionString: raw, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const { rows } = await c.query(
      `SELECT id, name, slug, type, lifecycle_state, status, source, verification_status, plan_tier,
              bd_listing_id, (SELECT count(*)::int FROM events e WHERE e.organization_id = o.id) AS event_count
         FROM organizations o WHERE id = $1`, [OWNER_ORG_ID]);
    if (!rows.length) {
      console.error('FAIL: approved canonical organization ' + OWNER_ORG_ID + ' NOT FOUND. Stop — do not create imports.');
      return 1;
    }
    const o = rows[0];
    console.log('Canonical import owner:', JSON.stringify(o, null, 1));
    // Sanity: must be an active, verified partner org (the owner-approved profile).
    const ok = o.status === 'active' && o.lifecycle_state === 'active_partner' && o.verification_status === 'verified';
    console.log('RESULT: ' + (ok ? 'PASS — safe to own imported events' : 'REVIEW — org exists but not active_partner/verified; confirm before use'));
    return ok ? 0 : 1;
  } catch (e) { console.error('ERROR:', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
