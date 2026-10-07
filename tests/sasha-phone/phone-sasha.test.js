'use strict';

/**
 * Phone Sasha foundation (migration 188). End to end through the REAL call path — ConversationRelay message
 * translator → PhoneCall → existing Sasha engine (streamed) → existing + phone tools → verification, sessions,
 * disclosure audit, escalation — against a real Postgres (PGlite, in memory). The model is a scripted stream (no
 * network); no telephone, SMS or Twilio is ever reached.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
delete process.env.SASHA_PHONE_SUPPORT_ALERT_E164S;
delete process.env.SASHA_PHONE_SMS_ENABLED;
delete process.env.TWILIO_VERIFY_SERVICE_SID;

jest.mock('../../src/db', () => require('./pgHarness').dbAdapter(() => global.__PG));
jest.setTimeout(60000);

const fs = require('fs');
const path = require('path');
const { createDb } = require('./pgHarness');
const settings = require('../../src/services/sasha/settings');
const phoneSettings = require('../../src/services/sasha/phone/phoneSettings');
const sim = require('../../src/services/sasha/phone/phoneSimulator');
const { PhoneCall } = require('../../src/services/sasha/phone/callSession');
const { RelaySession, connectTwiml, queueTwiml, afterSessionTwiml } = require('../../src/services/sasha/phone/adapters/conversationRelay');
const verification = require('../../src/services/sasha/phone/verification');
const redaction = require('../../src/services/sasha/phone/redaction');
const retention = require('../../src/services/sasha/phone/retention');
const engine = require('../../src/services/sasha/engine');
const tools = require('../../src/services/sasha/tools');
const { normalizeUsPhone } = require('../../src/lib/phoneNumber');

const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
let ADMIN; let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;

beforeAll(async () => {
  global.__PG = await createDb();
  ADMIN = (await q(`INSERT INTO users (email, role, full_name) VALUES ('ty-admin@example.org','admin','Ty Admin') RETURNING id`))[0].id;
});
afterAll(async () => { for (const id of [...sim.SIMS.keys()]) await sim.end(id, ADMIN).catch(() => {}); await global.__PG.close(); });
beforeEach(() => { settings.clear(); phoneSettings.clear(); });
// Hang up every simulated call a test left open (the concurrent-call limit applies to simulations too).
afterEach(async () => { for (const id of [...sim.SIMS.keys()]) await sim.end(id, ADMIN).catch(() => {}); });

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────
/** verified: the phone passed a code (stored as E.164 with phone_verified_e164), so Phone Sasha may text it. */
async function user({ phone = null, role = 'buyer', name = 'Pat Caller', verified = false } = {}) {
  const email = `caller-${uniq()}@buyers.org`;
  const e164 = verified ? normalizeUsPhone(phone).e164 : null;
  const id = (await q(`INSERT INTO users (email, full_name, role, phone, phone_verified_e164, phone_verified_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $5::text IS NOT NULL THEN now() END) RETURNING id`,
    [email, name, role, verified ? e164 : phone, e164]))[0].id;
  return { id, email };
}
let phoneSeq = 2010000;
const freshPhone = () => `(551) 6${String(++phoneSeq).slice(-2)}-${String(phoneSeq).slice(-4)}`.replace(/\(551\) 6(\d\d)/, '(551) 6$1');
async function auction({ sellerUserId, title = 'Henderson Estate', paidBy = null, unpaidBy = null } = {}) {
  const sp = (await q(`SELECT id FROM seller_profiles WHERE user_id = $1`, [sellerUserId]))[0] || (await q(`INSERT INTO seller_profiles (user_id, seller_type) VALUES ($1,'private') RETURNING id`, [sellerUserId]))[0];
  const a = (await q(`INSERT INTO auctions (seller_id, title, city, address_state, street_address, zip, state, end_time, pickup_window_start, pickup_window_end)
    VALUES ($1,$2,'Dayton','OH','742 Evergreen Terrace','45402','closed', now() - interval '2 days', now() + interval '2 days', now() + interval '3 days') RETURNING id`, [sp.id, title]))[0];
  for (const [buyer, status] of [[paidBy, 'paid'], [unpaidBy, 'payment_required']]) {
    if (!buyer) continue;
    await q(`INSERT INTO buyer_auction_invoices (invoice_number, buyer_user_id, auction_id, status, hammer_cents, buyer_premium_cents, sales_tax_cents, total_cents, paid_at)
      VALUES ($1,$2,$3,$4,10000,1800,700,12500, CASE WHEN $4 = 'paid' THEN now() ELSE NULL END)`, ['INV-' + uniq(), buyer, a.id, status]);
  }
  return a.id;
}

// ── scripted streaming model ─────────────────────────────────────────────────────────────────────────────
/** Each model call takes the next step: { text } or { tools: [{ name, input }], text? } or a function (params) → step. */
function model(steps) {
  const calls = [];
  const client = { messages: { create: async (params, opts) => {
    calls.push(params);
    let step = steps.length ? steps.shift() : { text: 'Is there anything else I can help with?' };
    if (typeof step === 'function') step = step(params, calls.length);
    return stream(step, opts && opts.signal);
  } } };
  return { client, calls };
}
async function* stream(step, signal) {
  yield { type: 'message_start', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } };
  let i = 0;
  if (step.text) {
    yield { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } };
    for (const w of step.text.split(/(?<= )/)) {
      if (signal && signal.aborted) return;
      if (step.slow) await new Promise((r) => setTimeout(r, step.slow));
      yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: w } };
    }
    i++;
  }
  for (const t of step.tools || []) {
    yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'tu_' + uniq(), name: t.name, input: {} } };
    yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } };
    i++;
  }
  yield { type: 'message_delta', delta: { stop_reason: (step.tools || []).length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 40 } };
}
const toolNames = (params) => (params.tools || []).map((t) => t.name);
const lastToolResult = (params) => { const m = params.messages[params.messages.length - 1]; return Array.isArray(m.content) ? JSON.parse(m.content[0].content) : null; };
const spokenText = (st) => st.transcript.filter((m) => m.author_type === 'sasha').map((m) => m.body_text).join(' | ');
/** The latest 4-digit code delivered to the simulated handset (text) or mailbox (email). */
const codeFrom = (st, where = null) => {
  const all = [...(where !== 'email' ? st.handset.map((x) => ({ ...x, via: 'sms' })) : []), ...(where !== 'sms' ? (st.mailbox || []).map((x) => ({ ...x, via: 'email' })) : [])]
    .filter((x) => x.kind === 'code').sort((a, b) => new Date(a.at) - new Date(b.at));
  const m = all[all.length - 1]; return m ? /\b(\d{4})\b/.exec(m.body)[1] : null;
};
const sent = (st) => st.handset.length + (st.mailbox || []).length;
async function startCall(client, callerNumber = null) { return sim.start({ actorId: ADMIN, callerNumber }, { client }); }

/** Verify a caller by email through the real tool + spoken code. Returns the call id. */
async function verifiedCall(u, extraSteps = []) {
  const m = model([{ tools: [{ name: 'start_account_verification', input: { email: u.email } }] }, { text: 'I just texted you a code. Please read it to me.' },
    { text: 'Thank you, you are verified. How can I help?' }, ...extraSteps]);
  const s = await startCall(m.client);
  await sim.say(s.call_id, ADMIN, 'I need help with my account. My email is ' + u.email);
  const st = await sim.state(s.call_id, ADMIN);
  const code = codeFrom(st);
  expect(code).toMatch(/^\d{4}$/);
  const r = await sim.say(s.call_id, ADMIN, 'The code is ' + code.split('').join(' '));
  expect(r.verification.state).toBe('verified');
  return { callId: s.call_id, m };
}

