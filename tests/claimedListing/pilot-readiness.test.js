'use strict';

/**
 * Claimed Listing: what the first controlled pilot needed (audit 2026-09-25, migration 171).
 *   - paying directory members never get acquisition outreach; an unknown plan is held (fail closed);
 *   - the directory sync records the plan id;
 *   - reviewers can leave a company out of a DRAFT cohort (with a reason) and put it back only while eligible;
 *   - a send that failed too often, or whose outcome is uncertain, stops and goes to a person (never resent);
 *   - draft copy can be edited and is validated; approved copy never changes;
 *   - the people running the campaign can stop it; only a Super Admin can restart it;
 *   - nothing here turns sending on.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-claimed-listing';
const fs = require('fs');
const path = require('path');
const http = require('http');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

jest.mock('../../src/db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }));
jest.mock('../../src/middleware/authMiddleware', () => (req, res, next) => {
  const who = req.headers['x-test-user'];
  if (!who) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: who === 'owner' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222' };
  req.testRole = who;
  return next();
});
jest.mock('../../src/middleware/requirePermission', () => {
  const rbac = jest.requireActual('../../src/lib/rbac');
  return (permission) => (req, res, next) => {
    req.staff = req.testRole === 'owner' ? { role: 'admin', staff_role: 'super_admin', staff_active: true, overrides: [] }
      : { role: 'seller', staff_role: 'marketing', staff_active: true, overrides: [] };
    req.staff.is_super_admin = rbac.isSuperAdmin(req.staff);
    return rbac.hasPermission(req.staff, permission) ? next() : res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  };
});

const db = require('../../src/db');
const identity = require('../../src/services/acquisition/companyIdentityService');
const elig = require('../../src/services/claimedListings/eligibilityService');
const listingContext = require('../../src/services/claimedListings/listingContext');
const templates = require('../../src/services/claimedListings/templates');
const sequences = require('../../src/services/claimedListings/sequenceService');
const sender = require('../../src/services/claimedListings/outreachSender');
const sendGate = require('../../src/services/claimedListings/sendGate');
const emailService = require('../../src/services/emailService');
const bdDirectory = require('../../src/services/bdDirectoryService');
const D = elig.DECISIONS;

/** A fake runner answering by regex; records every statement. */
function fake(routes = []) {
  const calls = [];
  const query = async (sql, params) => {
    const text = String(sql); calls.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
    for (const [re, h] of routes) if (re.test(text)) { const out = typeof h === 'function' ? await h(text, params) : h; return Array.isArray(out) ? { rows: out, rowCount: out.length } : out; }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), calls };
}

// ── eligibility: paying members ──────────────────────────────────────────────────────────────────
let n = 0;
function listing(o = {}, meta = {}) {
  n += 1;
  const row = Object.assign({ id: '00000000-0000-4000-8000-' + String(900 + n).padStart(12, '0'), name: 'Member ' + n + ' Estates', source: 'bd_import',
    bd_listing_id: String(700 + n), contact_email: 'owner' + n + '@member' + n + '.com', website_url: 'https://member' + n + '.com',
    state: 'TX', city: 'Houston', lat: 29.76, lng: -95.37, has_owner: false, bd_sync_status: 'active', profile_data: {},
    bd_metadata: Object.assign({ profession_id: '4', subscription_id: '7' }, meta) }, o);
  return { key: 'organization:' + row.id, entity_type: 'organization', entity_id: row.id, label: row.name, row,
    signals: identity.signalsOf({ name: row.name, website: row.website_url, email: row.contact_email, bdListingId: row.bd_listing_id }) };
}
function ctxFor(entities, { paid = [], claimPlans = ['7'] } = {}) {
  const built = identity.buildClusters(entities);
  for (const c of built.clusters) { c.journey = identity.deriveJourney(c.members).journey; c.companyId = null; }
  const by = new Map(); for (const c of built.clusters) for (const m of c.members) by.set(m.key, c);
  return {
    snap: { entities, clusters: built.clusters, clusterFor: (t, id) => by.get(t + ':' + id) || null, ambiguousFor: () => [] },
    config: { recentDays: 90, salesCooldownDays: 30, excludedBdIds: new Set(), excludedCompanyIds: new Set(), paidBadgeBdIds: new Set(paid), claimPlanIds: new Set(claimPlans), weights: {} },
    listings: entities, supp: new Map(), companySupp: new Map(), listingSends: [], epSends: [], salesSends: [], activeSequences: new Map(),
    internalAccounts: new Map(), locks: new Map(), primaryFor: new Map(), companyIdOf: () => null,
  };
}

