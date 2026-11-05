'use strict';

/**
 * Professional Seller welcome email (owner request 2026-11-05; migration 221).
 *
 * Real Postgres (PGlite, in memory) running the REAL migration 221 on minimal users / seller_profiles tables, and the real
 * sellerWelcomeEmailService. The mail transport and the owner alert are stand-ins: nothing is ever sent.
 * The registration route itself is covered end to end in tests/browser/seller-welcome-email.browser.test.js.
 */

const fs = require('fs');
const path = require('path');
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
    const r = await global.__PG.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null && !/^\s*select/i.test(sql) ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}
jest.mock('../src/db', () => mockAdapter());
jest.mock('../src/db/index', () => mockAdapter());
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'msg-1' })), isConfigured: () => true }));
jest.mock('../src/services/ownerAlertService', () => ({ notifyAdminActionRequired: jest.fn(async () => {}), ALERT_TYPES: { SELLER_WELCOME_EMAIL_FAILED: 'seller_welcome_email_failed' } }));

const mail = require('../src/services/emailService');
const alerts = require('../src/services/ownerAlertService');
const svc = require('../src/services/sellerWelcomeEmailService');
const { buildWelcomeEmail, LINKS } = require('../src/services/professionalSellerEmails');

jest.setTimeout(60000);   // the in-memory Postgres starts slowly when many suites run at once
let pg;
const q = async (sql, params) => (await pg.query(sql, params)).rows;
const client = { query: async (sql, params) => { const r = await pg.query(sql, params || []); return { rows: r.rows, rowCount: r.affectedRows }; } };
async function seller(email, { demo = false, name = 'Harbor Estate Sales' } = {}) {
  const u = (await q('INSERT INTO users (email, is_demo) VALUES ($1, $2) RETURNING id', [email, demo]))[0];
  const sp = (await q('INSERT INTO seller_profiles (user_id, display_name) VALUES ($1, $2) RETURNING id', [u.id, name]))[0];
  return { userId: u.id, sellerProfileId: sp.id };
}
// As in the route: queued inside the enrollment transaction.
async function enq(x) { await client.query('BEGIN'); try { const id = await svc.enqueue(client, x); await client.query('COMMIT'); return id; } catch (e) { await client.query('ROLLBACK'); throw e; } }
const row = async (sellerProfileId) => (await q('SELECT * FROM seller_welcome_emails WHERE seller_profile_id = $1', [sellerProfileId]))[0];

beforeAll(async () => {
  pg = startPg(); global.__PG = pg;
  await pg.exec(`CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT, is_demo BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE seller_profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), display_name TEXT, metadata JSONB NOT NULL DEFAULT '{}');`);
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '221_seller_welcome_emails.sql'), 'utf8'));
});
afterAll(async () => { if (pg) await pg.close(); });
beforeEach(() => { mail.sendEmail.mockReset(); mail.sendEmail.mockImplementation(async () => ({ messageId: 'msg-1' })); alerts.notifyAdminActionRequired.mockClear(); });

describe('migration 221', () => {
  test('additive only: one new table, a once-per-seller key, a written reverse', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '221_seller_welcome_emails.sql'), 'utf8');
    expect(sql.replace(/^--.*$/gm, '')).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|ALTER TABLE/i);
    expect(sql).toMatch(/CONSTRAINT uq_seller_welcome_email_once UNIQUE \(seller_profile_id\)/);
    expect(sql).toMatch(/-- Reverse: DROP TABLE IF EXISTS seller_welcome_emails;/);
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prod-migrate-221.js'), 'utf8');
    expect(runner).toMatch(/REFUSE: PRODUCTION endpoint only/);
    expect(runner).toMatch(/--check/); expect(runner).toMatch(/--dry-run/);
  });
});

