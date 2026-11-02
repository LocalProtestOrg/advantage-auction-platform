#!/usr/bin/env node
/* prod-correct-seller-business-name.js — PRODUCTION-guarded correction of an EXISTING seller's business identity
   (owner-confirmed). Corrects in place; creates no account, seller or organization and merges nothing.

   Changes, in one transaction:
     - seller_profiles.display_name (the storefront / dashboard business name)
     - the seller's own organization (linked_seller_profile_id = the seller AND the seller's user is its only active
       owner): name, match_key, slug. Any other organization is listed and left unchanged (relationship not verified).
     - seller_identity legal_name / company_name / signatory_name (what new agreements name); other fields kept
     - the organization's plan capabilities, if any are missing (idempotent)
     - audit rows: seller_business_identity_corrected, organization.updated, seller_identity_changed
   Never touches ids, users, roles, staff roles, agreements, items, auctions, orders or money.

   --check    READ-ONLY: shows what would change and every related organization.
   --dry-run  applies inside a transaction, verifies, then ROLLS BACK.
   (none)     applies and verifies.
   Usage: railway run node scripts/prod-correct-seller-business-name.js --seller <seller_profile_id> --name "<business>"
          --signatory "<person>" --reason "<why>" [--check | --dry-run] */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? String(process.argv[i + 1] || '').trim() : ''; };
const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry-run');
const SELLER = arg('--seller'); const NAME = arg('--name'); const SIGNATORY = arg('--signatory'); const REASON = arg('--reason');
const ACTOR_EMAIL = 'admin@advantage.bid';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