// ── anonymous / public ─────────────────────────────────────────────────────────────────────────────────
describe('anonymous public call', () => {
  test('disclosure greeting, public answer, no account tools offered before verification', async () => {
    const m = model([{ tools: [{ name: 'get_platform_rules', input: { topic: 'bidding' } }] }, { text: 'Bids go up in set increments. A bid in the last two minutes extends that lot by two minutes.' }]);
    const s = await startCall(m.client);
    expect(s.transcript[0].body_text).toMatch(/^You've reached Advantage\.Bid\. This call is answered by Sasha, our virtual assistant, and is transcribed for customer support\. How can I help you today\?$/);
    const r = await sim.say(s.call_id, ADMIN, 'How does bidding work?');
    expect(toolNames(m.calls[0])).toEqual(expect.arrayContaining(['search_help_center', 'get_platform_rules', 'get_auction_or_lot', 'request_human', 'start_account_verification', 'request_callback', 'find_auction']));
    expect(toolNames(m.calls[0]).some((n) => n.startsWith('get_my_') || n === 'send_text')).toBe(false);
    expect(r.turn.some((x) => x.kind === 'filler')).toBe(true);   // a holding phrase while the lookup ran
    expect(spokenText(r)).toMatch(/extends that lot by two minutes/);
    expect(m.calls[0].system[0].text).toMatch(/This is a PHONE CALL and the caller is NOT verified/);
    expect(m.calls[0].system[1].text).toMatch(/Caller verification: NOT verified/);
    expect(m.calls[0].max_tokens).toBe(450);
    expect(m.calls[0].stream).toBe(true);
  });
  test('caller ID is a hint only: a caller ID matching an account grants nothing', async () => {
    const phone = '(551) 610-2001';
    await user({ phone });
    const m = model([{ text: 'I can help with that once I verify your account.' }]);
    const s = await startCall(m.client, phone);
    const r = await sim.say(s.call_id, ADMIN, 'What did I win yesterday?');
    expect(r.verification.state).toBe('anonymous');
    expect(r.account).toBeNull();
    expect(toolNames(m.calls[0]).includes('get_my_bids')).toBe(false);
  });
  test('an account tool called without verification is refused and audited', async () => {
    const ctx = { channel: 'phone', userId: null, phone: { call: (await q(`SELECT * FROM cs_calls ORDER BY started_at DESC LIMIT 1`))[0] } };
    const out = await tools.run('get_my_invoices', {}, ctx);
    expect(out.error).toMatch(/not verified/);
    const ev = await q(`SELECT event_type, tool FROM cs_phone_audit WHERE call_id = $1 AND event_type = 'tool_refused'`, [ctx.phone.call.id]);
    expect(ev.map((e) => e.tool)).toContain('get_my_invoices');
  });
});

// ── verification ─────────────────────────────────────────────────────────────────────────────────────
describe('account verification (4-digit codes)', () => {
  const startStep = (input) => ({ tools: [{ name: 'start_account_verification', input }] });
  test('anti-enumeration: an existing account and an unknown email get the identical reply; only the real one gets a code', async () => {
    const u = await user({ phone: '(551) 610-3001', verified: true });
    const replies = [];
    for (const email of [u.email, 'nobody-' + uniq() + '@buyers.org']) {
      const m = model([startStep({ email }), (p) => { replies.push(lastToolResult(p).result); return { text: 'If that matches, a code is on its way.' }; }]);
      const s = await startCall(m.client);
      await sim.say(s.call_id, ADMIN, 'My email is ' + email);
      const st = await sim.state(s.call_id, ADMIN);
      if (email === u.email) expect(codeFrom(st, 'sms')).toMatch(/^\d{4}$/); else expect(sent(st)).toBe(0);
      expect(st.verification.state).toBe('code_sent');   // same visible state either way
    }
    expect(replies[0]).toBe(replies[1]);
    expect(replies[0]).toBe(verification.GENERIC_REPLY);
    expect(verification.GENERIC_REPLY).toMatch(/4-digit code/);
  });
  test('verified mobile → the code is TEXTED; successful code opens a session; the code is never stored, logged or shown to the model', async () => {
    const u = await user({ phone: '(551) 610-4001', verified: true });
    const { callId, m } = await verifiedCall(u);
    const st = await sim.state(callId, ADMIN);
    expect(st.handset.filter((h) => h.kind === 'code')).toHaveLength(1);
    expect(st.mailbox).toHaveLength(0);
    const last = m.calls[m.calls.length - 1];
    expect(toolNames(last)).toEqual(expect.arrayContaining(['get_my_invoices', 'get_my_pickup_details', 'send_text', 'send_payment_link', 'get_my_order_detail']));
    expect(last.system[0].text).toMatch(/the caller is VERIFIED/);
    expect(last.system[1].text).toMatch(/was CORRECT/);
    expect(st.account.email).toBe(u.email);
    expect(st.session).toBeTruthy();
    const code = codeFrom(st);
    const stored = (await q(`SELECT body_text FROM cs_messages WHERE conversation_id = (SELECT conversation_id FROM cs_calls WHERE id = $1)`, [callId])).map((r) => r.body_text).join('\n');
    expect(stored).toContain('[verification code]');
    expect(stored).not.toMatch(new RegExp('\\b' + code + '\\b'));
    expect(JSON.stringify(m.calls.map((c) => c.messages))).not.toMatch(new RegExp('\\b' + code + '\\b'));
    expect(JSON.stringify(await q(`SELECT detail FROM cs_phone_audit WHERE call_id = $1`, [callId]))).not.toMatch(new RegExp('\\b' + code + '\\b'));
    const v = (await q(`SELECT code_hash, channel, provider, status FROM cs_phone_verifications WHERE call_id = $1`, [callId]))[0];
    expect(v).toMatchObject({ channel: 'sms', provider: 'local_test', status: 'approved' });
    expect(v.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const ev = (await q(`SELECT event_type, detail FROM cs_phone_audit WHERE call_id = $1 ORDER BY created_at`, [callId]));
    expect(ev.map((e) => e.event_type)).toEqual(expect.arrayContaining(['call_started', 'verification_started', 'verification_succeeded', 'session_started']));
    expect(ev.find((e) => e.event_type === 'verification_succeeded').detail.what).toBe('sms');
  });
  test('no phone on the account → the code is EMAILED to the account email, and verifies the same way (method audited as email)', async () => {
    const u = await user({ phone: null });
    const { callId } = await verifiedCall(u);
    const st = await sim.state(callId, ADMIN);
    expect(st.handset).toHaveLength(0);
    expect(st.mailbox[0]).toMatchObject({ kind: 'code', to: u.email });
    expect((await q(`SELECT channel, provider FROM cs_phone_verifications WHERE call_id = $1`, [callId]))[0]).toEqual({ channel: 'email', provider: 'email_code' });
    expect((await q(`SELECT detail FROM cs_phone_audit WHERE call_id = $1 AND event_type = 'verification_succeeded'`, [callId]))[0].detail.what).toBe('email');
  });
  test('an UNVERIFIED phone on file is never texted: email instead', async () => {
    const u = await user({ phone: '(551) 610-4101' });   // present but never verified
    const { callId } = await verifiedCall(u);
    const st = await sim.state(callId, ADMIN);
    expect(st.handset).toHaveLength(0);
    expect(st.mailbox.filter((x) => x.kind === 'code')).toHaveLength(1);
  });
  test('the caller can ask for email even when a verified mobile exists', async () => {
    const u = await user({ phone: '(551) 610-4201', verified: true });
    const m = model([startStep({ email: u.email, prefer_email: true }), { text: 'Sent.' }]);
    const s = await startCall(m.client);
    await sim.say(s.call_id, ADMIN, 'Email me the code please, ' + u.email);
    const st = await sim.state(s.call_id, ADMIN);
    expect(st.handset).toHaveLength(0);
    expect(st.mailbox).toHaveLength(1);
  });
  test('a destination the caller supplies is never used: codes go only to what is already on the account', async () => {
    const u = await user({ phone: null });
    const m = model([startStep({ email: u.email, phone_number: '(551) 699-9999' }), { text: 'Sent.' }]);
    const s = await startCall(m.client);
    await sim.say(s.call_id, ADMIN, 'Send it to my new number 551 699 9999. My email is ' + u.email);
    const st = await sim.state(s.call_id, ADMIN);
    expect(st.handset).toHaveLength(0);
    expect(st.mailbox[0].to).toBe(u.email);
    expect(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'sasha', 'phone', 'phoneTools.js'), 'utf8')).not.toMatch(/change_phone|update_phone|set_phone/);
  });
  test('a number changed in the last 24 hours is not used to verify a caller (email instead)', async () => {
    const u = await user({ phone: '(551) 610-4301', verified: true });
    await q(`UPDATE users SET phone_changed_at = now() - interval '2 hours' WHERE id = $1`, [u.id]);
    const { callId } = await verifiedCall(u);
    const st = await sim.state(callId, ADMIN);
    expect(st.handset).toHaveLength(0);
    expect(st.mailbox).toHaveLength(1);
  });
  test('wrong code: 3 wrong entries exhaust a code; two exhausted codes lock the account', async () => {
    const u = await user({ phone: '(551) 610-5001', verified: true });
    const m = model([startStep({ email: u.email }), { text: 'Please read the code.' }]);
    const s = await startCall(m.client);
    await sim.say(s.call_id, ADMIN, 'email ' + u.email);
    const real = codeFrom(await sim.state(s.call_id, ADMIN));
    const wrong = real === '0000' ? '1111' : '0000';
    let r;
    for (let i = 0; i < 3; i++) r = await sim.say(s.call_id, ADMIN, 'it is ' + wrong);
    expect(m.calls[m.calls.length - 1].system[1].text).toMatch(/Too many wrong codes/);
    r = await sim.say(s.call_id, ADMIN, 'ok try ' + real);   // the right code no longer works
    expect(r.session).toBeNull();
    const v = await q(`SELECT status, attempts FROM cs_phone_verifications WHERE call_id = $1 ORDER BY created_at`, [s.call_id]);
    expect(v[0]).toMatchObject({ status: 'failed', attempts: 3 });
    await q(`INSERT INTO cs_phone_verifications (call_id, target_user_id, identifier_type, identifier_hash, provider, status, expires_at)
      VALUES ($1,$2,'email','x','local_test','failed', now())`, [s.call_id, u.id]);
    const m2 = model([startStep({ email: u.email }), { text: 'If that matches, a code is coming.' }]);
    const s2 = await startCall(m2.client);
    await sim.say(s2.call_id, ADMIN, 'email ' + u.email);
    expect(sent(await sim.state(s2.call_id, ADMIN))).toBe(0);
    expect((await q(`SELECT status FROM cs_phone_verifications WHERE call_id = $1`, [s2.call_id]))[0].status).toBe('locked');
  });
  test('expired code is refused (codes last 5 minutes)', async () => {
    expect((await q(`SELECT value FROM platform_config WHERE key = 'sasha.phone.code_ttl_minutes'`))[0].value).toBe(5);
    const u = await user({ phone: '(551) 610-6001', verified: true });
    const m = model([startStep({ email: u.email }), { text: 'Read it when it arrives.' }]);
    const s = await startCall(m.client);
    await sim.say(s.call_id, ADMIN, 'email ' + u.email);
    const code = codeFrom(await sim.state(s.call_id, ADMIN));
    await q(`UPDATE cs_phone_verifications SET expires_at = now() - interval '1 minute' WHERE call_id = $1`, [s.call_id]);
    const r = await sim.say(s.call_id, ADMIN, code);
    expect(r.session).toBeNull();
    expect(m.calls[m.calls.length - 1].system[1].text).toMatch(/EXPIRED/);
  });
  test('replay: a code that already verified cannot be used again', async () => {
    const u = await user({ phone: '(551) 610-6051', verified: true });
    const { callId } = await verifiedCall(u);
    const code = codeFrom(await sim.state(callId, ADMIN));
    const call = (await q(`SELECT * FROM cs_calls WHERE id = $1`, [callId]))[0];
    expect(await verification.check(call, code)).toMatchObject({ ok: false, reason: 'no_code_requested' });
    expect((await q(`SELECT count(*)::int n FROM cs_phone_sessions WHERE call_id = $1`, [callId]))[0].n).toBe(1);
  });
  test('resend limit: at most 3 codes per account per 30 minutes; at most 3 starts per call', async () => {
    const u = await user({ phone: '(551) 610-6101', verified: true });
    const m = model([startStep({ email: u.email }), { text: 'Sent.' }, startStep({ email: u.email }), { text: 'Sent.' }, startStep({ email: u.email }), { text: 'Sent.' },
      startStep({ email: u.email }), { text: 'No more.' }]);
    const s = await startCall(m.client);
    for (let i = 0; i < 4; i++) await sim.say(s.call_id, ADMIN, 'please send the code again to ' + u.email);
    expect((await sim.state(s.call_id, ADMIN)).handset.filter((h) => h.kind === 'code')).toHaveLength(3);
    expect(await q(`SELECT count(*)::int n FROM cs_phone_verifications WHERE call_id = $1`, [s.call_id])).toEqual([{ n: 3 }]);
  });
  test('per-caller-number throttle: one caller cannot keep starting verifications across calls', async () => {
    const caller = '+1 551 612 9999';
    let lastStatus = null;
    for (let i = 0; i < 7; i++) {
      const u = await user({ phone: null });
      const m = model([startStep({ email: u.email }), { text: 'ok' }]);
      const s = await startCall(m.client, caller);
      await sim.say(s.call_id, ADMIN, 'email ' + u.email);
      lastStatus = (await q(`SELECT status FROM cs_phone_verifications WHERE call_id = $1`, [s.call_id]))[0].status;
      await sim.end(s.call_id, ADMIN);
    }
    expect(lastStatus).toBe('locked');
  });
  test('shared verified number: never identifies an account; the email path verifies instead', async () => {
    const a = await user({ phone: '(551) 610-7001', verified: true }); await user({ phone: '551.610.7001', verified: true });
    const m = model([startStep({ phone_number: '5516107001' }), (p) => ({ text: lastToolResult(p).result === verification.GENERIC_REPLY ? 'Generic.' : 'LEAK' })]);
    const s = await startCall(m.client);
    const r = await sim.say(s.call_id, ADMIN, 'my number is 551 610 7001');
    expect(spokenText(r)).not.toMatch(/LEAK/);
    expect(sent(r)).toBe(0);
    expect((await q(`SELECT status FROM cs_phone_verifications WHERE call_id = $1`, [s.call_id]))[0].status).toBe('ambiguous');
    // Same account by email: the shared number is not texted; the code goes to the account email.
    const { callId } = await verifiedCall(a);
    const st = await sim.state(callId, ADMIN);
    expect(st.handset).toHaveLength(0);
    expect(st.mailbox[0].to).toBe(a.email);
  });
  test('identifying by phone works only for a VERIFIED number held by one account', async () => {
    const v = await user({ phone: '551-610-8001', verified: true });
    expect(await verification.findAccount({ phone: '+1 (551) 610 8001' })).toMatchObject({ status: 'found', user: { id: v.id } });
    await user({ phone: '551-610-8002' });   // unverified
    expect(await verification.findAccount({ phone: '5516108002' })).toEqual({ status: 'no_match' });
  });
});