describe('queueing: once per seller, never for demo accounts or accounts without an email address', () => {
  test('a repeated registration event queues nothing more', async () => {
    const s = await seller('Harbor@Example.com');
    const first = await enq(s);
    expect(first).toBeTruthy();
    expect(await enq(s)).toBeNull();
    expect(await enq(s)).toBeNull();
    expect((await q('SELECT count(*)::int n FROM seller_welcome_emails WHERE seller_profile_id = $1', [s.sellerProfileId]))[0].n).toBe(1);
    expect((await row(s.sellerProfileId)).recipient_email).toBe('harbor@example.com');
  });
  test('demo accounts and accounts without an email address are not queued', async () => {
    expect(await enq(await seller('demo@example.com', { demo: true }))).toBeNull();
    expect(await enq(await seller(null))).toBeNull();
  });
  test('a failure to queue never fails the enrollment transaction (savepoint)', async () => {
    const bad = { query: jest.fn(async (sql) => { if (/INSERT INTO seller_welcome_emails/.test(sql)) throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); return { rows: [] }; }) };
    expect(await svc.enqueue(bad, { sellerProfileId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002' })).toBeNull();
    expect(bad.query.mock.calls.map((c) => c[0])).toEqual(['SAVEPOINT seller_welcome', expect.stringMatching(/INSERT INTO seller_welcome_emails/), 'ROLLBACK TO SAVEPOINT seller_welcome']);
  });
});

describe('delivery', () => {
  test('sent once to the account address with the welcome content; a second attempt sends nothing', async () => {
    const s = await seller('owner@harbor.test');
    const id = await enq(s);
    expect(await svc.deliverNow(id)).toBe('sent');
    expect(await svc.deliverNow(id)).toBe('not_due');
    await svc.tick();   // the background sender never sends this welcome again
    const mine = mail.sendEmail.mock.calls.filter((c) => c[0].to === 'owner@harbor.test');
    expect(mine).toHaveLength(1);
    const m = mine[0][0];
    expect(m.to).toBe('owner@harbor.test');
    expect(m.subject).toBe('Welcome to Advantage.Bid, Harbor Estate Sales');
    const r = await row(s.sellerProfileId);
    expect([r.status, r.attempts, r.provider_message_id]).toEqual(['sent', 1, 'msg-1']);
  });
  test('a temporary failure is retried later with back-off, then sent exactly once', async () => {
    const s = await seller('retry@harbor.test');
    const id = await enq(s);
    mail.sendEmail.mockImplementationOnce(async () => { throw new Error('connection timed out'); });
    expect(await svc.deliverNow(id)).toBe('retry');
    let r = await row(s.sellerProfileId);
    expect([r.status, r.attempts, r.last_error]).toEqual(['pending', 1, 'connection timed out']);
    expect(new Date(r.next_attempt_at) > new Date()).toBe(true);
    expect((await svc.tick()).sent).toBe(0);                     // not due yet: no resend
    await q(`UPDATE seller_welcome_emails SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect((await svc.tick()).sent).toBe(1);
    r = await row(s.sellerProfileId);
    expect([r.status, r.attempts]).toEqual(['sent', 2]);
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);            // one failed attempt, one delivery
  });
  test('after the last attempt the welcome is failed and the owner is alerted once', async () => {
    const s = await seller('down@harbor.test');
    const id = await enq(s);
    mail.sendEmail.mockImplementation(async () => { throw new Error('mail service unavailable'); });
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) {
      await q(`UPDATE seller_welcome_emails SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
      await svc.tick();
    }
    const r = await row(s.sellerProfileId);
    expect([r.status, r.attempts]).toEqual(['failed', svc.MAX_ATTEMPTS]);
    expect(alerts.notifyAdminActionRequired).toHaveBeenCalledTimes(1);
    expect(alerts.notifyAdminActionRequired.mock.calls[0][0]).toMatchObject({ actionType: 'seller_welcome_email_failed', entityId: s.sellerProfileId });
    await q(`UPDATE seller_welcome_emails SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect((await svc.tick()).sent + (await svc.tick()).retry).toBe(0);   // never retried again
  });
  test('an interrupted delivery (stale lease) is picked up again instead of being lost', async () => {
    const s = await seller('crash@harbor.test');
    const id = await enq(s);
    await q(`UPDATE seller_welcome_emails SET status = 'processing', attempts = 1, locked_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    expect((await svc.tick()).sent).toBe(1);
    expect((await row(s.sellerProfileId)).status).toBe('sent');
  });
  test('with no mail service configured nothing is recorded as sent', async () => {
    const s = await seller('local@harbor.test');
    const id = await enq(s);
    mail.sendEmail.mockImplementationOnce(async () => ({ skipped: true }));
    expect(await svc.deliverNow(id)).toBe('skipped');
    expect((await row(s.sellerProfileId)).status).toBe('skipped');
  });
});

describe('content (owner rules)', () => {
  const m = buildWelcomeEmail({ companyName: 'Harbor & Sons <Estate> Sales' });
  const all = m.subject + m.html + m.text;
  test('the primary action is Go To Your Seller Dashboard at the authenticated dashboard; resources link to the demo and the How To Center', () => {
    expect(LINKS).toMatchObject({ dashboard: 'https://bid.advantage.bid/app.html', demo: 'https://bid.advantage.bid/seller-demo', howTo: 'https://bid.advantage.bid/seller-how-to' });
    const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    expect(hrefs.slice(0, 3)).toEqual([LINKS.dashboard, LINKS.demo, LINKS.howTo]);
    expect(m.html).toMatch(/>Go To Your Seller Dashboard</);
    expect(m.text).toContain('Go To Your Seller Dashboard: https://bid.advantage.bid/app.html');
    for (const u of [LINKS.demo, LINKS.howTo]) expect(m.text).toContain(u);
  });
  test('branding, slogan, benefits, website plus marketplace (never website-only)', () => {
    expect(m.html).toContain('src="https://bid.advantage.bid/img/brand/advantage-bid-logo-white.png" alt="Advantage.Bid"');
    expect(all).toMatch(/Get The Advantage\./);
    expect(all).toMatch(/your own branded storefront and your own website, while the same listings reach buyers across the Advantage\.Bid marketplace/);
    expect(all).toMatch(/Smart Catalog Tools/);
    expect(all).not.toMatch(/website[- ]only|only on your (own )?website|instead of the marketplace/i);
  });
  test('never presents checkout, payments or payouts as active, or registration as approval', () => {
    expect(all).not.toMatch(/payout|deposit|get paid|accept (card )?payments|checkout is|buy now|you are approved|approved to sell/i);
    expect(all).toMatch(/verifies your business/);
  });
  test('public language: no AI or vendor names, no long dashes, Title Case button; escapes what the seller typed', () => {
    expect(all).not.toMatch(/\bA\.?I\b|artificial intelligence|machine learning|OpenAI|GPT|Stripe|Amazon|SES\b|Railway/i);
    expect(all).not.toMatch(/[–—]/);
    expect(m.html).toContain('Harbor &amp; Sons &lt;Estate&gt; Sales');
    expect(m.html).not.toContain('<Estate>');
  });
  test('no passwords, tokens or account details; short; readable on a phone', () => {
    expect(all).not.toMatch(/password|token|https?:\/\/[^\s"]*[?&](t|token|code|key)=/i);
    expect(m.text.split(/\s+/).length).toBeLessThan(200);
    expect(m.html).toMatch(/<meta name="viewport" content="width=device-width,initial-scale=1">/);
    expect(m.html).toMatch(/max-width:600px/);
  });
});
