'use strict';

/**
 * Phone Sasha live Twilio line (migration 191): signed voice webhooks, routing menu, staff-only access, relay tickets,
 * the ConversationRelay WebSocket admission, routing context, greeting, time limit, take-a-message, and the phone
 * prompt. Real Postgres (PGlite); Twilio signatures are checked with an injected validator; the model is scripted;
 * nothing reaches Twilio, a telephone or SMS.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
delete process.env.SASHA_PHONE_SUPPORT_ALERT_E164S;
delete process.env.SASHA_PHONE_SMS_ENABLED;

jest.mock('../../src/db', () => require('./pgHarness').dbAdapter(() => global.__PG));
jest.setTimeout(60000);

const { createDb } = require('./pgHarness');
const phoneSettings = require('../../src/services/sasha/phone/phoneSettings');
const line = require('../../src/services/sasha/phone/voiceLine');
const voice = require('../../src/routes/voice');
const relayServer = require('../../src/services/sasha/phone/relayServer');
const testCallers = require('../../src/services/sasha/phone/testCallers');
const { RelaySession } = require('../../src/services/sasha/phone/adapters/conversationRelay');
const engine = require('../../src/services/sasha/engine');
const tools = require('../../src/services/sasha/tools');
const sim = require('../../src/services/sasha/phone/phoneSimulator');

const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const BASE = () => require('../../src/lib/publicUrls').publicBaseUrl().replace(/\/+$/, '');
const TOKEN = 'test-token-placeholder';
const GOOD = 'good-signature';
const validateRequest = (token, sig) => token === TOKEN && sig === GOOD;
const xml = (t) => t.replace(/'/g, '&apos;');
const ENV = {};
let ADMIN; let seq = 0;
const callSid = () => 'CA' + String(++seq).padStart(32, '0');
const ME = '(551) 616-7001'; const STRANGER = '(551) 616-7002';
const e164 = (n) => require('../../src/lib/phoneNumber').normalizeUsPhone(n).e164;

beforeAll(async () => {
  global.__PG = await createDb();
  ADMIN = (await q(`INSERT INTO users (email, role, full_name) VALUES ('voice-admin@example.org','admin','Voice Admin') RETURNING id`))[0].id;
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']) ENV[k] = process.env[k];
  process.env.TWILIO_ACCOUNT_SID = 'AC_test_placeholder'; process.env.TWILIO_AUTH_TOKEN = TOKEN;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await global.__PG.close();
});
beforeEach(() => phoneSettings.clear());

const setCfg = async (key, value) => { await q(`INSERT INTO platform_config (key, value, category) VALUES ($1, $2::jsonb, 'sasha_phone') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]); phoneSettings.clear(); };
async function lineOn(on = true) { await setCfg('sasha.phone.enabled', on); await setCfg('sasha.phone.provider', on ? 'twilio_cr' : 'none'); }

/** Run a voice webhook (signature guard + handler) with a fake Express request. */
async function hook(name, body, { sig = GOOD, query = {}, deps = {} } = {}) {
  const res = { code: null, body: null, ctype: null, status(c) { this.code = c; return this; }, type(t) { this.ctype = t; return this; }, send(b) { this.body = b; if (this.code == null) this.code = 200; return this; } };
  const req = { body, query, originalUrl: '/api/voice/' + name + (Object.keys(query).length ? '?' + new URLSearchParams(query) : ''),
    get: (h) => ({ 'x-twilio-signature': sig, host: 'bid.advantage.bid' })[String(h).toLowerCase()] };
  let passed = false;
  voice._handlers.guard({ validateRequest })(req, res, () => { passed = true; });
  if (passed) await voice._handlers[name](deps)(req, res);
  return res;
}

function model(steps) {
  const calls = [];
  async function* stream(step) {
    yield { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } };
  }
  return { calls, client: { messages: { create: async (params) => { calls.push(params); return stream(steps.length ? steps.shift() : { text: 'Happy to help.' }); } } } };
}

