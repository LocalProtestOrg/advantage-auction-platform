'use strict';

/**
 * Phone Sasha conversational UX (migration 192): barge-in and preemption on the live ConversationRelay socket, turn
 * timing instrumentation, the concise phone style, live public rules pre-loaded by menu choice (with account access
 * unchanged), live pricing in Sasha's facts, and separate menu / Sasha voices. Real Postgres (PGlite), a real local
 * WebSocket server, injected Twilio signature checks, and a scripted streaming model; nothing reaches Twilio.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
delete process.env.SASHA_PHONE_SUPPORT_ALERT_E164S;
delete process.env.SASHA_PHONE_SMS_ENABLED;

jest.mock('../../src/db', () => require('./pgHarness').dbAdapter(() => global.__PG));
jest.setTimeout(60000);

const http = require('http');
const WebSocket = require('ws');
const { createDb } = require('./pgHarness');
const phoneSettings = require('../../src/services/sasha/phone/phoneSettings');
const line = require('../../src/services/sasha/phone/voiceLine');
const relayServer = require('../../src/services/sasha/phone/relayServer');
const engine = require('../../src/services/sasha/engine');
const tools = require('../../src/services/sasha/tools');
const sim = require('../../src/services/sasha/phone/phoneSimulator');
const platformFacts = require('../../src/services/sasha/knowledge/platformFacts');

const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const TOKEN = 'test-token-placeholder'; const GOOD = 'good-signature';
const validateRequest = (token, sig) => token === TOKEN && sig === GOOD;
const ENV = {}; let ADMIN; let seq = 0;
const callSid = () => 'CA' + String(++seq).padStart(32, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  global.__PG = await createDb();
  ADMIN = (await q(`INSERT INTO users (email, role, full_name) VALUES ('ux-admin@example.org','admin','UX Admin') RETURNING id`))[0].id;
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']) ENV[k] = process.env[k];
  process.env.TWILIO_ACCOUNT_SID = 'AC_test_placeholder'; process.env.TWILIO_AUTH_TOKEN = TOKEN;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const id of [...sim.SIMS.keys()]) await sim.end(id, ADMIN).catch(() => {});
  await global.__PG.close();
});
beforeEach(() => phoneSettings.clear());
const setCfg = async (key, value) => { await q(`INSERT INTO platform_config (key, value, category) VALUES ($1, $2::jsonb, 'x') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]); phoneSettings.clear(); };
const lineOn = async (on = true) => { await setCfg('sasha.phone.enabled', on); await setCfg('sasha.phone.provider', on ? 'twilio_cr' : 'none'); };

/** Streaming model. step: { text, tools, wordMs } — words arrive wordMs apart and stop as soon as the request is aborted. */
function model(steps) {
  const calls = [];
  async function* stream(step, signal) {
    yield { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    let i = 0;
    if (step.text) {
      yield { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } };
      for (const w of step.text.split(/(?<= )/)) {
        if (signal && signal.aborted) return;
        if (step.wordMs) await sleep(step.wordMs);
        if (signal && signal.aborted) return;
        yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: w } };
      }
      i++;
    }
    for (const t of step.tools || []) {
      yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'tu_' + (++seq), name: t.name, input: {} } };
      yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } }; i++;
    }
    yield { type: 'message_delta', delta: { stop_reason: (step.tools || []).length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 30 } };
  }
  return { calls, client: { messages: { create: async (params, opts) => { calls.push(params); const s = steps.length ? steps.shift() : { text: 'Anything else?' }; return stream(s, opts && opts.signal); } } } };
}

