'use strict';
// Marketing Agency Phase 4C — Email + Audience Safety Foundation + Admin Quick-Contact.
// "Make future email SAFE before making it powerful." Nothing here sends, imports, or activates SMS/A7.

const fs = require('fs');
const vm = require('vm');

// marketingConfigService is DB-backed; stub it so the pure/stub-runner tests never touch a database.
jest.mock('../src/services/marketingConfigService', () => ({
  getInt: async (_k, fb) => (_k === 'marketing.email.soft_bounce_suppress_threshold' ? 4
    : _k === 'marketing.email.frequency_cap_per_30d' ? 4
    : _k === 'marketing.email.min_spacing_hours' ? 48 : fb),
  getBool: async (_k, fb) => fb,
  raw: async (_k, fb) => fb,
  a7SendEnabled: async () => false,
  adminSmsEnabled: async () => false,
}));

const { normalizeEmail } = require('../src/lib/emailNormalize');
const sesParser = require('../src/lib/sesNotificationParser');
const contract = require('../src/lib/marketingEmailContract');

// ── 1. Email normalization ───────────────────────────────────────────────────
describe('emailNormalize', () => {
  test('trims + lowercases; conservative (no dot-stripping)', () => {
    expect(normalizeEmail('  Foo.Bar@Example.COM ')).toBe('foo.bar@example.com');
    expect(normalizeEmail('a.b@gmail.com')).toBe('a.b@gmail.com'); // dots preserved
  });
  test('rejects unusable input', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail('not-an-email')).toBeNull();
  });
});

// ── 2. SES notification parsing (pure) ───────────────────────────────────────
describe('sesNotificationParser', () => {
  test('parses SNS-wrapped SES Bounce into per-recipient idempotent events', () => {
    const sns = { Type: 'Notification', Message: JSON.stringify({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'x@y.com' }, { emailAddress: 'z@y.com' }] },
      mail: { messageId: 'mid-1' },
    }) };
    const out = sesParser.parse(sns);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ eventType: 'Bounce', bounceSubtype: 'Permanent', email: 'x@y.com', providerEventId: 'mid-1:x@y.com' });
    expect(out[1].providerEventId).toBe('mid-1:z@y.com'); // distinct id per recipient
  });
  test('classifies Transient bounces as soft', () => {
    const out = sesParser.parse({ notificationType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'a@b.com' }] }, mail: { messageId: 'm2' } });
    expect(out[0].bounceSubtype).toBe('Transient');
  });
  test('parses Complaint + Delivery', () => {
    expect(sesParser.parse({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'c@d.com' }] }, mail: { messageId: 'm3' } })[0].eventType).toBe('Complaint');
    expect(sesParser.parse({ notificationType: 'Delivery', delivery: { recipients: ['e@f.com'] }, mail: { messageId: 'm4' } })[0].eventType).toBe('Delivery');
  });
  test('accepts the simplified direct shape', () => {
    const out = sesParser.parse({ eventType: 'Bounce', bounceSubtype: 'Permanent', email: 'q@r.com', providerEventId: 'p1' });
    expect(out[0]).toMatchObject({ eventType: 'Bounce', email: 'q@r.com', providerEventId: 'p1' });
  });
  test('SNS control messages are recognized and NOT auto-acted upon', () => {
    expect(sesParser.isSnsControl({ Type: 'SubscriptionConfirmation' })).toBe(true);
    expect(sesParser.parse({ Type: 'SubscriptionConfirmation', Token: 'x' })).toHaveLength(0);
  });
});