describe('paying directory members never get acquisition outreach', () => {
  test('a listing on the free Claim Listing plan (7) is eligible', () => {
    const e = listing();
    expect(elig.decide(e, ctxFor([e])).decision).toBe(D.ELIGIBLE);
  });
  test('a listing on a paid plan it holds (Gold 1, Silver 2, Appraiser 6, others) is EXCLUDE_PAID_MEMBER', () => {
    for (const plan of ['1', '2', '4', '5', '6']) {
      const e = listing({}, { subscription_id: plan });
      const d = elig.decide(e, ctxFor([e]));
      expect([plan, d.decision]).toEqual([plan, D.PAID_MEMBER]);
      expect(d.reason).toMatch(/paid directory plan/);
    }
  });
  test('an imported listing showing a paid badge it never bought stays a data-quality hold until corrected', () => {
    const e = listing({}, { subscription_id: '6' });
    const d = elig.decide(e, ctxFor([e], { paid: [e.row.bd_listing_id] }));
    expect(d.decision).toBe(D.DATA_QUALITY);
    expect(d.reason).toMatch(/badge correction pending/);
  });
  test('fail closed: an unknown plan is held for review, never eligible', () => {
    for (const meta of [{ subscription_id: null }, { subscription_id: '' }]) {
      const e = listing({}, meta);
      const d = elig.decide(e, ctxFor([e]));
      expect(d.decision).toBe(D.DATA_QUALITY);
      expect(d.reason).toMatch(/directory plan is not known/);
    }
  });
  test('a claimed listing (a genuine member such as Lewis & Maese) stays CLAIMED: the earlier rule wins', () => {
    const e = listing({ has_owner: true }, { subscription_id: '1' });
    expect(elig.decide(e, ctxFor([e])).decision).toBe(D.CLAIMED);
  });
  test('the claim-plan list is configurable (migration 171 seeds ["7"])', () => {
    const e = listing({}, { subscription_id: '8' });
    expect(elig.decide(e, ctxFor([e], { claimPlans: ['7', '8'] })).decision).toBe(D.ELIGIBLE);
    expect(read('db/migrations/171_claimed_listing_pilot_readiness.sql')).toMatch(/'claimed_listings\.claim_plan_ids',\s+'\["7"\]'::jsonb/);
  });
  test('the directory sync records the plan id for every listing', () => {
    expect(bdDirectory.normalize({ user_id: 5, company: 'Acme Estates', subscription_id: 6 }).subscriptionId).toBe('6');
    expect(read('src/services/directoryImportService.js')).toMatch(/subscription_id: l\.subscriptionId \|\| null/);
  });
  test('the one-off backfill writes only bd_metadata.subscription_id, and is a dry run unless --apply', () => {
    const s = read('scripts/backfill-bd-plan-ids.js');
    expect(s).toMatch(/const apply = process\.argv\.includes\('--apply'\)/);
    expect(s).toMatch(/if \(!apply\) return 0;/);
    const writes = s.match(/UPDATE organizations SET [^`]+/g);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/SET bd_metadata = jsonb_set\(COALESCE\(bd_metadata, '\{\}'::jsonb\), '\{subscription_id\}'/);
    expect(s).toMatch(/REFUSE: incomplete directory read/);
  });
});

describe('migration 171', () => {
  const m = read('db/migrations/171_claimed_listing_pilot_readiness.sql');
  test('adds the paid-member decision, the excluded member status and the delivery_issue task, keeping every old value', () => {
    for (const v of ['ELIGIBLE_UNCLAIMED_LISTING', 'EXCLUDE_PAID_MEMBER', 'REVIEW_DATA_QUALITY', 'REVIEW_OTHER_RELATIONSHIP', 'EXCLUDE_OUT_OF_SCOPE']) expect(m).toContain("'" + v + "'");
    expect(m).toMatch(/CHECK \(status IN \('pending','queued','active','completed','skipped','stopped','excluded'\)\)/);
    for (const v of ['reply_received', 'legal_escalation', 'profile_change_review', 'delivery_issue']) expect(m).toContain("'" + v + "'");
  });
  test('never touches a programme switch, and only adds config that does not exist', () => {
    expect(m).not.toMatch(/sending_enabled|inbound_enabled|self_request_enabled|activation_emails_enabled|UPDATE platform_config/);
    expect(m).toMatch(/ON CONFLICT \(key\) DO NOTHING;/);
  });
});

// ── safe retries ─────────────────────────────────────────────────────────────────────────────────
describe('a failing or uncertain send goes to a person, never resent blindly', () => {
  const seq = { id: 'seq-1', organization_id: 'org-1', company_id: 'co-1', cohort_id: 'coh-1', cycle_no: 1, step: 0, state: 'queued', retry_count: 0, next_send_at: new Date(0) };
  function runner(maxAttempts) {
    return fake([
      [/key = 'claimed_listings\.sending_enabled'/, [{ value: true }]],
      [/key = 'claimed_listings\.max_send_attempts'/, [{ value: maxAttempts }]],
      [/FROM listing_outreach_sequences WHERE state IN \('queued','active'\) AND next_send_at <= now\(\)/, () => [Object.assign({}, seq, this && this.seq)]],
      [/INSERT INTO listing_tasks/, (t, p) => [{ id: 'task-1', task_type: p[2] }]],
    ]);
  }
  let spyLoad; let spySend;
  beforeEach(() => { spyLoad = jest.spyOn(listingContext, 'load').mockResolvedValue({}); });
  afterEach(() => { spyLoad.mockRestore(); if (spySend) spySend.mockRestore(); });

  test('below the cap a provider error schedules a retry with backoff', async () => {
    spySend = jest.spyOn(sender, 'sendStep').mockResolvedValue({ sent: false, error: 'provider did not accept the message', gate: { allowed: true, blocked_by: [] } });
    const r = runner(5);
    const out = await sequences.tick({}, r);
    expect(out.stopped).toBe(0);
    expect(r.calls.some((c) => /SET retry_count = retry_count \+ 1, next_send_at = now\(\) \+/.test(c.sql))).toBe(true);
    expect(r.calls.some((c) => /INSERT INTO listing_tasks/.test(c.sql))).toBe(false);
  });
  test('at the cap the sequence stops, the lock is released and a delivery_issue task opens', async () => {
    spySend = jest.spyOn(sender, 'sendStep').mockResolvedValue({ sent: false, error: 'provider did not accept the message', gate: { allowed: true, blocked_by: [] } });
    const r = runner(1);
    const out = await sequences.tick({}, r);
    expect(out.stopped).toBe(1);
    const stop = r.calls.find((c) => /UPDATE listing_outreach_sequences SET state = 'stopped', stop_reason = \$2/.test(c.sql));
    expect(stop.params[1]).toBe('send_failed');
    expect(r.calls.some((c) => /DELETE FROM company_contact_locks WHERE holder_type = 'system'/.test(c.sql))).toBe(true);
    const task = r.calls.find((c) => /INSERT INTO listing_tasks/.test(c.sql));
    expect(task.params[2]).toBe('delivery_issue');
    expect(r.calls.some((c) => /retry_count = retry_count \+ 1/.test(c.sql))).toBe(false);
  });
  test('an uncertain earlier attempt (slot already sent, or queued for too long) stops the sequence for a person', async () => {
    spySend = jest.spyOn(sender, 'sendStep').mockResolvedValue({ sent: false, reason: 'already sent or in flight (idempotent)', inFlight: { status: 'sent', stale: true }, gate: { allowed: true, blocked_by: [] } });
    const r = runner(5);
    const out = await sequences.tick({}, r);
    expect(out.stopped).toBe(1);
    const stop = r.calls.find((c) => /UPDATE listing_outreach_sequences SET state = 'stopped', stop_reason = \$2/.test(c.sql));
    expect(stop.params[1]).toBe('delivery_uncertain');
  });
  test('a fresh in-flight attempt just waits', async () => {
    spySend = jest.spyOn(sender, 'sendStep').mockResolvedValue({ sent: false, reason: 'already sent or in flight (idempotent)', inFlight: { status: 'queued', stale: false }, gate: { allowed: true, blocked_by: [] } });
    const r = runner(5);
    const out = await sequences.tick({}, r);
    expect(out.blocked).toBe(1);
    expect(r.calls.some((c) => /INSERT INTO listing_tasks/.test(c.sql))).toBe(false);
  });
  test('nothing is queued, retried or stopped while sending is off', async () => {
    const r = fake([[/key = 'claimed_listings\.sending_enabled'/, [{ value: false }]]]);
    spySend = jest.spyOn(sender, 'sendStep');
    const out = await sequences.tick({}, r);
    expect(out.sending_enabled).toBe(false);
    expect(spySend).not.toHaveBeenCalled();
    expect(r.calls).toHaveLength(1);
  });
});

describe('the sender never sends twice for one (listing, cycle, step)', () => {
  test('when the slot already exists it reports the earlier attempt and sends nothing', async () => {
    const gate = jest.spyOn(sendGate, 'evaluate').mockResolvedValue({ allowed: true, checks: [], blocked_by: [], permanent: false });
    const mail = jest.spyOn(emailService, 'sendEmail');
    const r = fake([
      [/FROM organizations WHERE id = \$1/, [{ id: 'org-1', name: 'Acme Estates', city: 'Houston', state: 'TX', contact_email: 'a@acme.com' }]],
      [/FROM listing_outreach_cohorts WHERE id = \$1/, [{ id: 'coh-1', name: 'Pilot 1', template_versions: { E1: 'tpl-1' } }]],
      [/FROM listing_outreach_templates WHERE id = \$1/, [{ id: 'tpl-1', template_key: 'E1', version: 1, status: 'approved' }]],
      [/INSERT INTO listing_outreach_messages/, []],
      [/SELECT status, created_at FROM listing_outreach_messages WHERE idempotency_key = \$1/, [{ status: 'sent', created_at: new Date() }]],
    ]);
    const out = await sender.sendStep({ sequence: { id: 'seq-1', organization_id: 'org-1', cohort_id: 'coh-1', cycle_no: 1 }, stepKey: 'E1', stepNo: 1 }, r);
    expect(out.sent).toBe(false);
    expect(out.inFlight).toEqual({ status: 'sent', stale: true });
    expect(mail).not.toHaveBeenCalled();
    expect(r.calls.some((c) => /organization_claim_tokens/.test(c.sql))).toBe(false);
    gate.mockRestore(); mail.mockRestore();
  });
});

// ── cohort review ────────────────────────────────────────────────────────────────────────────────
describe('reviewers leave companies out of a draft cohort', () => {
  const draft = [/SELECT \* FROM listing_outreach_cohorts WHERE id = \$1/, [{ id: 'coh-1', status: 'draft' }]];
  test('a reason is required, and the change is audited', async () => {
    const r = fake([draft, [/UPDATE listing_outreach_cohort_members SET status = 'excluded'/, [{ organization_id: 'org-1', status: 'excluded' }]]]);
    await expect(sequences.excludeMember('coh-1', 'org-1', { actorId: 'u1', reason: '' }, r)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const m = await sequences.excludeMember('coh-1', 'org-1', { actorId: 'u1', reason: 'Owner knows them personally' }, r);
    expect(m.status).toBe('excluded');
    expect(r.calls.some((c) => /INSERT INTO audit_logs/i.test(c.sql) || /audit/i.test(c.sql))).toBe(true);
  });
  test('only a draft cohort can be changed', async () => {
    const r = fake([[/SELECT \* FROM listing_outreach_cohorts WHERE id = \$1/, [{ id: 'coh-1', status: 'approved' }]]]);
    await expect(sequences.excludeMember('coh-1', 'org-1', { actorId: 'u1', reason: 'late change' }, r)).rejects.toMatchObject({ code: 'COHORT_NOT_DRAFT' });
    await expect(sequences.includeMember('coh-1', 'org-1', { actorId: 'u1' }, r)).rejects.toMatchObject({ code: 'COHORT_NOT_DRAFT' });
  });
  test('a company is put back only while it is still eligible', async () => {
    const r = fake([draft, [/SELECT \* FROM listing_outreach_cohort_members WHERE cohort_id = \$1 AND organization_id = \$2/, [{ id: 'm1', status: 'excluded' }]],
      [/UPDATE listing_outreach_cohort_members SET status = 'pending'/, [{ id: 'm1', status: 'pending' }]]]);
    const re = jest.spyOn(elig, 'rescreen').mockResolvedValueOnce({ decision: D.PAID_MEMBER, reason: 'the listing is on paid directory plan 1' });
    await expect(sequences.includeMember('coh-1', 'org-1', { actorId: 'u1' }, r)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    re.mockResolvedValueOnce({ decision: D.ELIGIBLE, reason: 'ok' });
    expect((await sequences.includeMember('coh-1', 'org-1', { actorId: 'u1' }, r)).status).toBe('pending');
    re.mockRestore();
  });
  test('approval counts only the companies still in the cohort, and refuses an empty one', async () => {
    const base = [[/SELECT \* FROM listing_outreach_cohorts WHERE id = \$1/, [{ id: 'coh-1', status: 'draft', assigned_rep_user_id: 'rep', template_versions: { E1: 'a', E2_NOCLICK: 'b', E2_CLICKED: 'c', E3: 'd' } }]],
      [/status = 'approved'`?\s*$|FROM listing_outreach_templates WHERE id = ANY/, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]]];
    const empty = fake(base.concat([[/count\(\*\)::int AS n FROM listing_outreach_cohort_members WHERE cohort_id = \$1 AND status <> 'excluded'/, [{ n: 0 }]]]));
    await expect(sequences.approveCohort('coh-1', { actorId: 'owner' }, empty)).rejects.toMatchObject({ code: 'COHORT_EMPTY' });
  });
  test('the shadow run and the scheduler ignore companies left out', () => {
    const s = read('src/services/claimedListings/sequenceService.js');
    expect(s).toMatch(/WHERE m\.cohort_id = \$1 AND m\.status <> 'excluded' ORDER BY o\.name/);
    expect(s).toMatch(/WHERE m\.status = 'pending' AND c\.status IN \('approved','active'\)/);
  });
  test('the signing rep must be an outreach-enabled representative', async () => {
    const r = fake([[/SELECT \* FROM listing_outreach_cohorts WHERE id = \$1/, [{ id: 'coh-1', status: 'draft' }]]]);
    await expect(sequences.assignRep('coh-1', 'someone', { actorId: 'owner' }, r)).rejects.toMatchObject({ code: 'REP_NOT_ENABLED' });
  });
});

