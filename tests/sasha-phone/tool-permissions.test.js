'use strict';

/**
 * Sasha tool permissions (owner directive 2026-10-14): Sasha keeps her receptionist actions (verification, permitted
 * texts, secure payment links to existing invoices, seller pickup requests, callbacks, verified look-ups) but has NO
 * administrative or transactional authority. Enforced server-side by toolGuard, not by instructions:
 *   - the complete tool list is pinned (a new tool fails here until it is reviewed);
 *   - each tool may write only its customer-service tables; every other write and all DDL are refused before reaching
 *     the database, including through services and pooled clients;
 *   - payment-processor requests from inside a tool are refused.
 * Real Postgres (PGlite); no network; no model calls.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
jest.mock('../../src/db', () => require('./pgHarness').dbAdapter(() => global.__PG));
jest.setTimeout(60000);

const { createDb } = require('./pgHarness');
const db = require('../../src/db');
const tools = require('../../src/services/sasha/tools');
const phoneTools = require('../../src/services/sasha/phone/phoneTools');
const guard = require('../../src/services/sasha/toolGuard');
const sim = require('../../src/services/sasha/phone/phoneSimulator');

const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
let ADMIN; let BUYER; let INVOICE; let AUCTION;

beforeAll(async () => {
  global.__PG = await createDb();
  ADMIN = (await q(`INSERT INTO users (email, role, full_name) VALUES ('perm-admin@example.org','admin','Perm Admin') RETURNING id`))[0].id;
  BUYER = (await q(`INSERT INTO users (email, role, full_name) VALUES ('perm-buyer@example.org','buyer','Perm Buyer') RETURNING id`))[0].id;
  AUCTION = (await q(`INSERT INTO auctions (title, state) VALUES ('Perm Sale','closed') RETURNING id`))[0].id;
  INVOICE = (await q(`INSERT INTO buyer_auction_invoices (invoice_number, buyer_user_id, auction_id, status, total_cents) VALUES ('PERM-1',$1,$2,'payment_required',18510) RETURNING id`, [BUYER, AUCTION]))[0].id;
});
afterAll(async () => { for (const id of [...sim.SIMS.keys()]) await sim.end(id, ADMIN).catch(() => {}); await global.__PG.close(); });

// The approved receptionist tool set (owner directive 2026-10-14). Changing it requires a review of this file.
const APPROVED_TOOLS = [
  'search_help_center', 'get_platform_rules', 'get_auction_or_lot', 'request_human',
  'get_my_account', 'get_my_bids', 'get_my_invoices', 'get_my_pickup_details', 'get_my_orders', 'get_my_auctions', 'get_my_settlements',
  'get_my_seller_terms', 'get_my_storefront_orders',
  'start_account_verification', 'request_callback', 'find_auction',
  'send_text', 'send_payment_link', 'get_my_seller_onboarding', 'get_my_business_verification', 'get_my_agreements',
  'get_my_auction_registration', 'get_my_pickup_slots', 'get_my_order_detail', 'contact_seller_about_pickup',
].sort();

// Business records Sasha must never change (terms, policies, agreements, fees, rules, listings, bids, invoices, payments,
// orders, refunds, payouts, accounts, permissions, configuration, guidance).
const PROTECTED = ['terms_versions', 'terms_acceptances', 'agreements', 'agreement_templates', 'agreement_template_versions', 'platform_config',
  'professional_pricing_agreements', 'seller_profiles', 'seller_terms', 'founding_partners', 'auctions', 'lots', 'bids', 'auction_buyers',
  'buyer_auction_invoices', 'payments', 'card_verifications', 'marketplace_orders', 'marketplace_items', 'refunds', 'seller_payouts',
  'seller_settlements', 'settlements', 'payout_profiles', 'users', 'staff_roles', 'user_roles', 'verification_requests', 'cs_kb_articles',
  'watchlists', 'audit_log', 'account_phone_verifications'];

describe('the tool surface is exactly the approved receptionist set', () => {
  test('every tool Sasha can be offered, in every channel and state, is approved and has a write allowlist', () => {
    const ctxs = [{ channel: 'chat' }, { channel: 'chat', userId: 'u' }, { channel: 'email' }, { channel: 'phone', phone: {} },
      { channel: 'phone', userId: 'u', phone: { textingAvailable: false } }, { channel: 'phone', userId: 'u', phone: { textingAvailable: true } }];
    const offered = new Set(['request_human']);
    for (const c of ctxs) for (const t of tools.toolsFor(c)) offered.add(t.name);
    expect([...offered].sort()).toEqual(APPROVED_TOOLS);
    expect(Object.keys(guard.TOOL_WRITES).sort()).toEqual(APPROVED_TOOLS);
  });
  test('no tool may write any protected business record; read tools write nothing but the disclosure audit', () => {
    for (const [tool, tables] of Object.entries(guard.TOOL_WRITES)) {
      for (const t of tables) expect([tool, PROTECTED.includes(t)]).toEqual([tool, false]);
      if (/^(get_|search_|find_)/.test(tool)) expect(tables.filter((t) => t !== 'cs_phone_audit')).toEqual([]);
    }
  });
  test('an unknown tool name (e.g. a model asking for "update_invoice") does nothing', async () => {
    for (const name of ['update_invoice', 'issue_refund', 'edit_terms', 'set_fee', 'cancel_bid']) {
      expect(await tools.run(name, { invoice_number: 'PERM-1', total: 0 }, { channel: 'phone', userId: BUYER, phone: { call: { id: null } } })).toEqual({ error: 'unknown tool' });
    }
  });
});

describe('server-side enforcement inside a tool', () => {
  const inTool = (tool, fn) => guard.run(tool, fn);
  test.each([
    ['UPDATE buyer_auction_invoices SET total_cents = 0 WHERE invoice_number = \'PERM-1\''],
    ['update buyer_auction_invoices set status = \'paid\''],
    ['WITH x AS (UPDATE buyer_auction_invoices SET total_cents = 1 RETURNING id) SELECT * FROM x'],
    ['DELETE FROM bids'],
    ['INSERT INTO platform_config (key, value) VALUES (\'pricing.processing_fee_bps\', \'0\'::jsonb)'],
    ['UPDATE users SET role = \'admin\''],
    ['UPDATE public.terms_versions SET is_current = false'],
    ['UPDATE lots SET current_bid_cents = 1'],
    ['ALTER TABLE buyer_auction_invoices DROP COLUMN total_cents'],
    ['TRUNCATE audit_log'],
    ['GRANT ALL ON users TO public'],
    ['SELECT 1; DROP TABLE users'],
  ])('refused, and the database is unchanged: %s', async (sql) => {
    const before = await q(`SELECT total_cents, status FROM buyer_auction_invoices WHERE id = $1`, [INVOICE]);
    for (const tool of ['send_payment_link', 'request_callback', 'contact_seller_about_pickup', 'get_my_invoices']) {
      await expect(inTool(tool, () => db.query(sql))).rejects.toBeInstanceOf(guard.SashaToolPermissionError);
    }
    expect(await q(`SELECT total_cents, status FROM buyer_auction_invoices WHERE id = $1`, [INVOICE])).toEqual(before);
    expect((await q(`SELECT count(*)::int n FROM users`))[0].n).toBeGreaterThan(0);
  });
  test('pooled clients are guarded too', async () => {
    await expect(inTool('send_payment_link', async () => { const c = await db.connect(); try { await c.query('UPDATE buyer_auction_invoices SET total_cents = 0'); } finally { if (c.release) c.release(); } }))
      .rejects.toBeInstanceOf(guard.SashaToolPermissionError);
  });
  test('reads, row locks and the tool\'s own customer-service writes are allowed', async () => {
    await expect(inTool('get_my_invoices', () => db.query('SELECT id FROM buyer_auction_invoices WHERE buyer_user_id = $1 FOR UPDATE', [BUYER]))).resolves.toBeTruthy();
    expect(guard.writesOf(`INSERT INTO payment_links (x) VALUES (1) ON CONFLICT (x) DO UPDATE SET x = 2`).tables).toEqual(['payment_links']);
    expect(guard.writesOf(`SELECT created_at, cluster, copy_text FROM t`)).toEqual({ tables: [], ddl: false });
  });
  test('outside a Sasha tool nothing changes for the rest of the platform', async () => {
    await db.query(`UPDATE buyer_auction_invoices SET status = status WHERE id = $1`, [INVOICE]);
    expect(() => guard.checkSql('UPDATE lots SET state = state')).not.toThrow();
    expect(() => guard.checkHost('api.stripe.com')).not.toThrow();
  });
  test('the payment processor cannot be reached from inside a tool (https and fetch)', async () => {
    await expect(inTool('send_payment_link', async () => require('https').request({ hostname: 'api.stripe.com', path: '/v1/refunds', method: 'POST' })))
      .rejects.toBeInstanceOf(guard.SashaToolPermissionError);
    await expect(inTool('send_payment_link', () => fetch('https://api.stripe.com/v1/prices/price_x', { method: 'POST' })))
      .rejects.toBeInstanceOf(guard.SashaToolPermissionError);
    await expect(inTool('request_callback', () => fetch('https://files.stripe.com/v1/files'))).rejects.toBeInstanceOf(guard.SashaToolPermissionError);
  });
  test('a refused write inside a real tool becomes a tool error, never a crash, and nothing is written', async () => {
    const real = phoneTools._internal.findAuction;
    const out = await guard.run('find_auction', async () => { try { await db.query('UPDATE auctions SET title = \'x\''); return { ok: true }; } catch (e) { return { error: e.code }; } });
    expect(out).toEqual({ error: 'SASHA_TOOL_FORBIDDEN' });
    expect((await q(`SELECT title FROM auctions WHERE id = $1`, [AUCTION]))[0].title).toBe('Perm Sale');
    expect(typeof real).toBe('function');
  });
});

describe('approved receptionist actions keep working under the guard', () => {
  test('a secure payment link to an EXISTING invoice is issued and logged; the invoice amount is untouched', async () => {
    const s = await sim.start({ actorId: ADMIN }, {});
    const call = (await q(`SELECT * FROM cs_calls WHERE id = $1`, [s.call_id]))[0];
    // A live verified phone session for this buyer (as the call layer creates after the caller reads their code).
    const v = (await q(`INSERT INTO cs_phone_verifications (call_id, target_user_id, identifier_type, identifier_hash, provider, status, expires_at, verified_at)
      VALUES ($1,$2,'email','test','local_test','approved', now() + interval '5 minutes', now()) RETURNING id`, [s.call_id, BUYER]))[0];
    const sessionId = (await q(`INSERT INTO cs_phone_sessions (call_id, conversation_id, user_id, verification_id, expires_at) VALUES ($1,$2,$3,$4, now() + interval '20 minutes') RETURNING id`,
      [s.call_id, call.conversation_id, BUYER, v.id]))[0].id;
    const mailbox = [];
    const out = await tools.run('send_payment_link', { invoice_number: 'PERM-1', delivery: 'email' }, { channel: 'phone', userId: BUYER, phone: { call, sessionId, textingAvailable: false, deps: { mailbox } } });
    expect(out.sent).toBe(true);
    expect(mailbox.map((m) => m.kind)).toEqual(['payment_link']);
    expect((await q(`SELECT count(*)::int n FROM payment_links WHERE invoice_number = 'PERM-1'`))[0].n).toBe(1);
    expect((await q(`SELECT total_cents, status FROM buyer_auction_invoices WHERE id = $1`, [INVOICE]))[0]).toEqual({ total_cents: 18510, status: 'payment_required' });
    await sim.end(s.call_id, ADMIN);
  });
  test('a callback message reaches the Shared Inbox and the audit log', async () => {
    const s = await sim.start({ actorId: ADMIN, callerNumber: '+12025550177' }, {});
    const call = (await q(`SELECT * FROM cs_calls WHERE id = $1`, [s.call_id]))[0];
    const out = await tools.run('request_callback', { callback_number: 'caller_id', reason: 'customer_request', summary: 'Please call me about my invoice.' }, { channel: 'phone', userId: null, phone: { call, callerE164: '+12025550177', deps: {} } });
    expect(out.ok).toBe(true);
    expect((await q(`SELECT count(*)::int n FROM cs_handoffs WHERE conversation_id = $1`, [call.conversation_id]))[0].n).toBeGreaterThan(0);
    await sim.end(s.call_id, ADMIN);
  });
});