// ── 3. SES feedback ingestion (db + config mocked) ───────────────────────────
describe('sesFeedbackService (ingestion)', () => {
  function makeDb(preset = {}) {
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM ses_feedback_events WHERE provider_event_id/.test(sql)) return { rowCount: preset.dup ? 1 : 0, rows: [] };
        if (/SELECT soft_bounce_count/.test(sql)) return { rows: [{ soft_bounce_count: preset.softCount != null ? preset.softCount : 0 }] };
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    return { db: { connect: async () => client, query: (...a) => client.query(...a) }, calls };
  }
  function load(dbMock) {
    jest.resetModules();
    jest.doMock('../src/db', () => dbMock, { virtual: false });
    jest.doMock('../src/services/marketingConfigService', () => ({ getInt: async (_k, fb) => (_k === 'marketing.email.soft_bounce_suppress_threshold' ? 4 : fb) }));
    return require('../src/services/sesFeedbackService');
  }
  afterEach(() => { jest.dontMock('../src/db'); jest.dontMock('../src/services/marketingConfigService'); });

  test('hard bounce suppresses for marketing (scope=marketing) + marks deliverability', async () => {
    const { db, calls } = makeDb();
    const svc = load(db);
    const r = await svc.ingestEvent({ eventType: 'Bounce', bounceSubtype: 'Permanent', email: 'Hard@X.com', providerEventId: 'e1' });
    expect(r).toEqual({ ok: true, action: 'suppressed_hard_bounce' });
    const supp = calls.find(c => /INSERT INTO email_suppressions/.test(c.sql));
    expect(supp).toBeTruthy();
    expect(supp.params[0]).toBe('hard@x.com');   // normalized
    expect(supp.sql).toMatch(/'marketing'/);      // suppression scope is marketing (protects transactional)
    expect(calls.find(c => /INSERT INTO email_deliverability/.test(c.sql) && /hard_bounced/.test(c.sql))).toBeTruthy();
  });
  test('complaint suppresses for marketing', async () => {
    const { db, calls } = makeDb();
    const r = await load(db).ingestEvent({ eventType: 'Complaint', email: 'c@x.com', providerEventId: 'e2' });
    expect(r.action).toBe('suppressed_complaint');
    expect(calls.some(c => /INSERT INTO email_suppressions/.test(c.sql) && c.params[1] === 'complaint')).toBe(true);
  });
  test('soft bounce below threshold records but does NOT suppress', async () => {
    const { db, calls } = makeDb({ softCount: 1 });   // becomes 2, threshold 4
    const r = await load(db).ingestEvent({ eventType: 'Bounce', bounceSubtype: 'Transient', email: 's@x.com', providerEventId: 'e3' });
    expect(r.action).toBe('soft_bounce_recorded');
    expect(calls.some(c => /INSERT INTO email_suppressions/.test(c.sql))).toBe(false);
  });
  test('soft bounce at threshold suppresses', async () => {
    const { db, calls } = makeDb({ softCount: 3 });   // becomes 4 == threshold
    const r = await load(db).ingestEvent({ eventType: 'Bounce', bounceSubtype: 'Transient', email: 's2@x.com', providerEventId: 'e4' });
    expect(r.action).toBe('suppressed_soft_threshold');
    expect(calls.some(c => /INSERT INTO email_suppressions/.test(c.sql) && c.params[1] === 'soft_bounce_threshold')).toBe(true);
  });
  test('idempotent: a repeated provider event writes nothing new', async () => {
    const { db, calls } = makeDb({ dup: true });
    const r = await load(db).ingestEvent({ eventType: 'Bounce', bounceSubtype: 'Permanent', email: 'd@x.com', providerEventId: 'e1' });
    expect(r).toEqual({ ok: true, idempotent: true });
    expect(calls.some(c => /INSERT INTO email_suppressions/.test(c.sql))).toBe(false);
  });
  test('invalid email is rejected, not recorded', async () => {
    const { db } = makeDb();
    expect(await load(db).ingestEvent({ eventType: 'Bounce', email: 'nope' })).toEqual({ ok: false, reason: 'invalid_email' });
  });
});