// ── incoming call ─────────────────────────────────────────────────────────────────────────────────────
describe('incoming call: signed, OFF by default, staff-only while testing', () => {
  test('unsigned or badly signed requests are refused; no credentials → 503', async () => {
    expect((await hook('incoming', { From: '+15516167001' }, { sig: null })).code).toBe(403);
    expect((await hook('incoming', { From: '+15516167001' }, { sig: 'forged' })).code).toBe(403);
    const t = process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_AUTH_TOKEN;
    try { expect((await hook('incoming', { From: '+15516167001' })).code).toBe(503); } finally { process.env.TWILIO_AUTH_TOKEN = t; }
  });
  test('line OFF (the production default): a short "not available" message and the call ends; nothing is dialed', async () => {
    const r = await hook('incoming', { From: e164(ME), CallSid: callSid() });
    expect(r.code).toBe(200); expect(r.ctype).toBe('text/xml');
    expect(r.body).toContain(line.MESSAGES.unavailable);
    expect(r.body).toMatch(/<Hangup\/><\/Response>$/);
    expect(r.body).not.toMatch(/<Dial|<Gather|<Connect|<Enqueue/);
    const a = await q(`SELECT metadata FROM audit_log WHERE event_type = 'sasha.phone_call_not_connected' ORDER BY created_at DESC LIMIT 1`);
    expect(a[0].metadata).toMatchObject({ reason: 'line_off', caller_last4: '7001' });
  });
  test('line ON, staff-only: an unlisted caller hears "not available"; a listed caller hears the Advantage.Bid menu', async () => {
    await lineOn();
    try {
      const tc = await testCallers.add(ME, { label: 'Owner test phone', actorId: ADMIN });
      const out = await hook('incoming', { From: e164(STRANGER), CallSid: callSid() });
      expect(out.body).toContain(line.MESSAGES.unavailable); expect(out.body).not.toMatch(/<Gather/);
      const r = await hook('incoming', { From: e164(ME), CallSid: callSid() });
      expect(r.body).toMatch(/<Gather input="dtmf" numDigits="1" timeout="7" actionOnEmptyResult="true" action="[^"]+\/api\/voice\/menu\?attempt=1" method="POST">/);
      const said = [...r.body.matchAll(/<Say voice="([^"]+)">([^<]*)<\/Say>/g)];
      expect(said.map((m) => m[2])).toEqual(['Thank you for calling Advantage.Bid, where you always get the advantage!', 'If you are a buyer, please press 1.',
        'If you are a seller, please press 2.', 'If you have recently purchased and need assistance with pickup, please press 3.', 'For all other questions, please press 4.']);
      expect(said.every((m) => m[1] === 'Google.en-US-Chirp3-HD-Aoede')).toBe(true);
      expect(r.body).toMatch(/advantage!<\/Say><Pause length="1"\/>/);
      expect(r.body).not.toMatch(/virtual|automated|assistant|\bAI\b|operator|press 0|transcrib|record/i);
      await testCallers.remove(tc.id, { actorId: ADMIN });
      expect((await hook('incoming', { From: e164(ME), CallSid: callSid() })).body).toContain(line.MESSAGES.unavailable);
    } finally { await lineOn(false); }
  });
});

