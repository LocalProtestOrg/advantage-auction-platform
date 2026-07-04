#!/usr/bin/env node
/* Milestone 8 — Tier 2 staging validation (organizations + events, HTTP layer).
 * Read/writes STAGING only (BASE_URL must contain "staging"). Uses seeded test identities.
 * Covers: API + authz, onboarding, upload/attach (real Cloudinary), plan limits,
 * admin moderation, public listing/detail + allowlist, audit_log.
 * Widget + CORS are validated separately (browser / curl).
 */
'use strict';
const BASE = process.env.BASE_URL || 'https://advantage-staging-production.up.railway.app';
if (!/staging/.test(BASE)) { console.error('REFUSE: BASE_URL must target staging.'); process.exit(2); }
const ADMIN = { email: 'validation-admin@advantage.bid', password: 'ValidationAdmin2025!' };
const ORG_A = { email: 'pilot-buyer1@advantage.bid', password: 'PilotTest2026!' };
const ORG_B = { email: 'pilot-seller2@advantage.bid', password: 'PilotTest2026!' };
// 1x1 png
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; fails.push(name + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); } }
async function api(method, path, { token, body } = {}) {
  const opt = { method, headers: {} };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt); let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
async function login(c) { const { j } = await api('POST', '/api/auth/login', { body: c }); return j && j.token; }
async function uploadImage(token) {
  const fd = new FormData(); fd.append('image', new Blob([PNG], { type: 'image/png' }), 'test.png');
  const r = await fetch(BASE + '/api/org/upload-image', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const j = await r.json().catch(() => ({})); return { status: r.status, url: j.secure_url };
}

(async () => {
  console.log('Tier 2 staging validation → ' + BASE + '\n');

  // ── Auth ──
  console.log('[Auth]');
  const tAdmin = await login(ADMIN), tA = await login(ORG_A), tB = await login(ORG_B);
  ok('admin login', !!tAdmin); ok('organizer A login', !!tA); ok('organizer B login', !!tB);

  // ── Authz (no token / wrong role) ──
  console.log('[Authorization]');
  ok('GET /api/org/events without token → 401', (await api('GET', '/api/org/events')).status === 401);
  ok('organizer hitting /api/admin/events → 403', (await api('GET', '/api/admin/events', { token: tA })).status === 403);

  // ── Onboarding + create + upload + attach ──
  console.log('[Onboarding + create + upload/attach]');
  const created = await api('POST', '/api/org/events', { token: tA, body: {
    organization: { name: 'A Events Co', contactEmail: 'a@example.com' },
    title: 'Houston Estate Showcase', marketSlug: 'houston',
    description: 'Tier2 test event', city: 'Houston', state: 'TX', startAt: '2026-09-01T10:00' } });
  ok('POST /api/org/events auto-onboards org + creates draft (201)', created.status === 201 && created.j && created.j.event, 'status ' + created.status);
  const E1 = created.j && created.j.event; const org = created.j && created.j.organization;
  ok('organization auto-created (owner)', !!org, org ? org.slug : 'none');
  const up = await uploadImage(tA);
  ok('POST /api/org/upload-image → Cloudinary secure_url', up.status === 201 && /^https?:\/\//.test(up.url || ''), 'status ' + up.status);
  if (E1 && up.url) {
    const att = await api('POST', '/api/org/events/' + E1.id + '/images', { token: tA, body: { url: up.url } });
    ok('attach image → 201, is_cover', att.status === 201 && att.j.image && att.j.image.is_cover === true);
    const got = await api('GET', '/api/org/events/' + E1.id, { token: tA });
    ok('GET event shows 1 image', got.j && got.j.images && got.j.images.length === 1);
  }
  // cross-owner 403
  ok('organizer B cannot read A’s event → 403', E1 ? (await api('GET', '/api/org/events/' + E1.id, { token: tB })).status === 403 : false);

  // ── Submit → admin moderation ──
  console.log('[Submit + admin moderation]');
  let sub = E1 && await api('POST', '/api/org/events/' + E1.id + '/submit', { token: tA });
  ok('submit draft → submitted', sub && sub.j.event && sub.j.event.status === 'submitted');
  const queue = await api('GET', '/api/admin/events?status=submitted', { token: tAdmin });
  ok('admin queue lists the submitted event', queue.j && (queue.j.events || []).some(e => e.id === (E1 && E1.id)));
  const detail = E1 && await api('GET', '/api/admin/events/' + E1.id, { token: tAdmin });
  ok('admin detail returns audit trail', detail && Array.isArray(detail.j.audit) && detail.j.audit.length >= 2);
  const pub = E1 && await api('POST', '/api/admin/events/' + E1.id + '/publish', { token: tAdmin });
  ok('Approve & Publish → published', pub && pub.j.event && pub.j.event.status === 'published');

  // reject flow
  const e2c = await api('POST', '/api/org/events', { token: tA, body: { title: 'Reject Me', marketSlug: 'houston', startAt: '2026-09-02T10:00' } });
  const E2 = e2c.j && e2c.j.event;
  if (E2) {
    await api('POST', '/api/org/events/' + E2.id + '/submit', { token: tA });
    ok('reject without reason → 400', (await api('POST', '/api/admin/events/' + E2.id + '/reject', { token: tAdmin, body: {} })).status === 400);
    const rej = await api('POST', '/api/admin/events/' + E2.id + '/reject', { token: tAdmin, body: { reason: 'Add a venue' } });
    ok('reject with reason → rejected + reason', rej.j.event && rej.j.event.status === 'rejected');
    await api('PATCH', '/api/org/events/' + E2.id, { token: tA, body: { description: 'Updated for resubmit' } });
    const res = await api('POST', '/api/org/events/' + E2.id + '/submit', { token: tA });
    ok('edit rejected + resubmit → submitted', res.j.event && res.j.event.status === 'submitted');
  }

  // ── Public listing/detail + allowlist ──
  console.log('[Public listing/detail + allowlist]');
  const list = await api('GET', '/api/public/events?market=houston');
  ok('public list returns the published event', (list.j.data || []).some(e => E1 && e.slug === E1.slug));
  ok('public list hides non-published (E2 not present)', !(list.j.data || []).some(e => E2 && e.slug === E2.slug));
  const pubDetail = E1 && await api('GET', '/api/public/events/' + E1.slug);
  if (pubDetail) {
    const d = pubDetail.j.data || {};
    ok('public detail has organizer_badge + organization', d.organizer_badge === 'Community Organizer' && d.organization && d.organization.name);
    ok('public detail allowlisted (no reviewed_by/review_reason/organization_id/user_id)',
      !('reviewed_by' in d) && !('review_reason' in d) && !('organization_id' in d) && !('user_id' in d));
  }
  ok('unknown market → 400', (await api('GET', '/api/public/events?market=nope')).status === 400);

  // ── Plan limits (organizer B, clean org) ──
  console.log('[Plan limits — free tier]');
  const b1 = await api('POST', '/api/org/events', { token: tB, body: { organization: { name: 'B Events', contactEmail: 'b@example.com' }, title: 'B one', marketSlug: 'houston', startAt: '2026-09-03T10:00' } });
  const EB1 = b1.j && b1.j.event;
  const mk = async (t) => (await api('POST', '/api/org/events', { token: tB, body: { title: t, marketSlug: 'houston', startAt: '2026-09-03T10:00' } })).j.event;
  const EB2 = await mk('B two'), EB3 = await mk('B three'), EB4 = await mk('B four');
  await api('POST', '/api/org/events/' + EB1.id + '/submit', { token: tB });
  await api('POST', '/api/org/events/' + EB2.id + '/submit', { token: tB });
  await api('POST', '/api/org/events/' + EB3.id + '/submit', { token: tB });
  const fourth = await api('POST', '/api/org/events/' + EB4.id + '/submit', { token: tB });
  ok('4th active submit blocked (ACTIVE_EVENT_LIMIT)', fourth.status === 422 && fourth.j.code === 'ACTIVE_EVENT_LIMIT', 'status ' + fourth.status + ' code ' + (fourth.j && fourth.j.code));
  // image limit on EB4 (still draft)
  let imgResp;
  for (let i = 1; i <= 10; i++) imgResp = await api('POST', '/api/org/events/' + EB4.id + '/images', { token: tB, body: { url: 'https://res.cloudinary.com/x/image/upload/e' + i + '.jpg' } });
  ok('10 images attach OK', imgResp && imgResp.status === 201);
  const eleventh = await api('POST', '/api/org/events/' + EB4.id + '/images', { token: tB, body: { url: 'https://res.cloudinary.com/x/image/upload/e11.jpg' } });
  ok('11th image blocked (IMAGE_LIMIT)', eleventh.status === 422 && eleventh.j.code === 'IMAGE_LIMIT', 'status ' + eleventh.status + ' code ' + (eleventh.j && eleventh.j.code));

  // ── audit_log ──
  console.log('[audit_log]');
  const auditDetail = E1 && await api('GET', '/api/admin/events/' + E1.id, { token: tAdmin });
  const types = auditDetail ? (auditDetail.j.audit || []).map(a => a.event_type) : [];
  ok('audit has created/submitted/published', ['event.created', 'event.submitted', 'event.published'].every(t => types.includes(t)), types.join(','));

  console.log('\n════════════════════════════════════');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
