'use strict';

/**
 * Milestone 8 — Tier 1 integration tests (organizations + events).
 *
 * Runs against an ISOLATED, disposable Neon scratch branch with migration 076 applied.
 * NEVER production: the guard below refuses the prod host, and beforeAll aborts unless
 * the `events` table exists (it only does on the migrated scratch branch — prod does not
 * have it yet). Run via scripts that set DATABASE_URL=<scratch> and EVENTS_SCRATCH=1.
 */

// ── Hard safety guard (runs at file load, before any src/ is required) ──────────
(function guard() {
  const url = process.env.DATABASE_URL || '';
  if (!process.env.EVENTS_SCRATCH) throw new Error('Refusing to run: EVENTS_SCRATCH not set (Tier-1 scratch only).');
  if (/ep-proud-leaf/.test(url)) throw new Error('Refusing to run: DATABASE_URL looks like PRODUCTION.');
})();

const db = require('../../src/db');
const orgs = require('../../src/services/organizationsService');
const events = require('../../src/services/eventsService');

let POOL = [];       // organizer user ids (each gets its own org — one-org-per-user)
let ADMIN, STRANGER; // reusable actor / non-owner
function nextUser() { if (!POOL.length) throw new Error('out of test users'); return POOL.shift(); }
async function freshOrg(name) { const u = nextUser(); const o = await orgs.onboardOrganization(u, { name: name, contactEmail: 't@example.com' }); return { u, o }; }
async function auditTypes(entityId) {
  const { rows } = await db.query('SELECT event_type FROM audit_log WHERE entity_id = $1 ORDER BY created_at ASC', [entityId]);
  return rows.map((r) => r.event_type);
}
const EV = (t, extra) => Object.assign({ title: t, marketSlug: 'houston', startAt: '2026-08-01T10:00' }, extra || {});

beforeAll(async () => {
  // Definitive runtime guard: the events table exists ONLY on the migrated scratch branch.
  const reg = await db.query("SELECT to_regclass('public.events') AS t");
  expect(reg.rows[0].t).toBeTruthy();
  const us = await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 40');
  const ids = us.rows.map((r) => r.id);
  expect(ids.length).toBeGreaterThanOrEqual(9);
  ADMIN = ids[0]; STRANGER = ids[1]; POOL = ids.slice(2);
});
afterAll(async () => { await db.pool.end(); });

describe('1. Migration seeds', () => {
  test('plans=3, markets=2, categories=8', async () => {
    expect((await db.query('SELECT count(*)::int c FROM organization_plans')).rows[0].c).toBe(3);
    expect((await db.query('SELECT count(*)::int c FROM event_markets')).rows[0].c).toBe(2);
    expect((await db.query('SELECT count(*)::int c FROM event_categories')).rows[0].c).toBe(8);
  });
});

describe('2. Onboarding + one-org-per-user', () => {
  test('creates org + owner member + audit; idempotent; validates contact/name', async () => {
    const u = nextUser();
    const o = await orgs.onboardOrganization(u, { name: 'Acme Events', contactEmail: 'a@x.com' });
    expect(o.plan_tier).toBe('free');
    expect(o.verification_status).toBe('unverified');
    const mem = await db.query("SELECT role, status FROM organization_members WHERE organization_id=$1 AND user_id=$2", [o.id, u]);
    expect(mem.rows[0]).toMatchObject({ role: 'owner', status: 'active' });
    const again = await orgs.onboardOrganization(u, { name: 'Different Name', contactEmail: 'a@x.com' });
    expect(again.id).toBe(o.id); // never a second org
    await expect(orgs.onboardOrganization(STRANGER, { contactEmail: 'x@x.com' })).rejects.toMatchObject({ code: 'ORG_NAME_REQUIRED' });
    await expect(orgs.onboardOrganization(STRANGER, { name: 'No Contact' })).rejects.toMatchObject({ code: 'ORG_CONTACT_REQUIRED' });
    expect(await auditTypes(o.id)).toContain('organization.created');
  });
});

describe('3. Event create · slug · validation · audit', () => {
  test('createDraft, unique slugs, required fields', async () => {
    const { u, o } = await freshOrg('Slugs Co');
    const e1 = await events.createDraft(u, o, EV('Summer Market'));
    expect(e1.status).toBe('draft'); expect(e1.source).toBe('organization'); expect(e1.slug).toBe('summer-market');
    const e2 = await events.createDraft(u, o, EV('Summer Market'));
    expect(e2.slug).not.toBe(e1.slug);
    await expect(events.createDraft(u, o, { marketSlug: 'houston', startAt: 'x' })).rejects.toMatchObject({ code: 'EVENT_TITLE_REQUIRED' });
    await expect(events.createDraft(u, o, { title: 'X', startAt: 'x' })).rejects.toMatchObject({ code: 'EVENT_MARKET_REQUIRED' });
    await expect(events.createDraft(u, o, { title: 'X', marketSlug: 'houston' })).rejects.toMatchObject({ code: 'EVENT_START_REQUIRED' });
    expect(await auditTypes(e1.id)).toContain('event.created');
  });
});