// ── menu → Sasha ──────────────────────────────────────────────────────────────────────────────────────
describe('menu choice → ConversationRelay', () => {
  beforeAll(async () => { await lineOn(); await testCallers.add(ME, { actorId: ADMIN }); });
  afterAll(async () => { await lineOn(false); });
  test.each([['1', 'buyer'], ['2', 'seller'], ['3', 'pickup'], ['4', 'other']])('key %s connects to Sasha with reason %s, a signed ticket and the greeting', async (digit, reason) => {
    const cs = callSid();
    const r = await hook('menu', { From: e164(ME), CallSid: cs, Digits: digit }, { query: { attempt: '1' }, deps: { spentToday: async () => 0 } });
    const m = /<Connect action="([^"]+)"><ConversationRelay url="([^"]+)" welcomeGreeting="([^"]+)" language="en-US" ttsProvider="Google" voice="en-US-Chirp3-HD-Aoede" interruptible="any" dtmfDetection="true"><Parameter name="reason" value="([a-z]+)"\/><\/ConversationRelay><\/Connect><\/Response>$/.exec(r.body);
    expect(m).toBeTruthy();
    expect(m[1]).toBe(BASE() + '/api/voice/after');
    expect(m[3]).toBe('Thank you for calling Advantage.Bid. This is Sasha. How can I help you today?');
    expect(m[4]).toBe(reason);
    const url = new URL(m[2].replace(/&amp;/g, '&'));
    expect(url.protocol).toBe('wss:'); expect(url.pathname).toBe('/api/voice/relay');
    expect(line.verifyTicket(url.searchParams.get('t'))).toEqual({ callSid: cs, reason });
    expect(r.body).not.toMatch(/<Dial/);
  });
  test('no or invalid key: one re-prompt, then Sasha finds out what they need ("other")', async () => {
    const first = await hook('menu', { From: e164(ME), CallSid: callSid(), Digits: '9' }, { query: { attempt: '1' } });
    expect(first.body).toMatch(/Sorry, I didn&apos;t catch that\./);
    expect(first.body).toMatch(/action="[^"]+\/api\/voice\/menu\?attempt=2"/);
    expect(first.body).not.toMatch(/where you always get the advantage/);   // the welcome line is not repeated
    const second = await hook('menu', { From: e164(ME), CallSid: callSid(), Digits: '' }, { query: { attempt: '2' }, deps: { spentToday: async () => 0 } });
    expect(second.body).toMatch(/<Parameter name="reason" value="other"\/>/);
  });
  test('the menu step re-checks the staff list, the line switch, capacity and the daily budget', async () => {
    expect((await hook('menu', { From: e164(STRANGER), CallSid: callSid(), Digits: '1' })).body).toContain(line.MESSAGES.unavailable);
    expect((await hook('menu', { From: e164(ME), CallSid: callSid(), Digits: '1' }, { deps: { spentToday: async () => 999 } })).body).toContain(line.MESSAGES.busy);
    await setCfg('sasha.phone.max_concurrent_calls', 1);
    const conv = (await require('../../src/services/sasha/conversationService').createConversation({ channel: 'phone', subject: 'busy test' })).id;
    await q(`INSERT INTO cs_calls (conversation_id, provider, provider_call_id, is_simulated) VALUES ($1,'twilio_cr',$2,false)`, [conv, callSid()]);
    try { expect((await hook('menu', { From: e164(ME), CallSid: callSid(), Digits: '1' }, { deps: { spentToday: async () => 0 } })).body).toContain(line.MESSAGES.busy); }
    finally { await q(`UPDATE cs_calls SET status = 'completed' WHERE conversation_id = $1`, [conv]); await setCfg('sasha.phone.max_concurrent_calls', 10); }
    await lineOn(false);
    expect((await hook('menu', { From: e164(ME), CallSid: callSid(), Digits: '1' })).body).toContain(line.MESSAGES.unavailable);
    await lineOn(true);
  });
  test('after the session: goodbye, or a short apology if it failed; never a transfer', async () => {
    expect((await hook('after', { SessionStatus: 'completed', HandoffData: '' })).body).toContain(line.MESSAGES.goodbye);
    expect((await hook('after', { SessionStatus: 'failed', ErrorCode: '64101' })).body).toContain(xml(line.MESSAGES.failed));
    expect((await hook('after', { SessionStatus: 'ended', HandoffData: JSON.stringify({ action: 'busy' }) })).body).toContain(line.MESSAGES.busy);
    for (const b of [{}, { SessionStatus: 'failed' }]) expect((await hook('after', b)).body).not.toMatch(/<Dial|<Enqueue|<Redirect/);
  });
});