// ── templates ────────────────────────────────────────────────────────────────────────────────────
describe('draft copy can be edited and is validated; approved copy never changes', () => {
  const e1 = templates.CATALOGUE.E1;
  test('the blueprint copy passes validation', () => {
    for (const [k, c] of Object.entries(templates.CATALOGUE)) expect(() => templates.validateCopy(k, c.stream, { subject: c.subject, preheader: c.preheader, body_text: c.text })).not.toThrow();
  });
  test('an edit may not drop the footer or the claim link, add a foreign link, an em dash or technology terms', () => {
    const v = (body, subject = e1.subject) => () => templates.validateCopy('E1', 'claimed_listing', { subject, preheader: null, body_text: body });
    expect(v(e1.text.replace('{{footer}}', ''))).toThrow(/footer/);
    expect(v(e1.text.replace('{{claim_link}}', 'the link'))).toThrow(/claim_link/);
    expect(v(e1.text + '\nhttps://example.com/x')).toThrow(/outside Advantage\.Bid/);
    expect(v(e1.text.replace('Claiming is optional.', 'Claiming is optional — really.'))).toThrow(/em dash/);
    expect(v(e1.text.replace('Claiming is optional.', 'Our AI wrote this.'))).toThrow(/Public Language Standard/);
    expect(v(e1.text.replace('{{company}}', '{{companyy}}'))).toThrow(/missing template variables: companyy/);
    expect(v(e1.text, '')).toThrow(/subject is required/);
  });
  test('only a draft can be edited', async () => {
    const r = fake([[/SELECT \* FROM listing_outreach_templates WHERE id = \$1/, [{ id: 't1', template_key: 'E1', stream: 'claimed_listing', status: 'approved', version: 1 }]]]);
    await expect(templates.updateDraft('t1', { subject: 'x', body_text: e1.text }, { actorId: 'owner' }, r)).rejects.toMatchObject({ status: 409 });
    expect(r.calls.some((c) => /UPDATE listing_outreach_templates/.test(c.sql))).toBe(false);
  });
  test('a new version is a new draft row; the source version is never modified', async () => {
    const r = fake([[/SELECT \* FROM listing_outreach_templates WHERE id = \$1/, [{ id: 't1', template_key: 'E1', status: 'approved', version: 1 }]],
      [/INSERT INTO listing_outreach_templates/, [{ id: 't2', template_key: 'E1', version: 2, status: 'draft' }]]]);
    const t = await templates.newVersion('t1', { actorId: 'owner' }, r);
    expect(t).toMatchObject({ version: 2, status: 'draft' });
    expect(r.calls.some((c) => /UPDATE listing_outreach_templates/.test(c.sql))).toBe(false);
  });
  test('the copy only states what the listing actually shows (phone, description)', () => {
    const base = Object.assign({}, templates.SAMPLE_VARS, { postal_address: 'PO Box 1, Houston TX 77001' });
    const row = (k) => ({ subject: templates.CATALOGUE[k].subject, preheader: templates.CATALOGUE[k].preheader, body_text: templates.CATALOGUE[k].text, stream: 'claimed_listing' });
    expect(templates.render(row('E1'), Object.assign({}, base, { phone_listed: true })).text).toMatch(/your Houston location and phone number, taken from public/);
    expect(templates.render(row('E1'), Object.assign({}, base, { phone_listed: false })).text).toMatch(/your Houston location, taken from public/);
    const v = sender.variablesFor({ id: 'o', name: 'Acme', city: 'Houston', state: 'TX', contact_phone: null, description: '' },
      { rep: null, claimLink: 'https://bid.advantage.bid/claim/x', optionsLink: 'https://bid.advantage.bid/claim/x#options', unsubLink: 'https://bid.advantage.bid/u', postalAddress: 'PO', recipient: 'a@b.com', cohortKey: 'p', templateKey: 'E2_NOCLICK', version: 1 });
    expect(v.phone_listed).toBe(false);
    expect(v.description_status).toBe('none yet');
    expect(templates.render(row('E2_NOCLICK'), Object.assign({}, v, { postal_address: 'PO' })).text).toMatch(/Description: none yet/);
  });
  test('outreach copy never implies endorsement or independent verification', () => {
    for (const k of ['E1', 'E2_NOCLICK', 'E2_CLICKED', 'E3', 'E4_REFRESH']) {
      const t = templates.CATALOGUE[k].text + templates.CATALOGUE[k].subject;
      expect([k, t]).not.toEqual([k, expect.stringMatching(/\b(verified|endorse|partner of|recommended by|approved by)\b/i)]);
    }
    expect(templates.CATALOGUE.E1.text).toMatch(/taken from public business information/);
    expect(templates.LISTING_FOOTER).toMatch(/You are receiving this because/);
    expect(templates.LISTING_FOOTER).toMatch(/Don't email me about this listing: \{\{unsubscribe_link\}\}/);
  });
});

// ── routes: who can do what ──────────────────────────────────────────────────────────────────────
describe('Toolbox permissions: stop is for the campaign team, restart is the Super Admin', () => {
  let server; let base;
  beforeAll(async () => {
    const express = require('express');
    const app = express();
    app.use('/api/admin/claimed-listings', require('../../src/routes/adminClaimedListings'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = 'http://127.0.0.1:' + server.address().port + '/api/admin/claimed-listings';
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  beforeEach(() => { db.query.mockReset(); db.query.mockImplementation(async () => ({ rows: [], rowCount: 0 })); });
  const req = (method, p, who, body) => fetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, who ? { 'x-test-user': who } : {}), body: body ? JSON.stringify(body) : undefined });
  const COH = '33333333-3333-4333-8333-333333333333';
  const ORG = '44444444-4444-4444-8444-444444444444';

  test('marketing staff can stop all outreach: sending goes OFF and the reason is recorded', async () => {
    const res = await req('POST', '/program/stop', 'kym', { reason: 'A recipient called to complain' });
    expect(res.status).toBe(200);
    const writes = db.query.mock.calls.filter(([sql]) => /INSERT INTO platform_config/.test(sql)).map(([, p]) => p);
    expect(writes).toContainEqual(['claimed_listings.sending_enabled', 'false']);
    expect(writes.find((p) => p[0] === 'claimed_listings.paused_reason')[1]).toMatch(/A recipient called to complain/);
    expect(writes.some((p) => p[1] === 'true')).toBe(false);
  });
  test('stopping needs a reason', async () => {
    expect((await req('POST', '/program/stop', 'kym', { reason: '' })).status).toBe(400);
  });
  test('marketing staff cannot turn sending on or change a switch', async () => {
    const res = await req('POST', '/program', 'kym', { sending_enabled: true, confirm: 'START-CLAIMED-LISTING-OUTREACH' });
    expect(res.status).toBe(403);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO platform_config/.test(sql))).toBe(false);
  });
  test('marketing staff can pause or stop a cohort, but not resume one', async () => {
    db.query.mockImplementation(async (sql) => (/UPDATE listing_outreach_cohorts SET status = \$2/.test(sql) ? { rows: [{ id: COH, status: 'paused' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    expect((await req('POST', '/cohorts/' + COH + '/status', 'kym', { status: 'paused', reason: 'checking a reply' })).status).toBe(200);
    expect((await req('POST', '/cohorts/' + COH + '/status', 'kym', { status: 'active' })).status).toBe(403);
    expect((await req('POST', '/cohorts/' + COH + '/status', 'owner', { status: 'active', reason: 'resolved' })).status).toBe(200);
  });
  test('marketing staff can leave a company out of a draft cohort; editing copy and approving stay Super Admin', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM listing_outreach_cohorts WHERE id = \$1/.test(sql)) return { rows: [{ id: COH, status: 'draft' }], rowCount: 1 };
      if (/UPDATE listing_outreach_cohort_members SET status = 'excluded'/.test(sql)) return { rows: [{ organization_id: ORG, status: 'excluded' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    expect((await req('POST', '/cohorts/' + COH + '/members/' + ORG + '/exclude', 'kym', { reason: 'Duplicate of another listing' })).status).toBe(200);
    expect((await req('PUT', '/templates/' + COH, 'kym', { subject: 'x', body_text: 'y' })).status).toBe(403);
    expect((await req('POST', '/templates/' + COH + '/approve', 'kym')).status).toBe(403);
    expect((await req('POST', '/cohorts/' + COH + '/approve', 'kym')).status).toBe(403);
    expect((await req('POST', '/cohorts/' + COH + '/rep', 'kym', { rep_user_id: ORG })).status).toBe(403);
  });
  test('turning sending on still requires the Super Admin and the confirmation phrase', async () => {
    expect((await req('POST', '/program', 'owner', { sending_enabled: true })).status).toBe(400);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO platform_config/.test(sql))).toBe(false);
  });
  test('no route other than POST /program can turn a switch on', () => {
    const s = read('src/routes/adminClaimedListings.js');
    const stop = s.slice(s.indexOf("router.post('/program/stop'"), s.indexOf('// ── replies to outreach'));
    expect(stop).toMatch(/\['claimed_listings\.sending_enabled', false\]/);
    expect(stop).not.toMatch(/, true\]/);
  });
});