/** A live relay session over a real WebSocket (line on, Twilio-signed, ticketed). */
async function liveSession(m, reason = 'seller') {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  relayServer.attach(server, { validateRequest, callDeps: { client: m.client } });
  await new Promise((r) => server.listen(0, r));
  const cs = callSid();
  const t = line.issueTicket({ callSid: cs, reason });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/voice/relay?t=${encodeURIComponent(t)}`, { headers: { 'x-twilio-signature': GOOD } });
  const got = [];
  ws.on('message', (d) => got.push({ at: Date.now(), msg: JSON.parse(String(d)) }));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ type: 'setup', callSid: cs, from: '+15516168801', to: '+15550001111' }));
  await sleep(150);
  const close = async () => { const c = new Promise((r) => ws.on('close', r)); ws.close(); await c; await sleep(100); await new Promise((r) => server.close(r)); };
  const callRow = async () => (await q(`SELECT * FROM cs_calls WHERE provider_call_id = $1`, [cs]))[0];
  return { ws, got, close, callRow, cs };
}
const spokenTokens = (got) => got.filter((g) => g.msg.type === 'text' && g.msg.token).map((g) => g.msg.token.trim());
const waitFor = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(25); } return false; };
const LONG_A = 'One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve. Thirteen. Fourteen. Fifteen. Sixteen. Seventeen. Eighteen. Nineteen. Twenty.';

// ── barge-in ───────────────────────────────────────────────────────────────────────────────────────────
describe('barge-in and preemption on the live socket', () => {
  beforeAll(async () => { await lineOn(); });
  afterAll(async () => { await lineOn(false); });

  test('the connect TwiML enables barge-in, greeting interruption, preemption and backchannel tolerance', () => {
    const s = { ...phoneSettings.DEFAULTS, voice: { ...phoneSettings.DEFAULTS.voice } };
    const x = line.connectTwiml(s, { wsUrl: 'wss://x/api/voice/relay?t=1', actionUrl: 'https://x/after', reason: 'buyer' });
    for (const a of ['interruptible="any"', 'welcomeGreetingInterruptible="any"', 'preemptible="true"', 'ignoreBackchannel="true"', 'dtmfDetection="true"']) expect(x).toContain(a);
  });
  test('every spoken message reaches Twilio marked interruptible, with only documented fields', async () => {
    const m = model([{ text: 'For your own items there is no platform fee. Want me to go over payouts?' }]);
    const s = await liveSession(m);
    try {
      s.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'What are the seller fees?', last: true }));
      await waitFor(() => spokenTokens(s.got).length >= 2);
      const spoken = s.got.filter((g) => g.msg.type === 'text' && g.msg.token).map((g) => g.msg);
      expect(spoken.length).toBeGreaterThan(0);
      for (const msg of spoken) { expect(msg.interruptible).toBe(true); expect(Object.keys(msg).every((k) => ['type', 'token', 'last', 'interruptible', 'preemptible'].includes(k))).toBe(true); }
    } finally { await s.close(); }
  });
  test('a caller interruption stops the answer being generated: no further old speech, counted, timed, run marked interrupted', async () => {
    const m = model([{ text: LONG_A, wordMs: 120 }]);
    const s = await liveSession(m);
    const logs = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      s.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Tell me everything.', last: true }));
      expect(await waitFor(() => spokenTokens(s.got).length >= 2)).toBe(true);
      s.ws.send(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'One. Two.', durationUntilInterruptMs: 900 }));
      const at = Date.now();
      await sleep(1200);
      const after = s.got.filter((g) => g.at > at + 150 && g.msg.type === 'text' && g.msg.token);
      expect(after).toEqual([]);   // nothing more of the obsolete answer
      expect(spokenTokens(s.got)).not.toContain('Twenty.');
      const call = await s.callRow();
      expect(call.interruptions).toBe(1);
      const ev = await q(`SELECT event, detail FROM cs_call_timing_events WHERE call_id = $1 ORDER BY at`, [call.id]);
      expect(ev.find((e) => e.event === 'interrupt_received').detail).toEqual({ duration_ms: 900, played_chars: 9 });
      expect(ev.find((e) => e.event === 'generation_aborted').detail).toEqual({ reason: 'provider' });
      const run = (await q(`SELECT outcome_reason FROM cs_ai_runs WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [call.conversation_id]))[0];
      expect(run.outcome_reason).toBe('interrupted');
      expect(logs.mock.calls.some((c) => /\[voice-relay\] interrupt after 900 ms; generation aborted/.test(String(c[0])))).toBe(true);
    } finally { logs.mockRestore(); await s.close(); }
  });
  test('a new caller turn is answered right away, not queued behind the obsolete answer', async () => {
    const m = model([{ text: LONG_A, wordMs: 150 }, { text: 'Sure, payouts are processed every Thursday.' }]);
    const s = await liveSession(m);
    try {
      s.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Tell me everything.', last: true }));
      expect(await waitFor(() => spokenTokens(s.got).length >= 1)).toBe(true);
      const sentB = Date.now();
      s.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Actually, just tell me about payouts.', last: true }));
      expect(await waitFor(() => spokenTokens(s.got).some((t) => /payouts are processed/.test(t)), 2500)).toBe(true);
      const firstB = s.got.find((g) => g.msg.type === 'text' && /Sure, payouts/.test(g.msg.token || ''));
      expect(firstB.at - sentB).toBeLessThan(2000);   // the long answer A would have needed ~3 s more
      expect(s.got.filter((g) => g.at > firstB.at && g.msg.type === 'text' && /^(Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve)/.test((g.msg.token || '').trim()))).toEqual([]);
      const call = await s.callRow();
      const ev = await q(`SELECT event, detail FROM cs_call_timing_events WHERE call_id = $1 AND event = 'generation_aborted'`, [call.id]);
      expect(ev.map((e) => e.detail.reason)).toContain('new_prompt');
    } finally { await s.close(); }
  });
});