// ── tickets and the WebSocket handshake ────────────────────────────────────────────────────────────────
describe('relay ticket and WebSocket admission', () => {
  test('tickets are bound to the call and reason, expire, and cannot be forged or altered', () => {
    const t = line.issueTicket({ callSid: 'CA' + 'a'.repeat(32), reason: 'buyer' }, 1000);
    expect(line.verifyTicket(t, 2000)).toEqual({ callSid: 'CA' + 'a'.repeat(32), reason: 'buyer' });
    expect(line.verifyTicket(t, 1000 + line.TICKET_TTL_MS + 1)).toBeNull();
    const [p, s] = t.split('.');
    const altered = Buffer.from(JSON.stringify({ cs: 'CA' + 'b'.repeat(32), r: 'buyer', exp: 9e15 })).toString('base64url');
    expect(line.verifyTicket(altered + '.' + s, 2000)).toBeNull();
    expect(line.verifyTicket(p + '.' + s.slice(0, -2) + 'xx', 2000)).toBeNull();
    expect(line.verifyTicket('', 2000)).toBeNull();
  });
  test('the handshake is refused unless the line is on, the request is Twilio-signed and the ticket is valid', async () => {
    const ticket = line.issueTicket({ callSid: callSid(), reason: 'pickup' });
    const req = (sig, t = ticket) => ({ url: '/api/voice/relay?t=' + encodeURIComponent(t), headers: { 'x-twilio-signature': sig, host: 'bid.advantage.bid' } });
    expect(await relayServer.admit(req(GOOD), { validateRequest })).toMatchObject({ ok: false, status: 503 });   // line off
    await lineOn();
    try {
      expect(await relayServer.admit(req(undefined), { validateRequest })).toMatchObject({ ok: false, status: 403 });
      expect(await relayServer.admit(req('forged'), { validateRequest })).toMatchObject({ ok: false, status: 403 });
      expect(await relayServer.admit(req(GOOD, 'nope.nope'), { validateRequest })).toMatchObject({ ok: false, status: 403 });
      expect(await relayServer.admit(req(GOOD), { validateRequest })).toMatchObject({ ok: true, ticket: { reason: 'pickup' } });
      const seen = [];
      await relayServer.admit(req(GOOD), { validateRequest: (tok, sig, url) => { seen.push(url); return false; } });
      expect(seen).toEqual(expect.arrayContaining(['wss://bid.advantage.bid/api/voice/relay?t=' + encodeURIComponent(ticket), 'wss://bid.advantage.bid/api/voice/relay/?t=' + encodeURIComponent(ticket)]));
    } finally { await lineOn(false); }
  });
});