// ── 4. Audience eligibility (send-time gate; stub runner) ─────────────────────
describe('audienceEligibilityService.evaluateContact', () => {
  const svc = require('../src/services/audienceEligibilityService');
  function runner(opts = {}) {
    return { query: async (sql) => {
      if (/FROM email_suppressions/.test(sql)) return { rowCount: opts.suppressed ? 1 : 0, rows: opts.suppressed ? [{ reason: 'complaint' }] : [] };
      if (/FROM email_deliverability/.test(sql)) return { rows: opts.deliverability ? [opts.deliverability] : [] };
      if (/count\(\*\)[\s\S]*marketing_campaign_recipients/.test(sql)) return { rows: [{ c: opts.recentCount || 0, last_at: opts.lastAt || null }] };
      if (/too_soon/.test(sql)) return { rows: [{ too_soon: !!opts.tooSoon }] };
      if (/SELECT 1 FROM marketing_campaign_recipients WHERE campaign_id/.test(sql)) return { rowCount: opts.dup ? 1 : 0, rows: [] };
      if (/FROM marketing_contacts/.test(sql)) return { rows: [{ c: 0 }] };  // buildAudienceSpec candidate count
      return { rows: [], rowCount: 0 };
    } };
  }
  const base = { id: 'c1', normalized_email: 'ok@x.com', permission_basis: 'platform_relationship', is_demo: false };
  const R = svc.REASON;

  test('gate order: suppression wins first', async () => {
    expect(await svc.evaluateContact({ contact: base }, runner({ suppressed: true }))).toMatchObject({ eligible: false, reason: R.SUPPRESSED });
  });
  test('hard bounce + complaint + invalid deliverability block', async () => {
    expect((await svc.evaluateContact({ contact: base }, runner({ deliverability: { complaint: true } }))).reason).toBe(R.COMPLAINT);
    expect((await svc.evaluateContact({ contact: base }, runner({ deliverability: { hard_bounced: true } }))).reason).toBe(R.HARD_BOUNCED);
    expect((await svc.evaluateContact({ contact: base }, runner({ deliverability: { invalid: true } }))).reason).toBe(R.INVALID);
  });
  test('demo contact excluded', async () => {
    expect((await svc.evaluateContact({ contact: { ...base, is_demo: true } }, runner())).reason).toBe(R.DEMO_EXCLUDED);
  });
  test('permission default unknown = NO; withdrawn = NO', async () => {
    expect((await svc.evaluateContact({ contact: { ...base, permission_basis: 'unknown' } }, runner())).reason).toBe(R.PERMISSION_UNKNOWN);
    expect((await svc.evaluateContact({ contact: { ...base, permission_basis: undefined } }, runner())).reason).toBe(R.PERMISSION_UNKNOWN);
    expect((await svc.evaluateContact({ contact: { ...base, permission_basis: 'withdrawn' } }, runner())).reason).toBe(R.PERMISSION_WITHDRAWN);
  });
  test('permission scope mismatch blocks', async () => {
    const c = { ...base, permission_basis: 'explicit_opt_in', permission_scope: { classes: ['newsletter'] } };
    expect((await svc.evaluateContact({ contact: c, marketingClass: 'promo' }, runner())).reason).toBe(R.PERMISSION_SCOPE_MISMATCH);
  });
  test('geo mismatch blocks (email geo is its own strategy)', async () => {
    const c = { ...base, address_state: 'CA' };
    expect((await svc.evaluateContact({ contact: c, geoStrategy: { state: 'NY' } }, runner())).reason).toBe(R.GEO_MISMATCH);
  });
  test('frequency cap + spacing + per-campaign duplicate block', async () => {
    expect((await svc.evaluateContact({ contact: base }, runner({ recentCount: 4 }))).reason).toBe(R.FREQUENCY_CAPPED);
    expect((await svc.evaluateContact({ contact: base }, runner({ recentCount: 1, lastAt: '2026-09-01', tooSoon: true }))).reason).toBe(R.MIN_SPACING);
    expect((await svc.evaluateContact({ contact: base, campaignId: 'k1' }, runner({ dup: true }))).reason).toBe(R.DUPLICATE_CAMPAIGN_RECIPIENT);
  });
  test('fully eligible passes only when every gate clears', async () => {
    const r = await svc.evaluateContact({ contact: base, campaignId: 'k1' }, runner());
    expect(r.eligible).toBe(true);
  });
  test('buildAudienceSpec returns a SPEC (not a raw address list) for A7', async () => {
    const spec = await svc.buildAudienceSpec({ campaignId: 'k1' }, runner());
    expect(spec.kind).toBe('audience_specification');
    expect(spec).not.toHaveProperty('addresses');
    expect(spec).not.toHaveProperty('recipients');
    expect(Array.isArray(spec.send_time_gates)).toBe(true);
    expect(spec.note).toMatch(/re-check each address/i);
  });
  test("PERMITTED_BASES never includes unknown or withdrawn (default posture is NO)", () => {
    expect(svc.PERMITTED_BASES.has('unknown')).toBe(false);
    expect(svc.PERMITTED_BASES.has('withdrawn')).toBe(false);
  });
});