// ── instrumentation ────────────────────────────────────────────────────────────────────────────────────
describe('turn timing instrumentation', () => {
  test('a lookup turn records transcript, model request, first output, tool start/end, first audio and first sentence, with no caller words', async () => {
    const m = model([{ tools: [{ name: 'get_platform_rules', input: { topic: 'payouts' } }] }, { text: 'Payouts are processed every Thursday.' }]);
    const s = await sim.start({ actorId: ADMIN, routingReason: 'other' }, { client: m.client });
    await sim.say(s.call_id, ADMIN, 'When do sellers get paid? My cousin Bartholomew asked.');
    const ev = await q(`SELECT event, ms_from_turn_start, detail FROM cs_call_timing_events WHERE call_id = $1 ORDER BY at, ms_from_turn_start`, [s.call_id]);
    const names = ev.map((e) => e.event);
    for (const n of ['transcript_received', 'model_request', 'first_output', 'first_audio_sent', 'tool_start', 'tool_end', 'first_sentence_sent', 'turn_complete']) expect(names).toContain(n);
    expect(ev.find((e) => e.event === 'tool_end').detail).toMatchObject({ tool: 'get_platform_rules', timed_out: false, error: false });
    expect(ev.filter((e) => e.event === 'model_request')).toHaveLength(2);
    expect(ev.every((e) => e.ms_from_turn_start >= 0)).toBe(true);
    expect(JSON.stringify(ev)).not.toMatch(/Bartholomew|cousin|paid/);
    await sim.end(s.call_id, ADMIN);
  });
});