// ── verified buyer / seller ──────────────────────────────────────────────────────────────────────────
describe('verified account support', () => {
  test('verified buyer: invoices disclosed and audited with references only', async () => {
    const seller = await user({ role: 'seller' });
    const u = await user({ phone: '(551) 611-1001' });
    await auction({ sellerUserId: seller.id, paidBy: u.id });
    const { callId } = await verifiedCall(u, [{ tools: [{ name: 'get_my_invoices', input: {} }] }, (p) => ({ text: 'Your invoice total is ' + lastToolResult(p).invoices[0].total + ' and it is paid.' })]);
    const r = await sim.say(callId, ADMIN, 'What is on my invoice?');
    expect(spokenText(r)).toMatch(/\$125\.00 and it is paid/);
    const ev = (await q(`SELECT event_type, tool, data_category, account_user_id, phone_session_id, detail FROM cs_phone_audit WHERE call_id = $1 AND tool = 'get_my_invoices'`, [callId]))[0];
    expect(ev).toMatchObject({ event_type: 'tool_disclosed', data_category: 'invoices', account_user_id: u.id });
    expect(ev.phone_session_id).toBeTruthy();
    expect(ev.detail.invoices[0]).toMatch(/^INV-/);
  });
  test('unpaid invoice: pickup address is NOT disclosed by voice or text; refusal audited', async () => {
    const seller = await user({ role: 'seller' });
    const u = await user({ phone: '(551) 611-2001', verified: true });
    await auction({ sellerUserId: seller.id, unpaidBy: u.id });
    let pickupResult = null;
    const { callId, m } = await verifiedCall(u, [{ tools: [{ name: 'get_my_pickup_details', input: {} }] },
      (p) => { pickupResult = lastToolResult(p); return { text: 'The pickup address is shared after payment. The sale is in Dayton, Ohio.' }; },
      { tools: [{ name: 'send_text', input: { what: 'pickup_details' } }] }, (p) => ({ text: lastToolResult(p).note })]);
    const r = await sim.say(callId, ADMIN, 'Where do I pick up my items?');
    expect(pickupResult.pickups).toEqual([]);
    const r2 = await sim.say(callId, ADMIN, 'Can you text it to me?');
    expect(r2.handset.filter((h) => h.kind === 'text')).toHaveLength(0);
    const all = JSON.stringify([r, r2, m.calls.map((c) => c.messages)]);
    expect(all).not.toContain('742 Evergreen');
    expect(all).not.toContain('45402');
    const ev = await q(`SELECT event_type, tool FROM cs_phone_audit WHERE call_id = $1 AND tool IN ('get_my_pickup_details','send_text') ORDER BY created_at`, [callId]);
    expect(ev.map((e) => e.event_type)).toEqual(['tool_nothing_to_disclose', 'text_refused']);
  });
  test('paid invoice: pickup address may be spoken and texted to the phone on file; disclosure audited without the address', async () => {
    const seller = await user({ role: 'seller' });
    const u = await user({ phone: '(551) 611-3001', verified: true });
    await auction({ sellerUserId: seller.id, paidBy: u.id });
    const { callId } = await verifiedCall(u, [{ tools: [{ name: 'get_my_pickup_details', input: {} }] },
      (p) => ({ text: 'Your pickup address is ' + lastToolResult(p).pickups[0].pickup_address + '. Would you like me to text it?' }),
      { tools: [{ name: 'send_text', input: { what: 'pickup_details' } }] }, { text: 'Done, I texted it to the number on your account.' }]);
    const r = await sim.say(callId, ADMIN, 'Where is pickup?');
    expect(spokenText(r)).toMatch(/742 Evergreen Terrace, Dayton, OH 45402/);
    const r2 = await sim.say(callId, ADMIN, 'Yes please text it.');
    const text = r2.handset.find((h) => h.kind === 'text');
    expect(text.body).toMatch(/742 Evergreen Terrace/);
    expect(text.to_last4).toBe('3001');
    const audit = await q(`SELECT event_type, data_category, detail FROM cs_phone_audit WHERE call_id = $1 AND data_category = 'pickup_address' ORDER BY created_at`, [callId]);
    expect(audit.map((a) => a.event_type)).toEqual(['tool_disclosed', 'text_sent']);
    expect(JSON.stringify(audit)).not.toMatch(/Evergreen|45402/);
  });
  test('verified Professional Seller: onboarding stage and business verification come from the authoritative services', async () => {
    const u = await user({ phone: '(551) 611-4001', role: 'seller' });
    const sp = (await q(`INSERT INTO seller_profiles (user_id, seller_type, agreement_waived_at) VALUES ($1,'auction_house', now()) RETURNING id`, [u.id]))[0];
    await q(`INSERT INTO seller_identity (seller_profile_id, legal_name, ein, address_line1) VALUES ($1,'Acme Auctions LLC','12-3456789','1 Secret Way')`, [sp.id]);
    const vr = (await q(`INSERT INTO verification_requests (seller_profile_id, status, message) VALUES ($1,'more_info','Please upload your business license.') RETURNING id`, [sp.id]))[0];
    await q(`INSERT INTO verification_request_categories (request_id, category) VALUES ($1,'business_license')`, [vr.id]);
    let onboarding = null; let ver = null;
    const { callId } = await verifiedCall(u, [{ tools: [{ name: 'get_my_seller_onboarding', input: {} }, { name: 'get_my_business_verification', input: {} }] },
      (p) => { const res = p.messages[p.messages.length - 1].content.map((c) => JSON.parse(c.content)); onboarding = res[0]; ver = res[1]; return { text: 'You are close. We need one more document.' }; }]);
    await sim.say(callId, ADMIN, 'Where am I with my seller setup?');
    expect(onboarding).toMatchObject({ stage: 'finishing account setup', next_step_owner: 'the seller' });
    expect(onboarding.blocker).toMatch(/asked for more business verification information/);
    expect(ver).toEqual({ status: 'more info', message_from_advantage: 'Please upload your business license.' });
    expect(JSON.stringify(ver)).not.toMatch(/ein|tax_id|business_info|3456789|Secret Way|Acme/i);
  });
  test('Auction Partner seller: ordinary support only; no partner record or seller-activation outreach is created or changed', async () => {
    const u = await user({ phone: '(551) 611-5001', role: 'seller' });
    const sp = (await q(`INSERT INTO seller_profiles (user_id, seller_type) VALUES ($1,'estate_sale_company') RETURNING id`, [u.id]))[0];
    await q(`INSERT INTO founding_partners (seller_profile_id, status, intro_platform_fee_bps, fee_applied_at) VALUES ($1,'active',0, now())`, [sp.id]);
    const before = JSON.stringify(await q(`SELECT * FROM founding_partners ORDER BY id`)) + (await q(`SELECT count(*)::int n FROM seller_activation_touches`))[0].n;
    let terms = null;
    const { callId } = await verifiedCall(u, [{ tools: [{ name: 'get_my_seller_terms', input: {} }] }, (p) => { terms = lastToolResult(p); return { text: 'You are in the Auction Partner Program.' }; }]);
    await sim.say(callId, ADMIN, 'What are my fees?');
    expect(terms.program).toBe('Auction Partner Program');
    const after = JSON.stringify(await q(`SELECT * FROM founding_partners ORDER BY id`)) + (await q(`SELECT count(*)::int n FROM seller_activation_touches`))[0].n;
    expect(after).toBe(before);
    const src = ['phoneTools.js', 'callSession.js', 'escalation.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'sasha', 'phone', f), 'utf8')).join('\n');
    expect(src).not.toMatch(/INSERT INTO (founding_partners|seller_activation|sales_outreach)|UPDATE founding_partners/);
  });
});

// ── payments and card data ───────────────────────────────────────────────────────────────────────────
describe('payments: no card data ever reaches storage or the model', () => {
  test('a spoken card number, expiry and CVV are removed before storage and before the model; Sasha is told to stop the caller', async () => {
    const m = model([{ text: 'For your security I can\'t take card details over the phone. You can pay securely in your account under Invoices.' }]);
    const s = await startCall(m.client);
    const r = await sim.say(s.call_id, ADMIN, 'Can I just pay now? My card is four two four two four two four two four two four two four two four two, expires 12/28, CVV 123');
    const stored = (await q(`SELECT body_text FROM cs_messages WHERE conversation_id = (SELECT conversation_id FROM cs_calls WHERE id = $1) AND author_type = 'customer'`, [s.call_id]))[0].body_text;
    expect(stored).not.toMatch(/4242|12\/28|123/);
    expect(stored).toMatch(/\[card details removed\]/);
    const sent = JSON.stringify(m.calls[0].messages);
    expect(sent).not.toMatch(/4 2 4 2|4242|four two/);
    expect(m.calls[0].system[1].text).toMatch(/started reading payment card details/);
    expect(r.call.card_data_redacted).toBe(1);
    expect((await q(`SELECT count(*)::int n FROM cs_phone_audit WHERE call_id = $1 AND event_type = 'card_data_redacted'`, [s.call_id]))[0].n).toBe(1);
  });
  test('Sasha offers a secure payment link instead of taking card details', () => {
    expect(engine.systemPrompt({ channel: 'phone' })).toMatch(/never ask for, accept, repeat or write down a card number/);
    expect(engine.systemPrompt({ channel: 'phone' })).toMatch(/send them a secure payment link instead \(send_payment_link/);
  });
  test('redaction keeps ordinary speech and catches spoken digits (4-digit codes)', () => {
    expect(redaction.cleanUtterance('I need one or two items from lot 42').text).toBe('I need one or two items from lot 42');
    expect(redaction.cleanUtterance('double five three eight', { expectCode: true })).toMatchObject({ code: '5538', text: '[verification code]' });
    expect(redaction.cleanUtterance('it is 4 8 2 9', { expectCode: true }).code).toBe('4829');
    expect(redaction.cleanUtterance('call me at 551 655 7050', { expectCode: true }).code).toBeNull();
    expect(redaction.cleanUtterance('my cvv is 1234', { expectCode: true })).toMatchObject({ code: null, cardDetected: true });
    expect(redaction.scrubOutbound('card 4242 4242 4242 4242 ok')).toBe('card [removed] ok');
  });
});

// ── payment links (Option A) ───────────────────────────────────────────────────────────────────────────
describe('payment links', () => {
  const payLinks = require('../../src/services/payLinkService');
  async function linkCall(u, invoiceNumber, delivery = 'email') {
    const { callId } = await verifiedCall(u, [{ tools: [{ name: 'send_payment_link', input: { invoice_number: invoiceNumber, delivery } }] }, (p) => ({ text: lastToolResult(p).note })]);
    const r = await sim.say(callId, ADMIN, 'Can you send me a link to pay invoice ' + invoiceNumber + '?');
    return { callId, r };
  }
  const tokenFrom = (body) => { const m = /\/pay\/([A-Za-z0-9_-]{40,60})/.exec(body || ''); return m && m[1]; };
  async function unpaidInvoiceFor(buyerId) {
    const seller = await user({ role: 'seller' });
    await auction({ sellerUserId: seller.id, unpaidBy: buyerId });
    return (await q(`SELECT id, invoice_number FROM buyer_auction_invoices WHERE buyer_user_id = $1 AND status = 'payment_required'`, [buyerId]))[0];
  }
  test('unpaid invoice: a single-use, 30-minute link is emailed; the model and the audit never see the link', async () => {
    const u = await user({ phone: null });
    const inv = await unpaidInvoiceFor(u.id);
    const { callId, r } = await linkCall(u, inv.invoice_number);
    const mail = r.mailbox.find((x) => x.kind === 'payment_link');
    expect(mail.to).toBe(u.email);
    const token = tokenFrom(mail.body);
    expect(token).toBeTruthy();
    expect(spokenText(r)).toMatch(/secure payment link/);
    expect(JSON.stringify(r).split(token).length - 1).toBe(1);   // the link appears once: in the (simulated) email, nowhere else
    const call = (await q(`SELECT conversation_id FROM cs_calls WHERE id = $1`, [callId]))[0];
    const stored = JSON.stringify(await q(`SELECT body_text FROM cs_messages WHERE conversation_id = $1`, [call.conversation_id]));
    expect(stored).not.toContain(token);
    expect(JSON.stringify(await q(`SELECT detail FROM cs_phone_audit WHERE call_id = $1`, [callId]))).not.toContain(token);
    const row = (await q(`SELECT * FROM payment_links WHERE combined_invoice_id = $1`, [inv.id]))[0];
    expect(row.token_hash).toBe(payLinks._sha(token));
    expect(row).toMatchObject({ user_id: u.id, delivery: 'email', status: 'issued', is_simulated: true });
    expect(Math.round((new Date(row.expires_at) - new Date(row.created_at)) / 60000)).toBe(30);
    const ev = (await q(`SELECT event_type FROM cs_phone_audit WHERE call_id = $1 AND data_category = 'payment_link' ORDER BY created_at`, [callId])).map((e) => e.event_type);
    expect(ev).toEqual(['payment_link_requested', 'payment_link_sent']);
  });
  test('a verified mobile can receive the link by text', async () => {
    const u = await user({ phone: '(551) 616-1001', verified: true });
    const inv = await unpaidInvoiceFor(u.id);
    const { r } = await linkCall(u, inv.invoice_number, 'text');
    const text = r.handset.find((x) => x.kind === 'text');
    expect(text.body).toMatch(/\/pay\/[A-Za-z0-9_-]{40,}/);
    expect(text.to_last4).toBe('1001');
  });
  test('opening the link: no session → normal sign-in; wrong account → refused, not consumed; right account → existing Invoices pay flow; replay → expired', async () => {
    const u = await user({ phone: null }); const other = await user({ phone: null });
    const inv = await unpaidInvoiceFor(u.id);
    const { r } = await linkCall(u, inv.invoice_number);
    const token = tokenFrom(r.mailbox.find((x) => x.kind === 'payment_link').body);
    expect(await payLinks.open(token, null)).toEqual({ action: 'login', status: 302, location: '/login.html?next=' + encodeURIComponent('/pay/' + token) });
    expect(await payLinks.open(token, other.id)).toMatchObject({ action: 'wrong_account', status: 403 });
    expect(await payLinks.open(token, u.id)).toEqual({ action: 'redirect', status: 302, location: '/invoices.html?pay=' + encodeURIComponent(inv.id) });
    expect(await payLinks.open(token, u.id)).toMatchObject({ action: 'expired' });   // single use
    expect((await q(`SELECT status, used_at IS NOT NULL used FROM payment_links WHERE combined_invoice_id = $1`, [inv.id]))[0]).toEqual({ status: 'consumed', used: true });
    expect(await payLinks.open('not-a-real-token-but-long-enough-to-look-like-one-xx', u.id)).toMatchObject({ action: 'expired' });
  });
  test('expired link is refused; a newer link supersedes the older one', async () => {
    const u = await user({ phone: null });
    const inv = await unpaidInvoiceFor(u.id);
    const first = tokenFrom((await linkCall(u, inv.invoice_number)).r.mailbox.find((x) => x.kind === 'payment_link').body);
    const second = tokenFrom((await linkCall(u, inv.invoice_number)).r.mailbox.find((x) => x.kind === 'payment_link').body);
    expect(await payLinks.open(first, u.id)).toMatchObject({ action: 'expired' });
    await q(`UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [payLinks._sha(second)]);
    expect(await payLinks.open(second, u.id)).toMatchObject({ action: 'expired' });
  });
  test('Railway refuses paid invoices and invoices that belong to someone else; refusals are audited', async () => {
    const u = await user({ phone: null }); const other = await user({ phone: null });
    const seller = await user({ role: 'seller' });
    await auction({ sellerUserId: seller.id, paidBy: u.id, unpaidBy: other.id });
    const paid = (await q(`SELECT invoice_number FROM buyer_auction_invoices WHERE buyer_user_id = $1`, [u.id]))[0].invoice_number;
    const othersInv = (await q(`SELECT invoice_number FROM buyer_auction_invoices WHERE buyer_user_id = $1`, [other.id]))[0].invoice_number;
    const a = await linkCall(u, paid);
    expect(spokenText(a.r)).toMatch(/nothing to pay/);
    const b = await linkCall(u, othersInv);
    expect(spokenText(b.r)).toMatch(/No invoice with that number on this account/);
    expect((await q(`SELECT count(*)::int n FROM payment_links WHERE user_id = $1`, [u.id]))[0].n).toBe(0);
    expect((await q(`SELECT detail FROM cs_phone_audit WHERE call_id = $1 AND event_type = 'payment_link_refused'`, [b.callId]))[0].detail.reason).toBe('not_found');
  });
  test('an unverified caller cannot request a payment link (tool not offered and refused if forced)', async () => {
    const m = model([{ text: 'I can do that once I verify your account.' }]);
    const s = await startCall(m.client);
    await sim.say(s.call_id, ADMIN, 'Send me a payment link');
    expect(toolNames(m.calls[0])).not.toContain('send_payment_link');
    const call = (await q(`SELECT * FROM cs_calls WHERE id = $1`, [s.call_id]))[0];
    expect((await tools.run('send_payment_link', { invoice_number: 'X' }, { channel: 'phone', userId: null, phone: { call } })).error).toMatch(/not verified/);
  });
  test('the pay route reuses the existing payment flow: no new Stripe objects, no amount or tax logic', () => {
    const svc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'payLinkService.js'), 'utf8');
    const route = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'payLink.js'), 'utf8');
    const code = (svc + route).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // code only, not explanatory comments
    expect(code).not.toMatch(/stripe|paymentIntent|checkout\.sessions|tax_cents|settlement/i);
    expect(svc).toMatch(/'\/invoices\.html\?pay='/);
    expect(route).toMatch(/Referrer-Policy', 'no-referrer'/);
    expect(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'invoices.html'), 'utf8')).toMatch(/never pays automatically/);
  });
});

// ── escalation ───────────────────────────────────────────────────────────────────────────────────────
describe('human handoff and callbacks', () => {
  test('caller asks for a person: callback queued in the Shared Inbox with the number; staff alert simulated, never sent', async () => {
    const m = model([{ tools: [{ name: 'request_callback', input: { callback_number: 'caller_id', reason: 'customer_request', summary: 'Wants to talk about a damaged item.' } }] },
      (p) => ({ text: lastToolResult(p).note })]);
    const s = await startCall(m.client, '+1 551 612 1001');
    const r = await sim.say(s.call_id, ADMIN, 'I want to talk to a real person.');
    expect(spokenText(r)).toMatch(/call them back at the number ending in 1001/);
    expect(r.handoffs[0]).toMatchObject({ reason_code: 'customer_request', callback_requested: true, callback_status: 'open', callback_last4: '1001' });
    expect(r.handoff_state).toBe('needed');
    expect(r.staff_alerts[0].to).toMatch(/simulated, not sent/);
    const ev = (await q(`SELECT event_type, detail FROM cs_phone_audit WHERE call_id = $1 AND event_type IN ('callback_requested','staff_alerted')`, [s.call_id]));
    expect(ev.map((e) => e.event_type).sort()).toEqual(['callback_requested', 'staff_alerted']);
  });
  test('Sasha-triggered escalation (request_human) records the handoff and alerts the team once', async () => {
    const m = model([{ tools: [{ name: 'request_human', input: { reason: 'dispute', summary: 'Item damaged; caller wants a refund.' } }] },
      { tools: [{ name: 'request_callback', input: { callback_number: '5516121002', reason: 'dispute', summary: 'Damaged item.' } }] }, { text: 'A member of our team will call you back.' }]);
    const s = await startCall(m.client);
    const r = await sim.say(s.call_id, ADMIN, 'My dresser arrived broken and I want my money back.');
    expect(r.handoffs.length).toBeGreaterThanOrEqual(1);
    expect((await q(`SELECT count(*)::int n FROM cs_phone_audit WHERE call_id = $1 AND event_type = 'staff_alerted'`, [s.call_id]))[0].n).toBe(1);
    expect(spokenText(r)).not.toMatch(/refund will|we'll refund/i);
  });
  test('a real (non-simulated) call with no support-team numbers configured alerts nobody by SMS and never falls back to the owner', async () => {
    const escalation = require('../../src/services/sasha/phone/escalation');
    const smsService = { sendSMS: jest.fn() };
    process.env.OWNER_ALERT_PHONE_E164 = '+15005550006';
    const call = (await q(`SELECT * FROM cs_calls ORDER BY started_at DESC LIMIT 1`))[0];
    const fakeReal = { ...call, id: call.id, is_simulated: false };
    await q(`DELETE FROM cs_phone_audit WHERE call_id = $1 AND event_type = 'staff_alerted'`, [call.id]);
    const r = await escalation.alertStaff(fakeReal, { kind: 'callback', reason: 'customer_request' }, { smsService });
    expect(r.alerted).toBe(false);
    expect(smsService.sendSMS).not.toHaveBeenCalled();
    delete process.env.OWNER_ALERT_PHONE_E164;
  });
  test('when staff take the conversation over in the inbox, Sasha stops and only tells the caller the team is handling it', async () => {
    const m = model([]);
    const s = await startCall(m.client);
    const convId = (await q(`SELECT conversation_id FROM cs_calls WHERE id = $1`, [s.call_id]))[0].conversation_id;
    await q(`UPDATE cs_conversations SET owner = 'staff' WHERE id = $1`, [convId]);
    const r = await sim.say(s.call_id, ADMIN, 'Hello?');
    expect(m.calls).toHaveLength(0);
    expect(r.turn.map((t) => t.token).join('')).toMatch(/A member of our team is handling your request/);
  });
});

// ── session lifecycle ────────────────────────────────────────────────────────────────────────────────
describe('session expiry, call end, retention', () => {
  test('an expired session removes account access immediately and is audited', async () => {
    const u = await user({ phone: '(551) 613-1001' });
    const { callId, m } = await verifiedCall(u, [{ text: 'Your session has ended. I can verify you again.' }]);
    await q(`UPDATE cs_phone_sessions SET expires_at = now() - interval '1 second' WHERE call_id = $1`, [callId]);
    const r = await sim.say(callId, ADMIN, 'What about my bids?');
    const last = m.calls[m.calls.length - 1];
    expect(toolNames(last).some((n) => n.startsWith('get_my_'))).toBe(false);
    expect(last.system[1].text).toMatch(/EXPIRED/);
    expect(r.verification.state).toBe('expired');
    expect((await q(`SELECT end_reason FROM cs_phone_sessions WHERE call_id = $1`, [callId]))[0].end_reason).toBe('expired');
  });
  test('call end: session ends, summary kept, conversation resolved, transcript retention set; purge keeps the summary', async () => {
    const u = await user({ phone: '(551) 613-2001' });
    const { callId } = await verifiedCall(u);
    const st = await sim.end(callId, ADMIN);
    expect(st.call.status).toBe('completed');
    expect(st.call.summary).toMatch(/caller verified; topics: verification; simulation\.$/);
    expect(st.session).toBeNull();
    const call = (await q(`SELECT * FROM cs_calls WHERE id = $1`, [callId]))[0];
    expect(Math.round((new Date(call.transcript_purge_after) - new Date(call.ended_at)) / 86400000)).toBe(90);
    expect((await q(`SELECT end_reason FROM cs_phone_sessions WHERE call_id = $1`, [callId]))[0].end_reason).toBe('call_ended');
    expect((await q(`SELECT status FROM cs_conversations WHERE id = $1`, [call.conversation_id]))[0].status).toBe('resolved');
    await q(`UPDATE cs_calls SET transcript_purge_after = now() - interval '1 day' WHERE id = $1`, [callId]);
    const p = await retention.purgeExpired();
    expect(p.calls).toBeGreaterThanOrEqual(1);
    const msgs = await q(`SELECT direction, body_text FROM cs_messages WHERE conversation_id = $1`, [call.conversation_id]);
    expect(msgs.filter((x) => x.direction !== 'note').every((x) => x.body_text === retention.PURGED)).toBe(true);
    expect(msgs.find((x) => x.direction === 'note').body_text).toMatch(/^Call summary:/);
    expect((await q(`SELECT summary FROM cs_calls WHERE id = $1`, [callId]))[0].summary).toBeTruthy();
  });
});

// ── concurrency, budgets, streaming, interruption ──────────────────────────────────────────────────────
describe('concurrency and cost controls', () => {
  test('concurrent simulated calls stay isolated: each verified caller sees only their own invoices', async () => {
    const seller = await user({ role: 'seller' });
    const a = await user({ phone: '(551) 614-1001' }); const b = await user({ phone: '(551) 614-2001' });
    await auction({ sellerUserId: seller.id, title: 'Alpha Sale', paidBy: a.id });
    await auction({ sellerUserId: seller.id, title: 'Bravo Sale', paidBy: b.id });
    const seen = {};
    const mk = (who) => [{ tools: [{ name: 'get_my_invoices', input: {} }] }, (p) => { seen[who] = lastToolResult(p).invoices.map((i) => i.auction); return { text: 'Here you go.' }; }];
    const [ca, cb] = await Promise.all([verifiedCall(a, mk('a')), verifiedCall(b, mk('b'))]);
    await Promise.all([sim.say(ca.callId, ADMIN, 'my invoices?'), sim.say(cb.callId, ADMIN, 'my invoices?')]);
    expect(seen.a).toEqual(['Alpha Sale']);
    expect(seen.b).toEqual(['Bravo Sale']);
  });
  test('max concurrent calls: the next caller is queued, never a busy signal', async () => {
    await q(`INSERT INTO platform_config (key, value, category) VALUES ('sasha.phone.max_concurrent_calls', '1', 'sasha_phone') ON CONFLICT (key) DO UPDATE SET value = '1'`);
    await q(`UPDATE cs_calls SET status = 'completed' WHERE is_simulated AND status = 'in_progress'`);
    for (const id of [...sim.SIMS.keys()]) sim.SIMS.delete(id);
    phoneSettings.clear();
    const m = model([]);
    const first = await startCall(m.client);
    expect(first.started).toBe(true);
    const second = await startCall(m.client);
    expect(second).toMatchObject({ started: false, refused: 'queue' });
    expect(queueTwiml({ waitUrl: 'https://bid.advantage.bid/hold' })).toMatch(/<Enqueue waitUrl="https:\/\/bid\.advantage\.bid\/hold">sasha<\/Enqueue>/);
    await sim.end(first.call_id, ADMIN);
    await q(`UPDATE platform_config SET value = '10' WHERE key = 'sasha.phone.max_concurrent_calls'`);
  });
  test('per-call budget: when reached, Sasha stops calling the model and offers a team callback', async () => {
    await q(`INSERT INTO platform_config (key, value, category) VALUES ('sasha.phone.per_call_budget_usd', '0.001', 'sasha_phone') ON CONFLICT (key) DO UPDATE SET value = '0.001'`);
    phoneSettings.clear();
    const m = model([{ text: 'First answer.' }]);
    const s = await startCall(m.client);
    await sim.say(s.call_id, ADMIN, 'Question one');   // one turn costs about $0.0034, over the $0.001 cap
    const r = await sim.say(s.call_id, ADMIN, 'Question two');
    expect(m.calls).toHaveLength(1);
    expect(spokenText(r)).toMatch(/I can have a member of our team call you back/);
    expect((await q(`SELECT detail FROM cs_phone_audit WHERE call_id = $1 AND event_type = 'budget_stopped'`, [s.call_id]))[0].detail.reason).toBe('per_call');
    await q(`UPDATE platform_config SET value = '0.75' WHERE key = 'sasha.phone.per_call_budget_usd'`);
  });
  test('phone daily budget is separate from (and in addition to) the overall Sasha cap', async () => {
    await q(`INSERT INTO platform_config (key, value, category) VALUES ('sasha.phone.daily_budget_usd', '0', 'sasha_phone') ON CONFLICT (key) DO UPDATE SET value = '0'`);
    phoneSettings.clear();
    const m = model([{ text: 'never' }]);
    const s = await startCall(m.client);
    const r = await sim.say(s.call_id, ADMIN, 'Hi');
    expect(m.calls).toHaveLength(0);
    expect(r.runs[r.runs.length - 1].outcome_reason).toBe('phone_daily_budget_reached');
    await q(`UPDATE platform_config SET value = '10' WHERE key = 'sasha.phone.daily_budget_usd'`);
  });
  test('streaming: the first sentence is spoken before the model finishes; interruption stops Sasha and keeps only what was said', async () => {
    const m = model([{ text: 'First sentence here. Second sentence follows. Third sentence never finishes because the caller interrupts me right now in the middle.', slow: 15 }]);
    const s = await startCall(m.client);
    const call = PhoneCall.get(s.call_id);
    const spoken = [];
    const prev = call.deps.onSpeak;
    call.deps.onSpeak = (t, meta) => { prev(t, meta); spoken.push(t); if (spoken.length === 1) setTimeout(() => call.interrupt(), 5); };
    await sim.say(s.call_id, ADMIN, 'Tell me about pickup');
    expect(spoken[0]).toBe('First sentence here.');
    const st = await sim.state(s.call_id, ADMIN);
    expect(st.call.interruptions).toBe(1);
    expect(spokenText(st)).not.toMatch(/Third sentence/);
    expect(st.runs[st.runs.length - 1].outcome_reason).toBe('interrupted');
  });
});

// ── adapter protocol ─────────────────────────────────────────────────────────────────────────────────
describe('ConversationRelay adapter (simulated provider)', () => {
  test('setup → prompt → keypad code → interrupt → close, in the provider\'s message format', async () => {
    const u = await user({ phone: '(551) 615-1001' });
    const out = []; const handset = [];
    let code = null;
    const m = model([{ tools: [{ name: 'start_account_verification', input: { email: u.email } }] }, { text: 'Please enter the code on your keypad.' }, { text: 'You are verified.' }]);
    const relay = new RelaySession((x) => out.push(x), { provider: 'simulated', simulatedBy: ADMIN, deps: { client: m.client, handset, onTestCode: (c) => { code = c; } } });
    await relay.onMessage({ type: 'setup', callSid: 'CA' + uniq(), from: '+15556150000', to: '+15516557050' });
    expect(out[0]).toMatchObject({ type: 'text', kind: 'greeting' });
    await relay.onMessage({ type: 'prompt', voicePrompt: 'partial', last: false });
    await relay.onMessage({ type: 'prompt', voicePrompt: 'Check my account, ' + u.email, last: true });
    expect(code).toMatch(/^\d{4}$/);
    for (const d of code) await relay.onMessage({ type: 'dtmf', digit: d });
    expect((await q(`SELECT verification_state FROM cs_calls WHERE id = $1`, [relay.call.id]))[0].verification_state).toBe('verified');
    expect(out.filter((x) => x.last === true).length).toBeGreaterThanOrEqual(3);
    expect(await relay.onMessage({ type: 'interrupt', utteranceUntilInterrupt: 'Please' })).toEqual({ interrupted: true });
    const ended = await relay.close();
    expect(ended.status).toBe('completed');
  });
  test('a REAL provider session is refused while the phone switch is OFF (production cannot take a call)', async () => {
    const out = [];
    const relay = new RelaySession((x) => out.push(x), { provider: 'twilio_cr' });
    const r = await relay.onMessage({ type: 'setup', callSid: 'CA' + uniq(), from: '+15556150001', to: '+15516557050' });
    expect(r).toEqual({ refused: true, code: 'PHONE_DISABLED' });
    expect(out[0]).toEqual({ type: 'end', handoffData: JSON.stringify({ action: 'unavailable', reason: 'PHONE_DISABLED' }) });
    expect(afterSessionTwiml(out[0].handoffData)).toMatch(/not available right now/);
  });
  test('TwiML builders escape values and carry the configurable voice', () => {
    const x = connectTwiml({ wsUrl: 'wss://bid.advantage.bid/x?a=1&b=2', actionUrl: 'https://bid.advantage.bid/after', greeting: 'Hi "there"', voice: { tts_provider: 'ElevenLabs', voice: 'v1', language: 'en-US' } });
    expect(x).toMatch(/url="wss:\/\/bid\.advantage\.bid\/x\?a=1&amp;b=2"/);
    expect(x).toMatch(/welcomeGreeting="Hi &quot;there&quot;"/);
    expect(x).toMatch(/ttsProvider="ElevenLabs" voice="v1"/);
  });
});

// ── production safety, regressions, accounting ──────────────────────────────────────────────────────
describe('production safety and regressions', () => {
  test('defaults are OFF with no provider; no route accepts voice-provider traffic', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '188_sasha_phone_foundation.sql'), 'utf8');
    expect(sql).toMatch(/\('sasha\.phone\.enabled', 'false'::jsonb/);
    expect(sql).toMatch(/\('sasha\.phone\.provider', '"none"'::jsonb/);
    expect(await phoneSettings.liveCallsAllowed()).toBe(false);
    const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    expect(server).not.toMatch(/conversationRelay|phone\/voice|twiml|RelaySession/i);
    const routes = fs.readdirSync(path.join(__dirname, '..', '..', 'src', 'routes')).map((f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', f), 'utf8')).join('\n');
    expect(routes).not.toMatch(/RelaySession|connectTwiml|express-ws|WebSocketServer/);
  });
  test('real calls never use the local test code provider, and real texting is refused', async () => {
    expect(await verification.providerFor({ is_simulated: false })).toBe('none');
    expect(await verification.providerFor({ is_simulated: true })).toBe('local_test');
    const sms = require('../../src/services/sasha/phone/phoneSms');
    expect(await sms.send({ is_simulated: false }, { to: '+15516161001', body: 'x' })).toEqual({ sent: false, reason: 'texting not enabled' });
  });
  test('web chat and email prompts are byte-for-byte unchanged by the phone work', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sasha-system-prompts-pre-phone.json'), 'utf8'));
    const ctxs = { chat_anon: { channel: 'chat' }, chat_anon_email: { channel: 'chat', hasContactEmail: true }, chat_user: { channel: 'chat', userId: 'u1', customerName: 'Pat' },
      chat_seller_pro: { channel: 'chat', userId: 'u1', sellerType: 'auction_house', sellerProfessional: true }, chat_seller_ind: { channel: 'chat', userId: 'u1', sellerType: 'private', sellerProfessional: false },
      email: { channel: 'email', customerName: 'Pat' }, email_plain: { channel: 'email' } };
    for (const [k, c] of Object.entries(ctxs)) expect([k, engine.systemPrompt(c) === fx[k]]).toEqual([k, true]);
  });
  test('web chat and email tool lists are unchanged (no phone tools leak into them)', () => {
    expect(tools.toolsFor({ channel: 'chat' }).map((t) => t.name)).toEqual(['search_help_center', 'get_platform_rules', 'get_auction_or_lot', 'request_human']);
    expect(tools.toolsFor({ channel: 'email' }).map((t) => t.name)).toEqual(['search_help_center', 'get_platform_rules', 'get_auction_or_lot', 'request_human']);
    expect(tools.toolsFor({ channel: 'chat', userId: 'u' }).map((t) => t.name)).toEqual(['search_help_center', 'get_platform_rules', 'get_auction_or_lot', 'request_human',
      'get_my_account', 'get_my_bids', 'get_my_invoices', 'get_my_pickup_details', 'get_my_orders', 'get_my_auctions', 'get_my_settlements', 'get_my_seller_terms', 'get_my_storefront_orders']);
  });
  test('cost accounting: Sonnet 5 list prices ($2 / $10 per million) and prompt-cache reads and writes are counted', () => {
    expect(engine.costMicroUsd({ inTok: 1e6 })).toBe(2e6);
    expect(engine.costMicroUsd({ outTok: 1e6 })).toBe(10e6);
    expect(engine.costMicroUsd({ cacheTok: 1e6 })).toBe(0.2e6);
    expect(engine.costMicroUsd({ cacheWriteTok: 1e6 })).toBe(2.5e6);
    expect(engine.costMicroUsd({ inTok: 1000, outTok: 40, cacheTok: 5000 })).toBe(3400);
  });
  test('pickup-address knowledge now matches the product (email after payment, not the invoice)', () => {
    const facts = JSON.stringify(require('../../src/services/sasha/knowledge/platformFacts').getFacts('pickup'));
    expect(facts).not.toMatch(/shown on their paid invoice/);
    expect(facts).toMatch(/sent to the winning buyer by email after their payment succeeds/);
    expect(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'sasha', 'engine.js'), 'utf8')).not.toMatch(/paid invoices show the pickup address/);
  });
  test('phone numbers are normalized without rewriting the stored value', () => {
    expect(normalizeUsPhone('(551) 655-7050')).toMatchObject({ status: 'ok', e164: '+15516557050' });
    expect(normalizeUsPhone('1-551-655-7050')).toMatchObject({ status: 'ok', e164: '+15516557050' });
    expect(normalizeUsPhone('551 655 7050 x12').status).toBe('extension');
    expect(normalizeUsPhone('+44 20 7946 0958').status).toBe('international');
    expect(normalizeUsPhone('123-456-7890').status).toBe('invalid');
    expect(normalizeUsPhone('').status).toBe('empty');
  });
  test('the disclosure audit never stores codes, card numbers or addresses (detail is allow-listed)', () => {
    const { sanitizeDetail } = require('../../src/services/sasha/phone/phoneAudit');
    expect(sanitizeDetail({ invoices: ['INV-1'], address: '742 Evergreen', code: '123456', reason: 'code 123456' }))
      .toEqual({ invoices: ['INV-1'], reason: 'code [digits]' });
  });
  test('the Super Admin simulator and phone settings are gated in the routes', () => {
    const r = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'adminSasha.js'), 'utf8');
    for (const p of ['/phone/sim/start', '/phone/sim/:callId/say', '/phone/sim/:callId/keypad', '/phone/sim/:callId/interrupt', '/phone/sim/:callId/end']) {
      expect(r).toMatch(new RegExp(`router\\.post\\('${p.replace(/[/:]/g, (c) => '\\' + c)}', superAdminOnly`));
    }
    expect(r).toMatch(/router\.get\('\/phone\/sim\/:callId', superAdminOnly/);
    expect(r).toMatch(/router\.post\('\/phone\/settings', superAdminOnly/);
  });
});
