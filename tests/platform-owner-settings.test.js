'use strict';

/**
 * Owner-only sensitive platform settings, the setting audit trail and owner notices (owner decision 2026-11-06,
 * migration 222).
 *
 * Real Postgres (PGlite, in memory) running the REAL migration 222 on minimal users / platform_config tables, the real
 * configService choke point, the real /api/config routes, the real ownerNotifyService and the real ownerAlertService.
 * Only the transports are stand-ins (email and the SMS sender): nothing is ever sent.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Worker } = require('worker_threads');

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}
function mockAdapter() {
  const query = async (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    const r = await global.__PG.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null && !/^\s*select/i.test(sql) ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}
jest.mock('../src/db', () => mockAdapter());
jest.mock('../src/db/index', () => mockAdapter());
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'mail-1' })), isConfigured: () => true }));
jest.mock('../src/services/smsService', () => ({ sendSMS: jest.fn(async () => ({ sid: 'SM1', status: 'queued' })) }));
// Authentication stand-in: the test names the signed-in user with the x-test-user header.
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS[req.headers['x-test-user']];
  if (!u) return res.status(401).json({ success: false, message: 'unauthenticated' });
  req.user = { id: u.id, role: u.role }; return next();
});

const mail = require('../src/services/emailService');
const sms = require('../src/services/smsService');
const configService = require('../src/services/configService');
const sensitiveConfig = require('../src/lib/sensitiveConfig');
const platformOwner = require('../src/lib/platformOwner');
const ownerNotify = require('../src/services/ownerNotifyService');

jest.setTimeout(60000);
let pg; let server; let base;
const q = async (sql, params) => (await pg.query(sql, params)).rows;
const audit = (key) => q('SELECT * FROM platform_setting_audit WHERE config_key = $1 ORDER BY created_at DESC, id DESC', [key]);

async function call(method, url, user, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(async () => {
  pg = startPg(); global.__PG = pg;
  await pg.exec(`CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT, role TEXT, is_active BOOLEAN DEFAULT true);
    CREATE TABLE platform_config (key TEXT PRIMARY KEY, value JSONB NOT NULL, category TEXT NOT NULL DEFAULT 'general', description TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE organizations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug TEXT);
    CREATE TABLE organization_config (organization_id UUID, key TEXT, value JSONB, updated_by UUID, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (organization_id, key));
    CREATE TABLE owner_alert_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), alert_type TEXT, entity_type TEXT, entity_id TEXT, recipient_hash TEXT, dedup_key TEXT UNIQUE,
      status TEXT, provider_sid TEXT, provider_status TEXT, attempts INT DEFAULT 0, last_error TEXT, first_attempt_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);`);
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '222_platform_owner_and_config_audit.sql'), 'utf8'));
  const mk = async (email, role, extra = '') => (await q(`INSERT INTO users (email, role${extra ? ', is_platform_owner' : ''}) VALUES ($1, $2${extra ? ', true' : ''}) RETURNING id, role`, [email, role]))[0];
  global.__USERS = {
    owner: await mk('owner@advantage.test', 'admin', 'owner'),
    admin: await mk('staff-admin@advantage.test', 'admin'),
    seller: await mk('seller@advantage.test', 'seller'),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/config', require('../src/routes/config'));
  server = http.createServer(app).listen(0);
  base = 'http://127.0.0.1:' + server.address().port;
  process.env.OWNER_ALERT_PHONE_E164 = '+15555550100';
});
afterAll(async () => { if (server) server.close(); if (pg) await pg.close(); delete process.env.OWNER_ALERT_PHONE_E164; });
beforeEach(() => {
  mail.sendEmail.mockReset(); mail.sendEmail.mockImplementation(async () => ({ messageId: 'mail-1' }));
  sms.sendSMS.mockReset(); sms.sendSMS.mockImplementation(async () => ({ sid: 'SM1', status: 'queued' }));
});

describe('migration 222', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '222_platform_owner_and_config_audit.sql'), 'utf8');
  test('additive, designates nobody, seeds the two owner notice addresses only when absent, has a written reverse', () => {
    expect(sql.replace(/^--.*$/gm, '')).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|UPDATE\s+users/i);
    expect(sql).toMatch(/is_platform_owner BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).toMatch(/\["tylerwitt@gmail\.com","advantageauction\.bid@gmail\.com"\]/);
    expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(sql).toMatch(/-- Reverse:/);
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prod-migrate-222.js'), 'utf8');
    expect(runner).toMatch(/REFUSE: PRODUCTION endpoint only/); expect(runner).toMatch(/--dry-run/); expect(runner).toMatch(/nobody_designated/);
    const setter = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prod-set-platform-owner.js'), 'utf8');
    expect(setter).toMatch(/REFUSE: PRODUCTION endpoint only/);
    expect(setter).toMatch(/u\.role !== 'admin'/); expect(setter).toMatch(/is_active === false/); expect(setter).toMatch(/--apply/);
  });
});

describe('the sensitive key list', () => {
  test.each([
    'pricing.auction.processing_fee_bps', 'business.legal_name', 'marketing.paid.global_kill', 'marketing.paid_growth.monthly_ceiling_usd',
    'marketing.paidsocial.x', 'marketing.destinations.meta_ads_enabled', 'sasha.enabled', 'seller_activation.mode', 'marketing.a7_send_enabled',
    'marketing.a9_publish_enabled', 'claimed_listings.sending_enabled', 'event_partners.from_address', 'auction_sms.enabled',
    'marketing.measurement.meta_pixel', 'owner.notify_emails', 'webhooks.stripe', 'anything.kill_switch', 'x.daily_ceiling', 'x.budget_usd', 'x.execution_mode',
  ])('%s is owner only', (k) => expect(sensitiveConfig.isSensitive(k)).toBe(true));
  test.each(['branding.primary_color', 'marketing.pkg.homepage.hero_days', 'company.postal_address', 'bidder_phone.required', 'marketing.social.insights_enabled'])(
    '%s stays editable by any admin', (k) => expect(sensitiveConfig.isSensitive(k)).toBe(false));
  test('secrets are masked, ordinary values are kept', () => {
    expect(sensitiveConfig.maskValue('webhooks.signing_secret', 'abc')).toBe('[masked]');
    expect(sensitiveConfig.maskValue('x', 'whsec_1234567890abcdef')).toBe('[masked]');
    expect(sensitiveConfig.maskValue('x', { api_key: 'k', url: 'https://example.com' })).toEqual({ api_key: '[masked]', url: 'https://example.com' });
    expect(sensitiveConfig.maskValue('x', 'EAAB' + 'x'.repeat(40))).toBe('[masked]');
    expect(sensitiveConfig.maskValue('pricing.fee', 400)).toBe(400);
  });
});

describe('platform owner check (database, fail closed)', () => {
  test('only an active admin with the flag is the owner', async () => {
    expect(await platformOwner.isPlatformOwner(global.__USERS.owner)).toBe(true);
    expect(await platformOwner.isPlatformOwner(global.__USERS.admin)).toBe(false);
    expect(await platformOwner.isPlatformOwner(null)).toBe(false);
    const sellerFlagged = (await q(`INSERT INTO users (email, role, is_platform_owner) VALUES ('flagged@x.test', 'seller', true) RETURNING id`))[0];
    expect(await platformOwner.isPlatformOwner({ id: sellerFlagged.id })).toBe(false);
    const inactive = (await q(`INSERT INTO users (email, role, is_platform_owner, is_active) VALUES ('gone@x.test', 'admin', true, false) RETURNING id`))[0];
    expect(await platformOwner.isPlatformOwner({ id: inactive.id })).toBe(false);
  });
  test('a database error means "not the owner"', async () => {
    const broken = { query: async () => { throw new Error('column "is_platform_owner" does not exist'); } };
    expect(await platformOwner.isPlatformOwner(global.__USERS.owner, broken)).toBe(false);
  });
});

describe('PUT /api/config/platform', () => {
  test('a non-owner admin cannot write a sensitive key; nothing is written', async () => {
    const r = await call('PUT', '/api/config/platform', 'admin', { key: 'marketing.paid.execution_enabled', value: true });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PLATFORM_OWNER_REQUIRED');
    expect(r.body.message).toMatch(/Only the platform owner/);
    expect(await q(`SELECT 1 FROM platform_config WHERE key = 'marketing.paid.execution_enabled'`)).toHaveLength(0);
    expect(await audit('marketing.paid.execution_enabled')).toHaveLength(0);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
  test('a seller cannot reach platform settings at all', async () => {
    expect((await call('PUT', '/api/config/platform', 'seller', { key: 'branding.primary_color', value: '#000' })).status).toBe(403);
    expect((await call('GET', '/api/config/platform', 'seller')).status).toBe(403);
  });
  test('the owner can; the change is audited with old and new values and the owner is emailed at both addresses and texted', async () => {
    await q(`INSERT INTO platform_config (key, value, category) VALUES ('pricing.auction.processing_fee_bps', '300', 'pricing')`);
    const r = await call('PUT', '/api/config/platform', 'owner', { key: 'pricing.auction.processing_fee_bps', value: 290 });
    expect(r.status).toBe(200);
    expect((await q(`SELECT value FROM platform_config WHERE key = 'pricing.auction.processing_fee_bps'`))[0].value).toBe(290);
    const [row] = await audit('pricing.auction.processing_fee_bps');
    expect(row).toMatchObject({ previous_value: 300, new_value: 290, sensitive: true, actor_kind: 'user', actor_user_id: global.__USERS.owner.id });
    expect(row.owner_notified_at).not.toBeNull();
    const to = mail.sendEmail.mock.calls.map((c) => c[0].to).sort();
    expect(to).toEqual(['advantageauction.bid@gmail.com', 'tylerwitt@gmail.com']);
    const m = mail.sendEmail.mock.calls[0][0];
    expect(m.subject).toBe('Advantage.Bid owner notice: Sensitive setting changed: pricing.auction.processing_fee_bps');
    expect(m.text).toMatch(/Previous value: 300/); expect(m.text).toMatch(/New value: 290/); expect(m.text).toMatch(/owner@advantage\.test/);
    expect(m.text).toMatch(/information only/);
    expect(sms.sendSMS).toHaveBeenCalledTimes(1);
    const text = sms.sendSMS.mock.calls[0][0].message;
    expect(text).toMatch(/^Advantage\.Bid: Sensitive setting changed: pricing\.auction\.processing_fee_bps\./);
    expect(text).toMatch(/https:\/\/bid\.advantage\.bid\/admin\//);
    expect(text).not.toMatch(/@|290|300/);   // no account or value data in the text
    expect((m.subject + m.text + m.html + text)).not.toMatch(/[–—]/);
  });
  test('a secret-looking value is masked in the audit row and the notice', async () => {
    const r = await call('PUT', '/api/config/platform', 'owner', { key: 'webhooks.partner_signing_secret', value: 'whsec_' + 'a'.repeat(30) });
    expect(r.status).toBe(200);
    const [row] = await audit('webhooks.partner_signing_secret');
    expect(row.new_value).toBe('[masked]');
    expect(JSON.stringify(mail.sendEmail.mock.calls)).not.toMatch(/whsec_/);
  });
  test('an ordinary key stays open to any admin, is audited, and sends no notice', async () => {
    const r = await call('PUT', '/api/config/platform', 'admin', { key: 'branding.primary_color', value: '#2563eb' });
    expect(r.status).toBe(200);
    const [row] = await audit('branding.primary_color');
    expect(row).toMatchObject({ previous_value: null, new_value: '#2563eb', sensitive: false, actor_user_id: global.__USERS.admin.id });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(sms.sendSMS).not.toHaveBeenCalled();
  });
  test('the owner notice addresses themselves are owner only', async () => {
    expect((await call('PUT', '/api/config/platform', 'admin', { key: 'owner.notify_emails', value: ['attacker@example.com'] })).status).toBe(403);
    expect((await q(`SELECT value FROM platform_config WHERE key = 'owner.notify_emails'`))[0].value).toEqual(['tylerwitt@gmail.com', 'advantageauction.bid@gmail.com']);
  });
  test('the audit trail is readable by admins', async () => {
    const r = await call('GET', '/api/config/platform/audit?key=pricing.auction.processing_fee_bps', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.audit[0]).toMatchObject({ config_key: 'pricing.auction.processing_fee_bps', actor_email: 'owner@advantage.test' });
  });
});

describe('organization overrides cannot shadow platform settings', () => {
  test('PUT /api/config/org refuses a sensitive key', async () => {
    jest.spyOn(require('../src/services/organizationsService'), 'getPrimaryOrgForUser').mockResolvedValue({ id: '00000000-0000-4000-8000-0000000000aa', slug: 'org' });
    const r = await call('PUT', '/api/config/org', 'seller', { key: 'pricing.auction.processing_fee_bps', value: 0 });
    expect(r.status).toBe(403);
    expect(await q(`SELECT 1 FROM organization_config WHERE key = 'pricing.auction.processing_fee_bps'`)).toHaveLength(0);
  });
});

describe('the choke point (configService.setPlatformConfig)', () => {
  test('a sensitive write without any actor is refused', async () => {
    await expect(configService.setPlatformConfig('sasha.enabled', true)).rejects.toMatchObject({ status: 403, code: 'PLATFORM_OWNER_REQUIRED' });
  });
  test('a safety stop is open to any admin but can never turn anything on', async () => {
    await configService.setPlatformConfig('sasha.enabled', false, { actor: global.__USERS.admin, safetyStop: true });
    const [row] = await audit('sasha.enabled');
    expect(row).toMatchObject({ new_value: false, actor_label: 'safety_stop', actor_user_id: global.__USERS.admin.id, sensitive: true });
    expect(mail.sendEmail).toHaveBeenCalled();   // the owner still hears about it
    await expect(configService.setPlatformConfig('sasha.enabled', true, { actor: global.__USERS.admin, safetyStop: true })).rejects.toMatchObject({ code: 'NOT_A_STOP' });
    await configService.setPlatformConfig('marketing.paid.global_kill', true, { actor: global.__USERS.admin, safetyStop: true });
    await expect(configService.setPlatformConfig('marketing.paid.global_kill', false, { actor: global.__USERS.admin, safetyStop: true })).rejects.toMatchObject({ code: 'NOT_A_STOP' });
    await expect(configService.setPlatformConfig('marketing.paid.global_kill', false, { actor: global.__USERS.admin })).rejects.toMatchObject({ status: 403 });
  });
  test('failed notices are recorded and never treated as approval', async () => {
    mail.sendEmail.mockImplementation(async () => { throw new Error('mail down'); });
    sms.sendSMS.mockImplementation(async () => { throw new Error('sms down'); });
    // Notices failing does not let a non-owner through...
    await expect(configService.setPlatformConfig('seller_activation.mode', 'live', { actor: global.__USERS.admin })).rejects.toMatchObject({ status: 403 });
    // ...and an owner change still stands, with the failed notice on its audit row.
    const out = await configService.setPlatformConfig('seller_activation.mode', 'shadow', { actor: global.__USERS.owner });
    expect(out.owner_notice.ok).toBe(false);
    expect(out.owner_notice.email).toMatchObject({ attempted: 2, sent: 0, failed: 2 });
    expect(out.owner_notice.sms).toMatchObject({ sent: 0 });
    const [row] = await audit('seller_activation.mode');
    expect(row.owner_notified_at).toBeNull();
    expect(row.owner_notify_result).toMatchObject({ ok: false });
    expect((await q(`SELECT value FROM platform_config WHERE key = 'seller_activation.mode'`))[0].value).toBe('shadow');
  });
  test('an unchanged value is audited but sends no second notice; a system writer is labelled', async () => {
    await configService.setPlatformConfig('marketing.paid.global_kill', true, { system: 'automatic: paid spend ceiling breach', safetyStop: true });
    expect(mail.sendEmail).not.toHaveBeenCalled();   // already true from the earlier test
    const [row] = await audit('marketing.paid.global_kill');
    expect(row).toMatchObject({ actor_kind: 'system', actor_label: 'automatic: paid spend ceiling breach' });
  });
});

describe('ownerNotifyService', () => {
  test('emails every configured address and texts the owner; no addresses means only the text', async () => {
    const r = await ownerNotify.notify({ subject: 'Test notice', reason: 'Because', adminPath: '/admin/marketing-agency.html' });
    expect(r).toMatchObject({ ok: true, email: { attempted: 2, sent: 2, failed: 0 }, sms: { sent: 1 } });
    expect(sms.sendSMS.mock.calls[0][0].message).toMatch(/\/admin\/marketing-agency\.html/);
  });
});