// ── 5. Marketing contact service — SOURCE != PERMISSION (stub runner) ─────────
describe('marketingContactService (source != permission)', () => {
  const svc = require('../src/services/marketingContactService');
  function capRunner() {
    const calls = [];
    return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 'c1', permission_basis: 'unknown' }] }; } };
  }
  test('upsertContact normalizes email and NEVER sets permission_basis', async () => {
    const r = capRunner();
    await svc.upsertContact({ email: '  New@X.com ' }, r);
    const ins = r.calls.find(c => /INSERT INTO marketing_contacts/.test(c.sql));
    expect(ins.params[0]).toBe('new@x.com');                 // normalized_email
    expect(ins.sql).not.toMatch(/permission_basis\s*=/);     // upsert never writes permission
    // DO UPDATE clause also must not touch permission_basis
    expect(/DO UPDATE SET[\s\S]*permission_basis/.test(ins.sql)).toBe(false);
  });
  test('attachSource records provenance only; supports purchased/new-mover source types', async () => {
    const r = capRunner();
    await svc.attachSource('c1', { sourceType: 'purchased_audience', acquisitionDate: null, vendorPermittedUses: { email: false } }, r);
    const ins = r.calls.find(c => /INSERT INTO marketing_contact_sources/.test(c.sql));
    expect(ins.params).toContain('purchased_audience');
    expect(ins.sql).not.toMatch(/marketing_contacts/);       // never promotes the contact's permission
  });
  test('grantPermission is the ONLY permission mover and validates basis', async () => {
    await expect(svc.grantPermission('c1', { basis: 'not-a-basis' }, capRunner())).rejects.toThrow();
    const r = capRunner();
    await svc.grantPermission('c1', { basis: 'explicit_opt_in', evidence: 'signup form 2026' }, r);
    expect(r.calls.some(c => /UPDATE marketing_contacts SET[\s\S]*permission_basis/.test(c.sql))).toBe(true);
  });
});

// ── 6. Premium email deliverable contract — no fixed-reach promise ────────────
describe('marketingEmailContract', () => {
  test('Premium deliverable promises eligible subscribers, not a number', () => {
    expect(contract.PREMIUM_EMAIL_DELIVERABLE).toMatch(/eligible subscribers/i);
    expect(contract.promisesFixedReach(contract.PREMIUM_EMAIL_DELIVERABLE)).toBe(false);
  });
  test('promisesFixedReach catches 10,000-subscriber style promises', () => {
    expect(contract.promisesFixedReach('Reach 10,000 subscribers')).toBe(true);
    expect(contract.promisesFixedReach('email to our entire list')).toBe(true);
  });
  test('A7 contract encodes the safety invariants', () => {
    expect(contract.A7_CONTRACT).toMatchObject({
      receivesAudienceSpecNotRawList: true, eligibilityComputedAtSendTime: true,
      sourceIsNotPermission: true, emailGeoSeparateFromPaidRadius: true, cannotWeakenGrowthLabEligibility: true,
    });
  });
});

// ── 7. Admin Quick-Contact component (static) ────────────────────────────────
describe('admin-contact-actions.js (client component)', () => {
  const JS = fs.readFileSync('public/widgets/shared/admin-contact-actions.js', 'utf8');
  const code = JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  test('exposes mount + render; Email/Call/Copy actions present', () => {
    expect(JS).toMatch(/AdminContactActions\s*=/);
    ['Email', 'Call', 'Copy Email', 'Copy Phone', 'Text'].forEach(l => expect(JS).toContain("'" + l + "'"));
  });
  test('Text is GATED and shows activation-pending; never sends', () => {
    expect(JS).toContain('SMS activation pending');
    expect(JS).toMatch(/sms_enabled/);
    expect(code).not.toMatch(/twilio|sendSms|POST.*sms/i);   // component never sends SMS
  });
  test('no AI wording, no vendor names, no em/en dashes; parses', () => {
    expect(code).not.toMatch(/\bAI\b/);
    expect(code).not.toMatch(/twilio|cloudinary|postmark|railway|neon|openai|gpt/i);
    expect(code).not.toMatch(/[—–]/);   // no dashes in rendered/executed code (comments exempt)
    expect(() => new vm.Script(JS)).not.toThrow();
  });
});