// ── live relay session ────────────────────────────────────────────────────────────────────────────────
describe('live relay session (twilio_cr) with the menu choice', () => {
  beforeAll(async () => { await lineOn(); });
  afterAll(async () => { await lineOn(false); });
  test('a setup for a different call than the ticket is refused', async () => {
    const out = [];
    const relay = new RelaySession((x) => out.push(x), { provider: 'twilio_cr', routingReason: 'buyer', expectCallSid: callSid(), providerGreeting: true });
    expect(await relay.onMessage({ type: 'setup', callSid: callSid(), from: e164(ME), to: '+15550001111' })).toEqual({ refused: true, code: 'CALL_MISMATCH' });
    expect(out).toEqual([{ type: 'end', handoffData: JSON.stringify({ action: 'unavailable', reason: 'call_mismatch' }) }]);
  });
  test('the menu choice reaches Sasha as call context; Twilio speaks the greeting, it is recorded once; the reason from the socket cannot override the ticket', async () => {
    const cs = callSid(); const out = [];
    const m = model([{ text: 'Not a problem. I can help you with that. I\'ll just need to verify your account first so I can give you the correct information.' }]);
    const relay = new RelaySession((x) => out.push(x), { provider: 'twilio_cr', routingReason: 'pickup', expectCallSid: cs, providerGreeting: true, deps: { client: m.client } });
    await relay.onMessage({ type: 'setup', callSid: cs, from: e164(ME), to: '+15550001111', customParameters: { reason: 'seller' } });
    expect(out.filter((x) => x.kind === 'greeting')).toHaveLength(0);   // Twilio's welcomeGreeting already said it
    const row = (await q(`SELECT routing_reason, conversation_id, provider FROM cs_calls WHERE provider_call_id = $1`, [cs]))[0];
    expect(row).toMatchObject({ routing_reason: 'pickup', provider: 'twilio_cr' });
    const msgs = await q(`SELECT author_type, body_text FROM cs_messages WHERE conversation_id = $1 ORDER BY created_at, id`, [row.conversation_id]);
    expect(msgs[0]).toMatchObject({ author_type: 'sasha', body_text: 'Thank you for calling Advantage.Bid. This is Sasha. How can I help you today?' });
    await relay.onMessage({ type: 'prompt', voicePrompt: 'I bought a dresser and need to know when I can pick it up.', last: true });
    const callState = m.calls[0].system[1].text;
    expect(callState).toMatch(/MENU CHOICE: the caller pressed 3 \(RECENT PURCHASE \/ PICKUP\)/);
    expect(callState).toMatch(/There is no live transfer to staff/);
    expect(out.some((x) => x.type === 'text' && /verify your account first/.test(x.token))).toBe(true);
    await relay.close();
  });
  test('the call time limit ends politely and Twilio is told to say goodbye (no transfer)', async () => {
    const cs = callSid(); const out = [];
    const relay = new RelaySession((x) => out.push(x), { provider: 'twilio_cr', routingReason: 'other', expectCallSid: cs, providerGreeting: true, deps: { client: model([]).client } });
    await relay.onMessage({ type: 'setup', callSid: cs, from: e164(ME), to: '+15550001111' });
    const ended = await relay.timeLimit();
    expect(ended).toMatchObject({ status: 'completed', end_reason: 'time_limit' });
    expect(out.slice(-2)).toEqual([{ type: 'text', token: expect.stringMatching(/time limit for this call/), last: true }, { type: 'end', handoffData: JSON.stringify({ action: 'goodbye', reason: 'time_limit' }) }]);
  });
  test('the simulator passes the menu choice the same way (customParameters)', async () => {
    const s = await sim.start({ actorId: ADMIN, routingReason: 'seller' }, { client: model([]).client });
    expect((await q(`SELECT routing_reason FROM cs_calls WHERE id = $1`, [s.call_id]))[0].routing_reason).toBe('seller');
    await sim.end(s.call_id, ADMIN);
  });
});

