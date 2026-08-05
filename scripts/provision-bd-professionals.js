'use strict';

/**
 * Phase 4B — provision eligible BD professional members into their EXISTING imported Railway
 * organization (owner membership + 'events' capability + display name). Idempotent, additive,
 * reversible. Business Administration (BD membership/billing/listing) is NEVER touched.
 *
 *   node -r dotenv/config scripts/provision-bd-professionals.js                 # dry-run Lewis & Maese (bd-350)
 *   node -r dotenv/config scripts/provision-bd-professionals.js --apply         # apply Lewis & Maese
 *   node -r dotenv/config scripts/provision-bd-professionals.js --bd-user 350 --bd-listing 350 --name lewis --apply
 *   node -r dotenv/config scripts/provision-bd-professionals.js --candidates    # list unprovisioned candidates (read-only)
 *
 * Defaults to DRY-RUN. Only writes with --apply. Only ever provisions the member(s) explicitly named
 * (no blanket bulk run here) — bulk eligibility awaits the confirmed per-plan entitlement matrix.
 */

const svc = require('../src/services/professionalProvisioningService');
const db = require('../src/db');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
const APPLY = process.argv.includes('--apply');
const CANDIDATES = process.argv.includes('--candidates');

async function actorAdminId() {
  try { const { rows } = await db.query("SELECT id FROM users WHERE role='admin' ORDER BY created_at ASC LIMIT 1"); return rows[0] && rows[0].id; }
  catch (_) { return null; }
}

async function listCandidates() {
  // Bridge members whose BD member id matches an imported professional org's listing id, not yet owned.
  const { rows } = await db.query(
    `SELECT ei.provider_subject AS bd_user_id, o.bd_listing_id, o.id AS org_id, o.name, o.type, o.lifecycle_state,
            (SELECT count(*)::int FROM organization_members m WHERE m.organization_id=o.id AND m.status='active') AS members
       FROM external_identities ei
       JOIN organizations o ON o.bd_listing_id = ei.provider_subject AND o.source='bd_import'
      WHERE ei.provider='brilliant_directories'
      ORDER BY o.name ASC`);
  console.log(`\nCandidates (bridge member id == imported listing id): ${rows.length}`);
  console.table(rows.map((r) => ({ bd_user_id: r.bd_user_id, listing: r.bd_listing_id, type: r.type, state: r.lifecycle_state, members: r.members, name: (r.name || '').slice(0, 28) })));
  console.log('NOTE: matching by (member id == listing id) is a heuristic — confirm per-member before bulk apply.');
}

async function run() {
  const bdUser = String(arg('bd-user', '350'));
  const bdListing = String(arg('bd-listing', '350'));
  const namePrefix = String(arg('name', 'lewis'));

  if (CANDIDATES) { await listCandidates(); return; }

  const user = await svc.findUserByBdMember(bdUser);
  const org = await svc.findOrgByBdListing(bdListing);
  console.log('\n== Phase 4B provisioning ==');
  console.log('mode         :', APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)');
  console.log('BD member    :', bdUser, user ? `→ user ${user.id}` : '→ (no bridge user found)');
  console.log('BD listing   :', bdListing, org ? `→ org ${org.id} "${(org.name || '').slice(0, 30)}" type=${org.type} state=${org.lifecycle_state}` : '→ (no imported org found)');
  if (!user || !org) { console.log('\nABORT: could not resolve both the bridge user and the imported org.'); return; }

  const before = await svc.getStatus(user.id);
  console.log('before status:', before || '(no active org membership)');

  if (!APPLY) {
    const ownerRow = (await db.query("SELECT user_id FROM organization_members WHERE organization_id=$1 AND role='owner' AND status='active' LIMIT 1", [org.id])).rows[0];
    const decision = svc.decideMembership(ownerRow && ownerRow.user_id, user.id);
    console.log('\nWOULD:', decision === 'create' ? 'create owner membership + set lifecycle claimed' : decision === 'exists' ? 'keep existing owner membership' : 'ABORT (org owned by another account)');
    console.log('WOULD: grant events capability (idempotent)');
    console.log('WOULD: set display name if the account has none →', [user.provider_first_name, user.provider_last_name].filter(Boolean).join(' ') || org.name);
    console.log('\n(dry-run only — re-run with --apply to write)');
    return;
  }

  const actorId = await actorAdminId();
  const result = await svc.provisionByBdIds({ bdUserId: bdUser, bdListingId: bdListing, expectNameStartsWith: namePrefix, actorId });
  const after = await svc.getStatus(user.id);
  console.log('\nRESULT:', result);
  console.log('after status :', after);
  console.log('\nDONE. Reversible: DELETE the org membership + the events capability row, revert lifecycle to prior state, null the display name if set.');
}

run().then(() => db.end && db.end()).catch((e) => { console.error('FATAL', e.code || '', e.message); if (db.end) db.end(); process.exit(1); });
