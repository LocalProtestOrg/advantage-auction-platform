'use strict';

/**
 * Phase 3A — Activation Foundation Tier-1 integration tests.
 * Scratch-only (isolated Neon branch, 077+078+079 applied). Skips unless ACTIVATION_SCRATCH=1
 * and a non-prod DATABASE_URL are set.
 */

const SCRATCH_OK = !!process.env.ACTIVATION_SCRATCH && !/ep-proud-leaf/.test(process.env.DATABASE_URL || '');
if (!SCRATCH_OK) {
  // eslint-disable-next-line no-console
  console.warn('[activation-foundation] SKIPPED — scratch env not configured (ACTIVATION_SCRATCH=1 + non-prod DATABASE_URL).');
}
const suite = SCRATCH_OK ? describe : describe.skip;

const db = require('../../src/db');
const orgs = require('../../src/services/organizationsService');
const lifecycle = require('../../src/services/organizationLifecycleService');
const matching = require('../../src/services/organizationMatchingService');
const capabilityService = require('../../src/services/capabilityService');

let USERS = [], ADMIN, CLAIMER, ONBOARDER;
const caps = (id) => capabilityService.getEffectiveCapabilities(id);

beforeAll(async () => {
  if (!SCRATCH_OK) return;
  expect((await db.query("SELECT to_regclass('public.organizations') AS t")).rows[0].t).toBeTruthy();
  expect((await db.query("SELECT count(*)::int c FROM information_schema.columns WHERE table_name='organizations' AND column_name IN ('lifecycle_state','source','bd_listing_id','match_key')")).rows[0].c).toBe(4);
  USERS = (await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 8')).rows.map((r) => r.id);
  expect(USERS.length).toBeGreaterThanOrEqual(4);
  [ADMIN, CLAIMER, ONBOARDER] = USERS;
});
afterAll(async () => { if (!SCRATCH_OK) return; await db.pool.end(); });

suite('Migration 079 — backfill + deprecation', () => {
  test('existing orgs backfilled to active_partner (no pre-existing inactive)', async () => {
    expect((await db.query("SELECT count(*)::int c FROM organizations WHERE lifecycle_state='inactive'")).rows[0].c).toBe(0);
  });
  test('platform tenant source=admin; all orgs have match_key', async () => {
    expect((await db.query("SELECT count(*)::int c FROM organizations WHERE is_platform_tenant=true AND source='admin'")).rows[0].c).toBe(1);
    expect((await db.query('SELECT count(*)::int c FROM organizations WHERE match_key IS NULL')).rows[0].c).toBe(0);
  });
  test('deprecation comments present', async () => {
    const cmt = (await db.query("SELECT col_description('seller_profiles'::regclass, a.attnum) AS c FROM pg_attribute a WHERE a.attrelid='seller_profiles'::regclass AND a.attname='capabilities'")).rows[0].c || '';
    expect(cmt).toMatch(/DEPRECATED/);
  });
});

suite('Shells, matching, null-owner', () => {
  let shell;
  test('createShell → inactive, no owner, no capabilities', async () => {
    shell = await lifecycle.createShell({ name: 'Lone Star Auctions', state: 'TX', bdListingId: 'BD-TEST-1' });
    expect(shell.lifecycle_state).toBe('inactive');
    expect(shell.source).toBe('bd_import');
    expect(shell.bd_listing_id).toBe('BD-TEST-1');
    expect(await orgs.getOwner(shell.id)).toBeNull();
    expect(await orgs.hasOwner(shell.id)).toBe(false);
    expect((await caps(shell.id)).size).toBe(0);
  });
  test('matching by bd_listing_id and match_key', async () => {
    expect(matching.computeMatchKey('Lone Star Auctions', 'TX')).toBe('lonestarauctions:tx');
    expect((await matching.findByBdListingId('BD-TEST-1')).id).toBe(shell.id);
    expect((await matching.findCandidatesByMatchKey('Lone Star Auctions', 'TX')).some((r) => r.id === shell.id)).toBe(true);
  });
});

suite('Lifecycle: claim → verify → activate (strict capability timing)', () => {
  let shell;
  beforeAll(async () => { if (!SCRATCH_OK) return; shell = await lifecycle.createShell({ name: 'Bayou Estate Co', state: 'LA', bdListingId: 'BD-TEST-2' }); });
  test('claim → claimed, owner set, NO capabilities', async () => {
    const o = await lifecycle.claim(CLAIMER, shell.id);
    expect(o.lifecycle_state).toBe('claimed');
    expect((await orgs.getOwner(shell.id)).id).toBe(CLAIMER);
    expect((await caps(shell.id)).size).toBe(0); // claim grants nothing
  });
  test('double claim → ALREADY_CLAIMED', async () => {
    await expect(lifecycle.claim(USERS[3], shell.id)).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
  });
  test('verify → verified + verification_status + baseline caps', async () => {
    const o = await lifecycle.verify(ADMIN, shell.id);
    expect(o.lifecycle_state).toBe('verified');
    expect(o.verification_status).toBe('verified');
    const c = await caps(shell.id);
    ['organizations', 'events', 'widgets'].forEach((x) => expect(c.has(x)).toBe(true));
    expect(c.has('auctions')).toBe(false);
  });
  test('activate → active_partner + operational caps', async () => {
    const o = await lifecycle.activate(ADMIN, shell.id);
    expect(o.lifecycle_state).toBe('active_partner');
    const c = await caps(shell.id);
    ['auctions', 'imports', 'shipping'].forEach((x) => expect(c.has(x)).toBe(true));
  });
  test('transition guards', async () => {
    const s2 = await lifecycle.createShell({ name: 'Guard Co', state: 'TX' });
    await expect(lifecycle.verify(ADMIN, s2.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });   // not claimed
    await expect(lifecycle.activate(ADMIN, s2.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' }); // not verified
    await expect(lifecycle.claim(CLAIMER, shell.id)).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });   // active org has an owner
  });
  test('all transitions audited', async () => {
    const types = (await db.query("SELECT event_type FROM audit_log WHERE entity_type='organization' AND entity_id=$1", [shell.id])).rows.map((r) => r.event_type);
    ['organization.shell_created', 'organization.claimed', 'organization.verified', 'organization.activated'].forEach((t) => expect(types).toContain(t));
  });
});

suite('Onboarding sets lifecycle fields (grant unchanged)', () => {
  test('onboard → active_partner + source onboarding + match_key + events capability', async () => {
    const o = await orgs.onboardOrganization(ONBOARDER, { name: 'Onboard Test Co', contactEmail: 'o@x.com', state: 'TX' });
    expect(o.lifecycle_state).toBe('active_partner');
    expect(o.source).toBe('onboarding');
    expect(o.match_key).toBeTruthy();
    expect((await caps(o.id)).has('events')).toBe(true);
  });
});