// ── Sasha on the phone ────────────────────────────────────────────────────────────────────────────────
describe('phone prompt and take-a-message', () => {
  test('identity is truthful only when asked, with the owner\'s wording; chat keeps its own', () => {
    const phone = engine.systemPrompt({ channel: 'phone' });
    expect(phone).toContain(`"${engine.PHONE_IDENTITY_ANSWER}"`);
    expect(engine.PHONE_IDENTITY_ANSWER).toBe("Yes, I'm Advantage.Bid's virtual assistant. I can help with bidding, invoices, payments, pickup information, seller questions, account assistance, and much more. What can I help you with today?");
    expect(phone).toMatch(/Do not call yourself an AI, bot, virtual or automated assistant unless asked/);
    expect(phone).toMatch(/Never claim to be human/);
    expect(engine.systemPrompt({ channel: 'chat' })).toContain(`"${engine.IDENTITY_ANSWER}"`);
  });
  test('human requests: capability first, at most once, then take a message; no transfer; permission before codes', () => {
    const phone = engine.systemPrompt({ channel: 'phone' });
    expect(phone).toMatch(/I'd be happy to help\. I can handle most Advantage\.Bid questions and account needs right here\./);
    expect(phone).toMatch(/Say this at most once and never argue/);
    expect(phone).toMatch(/offer to take a message for the Advantage\.Bid team \(request_callback/);
    expect(phone).not.toMatch(/A caller can ALWAYS get a person/);
    expect(phone).toMatch(/May I send a verification code to the mobile number or email on your Advantage\.Bid account\?/);
    expect(phone).toMatch(/Never read a stored number or email aloud/);
    expect(phone).toMatch(/TAKING A MESSAGE \(request_callback\)/);
  });
  test('take a message: name, callback number, email, reference and message reach the Shared Inbox as an open callback', async () => {
    const s = await sim.start({ actorId: ADMIN, callerNumber: '+15516167009', routingReason: 'seller' }, { client: model([]).client });
    const call = (await q(`SELECT * FROM cs_calls WHERE id = $1`, [s.call_id]))[0];
    const r = await tools.run('request_callback', { callback_number: 'caller_id', caller_name: 'Jordan Reyes', email: 'jordan@example.org', reference: 'Henderson Estate auction',
      reason: 'customer_request', summary: 'Wants to discuss consigning a large furniture collection.' }, { channel: 'phone', userId: null, phone: { call, callerE164: '+15516167009', deps: {} } });
    expect(r.note).toMatch(/get back to them as soon as possible at the number ending in 7009/);
    const h = (await q(`SELECT reason_text, callback_requested, callback_status, right(callback_phone_e164, 4) l4 FROM cs_handoffs WHERE conversation_id = $1`, [call.conversation_id]))[0];
    expect(h).toMatchObject({ callback_requested: true, callback_status: 'open', l4: '7009' });
    expect(h.reason_text).toBe('Name: Jordan Reyes. Callback number ending 7009. Email: jordan@example.org. About: Henderson Estate auction. Message: Wants to discuss consigning a large furniture collection.');
    await sim.end(s.call_id, ADMIN);
  });
});

// ── settings and the staff list ──────────────────────────────────────────────────────────────────────
describe('settings and staff test callers', () => {
  test('migration 191 defaults: staff-only access, the owner\'s greeting and menu, no notice; the old disclosure is not spoken', async () => {
    const s = await phoneSettings.load();
    expect(s).toMatchObject({ enabled: false, provider: 'none', access_mode: 'staff_only', call_notice: '',
      greeting: 'Thank you for calling Advantage.Bid. This is Sasha. How can I help you today?' });
    expect(phoneSettings.menuLines(s)).toHaveLength(5);
    expect(line.menuTwiml(s, { actionUrl: 'https://x/menu' })).not.toContain(s.disclosure_text);
  });
  test('test callers are stored as a hash and the last 4 digits only; invalid numbers are refused', async () => {
    const r = await testCallers.add('(551) 616-7055', { label: 'Staff phone', actorId: ADMIN });
    expect(r.phone_last4).toBe('7055');
    expect(JSON.stringify(await q(`SELECT * FROM cs_phone_test_callers`))).not.toMatch(/6167055|616-7055/);
    expect(await testCallers.isAllowed('+15516167055')).toBe(true);
    expect((await testCallers.add('+1 (551) 616-7055', { actorId: ADMIN })).already).toBe(true);
    await expect(testCallers.add('12345', { actorId: ADMIN })).rejects.toMatchObject({ code: 'INVALID_PHONE' });
    await expect(testCallers.add('(202) 555-0101', { actorId: ADMIN })).rejects.toMatchObject({ code: 'INVALID_PHONE' });
    await testCallers.remove(r.id, { actorId: ADMIN });
    expect(await testCallers.isAllowed('+15516167055')).toBe(false);
  });
});

// ── real HTTP server: the relay upgrade coexists with Socket.IO ────────────────────────────────────────
describe('WebSocket wiring on a real HTTP server', () => {
  test('relay handshakes are refused (line off / unsigned) and accepted only when signed + ticketed; Socket.IO still connects', async () => {
    const http = require('http'); const WebSocket = require('ws'); const { Server } = require('socket.io'); const ioClient = require('socket.io-client');
    const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    const io = new Server(server);
    io.on('connection', () => {});
    relayServer.attach(server, { validateRequest });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const tryWs = (path, headers = {}) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      ws.on('open', () => { resolve({ open: true, ws }); });
      ws.on('unexpected-response', (req, res) => resolve({ open: false, status: res.statusCode }));
      ws.on('error', () => resolve({ open: false, status: 'error' }));
    });
    try {
      const t = line.issueTicket({ callSid: callSid(), reason: 'buyer' });
      expect(await tryWs('/api/voice/relay?t=' + encodeURIComponent(t), { 'x-twilio-signature': GOOD })).toMatchObject({ open: false, status: 503 });
      await lineOn();
      expect(await tryWs('/api/voice/relay?t=' + encodeURIComponent(t))).toMatchObject({ open: false, status: 403 });
      expect(await tryWs('/api/voice/relay?t=bad', { 'x-twilio-signature': GOOD })).toMatchObject({ open: false, status: 403 });
      const ok = await tryWs('/api/voice/relay?t=' + encodeURIComponent(t), { 'x-twilio-signature': GOOD });
      expect(ok.open).toBe(true);
      ok.ws.close();
      const sock = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
      await new Promise((resolve, reject) => { sock.on('connect', resolve); sock.on('connect_error', reject); });
      sock.close();
    } finally { await lineOn(false); io.close(); await new Promise((r) => server.close(r)); }
  });
});