(async () => {
  if (!UUID.test(SELLER) || !NAME || NAME.length > 120 || !SIGNATORY || !REASON) { console.error('REFUSE: --seller <uuid> --name --signatory --reason are required.'); return 2; }
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { computeMatchKey } = require('../src/services/organizationMatchingService');
  const { slugify } = require('../src/utils/slug');
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = async (sql, p) => (await c.query(sql, p || [])).rows;
  const one = async (sql, p) => (await rows(sql, p))[0];
  try {
    await c.query(CHECK ? 'BEGIN READ ONLY' : 'BEGIN');
    const sp = await one(`SELECT sp.id, sp.user_id, sp.seller_type, sp.display_name, u.email, u.role, u.staff_role, u.full_name
                            FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`, [SELLER]);
    if (!sp) { console.error('REFUSE: seller profile not found'); await c.query('ROLLBACK'); return 1; }
    const linked = await rows(`SELECT o.id, o.name, o.slug, o.state, o.source, o.plan_tier, o.match_key,
        (SELECT json_agg(json_build_object('user_id', m.user_id, 'role', m.role, 'status', m.status)) FROM organization_members m WHERE m.organization_id = o.id) members
        FROM organizations o WHERE o.linked_seller_profile_id = $1`, [SELLER]);
    const owned = (o) => { const act = (o.members || []).filter((m) => m.status === 'active' && m.role === 'owner'); return act.length === 1 && act[0].user_id === sp.user_id; };
    const verified = linked.filter(owned);
    const related = await rows(`SELECT o.id, o.name, o.source, o.bd_listing_id, o.lifecycle_state,
        (SELECT json_agg(json_build_object('email', u.email, 'role', m.role, 'status', m.status)) FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = o.id) members
        FROM organizations o WHERE (lower(o.contact_email) = lower($1) OR o.id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))
          AND o.id <> ALL($3::uuid[])`, [sp.email, sp.user_id, verified.map((o) => o.id)]);
    const ident = await one('SELECT legal_name, company_name, signatory_name FROM seller_identity WHERE seller_profile_id = $1', [SELLER]);
    const counts = async () => one(`SELECT
        (SELECT count(*)::int FROM marketplace_items WHERE seller_id = $1) items, (SELECT count(*)::int FROM auctions WHERE seller_id = $1) auctions,
        (SELECT count(*)::int FROM agreements WHERE seller_profile_id = $1) agreements, (SELECT md5(string_agg(id::text || status || coalesce(rendered_body, ''), ',' ORDER BY id)) FROM agreements WHERE seller_profile_id = $1) agreements_h,
        (SELECT count(*)::int FROM organization_members WHERE user_id = $2) memberships,
        (SELECT role || ':' || coalesce(staff_role, '') FROM users WHERE id = $2) roles`, [SELLER, sp.user_id]);
    const before = await counts();
    console.log('Seller:', JSON.stringify({ id: sp.id, user_id: sp.user_id, seller_type: sp.seller_type, display_name: sp.display_name, role: sp.role, staff_role: sp.staff_role }));
    console.log('Identity now:', JSON.stringify(ident || null));
    console.log('Own organization(s), verified (linked to this seller, this user is the only active owner):', JSON.stringify(verified.map((o) => ({ id: o.id, name: o.name, slug: o.slug }))));
    const unverifiedLinked = linked.filter((o) => !owned(o));
    if (unverifiedLinked.length) console.log('LINKED BUT NOT VERIFIED (left unchanged):', JSON.stringify(unverifiedLinked));
    console.log('Other related organizations (left unchanged):', JSON.stringify(related));
    console.log('Unchanged-records snapshot:', JSON.stringify(before));
    if (CHECK) { await c.query('ROLLBACK'); console.log('RESULT: CHECK ONLY (nothing changed)'); return 0; }

    const actor = await one('SELECT id FROM users WHERE lower(email) = $1', [ACTOR_EMAIL]);
    const audit = (type, entityType, id, metadata) => c.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ($1,$2,$3,$4,$5)`,
      [type, entityType, id, actor ? actor.id : null, JSON.stringify(metadata)]);
    await c.query('UPDATE seller_profiles SET display_name = $2 WHERE id = $1', [SELLER, NAME]);
    const orgChanges = [];
    for (const o of verified) {
      let slug = slugify(NAME);
      for (let i = 2; (await one('SELECT 1 x FROM organizations WHERE slug = $1 AND id <> $2', [slug, o.id])); i++) slug = `${slugify(NAME)}-${i}`;
      await c.query('UPDATE organizations SET name = $2, slug = $3, match_key = $4, updated_at = now() WHERE id = $1', [o.id, NAME, slug, computeMatchKey(NAME, o.state)]);
      const caps = await c.query(`INSERT INTO organization_capabilities (organization_id, capability, source)
          SELECT $1, capability, 'plan' FROM plan_capabilities WHERE plan_tier = $2 ON CONFLICT (organization_id, capability) DO NOTHING`, [o.id, o.plan_tier]);
      await audit('organization.updated', 'organization', o.id, { fields: ['name', 'slug', 'match_key'], from: { name: o.name, slug: o.slug }, to: { name: NAME, slug }, reason: REASON, capabilities_added: caps.rowCount });
      orgChanges.push({ id: o.id, from: o.name, to: NAME, slug, capabilities_added: caps.rowCount });
    }
    await c.query(`INSERT INTO seller_identity (seller_profile_id, legal_name, company_name, signatory_name, updated_by, updated_at)
        VALUES ($1, $2, $2, $3, $4, now())
        ON CONFLICT (seller_profile_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, company_name = EXCLUDED.company_name,
          signatory_name = EXCLUDED.signatory_name, updated_by = EXCLUDED.updated_by, updated_at = now()`, [SELLER, NAME, SIGNATORY, actor ? actor.id : null]);
    await audit('seller_identity_changed', 'seller_identity', SELLER, { changed_fields: ['legal_name', 'company_name', 'signatory_name'] });
    await audit('seller_business_identity_corrected', 'seller_profile', SELLER, { from: sp.display_name, to: NAME, organizations: orgChanges, reason: REASON,
      left_unchanged: related.map((o) => ({ id: o.id, name: o.name, why: 'relationship to this seller not verified' })) });

    const after = await counts();
    const now = await one(`SELECT sp.display_name, si.legal_name, si.company_name, si.signatory_name FROM seller_profiles sp LEFT JOIN seller_identity si ON si.seller_profile_id = sp.id WHERE sp.id = $1`, [SELLER]);
    const ok = now.display_name === NAME && now.legal_name === NAME && now.signatory_name === SIGNATORY && JSON.stringify(before) === JSON.stringify(after);
    console.log('Organization changes:', JSON.stringify(orgChanges));
    console.log('After:', JSON.stringify(now), JSON.stringify(after));
    if (!ok) { await c.query('ROLLBACK'); console.error('RESULT: FAIL (rolled back)'); return 1; }
    await c.query(DRY ? 'ROLLBACK' : 'COMMIT');
    console.log('RESULT: ' + (DRY ? 'DRY-RUN PASS (rolled back)' : 'APPLIED'));
    return 0;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('ERROR', e.message); return 1;
  } finally { await c.end(); }
})().then((code) => process.exit(code));