describe('4. Attach flow + image limit (free = 10)', () => {
  test('first image is cover; 11th blocked; remove works; audited', async () => {
    const { u, o } = await freshOrg('Imgs Co');
    const e = await events.createDraft(u, o, EV('Photo Event'));
    const img1 = await events.addImage(u, e.id, 'https://cdn.example.com/1.jpg');
    expect(img1.is_cover).toBe(true);
    for (let i = 2; i <= 10; i++) await events.addImage(u, e.id, 'https://cdn.example.com/' + i + '.jpg');
    await expect(events.addImage(u, e.id, 'https://cdn.example.com/11.jpg')).rejects.toMatchObject({ code: 'IMAGE_LIMIT' });
    await events.removeImage(u, e.id, img1.id);
    expect((await events.listImages(e.id)).length).toBe(9);
    expect(await auditTypes(e.id)).toEqual(expect.arrayContaining(['event.image_added', 'event.image_removed']));
  });
});

describe('5. Submit + active-event limit (free = 3); drafts uncounted', () => {
  test('4th active submit blocked; extra drafts do not count', async () => {
    const { u, o } = await freshOrg('Limit Co');
    const a = await events.createDraft(u, o, EV('A')), b = await events.createDraft(u, o, EV('B')),
      c = await events.createDraft(u, o, EV('C')), d = await events.createDraft(u, o, EV('D'));
    await events.submit(u, a.id); await events.submit(u, b.id); await events.submit(u, c.id);
    expect(await events.countActiveEvents(o.id)).toBe(3);
    await expect(events.submit(u, d.id)).rejects.toMatchObject({ code: 'ACTIVE_EVENT_LIMIT' });
    await events.createDraft(u, o, EV('E')); await events.createDraft(u, o, EV('F'));
    expect(await events.countActiveEvents(o.id)).toBe(3); // drafts don't count
    expect(await auditTypes(a.id)).toContain('event.submitted');
  });
});

describe('6. Admin moderation transitions + guards + reason + audit', () => {
  test('publish/reject/return/archive, from-state guards, reasons', async () => {
    const { u, o } = await freshOrg('Mod Co');
    const e = await events.createDraft(u, o, EV('Mod Event'));
    await expect(events.adminPublish(ADMIN, e.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' }); // can't publish a draft
    await events.submit(u, e.id);
    await expect(events.adminReject(ADMIN, e.id)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const rej = await events.adminReject(ADMIN, e.id, 'Needs a clearer description');
    expect(rej.status).toBe('rejected'); expect(rej.review_reason).toBe('Needs a clearer description');
    await events.updateDraft(u, e.id, { description: 'Much better now' }); // rejected is editable
    await events.submit(u, e.id);
    const pub = await events.adminPublish(ADMIN, e.id);
    expect(pub.status).toBe('published'); expect(pub.published_at).toBeTruthy(); expect(pub.reviewed_by).toBe(ADMIN);
    await expect(events.archiveByOwner(u, e.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' }); // owner can't archive published
    const arch = await events.adminArchive(ADMIN, e.id);
    expect(arch.status).toBe('archived');
    expect(await auditTypes(e.id)).toEqual(expect.arrayContaining(
      ['event.created', 'event.submitted', 'event.rejected', 'event.updated', 'event.published', 'event.archived']));
  });
  test('return-to-draft requires a reason', async () => {
    const { u, o } = await freshOrg('Ret Co');
    const e = await events.createDraft(u, o, EV('Ret Event'));
    await events.submit(u, e.id);
    await expect(events.adminReturnToDraft(ADMIN, e.id)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const r = await events.adminReturnToDraft(ADMIN, e.id, 'Please add a venue');
    expect(r.status).toBe('draft'); expect(r.review_reason).toBe('Please add a venue');
  });
});

describe('7. Ownership + editable-state guards', () => {
  test('non-owner blocked; cannot edit once published', async () => {
    const { u, o } = await freshOrg('Own Co');
    const e = await events.createDraft(u, o, EV('Own Event'));
    await expect(events.updateDraft(STRANGER, e.id, { title: 'Hijack' })).rejects.toMatchObject({ code: 'NOT_ORG_OWNER' });
    await events.submit(u, e.id); await events.adminPublish(ADMIN, e.id);
    await expect(events.updateDraft(u, e.id, { title: 'Late edit' })).rejects.toMatchObject({ code: 'EVENT_NOT_EDITABLE' });
  });
});

describe('8. deriveOrganizerBadge', () => {
  test('badge derivation by source + verification', () => {
    expect(events.deriveOrganizerBadge({ source: 'imported' }, null)).toBe('Imported Listing');
    expect(events.deriveOrganizerBadge({ source: 'admin' }, null)).toBe('Advantage');
    expect(events.deriveOrganizerBadge({ source: 'organization' }, { verification_status: 'verified' })).toBe('Verified Organizer');
    expect(events.deriveOrganizerBadge({ source: 'organization' }, { verification_status: 'unverified' })).toBe('Community Organizer');
  });
});