// ── regression: live call 2026-10-08 (Twilio 64107 "Unexpected fields: [kind]") ─────────────────────────
describe('live ConversationRelay outbound message schema', () => {
  // Twilio's documented outbound messages (independent of the code under test). Anything else is rejected (64107).
  const TWILIO_SCHEMA = { text: ['type', 'token', 'last', 'lang', 'interruptible', 'preemptible'], end: ['type', 'handoffData'] };
  test('a full live call over a real WebSocket sends only fields Twilio accepts, and Sasha\'s reply is actually spoken', async () => {
    const http = require('http'); const WebSocket = require('ws');
    const m = model([{ text: 'I\'d be happy to check that for you. I\'ll just need to verify your account first.' }]);
    const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    relayServer.attach(server, { validateRequest, callDeps: { client: m.client } });
    await new Promise((r) => server.listen(0, r));
    await lineOn();
    const received = [];
    try {
      const cs = callSid();
      const t = line.issueTicket({ callSid: cs, reason: 'buyer' });
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/voice/relay?t=${encodeURIComponent(t)}`, { headers: { 'x-twilio-signature': GOOD } });
      ws.on('message', (d) => received.push(JSON.parse(String(d))));
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'setup', callSid: cs, from: e164(ME), to: '+15550001111', customParameters: { reason: 'buyer' } }));
      ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'I recently bid on an item and I was wondering if I won it?', lang: 'en-US', last: true }));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !received.some((x) => x.type === 'text' && /verify your account/.test(x.token || ''))) await new Promise((r) => setTimeout(r, 50));
      const closed = new Promise((r) => ws.on('close', r)); ws.close(); await closed;
      expect(received.length).toBeGreaterThan(0);
      for (const msg of received) {
        expect(TWILIO_SCHEMA[msg.type]).toBeDefined();
        expect(Object.keys(msg).filter((k) => !TWILIO_SCHEMA[msg.type].includes(k))).toEqual([]);   // e.g. no `kind`
      }
      expect(received.filter((x) => x.type === 'text' && x.token).map((x) => x.token).join('')).toMatch(/I'd be happy to check that for you\./);
      expect(received.some((x) => x.type === 'text' && x.last === true)).toBe(true);
    } finally { await lineOn(false); await new Promise((r) => server.close(r)); }
  });
  test('the filter keeps protocol fields, drops internal labels, and never forwards unknown message types', () => {
    expect(relayServer.toTwilio({ type: 'text', token: 'Hi ', last: false, kind: 'speech' })).toEqual({ type: 'text', token: 'Hi ', last: false });
    expect(relayServer.toTwilio({ type: 'end', handoffData: '{"action":"busy"}', kind: 'x' })).toEqual({ type: 'end', handoffData: '{"action":"busy"}' });
    expect(relayServer.toTwilio({ type: 'debug', token: 'x' })).toBeNull();
    for (const [type, fields] of Object.entries(relayServer.ALLOWED_FIELDS)) expect(fields.every((f) => TWILIO_SCHEMA[type].includes(f))).toBe(true);
  });
});