// ── 8. Routes (source-assertion; fail-closed + RBAC) ─────────────────────────
describe('sesFeedback route (fail-closed webhook)', () => {
  const SRC = fs.readFileSync('src/routes/sesFeedback.js', 'utf8');
  test('disabled without secret (503), rejects wrong secret (401), timing-safe', () => {
    expect(SRC).toMatch(/503/); expect(SRC).toMatch(/SES_FEEDBACK_WEBHOOK_SECRET/);
    expect(SRC).toMatch(/401/); expect(SRC).toMatch(/timingSafeEqual/);
  });
  test('malformed payloads rejected; SNS control not auto-confirmed', () => {
    expect(SRC).toMatch(/400/);
    expect(SRC).toMatch(/auto_confirmed:\s*false/);
  });
});
describe('adminContact route (RBAC + gated SMS + authoritative email)', () => {
  const SRC = fs.readFileSync('src/routes/adminContact.js', 'utf8');
  test('requires auth + existing permission, resolves email via recipientService, gates SMS, never sends', () => {
    expect(SRC).toMatch(/requirePermission\('members\.view'\)/);
    expect(SRC).toMatch(/recipientEmailSql/);
    expect(SRC).toMatch(/adminSmsEnabled/);
    const code = SRC.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/twilio|sendSms/i);              // resolves contact info only; never sends
  });
});

// ── 9. Migration 131 (additive + safe defaults) ──────────────────────────────
describe('migration 131 (email/audience safety schema)', () => {
  const SQL = fs.readFileSync('db/migrations/131_email_audience_safety_4c.sql', 'utf8');
  const code = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  test('additive only (IF NOT EXISTS), no destructive statements', () => {
    expect(code).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(code).not.toMatch(/DELETE\s+FROM/i);
    expect((code.match(/IF NOT EXISTS/g) || []).length).toBeGreaterThanOrEqual(8);
  });
  test('permission defaults to unknown (source != permission)', () => {
    expect(code).toMatch(/permission_basis[\s\S]*DEFAULT 'unknown'/);
  });
  test('gates seeded OFF; source types include purchased_audience + new_mover', () => {
    expect(code).toMatch(/marketing\.a7_send_enabled',\s*'false'/);
    expect(code).toMatch(/marketing\.admin_sms_enabled',\s*'false'/);
    expect(code).toMatch(/purchased_audience/);
    expect(code).toMatch(/new_mover/);
  });
  test('campaign recipient idempotency + normalized suppression uniqueness', () => {
    expect(code).toMatch(/UNIQUE \(campaign_id, contact_id\)/);
    expect(code).toMatch(/uq_email_suppressions_normalized/);
  });
});

// ── 10. A7 dormant + suppression normalization wiring + transactional protection ─
describe('A7 dormant contract + suppression normalization', () => {
  test('marketing agent doc documents A7 as dormant (a7_send_enabled=false) with spec-not-list rule', () => {
    const md = fs.readFileSync('.claude/agents/marketing.md', 'utf8');
    expect(md).toMatch(/a7_send_enabled\s*=\s*true.*currently false|marketing\.a7_send_enabled = true/);
    expect(md).toMatch(/audience SPECIFICATION/i);
    expect(md).toMatch(/SOURCE != PERMISSION/);
  });
  test('follower campaign + notification worker read suppression via normalized form', () => {
    const fc = fs.readFileSync('src/services/followerCampaignService.js', 'utf8');
    const nw = fs.readFileSync('src/workers/notificationWorker.js', 'utf8');
    expect(fc).toMatch(/normalized_email/);
    expect(nw).toMatch(/normalized_email/);
  });
  test('SES suppression is scoped to marketing (transactional email protected)', () => {
    const svc = fs.readFileSync('src/services/sesFeedbackService.js', 'utf8');
    expect(svc).toMatch(/'marketing'/);
  });
});
