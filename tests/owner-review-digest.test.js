'use strict';

/**
 * Daily owner review digest (owner 2026-11-10; src/services/ownerReviewDigestService.js, migration 228).
 * Real Postgres (PGlite) with the real migration 228 and small stand-ins for the review queues; email and text
 * transports are in-memory stand-ins. Covers: single pending, multiple, multi-day, resolved, none, duplicate run,
 * restart, daylight saving time, email failure, text failure, links (administrator-only), unverified destination,
 * and that no customer data reaches a message.
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

jest.mock('../src/db', () => ({ query: async () => { throw new Error('the digest test passes its own runner'); } }));

jest.setTimeout(60000);   // PGlite starts slowly when the whole suite runs in parallel

const svc = require('../src/services/ownerReviewDigestService');
const htmlAuthGate = require('../src/middleware/htmlAuthGate');

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}

let pg; let runner;
const OWNER_PHONE = '+15550001111';      // test numbers only
const OTHER_PHONE = '+15550002222';
const ENV = { NODE_ENV: 'production', APP_BASE_URL: 'https://bid.advantage.bid', OWNER_ALERT_PHONE_E164S: `${OWNER_PHONE},${OTHER_PHONE}` };
// 2026-11-12 is Eastern Standard Time (UTC-5): 9:00 AM New York = 14:00 UTC
const at = (iso) => new Date(iso);
const NOV12_0900 = at('2026-11-12T14:00:00Z');

function transports({ failEmail = new Set(), failSms = false } = {}) {
  const sent = { email: [], sms: [] };
  return {
    sent,
    mail: { sendEmail: async (m) => { if (failEmail.has(m.to)) throw new Error('mailbox unavailable'); sent.email.push(m); return { messageId: 'm' + sent.email.length }; } },
    sms: { sendSMS: async (m) => { if (failSms) throw new Error('carrier unavailable'); sent.sms.push(m); return { sid: 'SM' + sent.sms.length }; } },
  };
}
const tick = (t, now, extra = {}) => svc.runDigestTick({ runner, env: ENV, now, mail: t.mail, sms: t.sms, ...extra });
const one = async (sql, p) => (await runner.query(sql, p)).rows[0];

beforeAll(async () => {
  pg = startPg();
  runner = { query: async (sql, params) => { const r = await pg.query(sql, params || []); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }; } };
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, is_platform_owner boolean, is_active boolean DEFAULT true,
      phone_verified_e164 text, phone_verified_at timestamptz);
    CREATE TABLE platform_config (key text PRIMARY KEY, value jsonb);
    CREATE TABLE cs_conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_email text, handoff_state text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, seller_type text, display_name text,
      verification_required_before_publication boolean DEFAULT false, is_demo boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now());
    CREATE TABLE verification_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, status text, business_name text, ein_last4 text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE verification_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid, category text);
    CREATE TABLE payment_disputes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, opened_at timestamptz, closed_at timestamptz, created_at timestamptz DEFAULT now());
    CREATE TABLE marketplace_order_issues (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, buyer_message text, created_at timestamptz DEFAULT now());
  `);
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '228_owner_review_digest.sql'), 'utf8'));
});
afterAll(async () => { if (pg) await pg.close(); });

beforeEach(async () => {
  await pg.exec(`DELETE FROM owner_digest_deliveries; DELETE FROM owner_digest_runs; DELETE FROM cs_conversations; DELETE FROM verification_documents; DELETE FROM verification_requests; DELETE FROM seller_profiles;
    DELETE FROM payment_disputes; DELETE FROM marketplace_order_issues; DELETE FROM users; DELETE FROM platform_config;`);
  await runner.query(`INSERT INTO platform_config (key, value) VALUES ('owner.notify_emails', $1::jsonb)`, [JSON.stringify(['owner@example.test', 'inbox@example.test'])]);
  await runner.query(`INSERT INTO users (email, is_platform_owner, phone_verified_e164, phone_verified_at) VALUES ('owner@example.test', true, $1, now())`, [OWNER_PHONE]);
});

describe('schedule (America/New_York, daylight saving time aware)', () => {
  test('9:00 AM New York is 14:00 UTC in standard time and 13:00 UTC in daylight time', () => {
    expect(svc.isDue(at('2026-11-12T13:59:00Z'))).toBe(false);   // 8:59 AM EST
    expect(svc.isDue(at('2026-11-12T14:00:00Z'))).toBe(true);    // 9:00 AM EST
    expect(svc.isDue(at('2026-07-15T12:59:00Z'))).toBe(false);   // 8:59 AM EDT
    expect(svc.isDue(at('2026-07-15T13:00:00Z'))).toBe(true);    // 9:00 AM EDT
    expect(svc.isDue(at('2026-07-15T14:00:00Z'))).toBe(true);    // 10:00 AM EDT (a later step the same day still runs, once)
  });
  test('the days clocks change: 2026-03-08 (spring forward) and 2026-11-01 (fall back)', () => {
    expect(svc.isDue(at('2026-03-08T12:59:00Z'))).toBe(false);   // 8:59 AM EDT
    expect(svc.isDue(at('2026-03-08T13:00:00Z'))).toBe(true);    // 9:00 AM EDT
    expect(svc.isDue(at('2026-11-01T13:59:00Z'))).toBe(false);   // 8:59 AM EST
    expect(svc.isDue(at('2026-11-01T14:00:00Z'))).toBe(true);    // 9:00 AM EST
    expect(svc.nyDate(at('2026-11-02T03:30:00Z'))).toBe('2026-11-01');   // late evening New York is still the earlier day
  });
  test('no catch-up late at night; production only unless enabled; can be switched off', () => {
    expect(svc.isDue(at('2026-11-13T02:00:00Z'))).toBe(false);   // 9:00 PM EST
    expect(svc.enabled({ NODE_ENV: 'production' })).toBe(true);
    expect(svc.enabled({ NODE_ENV: 'development' })).toBe(false);
    expect(svc.enabled({ NODE_ENV: 'development', OWNER_DIGEST_ENABLED: 'true' })).toBe(true);
    expect(svc.enabled({ NODE_ENV: 'production', OWNER_DIGEST_DISABLED: 'true' })).toBe(false);
  });
  test('before 9:00 AM nothing is created or sent; disabled sends nothing', async () => {
    const t = transports();
    expect(await tick(t, at('2026-11-12T13:30:00Z'))).toMatchObject({ ran: false, reason: 'not_due' });
    expect(await svc.runDigestTick({ runner, env: { NODE_ENV: 'production', OWNER_DIGEST_DISABLED: 'true' }, now: NOV12_0900, mail: t.mail, sms: t.sms })).toMatchObject({ reason: 'disabled' });
    expect((await one('SELECT count(*)::int n FROM owner_digest_runs')).n).toBe(0);
    expect(t.sent.email.length + t.sent.sms.length).toBe(0);
  });
});

describe('content', () => {
  test('none pending: nothing is sent, and the day is recorded as nothing_pending', async () => {
    const t = transports();
    expect(await tick(t, NOV12_0900)).toMatchObject({ ran: true, status: 'nothing_pending' });
    expect(t.sent.email.length + t.sent.sms.length).toBe(0);
    expect(await one('SELECT status, task_count FROM owner_digest_runs')).toEqual({ status: 'nothing_pending', task_count: 0 });
    // and a later step that day does not change its mind
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    expect(await tick(t, at('2026-11-12T15:00:00Z'))).toMatchObject({ ran: false, reason: 'already_handled_or_in_progress' });
    expect(t.sent.email.length).toBe(0);
  });

  test('single pending task: one email per owner address, one text to the verified owner phone', async () => {
    await runner.query(`INSERT INTO verification_requests (status, created_at, updated_at) VALUES ('submitted', $1, $1)`, [at('2026-11-11T16:00:00Z')]);
    const t = transports();
    expect(await tick(t, NOV12_0900)).toMatchObject({ ran: true, status: 'complete', sent: 3, total: 1 });
    expect(t.sent.email.map((m) => m.to).sort()).toEqual(['inbox@example.test', 'owner@example.test']);
    expect(t.sent.sms.map((m) => m.to)).toEqual([OWNER_PHONE]);
    const m = t.sent.email[0];
    expect(m.subject).toBe('Advantage.Bid daily review: 1 task waiting');
    expect(m.text).toMatch(/Business verifications submitted: 1 \(High, oldest waiting less than 1 day\)/);
    expect(m.text).toMatch(/Open: https:\/\/bid\.advantage\.bid\/admin\/verification\.html/);
    expect(t.sent.sms[0].message).toMatch(/^Advantage\.Bid daily review: 1 waiting\. Business verifications submitted 1\./);
    expect(t.sent.sms[0].message.length).toBeLessThanOrEqual(320);
    const deliveries = (await runner.query(`SELECT channel, status, attempts FROM owner_digest_deliveries ORDER BY channel`)).rows;
    expect(deliveries).toEqual([{ channel: 'email', status: 'sent', attempts: 1 }, { channel: 'email', status: 'sent', attempts: 1 }, { channel: 'sms', status: 'sent', attempts: 1 }]);
  });

  test('multiple tasks across queues: grouped, most urgent first, age and urgency per task; queues that cannot be read are named', async () => {
    await runner.query(`INSERT INTO payment_disputes (status, opened_at) VALUES ('needs_response', $1)`, [at('2026-11-11T14:00:00Z')]);
    await runner.query(`INSERT INTO marketplace_order_issues (status, created_at) VALUES ('open', $1), ('seller_responded', $2), ('resolved', $2)`, [at('2026-11-09T12:00:00Z'), at('2026-11-12T10:00:00Z')]);
    await runner.query(`INSERT INTO cs_conversations (handoff_state, updated_at) VALUES ('needed', $1), ('resolved', $1)`, [at('2026-11-12T12:00:00Z')]);
    const t = transports();
    await tick(t, NOV12_0900);
    const text = t.sent.email[0].text;
    expect(t.sent.email[0].subject).toBe('Advantage.Bid daily review: 4 tasks waiting (2 urgent)');
    const order = ['Storefront order issues', 'Card disputes', 'Customers waiting for a person']   // urgent first, oldest first within urgency
      .map((l) => text.indexOf(l));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toMatch(/Storefront order issues: 2 \(Urgent, oldest waiting 3 days\)/);   // high + 3 days waiting = urgent
    expect(text).toMatch(/waiting 3 days, Urgent/);
    expect(text).toMatch(/waiting less than 1 day, High/);
    expect(text).toMatch(/Not checked today \(could not be read\):/);                      // queues absent from this test schema
    expect(t.sent.email[0].html).toMatch(/Open in Admin/);
  });

  test('multi-day: a task still waiting is reported again the next day, older and more urgent', async () => {
    await runner.query(`INSERT INTO verification_requests (status, created_at, updated_at) VALUES ('submitted', $1, $1)`, [at('2026-11-11T16:00:00Z')]);
    const t = transports();
    await tick(t, NOV12_0900);
    await tick(t, at('2026-11-13T14:00:00Z'));
    await tick(t, at('2026-11-14T14:05:00Z'));
    expect((await runner.query(`SELECT run_date::text d, status FROM owner_digest_runs ORDER BY 1`)).rows).toEqual([
      { d: '2026-11-12', status: 'complete' }, { d: '2026-11-13', status: 'complete' }, { d: '2026-11-14', status: 'complete' }]);
    expect(t.sent.email.length).toBe(6);
    expect(t.sent.email[2].text).toMatch(/waiting 1 day, High/);
    expect(t.sent.email[4].text).toMatch(/waiting 2 days, Urgent/);
  });

  test('resolved: once the task is handled, the next day sends nothing', async () => {
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const t = transports();
    await tick(t, NOV12_0900);
    await runner.query(`UPDATE verification_requests SET status = 'approved'`);
    expect(await tick(t, at('2026-11-13T14:00:00Z'))).toMatchObject({ status: 'nothing_pending' });
    expect(t.sent.email.length).toBe(2);
  });

  test('no customer data in any message or record: no names, addresses, numbers, documents or message text', async () => {
    await runner.query(`INSERT INTO verification_requests (status, business_name, ein_last4) VALUES ('submitted', 'Acme Estate Sales', '6789')`);
    await runner.query(`INSERT INTO cs_conversations (handoff_state, customer_email) VALUES ('needed', 'buyer.private@example.test')`);
    await runner.query(`INSERT INTO marketplace_order_issues (status, buyer_message) VALUES ('open', 'My address is 12 Elm St, call 555-123-9876')`);
    const t = transports();
    await tick(t, NOV12_0900);
    const run = await one(`SELECT summary::text s, destinations::text d, email_text, email_html, sms_text FROM owner_digest_runs`);
    const deliveries = JSON.stringify((await runner.query(`SELECT * FROM owner_digest_deliveries`)).rows);
    const all = [run.s, run.d, run.email_text, run.email_html, run.sms_text, deliveries, ...t.sent.email.map((m) => m.text + m.html), ...t.sent.sms.map((m) => m.message)].join('\n');
    for (const secret of ['Acme', '6789', 'buyer.private', '12 Elm', '555-123-9876', OWNER_PHONE, OTHER_PHONE, 'owner@example.test', 'inbox@example.test']) {
      expect(all.includes(secret)).toBe(false);
    }
    expect(all).not.toMatch(/[–—]/);   // no long dashes
  });
});

describe('links', () => {
  test('every link is an Advantage.Bid admin page, and admin pages require an administrator sign-in', async () => {
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    await runner.query(`INSERT INTO cs_conversations (handoff_state) VALUES ('needed')`);
    const t = transports();
    await tick(t, NOV12_0900);
    const urls = [t.sent.email[0].text, t.sent.email[0].html, t.sent.sms[0].message].join(' ').match(/https?:\/\/[^\s"<>]+/g);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u.startsWith('https://bid.advantage.bid/admin/')).toBe(true);
      const req = htmlAuthGate.requirement(new URL(u).pathname);
      expect(req).toEqual(['admin']);   // a buyer or seller is refused; the gate redirects a signed-out visitor to sign in
    }
    for (const c of svc.CATEGORIES) expect(c.path.startsWith('/admin/')).toBe(true);
  });
});

describe('delivery safety', () => {
  test('duplicate run: steps later the same day, and two processes at once, never send twice', async () => {
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const t = transports();
    const [a, b] = await Promise.all([tick(t, NOV12_0900), tick(t, NOV12_0900)]);
    expect([a.ran, b.ran].filter(Boolean).length).toBe(1);
    await tick(t, at('2026-11-12T14:01:00Z'));
    await tick(t, at('2026-11-12T18:00:00Z'));
    expect(t.sent.email.length).toBe(2);
    expect(t.sent.sms.length).toBe(1);
    expect((await one('SELECT count(*)::int n FROM owner_digest_runs')).n).toBe(1);
  });

  test('restart mid-run: a process that stopped after some sends is resumed, sending only what was not sent, with the same content', async () => {
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const t1 = transports({ failEmail: new Set(['inbox@example.test']), failSms: true });
    await tick(t1, NOV12_0900);
    const stored = await one(`SELECT email_text, sms_text FROM owner_digest_runs`);
    // a crashed process: lease still held, work unfinished
    await runner.query(`UPDATE owner_digest_runs SET status = 'sending', lease_until = $1`, [at('2026-11-12T14:20:00Z')]);
    // a new task appears; the resumed run still sends the digest as composed
    await runner.query(`INSERT INTO payment_disputes (status, opened_at) VALUES ('needs_response', now())`);
    const t2 = transports();
    expect(await tick(t2, at('2026-11-12T14:15:00Z'))).toMatchObject({ ran: false });   // lease still held by the stopped process
    expect(await tick(t2, at('2026-11-12T14:25:00Z'))).toMatchObject({ ran: true, status: 'complete' });
    expect(t2.sent.email.map((m) => m.to)).toEqual(['inbox@example.test']);              // the owner address was already sent
    expect(t2.sent.sms.length).toBe(1);
    expect(t2.sent.email[0].text).toBe(stored.email_text);
    expect(t2.sent.sms[0].message).toBe(stored.sms_text);
  });

  test('email failure: retried after 10 minutes, at most 3 attempts; the text and the other address are unaffected', async () => {
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const t = transports({ failEmail: new Set(['inbox@example.test']) });
    expect(await tick(t, NOV12_0900)).toMatchObject({ status: 'sending', sent: 2, open: 1 });
    await tick(t, at('2026-11-12T14:05:00Z'));   // too soon to retry
    expect((await one(`SELECT attempts FROM owner_digest_deliveries WHERE status = 'failed'`)).attempts).toBe(1);
    await tick(t, at('2026-11-12T14:11:00Z'));
    expect(await tick(t, at('2026-11-12T14:22:00Z'))).toMatchObject({ status: 'partial', sent: 2, open: 0 });
    const failed = await one(`SELECT attempts, last_error, recipient_hint FROM owner_digest_deliveries WHERE status = 'failed'`);
    expect(failed).toEqual({ attempts: 3, last_error: 'mailbox unavailable', recipient_hint: 'in***@example.test' });
    expect(await tick(t, at('2026-11-12T15:00:00Z'))).toMatchObject({ ran: false });   // finished for the day
    expect(t.sent.email.map((m) => m.to)).toEqual(['owner@example.test']);
    expect(t.sent.sms.length).toBe(1);
  });

  test('a transient email failure recovers on retry', async () => {
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const fail = new Set(['inbox@example.test']);
    const t = transports({ failEmail: fail });
    await tick(t, NOV12_0900);
    fail.clear();
    expect(await tick(t, at('2026-11-12T14:10:00Z'))).toMatchObject({ status: 'complete', sent: 3 });
  });

  test('text failure: retried, never blocks the email, and recorded when it gives up', async () => {
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const t = transports({ failSms: true });
    await tick(t, NOV12_0900); await tick(t, at('2026-11-12T14:10:00Z')); await tick(t, at('2026-11-12T14:20:00Z'));
    expect(t.sent.email.length).toBe(2);
    expect(await one(`SELECT status, attempts, last_error FROM owner_digest_deliveries WHERE channel = 'sms'`)).toEqual({ status: 'failed', attempts: 3, last_error: 'carrier unavailable' });
    expect((await one(`SELECT status FROM owner_digest_runs`)).status).toBe('partial');
  });

  test('every delivery failing is recorded as failed, never as sent', async () => {
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const t = transports({ failEmail: new Set(['owner@example.test', 'inbox@example.test']), failSms: true });
    for (const m of ['14:00', '14:10', '14:20']) await tick(t, at(`2026-11-12T${m}:00Z`));
    expect((await one(`SELECT status FROM owner_digest_runs`)).status).toBe('failed');
  });
});

describe('destinations', () => {
  test('an alert number that is not the platform owner\'s verified phone is never texted, and is reported masked', async () => {
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const t = transports();
    await tick(t, NOV12_0900);
    expect(t.sent.sms.map((m) => m.to)).toEqual([OWNER_PHONE]);
    const dest = JSON.parse((await one(`SELECT destinations::text d FROM owner_digest_runs`)).d);
    expect(dest).toMatchObject({ sms: ['phone ending 1111'], sms_not_verified: ['phone ending 2222'], email: ['ow***@example.test', 'in***@example.test'] });
    expect(t.sent.email[0].text).toMatch(/Not texted \(not a verified owner phone\): phone ending 2222\./);
  });

  test('no verified owner phone: no text is sent, and the email says why', async () => {
    await runner.query(`UPDATE users SET phone_verified_at = NULL`);
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const t = transports();
    expect(await tick(t, NOV12_0900)).toMatchObject({ status: 'complete', sent: 2 });
    expect(t.sent.sms.length).toBe(0);
    expect(t.sent.email[0].text).toMatch(/Text summary: not sent\. No configured owner alert number matches the platform owner's verified phone/);
  });

  test('a verified phone that is not a configured owner alert number is not texted either (configuration and verification both required)', async () => {
    await runner.query(`UPDATE users SET phone_verified_e164 = '+15550003333'`);
    const d = await svc.resolveDestinations({ runner, env: ENV });
    expect(d.sms).toEqual([]);
    expect(svc.publicDestinations(d).sms_not_verified).toEqual(['phone ending 1111', 'phone ending 2222']);
  });

  test('no email address and no phone configured: reported, and the day is recorded as failed', async () => {
    await runner.query(`UPDATE platform_config SET value = '[]'::jsonb`);
    await runner.query(`INSERT INTO verification_requests (status) VALUES ('submitted')`);
    const t = transports();
    const r = await svc.runDigestTick({ runner, env: { NODE_ENV: 'production' }, now: NOV12_0900, mail: t.mail, sms: t.sms });
    expect(r).toMatchObject({ status: 'failed' });
    const dest = JSON.parse((await one(`SELECT destinations::text d FROM owner_digest_runs`)).d);
    expect(dest.email_problem).toMatch(/No owner notice email address is configured/);
    expect(dest.sms_problem).toMatch(/No owner alert phone number is configured/);
  });
});

// ── Seller business verification (owner 2026-11-11: Timeless Treasures, a Professional Seller with no verification
//    request, was missing from the report because only SUBMITTED requests were counted) ─────────────────────────────
describe('sellers awaiting business verification', () => {
  const REG = at('2026-11-10T19:25:30Z');
  async function seller({ name = 'Timeless Treasures', type = 'auction_house', required = true, demo = false, active = true, registered = REG } = {}) {
    const u = await one(`INSERT INTO users (email, is_active) VALUES ($1, $2) RETURNING id`, [`${Math.random().toString(36).slice(2)}@example.test`, active]);
    return (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, verification_required_before_publication, is_demo, created_at)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [u.id, type, name, required, demo, registered])).id;
  }
  const request = async (sp, status, { docs = 0, when = at('2026-11-11T12:00:00Z') } = {}) => {
    const r = await one(`INSERT INTO verification_requests (seller_profile_id, status, created_at, updated_at) VALUES ($1,$2,$3,$3) RETURNING id`, [sp, status, when]);
    for (let i = 0; i < docs; i += 1) await runner.query(`INSERT INTO verification_documents (request_id, category) VALUES ($1, $2)`, [r.id, 'doc' + i]);
    return r.id;
  };
  const verificationCategory = async (now = NOV12_0900) => (await svc.collectTasks({ runner, now })).categories.find((c) => c.key === 'seller_verification');

  test('a Professional Seller with NO verification request appears (the reported omission), with name, date, status, need and link', async () => {
    const sp = await seller();
    const t = transports();
    expect(await tick(t, NOV12_0900)).toMatchObject({ ran: true, status: 'complete', total: 1 });   // no longer "nothing pending"
    const m = t.sent.email[0];
    expect(m.text).toMatch(/Sellers awaiting business verification: 1/);
    expect(m.text).toContain('- Timeless Treasures: Awaiting Seller Action (Normal). Registered 2026-11-10; waiting 1 day.');
    expect(m.text).toContain('Needed: Verification not started: no request and no documents yet.');
    expect(m.text).toContain(`Open: https://bid.advantage.bid/admin/verification.html?seller=${sp}`);
    expect(m.html).toContain('<b>Timeless Treasures</b>: Awaiting Seller Action');
    expect(m.html).toContain(`href="https://bid.advantage.bid/admin/verification.html?seller=${sp}"`);
    // The text message stays counts only: no business name.
    expect(t.sent.sms[0].message).toMatch(/Sellers awaiting business verification 1/);
    expect(t.sent.sms[0].message).not.toContain('Timeless');
  });

  test.each([
    ['open, nothing uploaded', 'open', 0, 'Awaiting Seller Action', 'Documents requested; none uploaded yet'],
    ['open, some uploaded', 'open', 2, 'Awaiting Seller Action', 'Documents requested; 2 uploaded so far, not yet submitted'],
    ['more information requested', 'more_info', 1, 'Awaiting Seller Action', 'Additional information requested from the seller'],
    ['submitted for review', 'submitted', 3, 'Awaiting Admin Review', 'Documents submitted (3); an administrator decision is needed'],
    ['rejected', 'rejected', 1, 'Verification Blocked', 'Verification was rejected'],
    ['cancelled', 'cancelled', 0, 'Verification Blocked', 'cancelled without approval'],
  ])('%s', async (_n, status, docs, label, need) => {
    const sp = await seller();
    await request(sp, status, { docs });
    const c = await verificationCategory();
    expect(c.count).toBe(1);
    expect(c.tasks[0].detail).toMatchObject({ name: 'Timeless Treasures', status: label, registered: '2026-11-10' });
    expect(c.tasks[0].detail.missing).toContain(need);
    expect(c.tasks[0].link).toBe(`https://bid.advantage.bid/admin/verification.html?seller=${sp}`);
  });

  test('a submitted request is listed once, under the seller (not again as a bare submission)', async () => {
    await request(await seller(), 'submitted', { docs: 1 });
    const r = await svc.collectTasks({ runner, now: NOV12_0900 });
    expect(r.total).toBe(1);
    expect(r.categories.map((c) => c.key)).toEqual(['seller_verification']);
    expect(r.categories[0].tasks[0].urgency).toBe('high');   // an administrator decision is waiting
  });

  test('the most recent request decides: a later submission after a rejection is Awaiting Admin Review', async () => {
    const sp = await seller();
    await request(sp, 'rejected', { when: at('2026-11-10T20:00:00Z') });
    await request(sp, 'submitted', { when: at('2026-11-11T20:00:00Z') });
    expect((await verificationCategory()).tasks[0].detail.status).toBe('Awaiting Admin Review');
  });

  test('approved sellers, sellers not required to verify, demo accounts and closed accounts never appear', async () => {
    const ok = await seller({ name: 'Approved Co' });
    await request(ok, 'rejected', { when: at('2026-11-01T00:00:00Z') });
    await request(ok, 'approved', { when: at('2026-11-05T00:00:00Z') });   // approved at any point = verified (same as the sale gate)
    await seller({ name: 'Lewis & Maese', type: 'professional_liquidator', required: false });   // grandfathered
    await seller({ name: 'Demo Estate', type: 'estate_sale_company', demo: true });
    await seller({ name: 'Closed Co', active: false });
    expect(await verificationCategory()).toBeUndefined();
  });

  test('a seller stays in the report every day until approved, then drops out', async () => {
    const sp = await seller();
    expect((await verificationCategory()).count).toBe(1);
    const later = await verificationCategory(at('2026-11-15T14:00:00Z'));
    expect(later.tasks[0]).toMatchObject({ age_days: 4, urgency: 'high' });   // waiting on the seller 3+ days rises to High
    await request(sp, 'approved');
    expect(await verificationCategory()).toBeUndefined();
  });

  test('a seller that is not a Professional Seller is described by type only, never by name', async () => {
    await seller({ name: 'Jane Private', type: 'private' });
    const c = await verificationCategory();
    expect(c.tasks[0].detail.name).toBe('Seller (private)');
    expect(JSON.stringify(c)).not.toContain('Jane');
  });

  test('state mapping is complete and an unknown status is flagged, never hidden', () => {
    expect(svc.verificationState(null, 0).state).toBe('seller_action');
    expect(svc.verificationState('submitted', 1).state).toBe('admin_review');
    expect(svc.verificationState('something_new', 0)).toMatchObject({ state: 'blocked' });
    expect(Object.values(svc.VERIFICATION_STATES).map((s) => s.label)).toEqual(['Awaiting Seller Action', 'Awaiting Admin Review', 'Verification Blocked']);
  });

  test('the report rule matches the sale gate (verificationService.publicationGate: required flag + an approved request)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'verificationService.js'), 'utf8');
    expect(src).toMatch(/SELECT verification_required_before_publication FROM seller_profiles/);
    expect(src).toMatch(/status='approved'/);
  });
});