// ── concise phone style ────────────────────────────────────────────────────────────────────────────────
describe('concise conversational phone style', () => {
  test('the phone prompt asks for short conversational turns and keeps the seller-type clarifying question', () => {
    const p = engine.systemPrompt({ channel: 'phone' });
    expect(p).toMatch(/answer the caller's immediate question first, normally in about two to four short spoken sentences, then stop and let them respond/);
    expect(p).toMatch(/give it in natural chunks of a few sentences and check in between/);
    expect(p).toMatch(/Never speak headings or labels/);
    expect(p).toMatch(/never speak parenthetical asides/);
    expect(p).toMatch(/don't repeat anything you already told this caller unless they ask/);
    expect(p).toMatch(/Use the caller's name at most once/);
    expect(p).toMatch(/don't add another opener such as "Perfect", "Sure thing" or "Great question"/);
    expect(p).toMatch(/Are you selling some of your own items, or do you run an auction, estate-sale, antique, liquidation or other selling business\?/);   // preserved
    expect(p).not.toMatch(/50 words|fifty words/i);   // no simplistic word cap
  });
  test('the phone reply limit is a 200-token backstop', async () => {
    const m = model([{ text: 'Happy to help.' }]);
    const s = await sim.start({ actorId: ADMIN }, { client: m.client });
    await sim.say(s.call_id, ADMIN, 'Hi');
    expect(m.calls[0].max_tokens).toBe(200);
    await sim.end(s.call_id, ADMIN);
  });
});

// ── live public rules by menu choice ───────────────────────────────────────────────────────────────────
describe('core public rules in call context (live pricing; account access unchanged)', () => {
  afterAll(async () => { await q(`DELETE FROM platform_config WHERE key = 'pricing.auction.processing_fee_bps'`); });
  test('seller calls carry selling, fee and payout rules with the CURRENT admin processing fee; answering needs no lookup round-trip', async () => {
    await setCfg('pricing.auction.processing_fee_bps', 350);
    const m = model([{ text: 'For your own items there is no platform fee, just a 3.5% processing fee.' }]);
    const s = await sim.start({ actorId: ADMIN, routingReason: 'seller' }, { client: m.client });
    await sim.say(s.call_id, ADMIN, 'What are the seller fees for my own stuff?');
    const block = m.calls[0].system.find((b) => /^CORE PUBLIC RULES/.test(b.text));
    expect(block).toBeTruthy();
    expect(block.cache_control).toEqual({ type: 'ephemeral' });
    expect(block.text).toMatch(/\[selling\]/); expect(block.text).toMatch(/\[seller_fees\]/); expect(block.text).toMatch(/\[payouts\]/);
    expect(block.text).toMatch(/Individual sellers: no platform fee; a 3\.50% payment-processing fee/);
    expect(block.text).toMatch(/still needs the right tool and the caller's verification/);
    expect(m.calls).toHaveLength(1);   // one model call: no get_platform_rules round-trip
    await sim.end(s.call_id, ADMIN);
  });
  test('the rules tool uses the same live pricing (no second hard-coded source)', async () => {
    await setCfg('pricing.auction.processing_fee_bps', 350);
    const r = await tools.run('get_platform_rules', { topic: 'seller_fees' }, { channel: 'chat' });
    expect(r.seller_fees.facts.join(' ')).toMatch(/3\.50% payment-processing fee/);
    expect(platformFacts.getFacts('seller_fees').seller_fees.facts.join(' ')).toMatch(/3% payment-processing fee/);   // code default stays the fallback
    await q(`DELETE FROM platform_config WHERE key = 'pricing.auction.processing_fee_bps'`);
    expect((await platformFacts.getCurrentFacts('seller_fees')).seller_fees.facts.join(' ')).toMatch(/a 3% payment-processing fee/);
  });
  test('buyer calls carry bidding, premium, payment and pickup rules; "other" carries none', async () => {
    const mb = model([{ text: 'Sure.' }]);
    const b = await sim.start({ actorId: ADMIN, routingReason: 'buyer' }, { client: mb.client });
    await sim.say(b.call_id, ADMIN, 'How does bidding work?');
    const bt = mb.calls[0].system.map((x) => x.text).join('\n');
    for (const t of ['[bidding]', '[buyer_premium]', '[payment]', '[pickup]']) expect(bt).toContain(t);
    await sim.end(b.call_id, ADMIN);
    const mo = model([{ text: 'Sure.' }]);
    const o = await sim.start({ actorId: ADMIN, routingReason: 'other' }, { client: mo.client });
    await sim.say(o.call_id, ADMIN, 'Hello');
    expect(mo.calls[0].system.some((x) => /^CORE PUBLIC RULES/.test(x.text))).toBe(false);
    await sim.end(o.call_id, ADMIN);
  });
  test('pre-loaded rules never unlock account data: an unverified caller still has no account tools and is refused', async () => {
    const m = model([{ text: 'I can check that once I verify your account.' }]);
    const s = await sim.start({ actorId: ADMIN, routingReason: 'buyer' }, { client: m.client });
    await sim.say(s.call_id, ADMIN, 'Did I win my lot?');
    const names = (m.calls[0].tools || []).map((t) => t.name);
    expect(names.some((n) => n.startsWith('get_my_') || n === 'send_payment_link' || n === 'send_text')).toBe(false);
    const call = (await q(`SELECT * FROM cs_calls WHERE id = $1`, [s.call_id]))[0];
    expect((await tools.run('get_my_bids', {}, { channel: 'phone', userId: null, phone: { call, deps: {} } })).error).toMatch(/not verified/);
    expect(m.calls[0].system.find((b) => /^CORE PUBLIC RULES/.test(b.text)).text).not.toMatch(/@|\+1\d{10}/);
    await sim.end(s.call_id, ADMIN);
  });
});

// ── voices ─────────────────────────────────────────────────────────────────────────────────────────────
describe('separate menu and Sasha voices', () => {
  test('the menu and call messages use the British menu voice; Sasha keeps her own voice', async () => {
    const s = await phoneSettings.load();
    expect(s.menu_voice).toEqual({ tts_provider: 'Amazon', voice: 'Amy-Generative', language: 'en-GB' });
    expect(s.voice).toMatchObject({ tts_provider: 'Google', voice: 'en-US-Chirp3-HD-Aoede' });
    expect(line.menuTwiml(s, { actionUrl: 'https://x/menu' })).toMatch(/<Say voice="Polly\.Amy-Generative">Thank you for calling Advantage\.Bid, where you always get the advantage!<\/Say>/);
    expect(line.afterTwiml(s, { sessionStatus: 'completed' })).toContain('<Say voice="Polly.Amy-Generative">');
    const c = line.connectTwiml(s, { wsUrl: 'wss://x/r', actionUrl: 'https://x/a', reason: 'buyer' });
    expect(c).toContain('ttsProvider="Google" voice="en-US-Chirp3-HD-Aoede"');
    expect(c).not.toContain('Amy');
  });
  test('the menu voice is configurable independently; unsupported <Say> providers fall back to the menu default', async () => {
    await setCfg('sasha.phone.menu_voice', { tts_provider: 'Google', voice: 'en-GB-Chirp3-HD-Leda', language: 'en-GB' });
    const s = await phoneSettings.load();
    expect(line.menuTwiml(s, { actionUrl: 'https://x/menu' })).toContain('<Say voice="Google.en-GB-Chirp3-HD-Leda">');
    expect(s.voice.voice).toBe('en-US-Chirp3-HD-Aoede');   // Sasha unchanged
    expect(line.sayVoice({ tts_provider: 'ElevenLabs', voice: 'abc' })).toBe('Polly.Amy-Generative');
    await setCfg('sasha.phone.menu_voice', { tts_provider: 'Amazon', voice: 'Amy-Generative', language: 'en-GB' });
  });
});
