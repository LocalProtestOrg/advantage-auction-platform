'use strict';

/**
 * Phase 3C.1 — CRM Foundation Tier-1 integration tests.
 * Scratch-only (isolated Neon branch, 077-081). Skips unless CRM_SCRATCH=1 + non-prod DATABASE_URL.
 */

const SCRATCH_OK = !!process.env.CRM_SCRATCH && !/ep-proud-leaf/.test(process.env.DATABASE_URL || '');
if (!SCRATCH_OK) {
  // eslint-disable-next-line no-console
  console.warn('[crm-foundation] SKIPPED — scratch env not configured (CRM_SCRATCH=1 + non-prod DATABASE_URL).');
}
const suite = SCRATCH_OK ? describe : describe.skip;

const db = require('../../src/db');
const health = require('../../src/services/healthScoreService');
const activity = require('../../src/services/crmActivityService');
const reps = require('../../src/services/crmRepService');
const crm = require('../../src/services/crmService');
const orgs = require('../../src/services/organizationsService');
const lifecycle = require('../../src/services/organizationLifecycleService');

let U, PLATFORM, ORG, SHELL;
beforeAll(async () => {
  if (!SCRATCH_OK) return;
  expect((await db.query("SELECT to_regclass('public.organization_activity') t, to_regclass('public.organization_reps') r")).rows[0]).toMatchObject({ t: 'organization_activity', r: 'organization_reps' });
  U = (await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 4')).rows.map((x) => x.id);
  PLATFORM = (await db.query('SELECT id FROM organizations WHERE is_platform_tenant = true')).rows[0].id;
  ORG = (await orgs.onboardOrganization(U[0], { name: 'CRM Test Org', contactEmail: 'c@x.com', state: 'TX' })).id;
  SHELL = (await lifecycle.createShell({ name: 'Shell CRM Co', state: 'TX', bdListingId: 'CRM-BD-1' })).id;
});
afterAll(async () => { if (!SCRATCH_OK) return; await db.pool.end(); });

suite('migration 081', () => {
  test('crm columns present', async () => {
    expect((await db.query("SELECT count(*)::int c FROM information_schema.columns WHERE table_name='organizations' AND column_name IN ('crm_stage','next_action_at','last_contacted_at','health_score','health_computed_at')")).rows[0].c).toBe(5);
  });
});

suite('health scoring', () => {
  test('platform tenant scores higher than an empty shell; recompute caches', async () => {
    const plat = await health.compute(PLATFORM);
    const shell = await health.compute(SHELL);
    expect(plat.score).toBeGreaterThan(shell.score);
    expect(plat.breakdown.claimed.earned).toBe(20); // platform tenant is active_partner
    const r = await health.recompute(SHELL);
    const cached = (await db.query('SELECT health_score FROM organizations WHERE id=$1', [SHELL])).rows[0].health_score;
    expect(cached).toBe(r.score);
  });
});

suite('activity timeline (tracking-first, any channel)', () => {
  test('log note + outreach; outreach sets last_contacted_at; timeline unions audit', async () => {
    await activity.log(ORG, { activityType: 'note', actorId: U[0], subject: 'A note' });
    await activity.log(ORG, { activityType: 'outreach', channel: 'phone', direction: 'outbound', actorId: U[0], subject: 'Called them' });
    expect((await db.query('SELECT last_contacted_at FROM organizations WHERE id=$1', [ORG])).rows[0].last_contacted_at).toBeTruthy();
    const tl = await activity.timeline(ORG);
    expect(tl.some((e) => e.kind === 'activity' && e.type === 'outreach' && e.channel === 'phone')).toBe(true);
    expect(tl.some((e) => e.kind === 'audit' && e.type === 'organization.created')).toBe(true); // unified with audit_log
  });
});

suite('multi-rep ownership', () => {
  test('assign multiple, single primary enforced, remove', async () => {
    await reps.assign(ORG, U[0], { role: 'owner', isPrimary: true });
    await reps.assign(ORG, U[1], { role: 'rep' });
    let list = await reps.list(ORG);
    expect(list.length).toBe(2);
    expect(list.filter((r) => r.is_primary).length).toBe(1);
    await reps.assign(ORG, U[1], { isPrimary: true }); // move primary
    list = await reps.list(ORG);
    expect(list.filter((r) => r.is_primary).length).toBe(1);
    expect(list.find((r) => r.is_primary).user_id).toBe(U[1]);
    await reps.remove(ORG, U[0]);
    expect((await reps.list(ORG)).length).toBe(1);
  });
});

suite('crm stage + targets', () => {
  test('setStage updates + logs; invalid rejected; targets find shell', async () => {
    await crm.setStage(ORG, 'contacted', U[0]);
    expect((await db.query('SELECT crm_stage FROM organizations WHERE id=$1', [ORG])).rows[0].crm_stage).toBe('contacted');
    expect((await activity.timeline(ORG)).some((e) => e.type === 'status_change')).toBe(true);
    await expect(crm.setStage(ORG, 'nope', U[0])).rejects.toMatchObject({ code: 'INVALID_STAGE' });
    const t = await crm.targets('unclaimed_high_potential', { state: 'TX' });
    expect(t.some((r) => r.id === SHELL)).toBe(true);
  });
});
