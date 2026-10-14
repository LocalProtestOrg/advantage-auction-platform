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
  test('the phone output ceiling leaves room for reasoning, tool use and a complete answer (technical ceiling, not a length target)', async () => {
    const m = model([{ text: 'Happy to help.' }]);
    const s = await sim.start({ actorId: ADMIN }, { client: m.client });
    await sim.say(s.call_id, ADMIN, 'Hi');
    expect(m.calls[0].max_tokens).toBe(engine.PHONE_MAX_OUTPUT_TOKENS);
    expect(engine.PHONE_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(1024);
    await sim.end(s.call_id, ADMIN);
  });
});

// ── reasoning-heavy turns and the output ceiling (Phone Sasha Certification 2026-10-09) ───────────────────
describe('reasoning-heavy turns never end empty, holding-only or cut off by the output ceiling', () => {
  const { RECOVERY } = require('../../src/services/sasha/phone/callSession');
  const { FILLERS } = require('../../src/services/sasha/phone/speech');
  /** A model whose turns may reason first and may stop at the ceiling ({ thinking, text, partialTool, stop }). */
  function reasoningModel(steps) {
    const calls = [];
    async function* stream(step) {
      yield { type: 'message_start', message: { usage: { input_tokens: 100 } } };
      let i = 0;
      if (step.thinking) {
        yield { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } };
        yield { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: step.thinking } }; i++;
      }
      if (step.text) {
        yield { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } };
        for (const w of step.text.split(/(?<= )/)) yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: w } };
        i++;
      }
      if (step.partialTool) {
        yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'tu_' + (++seq), name: step.partialTool, input: {} } };
        yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: '{"wor' } }; i++;
      }
      yield { type: 'message_delta', delta: { stop_reason: step.stop || 'end_turn' }, usage: { output_tokens: step.stop === 'max_tokens' ? engine.PHONE_MAX_OUTPUT_TOKENS : 60 } };
    }
    return { calls, client: { messages: { create: async (params) => { calls.push(params); return stream(steps.length ? steps.shift() : { text: 'Anything else?' }); } } } };
  }
  const LONG_THOUGHT = 'The caller asks about maximum bids. '.repeat(40);
  async function turn(steps, said = 'If I bid 500 do I pay 500?') {
    const m = reasoningModel(steps);
    const ran = jest.spyOn(tools, 'run');
    const s = await sim.start({ actorId: ADMIN, routingReason: 'buyer' }, { client: m.client });
    try {
      const r = await sim.say(s.call_id, ADMIN, said);
      const spoken = r.turn.filter((x) => x.type === 'text' && x.token).map((x) => x.token.trim());
      const run = (await q(`SELECT r.outcome, r.outcome_reason FROM cs_ai_runs r JOIN cs_calls c ON c.conversation_id = r.conversation_id WHERE c.id = $1 ORDER BY r.created_at DESC LIMIT 1`, [s.call_id]))[0];
      return { spoken, run, toolRuns: ran.mock.calls.length, calls: m.calls };
    } finally { ran.mockRestore(); await sim.end(s.call_id, ADMIN); }
  }
  const isHolding = (t) => FILLERS.includes(t) || Object.values(engine.PROGRESS_PHRASES).includes(t) || engine.PROGRESS_UPDATES.includes(t);

  test('reasoning that uses the whole ceiling never leaves silence: the recovery line is spoken and the run says why', async () => {
    const t = await turn([{ thinking: LONG_THOUGHT, stop: 'max_tokens' }]);
    expect(t.spoken.length).toBeGreaterThan(0);
    expect(t.spoken[t.spoken.length - 1]).toBe(RECOVERY);
    expect(t.run).toMatchObject({ outcome: 'error', outcome_reason: 'output_ceiling' });
  });
  test('reasoning then a half-written lookup at the ceiling never ends on only a holding phrase, and the half-written tool never runs', async () => {
    const t = await turn([{ thinking: LONG_THOUGHT, partialTool: 'search_help_center', stop: 'max_tokens' }], 'Can you cancel my bid?');
    expect(t.spoken.some(isHolding)).toBe(true);                       // the holding phrase played when the lookup began...
    expect(t.spoken.every(isHolding)).toBe(false);                     // ...but the turn did not end there
    expect(t.spoken[t.spoken.length - 1]).toBe(RECOVERY);
    expect(t.toolRuns).toBe(0);
    expect(t.run.outcome_reason).toBe('output_ceiling');
  });
  test('an answer stopped by the ceiling is never spoken mid-sentence: complete sentences stand, the fragment is dropped', async () => {
    const t = await turn([{ thinking: LONG_THOUGHT, text: 'Not necessarily. Your five hundred dollars is a maximum, not the price. So if the next highest bid is', stop: 'max_tokens' }]);
    expect(t.spoken).toEqual(['Not necessarily.', 'Your five hundred dollars is a maximum, not the price.']);
    expect(t.spoken.join(' ')).not.toMatch(/next highest bid is/);
    expect(t.run).toMatchObject({ outcome: 'replied', outcome_reason: 'output_ceiling' });
  });
  test('a turn whose only words are a holding phrase is never accepted as an answer (no ceiling involved)', async () => {
    const t = await turn([{ text: 'One moment, please.', partialTool: 'search_help_center', stop: 'end_turn' }], 'What is the return policy?');
    expect(t.spoken.every(isHolding)).toBe(false);
  });
  test('normal reasoning followed by a complete short answer is spoken in full, with no recovery line', async () => {
    const t = await turn([{ thinking: 'Short check of the max-bid rule.', text: 'Not necessarily. You pay the winning price, which can be less than your maximum.' }]);
    expect(t.spoken).toEqual(['Not necessarily.', 'You pay the winning price, which can be less than your maximum.']);
    expect(t.spoken).not.toContain(RECOVERY);
    expect(t.run).toMatchObject({ outcome: 'replied', outcome_reason: null });
  });
  test('the ceiling is sized for reasoning plus a lookup plus a short spoken answer, while spoken length stays governed by the conversational rules', () => {
    expect(engine.PHONE_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(1024);
    const p = engine.systemPrompt({ channel: 'phone' });
    expect(p).toMatch(/normally in about two to four short spoken sentences, then stop and let them respond/);
    expect(p).toMatch(/give it in natural chunks of a few sentences and check in between/);
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
    expect(block.text).toMatch(/Individual sellers: no platform fee; the standard 3\.50% payment-processing fee/);
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
  test('buyer calls carry bidding, premium, payment and pickup rules; "other" carries only contact and account basics', async () => {
    const mb = model([{ text: 'Sure.' }]);
    const b = await sim.start({ actorId: ADMIN, routingReason: 'buyer' }, { client: mb.client });
    await sim.say(b.call_id, ADMIN, 'How does bidding work?');
    const bt = mb.calls[0].system.map((x) => x.text).join('\n');
    for (const t of ['[bidding]', '[buyer_premium]', '[payment]', '[pickup]']) expect(bt).toContain(t);
    await sim.end(b.call_id, ADMIN);
    const mo = model([{ text: 'Sure.' }]);
    const o = await sim.start({ actorId: ADMIN, routingReason: 'other' }, { client: mo.client });
    await sim.say(o.call_id, ADMIN, 'Hello');
    const other = mo.calls[0].system.find((x) => /^CORE PUBLIC RULES/.test(x.text)).text;
    expect(other).toMatch(/\[contact\]/); expect(other).toMatch(/\[account\]/); expect(other).not.toMatch(/\[bidding\]|\[seller_fees\]/);
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
    // No account data: the only email in the rules is Advantage.Bid's own public support address.
    expect(m.calls[0].system.find((b) => /^CORE PUBLIC RULES/.test(b.text)).text.replace(/info@advantage\.bid/g, '')).not.toMatch(/@|\+1\d{10}/);
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

// ── seller content after live call #4 (2026-10-09) ────────────────────────────────────────────────────
describe('seller guidance: lot minimum, dimensions, easy listing, benefits, marketing, payouts', () => {
  const facts = (t) => platformFacts.getFacts(t)[t].facts.join('\n');
  test('30-lot rule: grouping is only a listing tip and never a way to reach the minimum (it lowers the lot count); no exceptions talk', () => {
    const s = facts('selling');
    expect(s).toMatch(/every auction needs at least 30 lots to be submitted or published/);
    expect(s).toMatch(/Combining items into one lot LOWERS the number of lots, so grouping never helps anyone reach 30/);
    expect(s).toMatch(/Grouping is only a listing tip for items that naturally belong together/);
    expect(s).toMatch(/not even to say there are none or that you cannot make one/);
    expect(s).not.toMatch(/smaller pieces can be grouped into one lot/);
    expect(s).not.toMatch(/group (several|a few)[^.]*to (help )?reach/i);
  });
  test('certification corrections live in the authoritative rules, not in a script (2026-10-09)', () => {
    const all = platformFacts.getFacts('all');
    const t = (k) => all[k].facts.join('\n');
    expect(t('bidding')).toMatch(/The trigger is always 2 minutes or less, whatever time the caller mentions/);
    expect(t('bidding')).toMatch(/Bids are binding \(Terms of Service section 10\)/);
    expect(t('bidding')).toMatch(/Advantage\.Bid may reject or cancel bids in its sole discretion/);
    expect(t('payment')).toMatch(/Buyers never pay the payment-processing fee: that is a SELLER fee .* for Individual and Professional Sellers alike/);
    expect(t('payment')).toMatch(/Uploading alone does not make purchases exempt/);
    expect(t('buyer_premium')).toMatch(/Do not tell buyers who receives the premium/);
    expect(t('buyer_policies')).toMatch(/sold as is, where is, with all faults/);
    expect(t('buyer_policies')).toMatch(/Refunds \(Terms of Service section 25\)/);
    expect(t('buyer_policies')).toMatch(/Advantage\.Bid does not currently offer price matching\. No Advantage\.Bid source describes buyer insurance, purchase protection plans/);
    expect(t('seller_benefits')).toMatch(/Do not reassure them with competition, marketing, the soft close/);
    expect(t('programs')).toMatch(/Advantage\.Bid Auction Partner Program \(always use this name; if the caller calls it something else, such as "Founding Partner", do not repeat their term/);
    expect(t('programs')).toMatch(/Do not pitch it, do not promise an invitation/);
    expect(t('programs')).toMatch(/Advantage.Bid does not currently offer a paid Estate Sale Promotion/);   // owner round 4: not a confirmed offering
    expect(t('programs')).not.toMatch(/\$39/);
    expect(t('programs')).toMatch(/Do not state anything about Advantage\.Bid's history, founding date, years in business/);
    const p = engine.systemPrompt({ channel: 'phone' });
    expect(p).toMatch(/if your tools don't state it, say you don't have that information rather than saying it does or doesn't exist/);
    expect(p).toMatch(/When a source does not support a detail, do not make it up/);
    expect(p).toMatch(/never give tax, legal or chargeback advice/);
  });
  test('live switches decide what the rules promise: ending-soon reminders, auction text alerts, phone needed to bid', () => {
    const off = platformFacts.getFacts('all', { processingBps: 300, endingSoonReminder: false, auctionTextAlerts: false, phoneRequiredToBid: false });
    expect(off.account.facts.join('\n')).not.toMatch(/Ending-soon reminder/);
    expect(off.account.facts.join('\n')).toMatch(/Auction text alerts are not being sent at this time/);
    expect(off.seller_benefits.facts.join('\n')).not.toMatch(/ending-soon reminder/);
    expect(off.bidding.facts.join('\n')).not.toMatch(/verify your mobile number/);
    const on = platformFacts.getFacts('all', { processingBps: 300, endingSoonReminder: true, auctionTextAlerts: true, phoneRequiredToBid: true });
    expect(on.account.facts.join('\n')).toMatch(/Ending-soon reminder: a buyer who has saved a lot to their watchlist, or bid on it/);
    expect(on.account.facts.join('\n')).toMatch(/a text only if they have opted in to auction text alerts/);
    expect(on.bidding.facts.join('\n')).toMatch(/to verify your mobile number/);
  });
  test('dimensions: optional but highly recommended where size matters, with the buyer benefit', () => {
    const s = facts('selling');
    expect(s).toMatch(/measurements are optional, but highly recommended for anything where size matters/);
    expect(s).toMatch(/help buyers bid with confidence and plan pickup/);
    expect(s).toMatch(/The size category is always required/);
  });
  test('easy listing describes only live tools (phone photos, Smart Description review, photo enhancement) with no AI wording or overpromise', () => {
    const s = facts('selling');
    expect(s).toMatch(/start a lot simply by taking photos of the item with their phone \(up to 20 photos per lot\)/);
    expect(s).toMatch(/Smart Description tool can then suggest a title, a short description and a category from the photos, which the seller reviews and adjusts before saving/);
    expect(s).toMatch(/photo enhancement can automatically clean up the background/);
    expect(s).toMatch(/there is no one-photo-per-lot bulk upload/);
    expect(s).not.toMatch(/state-of-the-art|\bBreeze\b/i);
    expect(s).toMatch(/Never call these tools AI/);
  });
  test('seller benefits: marketing and exposure, bidding, payments, payouts; individual vs professional value; no invented guarantees', () => {
    const b = facts('seller_benefits');
    expect(b).toMatch(/Marketing and exposure: every published auction is automatically listed on the Advantage\.Bid marketplace/);
    expect(b).toMatch(/search-engine-friendly auction and lot pages/);
    expect(b).toMatch(/ending-soon reminder/);
    expect(b).toMatch(/card on file is charged automatically when the auction closes, so the seller never has to chase or collect payments/);
    expect(b).toMatch(/INDIVIDUAL Sellers in particular: no commission and nothing to pay upfront to list, only a 3% processing fee/);
    expect(b).toMatch(/PROFESSIONAL Sellers in particular \(lead with the seller's own business benefit\)/);
    expect(b).toMatch(/embeddable auction widget, so the same auctions appear on their site and on the Advantage\.Bid marketplace at the same time/);
    expect(b).toMatch(/never quote a standard percentage/);
    expect(b).toMatch(/Storefront items support Buy Now \(fixed-price purchase\) as a platform capability/);   // owner decision 2026-10-12
    const sf = platformFacts.getFacts('storefront').storefront.facts.join('\n');
    expect(sf).toMatch(/Never tell a caller that a particular item can be bought online right now unless current listing or tool data shows it/);
    const pol = platformFacts.getFacts('buyer_policies').buyer_policies.facts.join('\n');
    expect(pol).toMatch(/Never make a blanket promise such as "ships nationwide" and never imply every item can be shipped/);
    const fees = platformFacts.getFacts('seller_fees').seller_fees.facts.join('\n');
    expect(fees).toMatch(/Never quote a standard or default Professional Seller platform-fee percentage/);
    expect(fees).toMatch(/Professional Seller pricing is established for each seller in their agreement/);
    const progs = platformFacts.getFacts('programs').programs.facts.join('\n');
    expect(progs).toMatch(/Do not describe, promote or quote any price for it; if asked, say it is not currently offered/);
    expect(b).toMatch(/Do NOT mention: neighborhood "Sales Near You" emails, paid promotion packages, social media posting or ads/);
    expect(b).not.toMatch(/guarantee(d)? (sale|bidders|traffic)|\d+,?\d* (bidders|visitors)|nationwide/i);
  });
  test('payouts: direct deposit is mentioned as the way sellers get paid, a mailed check remains available, bank details stay with Stripe', () => {
    const p = facts('payouts');
    expect(p).toMatch(/HOW SELLERS GET PAID \(mention this whenever you explain payouts, without waiting to be asked\): by direct deposit \(ACH\)/);
    expect(p).toMatch(/A mailed check is also available if the seller prefers/);
    expect(p).toMatch(/Advantage\.Bid never sees the full account number/);
    expect(p).toMatch(/processes eligible seller payouts every Thursday/);
  });
  test('the phone prompt makes Sasha a conversational seller representative without monologues', () => {
    const p = engine.systemPrompt({ channel: 'phone' });
    expect(p).toMatch(/PROSPECTIVE SELLERS: .*be a knowledgeable, friendly sales representative, not a brochure/);
    expect(p).toMatch(/Keep answering the question they asked first, in a few sentences/);
    expect(p).toMatch(/Make sure marketing and exposure come up/);
    expect(p).toMatch(/Would you like me to walk you through those\?/);
    expect(p).toMatch(/Never stack several benefits into one long answer, never repeat a benefit already mentioned, and never promise results, traffic or sale prices/);
    expect(p).toMatch(/normally in about two to four short spoken sentences/);   // brevity kept
    expect(engine.systemPrompt({ channel: 'chat' })).not.toMatch(/PROSPECTIVE SELLERS/);
  });
  test('seller calls pre-load the benefits with the live processing fee; account data still needs verification', async () => {
    await setCfg('pricing.auction.processing_fee_bps', 350);
    const m = model([{ text: 'For your own items there is no commission.' }]);
    const s = await sim.start({ actorId: ADMIN, routingReason: 'seller' }, { client: m.client });
    await sim.say(s.call_id, ADMIN, 'Why should I sell with you?');
    const block = m.calls[0].system.find((b) => /^CORE PUBLIC RULES/.test(b.text)).text;
    expect(block).toMatch(/\[seller_benefits\] Marketing and exposure/);
    expect(block).toMatch(/\[seller_benefits\] INDIVIDUAL Sellers in particular: no commission and nothing to pay upfront to list, only a 3\.50% processing fee/);
    expect(block).toMatch(/\[payouts\] HOW SELLERS GET PAID/);
    expect((m.calls[0].tools || []).map((t) => t.name).some((n) => n.startsWith('get_my_'))).toBe(false);
    await sim.end(s.call_id, ADMIN);
    await q(`DELETE FROM platform_config WHERE key = 'pricing.auction.processing_fee_bps'`);
  });
});

// ── menu-to-Sasha ring, texting availability, Individual Seller bidding wording (2026-10-09) ─────────────
describe('menu-to-Sasha transition ring', () => {
  const voice = require('../../src/routes/voice');
  const testCallers = require('../../src/services/sasha/phone/testCallers');
  const fs = require('fs');
  const BASE = () => require('../../src/lib/publicUrls').publicBaseUrl().replace(/\/+$/, '');
  async function menuHook(body, deps = {}) {
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, type() { return this; }, send(b) { this.body = b; if (this.code == null) this.code = 200; return this; } };
    const req = { body, query: { attempt: '1' }, originalUrl: '/api/voice/menu?attempt=1', get: (h) => ({ 'x-twilio-signature': GOOD, host: 'bid.advantage.bid' })[String(h).toLowerCase()] };
    let ok = false; voice._handlers.guard({ validateRequest })(req, res, () => { ok = true; });
    if (ok) await voice._handlers.menu({ spentToday: async () => 0, ...deps })(req, res);
    return res;
  }
  beforeAll(async () => { await lineOn(); await testCallers.add('(551) 616-8899', { actorId: ADMIN }); });
  afterAll(async () => { await lineOn(false); });

  test('one ring cycle plays exactly once, after the key press and before Sasha connects', async () => {
    const r = await menuHook({ From: '+15516168899', CallSid: callSid(), Digits: '2' });
    expect((r.body.match(/<Play>/g) || [])).toHaveLength(1);
    expect(r.body).toMatch(new RegExp(`<Response><Play>${BASE().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/audio/connecting-ring\\.wav</Play><Connect action=`));
    expect(r.body.indexOf('<Play>')).toBeLessThan(r.body.indexOf('<ConversationRelay'));
    expect(r.body).not.toMatch(/Connecting you|<Pause/);
  });
  test('no ring on the menu, the re-prompt, or refusals', async () => {
    const s = await phoneSettings.load();
    expect(line.menuTwiml(s, { actionUrl: 'https://x/menu' })).not.toMatch(/<Play>/);
    expect((await menuHook({ From: '+15516168899', CallSid: callSid(), Digits: '9' })).body).not.toMatch(/<Play>/);
    expect((await menuHook({ From: '+15516168800', CallSid: callSid(), Digits: '1' })).body).not.toMatch(/<Play>|<Connect/);   // not on the staff list
  });
  test('if the sound is missing or switched off, the call still goes straight to Sasha', async () => {
    const missing = await menuHook({ From: '+15516168899', CallSid: callSid(), Digits: '1' }, { fileExists: () => false });
    expect(missing.body).not.toMatch(/<Play>/);
    expect(missing.body).toMatch(/<Response><Connect action="[^"]+"><ConversationRelay /);
    await setCfg('sasha.phone.transition_audio', false);
    try {
      const off = await menuHook({ From: '+15516168899', CallSid: callSid(), Digits: '1' });
      expect(off.body).not.toMatch(/<Play>/); expect(off.body).toMatch(/<Connect /);
    } finally { await setCfg('sasha.phone.transition_audio', true); }
  });
  test('the ring is one standard US ringback cycle: 440 + 480 Hz, 2 s tone then 0.5 s quiet, 8 kHz mono 16-bit, subtle level', () => {
    const b = fs.readFileSync(line.RING_FILE);
    expect(b.toString('ascii', 0, 4)).toBe('RIFF'); expect(b.toString('ascii', 8, 12)).toBe('WAVE');
    expect(b.readUInt16LE(20)).toBe(1); expect(b.readUInt16LE(22)).toBe(1); expect(b.readUInt32LE(24)).toBe(8000); expect(b.readUInt16LE(34)).toBe(16);
    const samples = b.readUInt32LE(40) / 2;
    expect(samples / 8000).toBeCloseTo(2.5, 2);
    let peak = 0; for (let i = 0; i < 16000; i++) peak = Math.max(peak, Math.abs(b.readInt16LE(44 + i * 2)));
    expect(peak).toBeGreaterThan(3000); expect(peak).toBeLessThan(9000);   // audible but soft (about -11 dBFS peak)
    let tail = 0; for (let i = 16000; i < samples; i++) tail = Math.max(tail, Math.abs(b.readInt16LE(44 + i * 2)));
    expect(tail).toBe(0);
    // energy at 440 Hz and 480 Hz, nothing at 1 kHz (simple DFT over the tone)
    const mag = (f) => { let re = 0, im = 0; for (let i = 1000; i < 9000; i++) { const v = b.readInt16LE(44 + i * 2); re += v * Math.cos(2 * Math.PI * f * i / 8000); im += v * Math.sin(2 * Math.PI * f * i / 8000); } return Math.hypot(re, im); };
    expect(mag(440)).toBeGreaterThan(20 * mag(1000)); expect(mag(480)).toBeGreaterThan(20 * mag(1000));
  });
});

describe('texting is offered only when it is really available', () => {
  const phoneTools = require('../../src/services/sasha/phone/phoneTools');
  const phoneSms = require('../../src/services/sasha/phone/phoneSms');
  const { PhoneCall } = require('../../src/services/sasha/phone/callSession');
  const names = (ctx) => phoneTools.toolsFor(ctx).map((t) => t.name);
  test('tools: unverified callers get no texting tools; verified callers get send_text only when texting is available, otherwise payment links by email only', () => {
    expect(names({ userId: null, phone: {} })).not.toEqual(expect.arrayContaining(['send_text']));
    expect(names({ userId: 'u', phone: { textingAvailable: true } })).toEqual(expect.arrayContaining(['send_text', 'send_payment_link']));
    const off = phoneTools.toolsFor({ userId: 'u', phone: { textingAvailable: false } });
    expect(off.map((t) => t.name)).not.toContain('send_text');
    const pl = off.find((t) => t.name === 'send_payment_link');
    expect(pl.input_schema.properties.delivery.enum).toEqual(['email']);
    expect(pl.description).toMatch(/Texting is not available on this call, so the link goes to the email address on their account/);
  });
  test('simulations mirror production texting: unavailable while the live switch is off (no offers, no send_text), unless a test opts in', async () => {
    const prev = process.env.SASHA_PHONE_SMS_ENABLED;
    try {
      delete process.env.SASHA_PHONE_SMS_ENABLED;
      await lineOn();
      expect(await phoneSms.available({ is_simulated: true }, '+12025550111')).toBe(false);
      expect(await phoneSms.available({ is_simulated: true }, '+12025550111', { simulateTexting: true })).toBe(true);
      process.env.SASHA_PHONE_SMS_ENABLED = 'true'; phoneSettings.clear();
      expect(await phoneSms.available({ is_simulated: true }, '+12025550111')).toBe(true);
    } finally { if (prev === undefined) delete process.env.SASHA_PHONE_SMS_ENABLED; else process.env.SASHA_PHONE_SMS_ENABLED = prev; await lineOn(false); }
    expect(phoneTools.toolsFor({ userId: 'u', phone: { textingAvailable: false } }).map((t) => t.name)).not.toContain('send_text');
  });
  test('no internal infrastructure names in anything Sasha reads as a tool description', () => {
    const all = [...phoneTools.toolsFor({ userId: 'u', phone: { textingAvailable: true } }), ...phoneTools.toolsFor({ userId: 'u', phone: { textingAvailable: false } }),
      ...tools.toolsFor({ channel: 'phone', userId: 'u' })];
    for (const t of all) expect(t.description).not.toMatch(/Railway|Neon|Cloudinary|Postmark|Twilio/);
  });
  test('availability: real calls need in-call texting switched on; numbers that replied STOP are never available', async () => {
    const prev = process.env.SASHA_PHONE_SMS_ENABLED;
    try {
      delete process.env.SASHA_PHONE_SMS_ENABLED;
      await lineOn();
      expect(await phoneSms.available({ is_simulated: false }, '+15516168877')).toBe(false);
      process.env.SASHA_PHONE_SMS_ENABLED = 'true'; phoneSettings.clear();
      expect(await phoneSms.available({ is_simulated: false }, '+15516168877')).toBe(true);
      await require('../../src/services/smsSuppressionService').suppress('+15516168877', { reason: 'admin' });
      expect(await phoneSms.available({ is_simulated: false }, '+15516168877')).toBe(false);
      expect(await phoneSms.available({ is_simulated: false }, null)).toBe(false);
    } finally { if (prev === undefined) delete process.env.SASHA_PHONE_SMS_ENABLED; else process.env.SASHA_PHONE_SMS_ENABLED = prev; await lineOn(false); }
  });
  test('the tools refuse a text when texting is unavailable and point Sasha to the email / website alternative', async () => {
    const s = await sim.start({ actorId: ADMIN }, { client: model([]).client });
    const call = (await q(`SELECT * FROM cs_calls WHERE id = $1`, [s.call_id]))[0];
    const ctx = { channel: 'phone', userId: ADMIN, phone: { call, sessionId: null, textingAvailable: false, deps: {} } };
    expect((await tools.run('send_text', { what: 'invoices_page' }, ctx))).toMatchObject({ sent: false, note: expect.stringMatching(/Texting is not available on this call\. Do not offer it/) });
    expect((await tools.run('send_payment_link', { invoice_number: 'INV-1', delivery: 'text' }, ctx))).toMatchObject({ sent: false, note: expect.stringMatching(/Offer to email the secure payment link/) });
    await sim.end(s.call_id, ADMIN);
  });
  test('CALL STATE tells Sasha whether texting is available, and the phone prompt forbids offering texts otherwise', async () => {
    const c = new PhoneCall({ id: 'x', verification_state: 'anonymous', routing_reason: null }, {});
    expect(c.callState(null)).toMatch(/Texting: NOT available \(the caller is not verified\)\. Do not offer to text anything/);   // texting on for the line, caller not verified
    c.textingOnLine = false;
    expect(c.callState(null)).toMatch(/Texting: NOT available on calls at this time, before or after verification\. Do not offer, suggest or imply texting/);
    c.textingOnLine = undefined;
    c.textingNow = false;
    expect(c.callState({ expires_at: new Date().toISOString() })).toMatch(/Texting: NOT available on this call\. Do not offer to text anything\. .*for a payment link offer to email it/);
    c.textingNow = true;
    expect(c.callState({ expires_at: new Date().toISOString() })).toMatch(/Texting: AVAILABLE/);
    const p = engine.systemPrompt({ channel: 'phone' });
    expect(p).toMatch(/offer to text it \(send_text\) only when CALL STATE says texting is AVAILABLE\. Never offer a text otherwise, not even "would you like me to text you a link\?"/);
    expect(p).not.toMatch(/offer to text it \(send_text, verified callers only\)/);
    const m = model([{ text: 'You can find that under Invoices on our website.' }]);
    const sc = await sim.start({ actorId: ADMIN, routingReason: 'seller' }, { client: m.client });
    await sim.say(sc.call_id, ADMIN, 'Can you send me the link to start selling?');
    expect(m.calls[0].system.map((b) => b.text).join('\n')).toMatch(/Texting: NOT available on calls at this time, before or after verification/);   // production mirror: texting is off
    expect((m.calls[0].tools || []).map((t) => t.name)).not.toContain('send_text');
    await sim.end(sc.call_id, ADMIN);
  });
});

describe('Individual Seller bidding wording', () => {
  test('benefits describe competitive bidding, automatic maximum bids and soft close, never price protection or reserves for individuals', () => {
    const b = platformFacts.getFacts('seller_benefits').seller_benefits.facts.join('\n');
    expect(b).toMatch(/Competitive online bidding: bidders compete in real time and can set a maximum bid that bids for them automatically/);
    expect(b).toMatch(/a bid in the last two minutes extends that lot by two more minutes \(soft close\)/);
    expect(b).toMatch(/INDIVIDUAL Sellers and price: never say or imply that bidding protects their prices, sets a minimum price, guarantees a sale amount, or works like a reserve/);
    expect(b).toMatch(/Their lots start at \$1 with no reserve and sell to the highest bidder/);
    expect(b).toMatch(/Reserves and starting bids are Professional Seller controls only/);
    const withoutRules = b.split('\n').filter((l) => !/never say or imply/.test(l)).join('\n');
    expect(withoutRules).not.toMatch(/protect(s|ing)? (their |your )?price|price protection|guaranteed? (a )?(minimum|price|sale)/i);
    expect(b).toMatch(/PROFESSIONAL Sellers in particular .* their own starting bids, reserves, bid increments/);
  });
  test('the seller sales guidance uses the accurate bidding benefits', () => {
    const p = engine.systemPrompt({ channel: 'phone' });
    expect(p).not.toMatch(/bidding that protects their prices/);
    expect(p).toMatch(/competitive bidding with automatic maximum bids and a soft close/);
    expect(p).toMatch(/For Individual Sellers never imply a minimum price, reserve or price protection: their lots start at \$1 and sell to the highest bidder/);
  });
});

// ── Sasha ElevenLabs voice audition (2026-10-09) ────────────────────────────────────────────────────────
describe('Sasha ElevenLabs voice configuration', () => {
  const FIRST = 'KpTQ5yzwazQWLkvnK59A'; const SECOND = 'DIS307HFaAvJZzq496qM';
  test('validation accepts the two chosen ElevenLabs IDs (Flash 2.5 by default) and rejects malformed voices', () => {
    expect(phoneSettings.normalizeSashaVoice({ tts_provider: 'elevenlabs', voice: FIRST })).toEqual({ value: { tts_provider: 'ElevenLabs', voice: FIRST, language: 'en-US' } });
    expect(phoneSettings.normalizeSashaVoice({ tts_provider: 'ElevenLabs', voice: SECOND }).value.voice).toBe(SECOND);
    expect(phoneSettings.normalizeSashaVoice({ tts_provider: 'ElevenLabs', voice: SECOND + '-flash_v2_5-1.0_0.5_0.75' }).value).toBeTruthy();
    for (const bad of [FIRST.slice(1), FIRST + '!', FIRST + '-fast', 'Rachel']) expect(phoneSettings.normalizeSashaVoice({ tts_provider: 'ElevenLabs', voice: bad }).error).toMatch(/20-character voice ID/);
    expect(phoneSettings.normalizeSashaVoice({ tts_provider: 'Azure', voice: 'x' }).error).toMatch(/Google, Amazon or ElevenLabs/);
  });
  test('with the first choice set, Sasha speaks with ElevenLabs while the menu keeps Amy, the ring and barge-in stay', async () => {
    await setCfg('sasha.phone.voice', { tts_provider: 'ElevenLabs', voice: FIRST, language: 'en-US' });
    try {
      const s = await phoneSettings.load();
      const c = line.connectTwiml(s, { wsUrl: 'wss://x/api/voice/relay?t=1', actionUrl: 'https://x/after', reason: 'seller', transitionUrl: 'https://x/audio/connecting-ring.wav' });
      expect(c).toContain(`language="en-US" ttsProvider="ElevenLabs" voice="${FIRST}"`);
      expect(c).not.toContain('-flash');   // plain ID: Flash 2.5 with the voice's default settings
      for (const a of ['interruptible="any"', 'welcomeGreetingInterruptible="any"', 'preemptible="true"', 'ignoreBackchannel="true"']) expect(c).toContain(a);
      expect(c).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?><Response><Play>https:\/\/x\/audio\/connecting-ring\.wav<\/Play><Connect /);
      expect(line.menuTwiml(s, { actionUrl: 'https://x/menu' })).toContain('<Say voice="Polly.Amy-Generative">');
      expect(line.afterTwiml(s, { sessionStatus: 'completed' })).toContain('<Say voice="Polly.Amy-Generative">');
    } finally { await setCfg('sasha.phone.voice', { tts_provider: null, voice: null, language: 'en-US' }); }
  });
  test('saved voice presets load for one-click switching; invalid presets are dropped', async () => {
    await setCfg('sasha.phone.voice_presets', [{ label: 'ElevenLabs first choice', tts_provider: 'ElevenLabs', voice: FIRST }, { label: 'ElevenLabs second choice', tts_provider: 'ElevenLabs', voice: SECOND },
      { label: 'Previous Google voice', tts_provider: 'Google', voice: 'en-US-Chirp3-HD-Aoede' }, { label: 'broken', tts_provider: 'ElevenLabs', voice: 'nope' }]);
    try {
      const s = await phoneSettings.load();
      expect(s.voice_presets.map((p) => p.label)).toEqual(['ElevenLabs first choice', 'ElevenLabs second choice', 'Previous Google voice']);
      expect(s.voice_presets[1]).toEqual({ label: 'ElevenLabs second choice', tts_provider: 'ElevenLabs', voice: SECOND, language: 'en-US' });
    } finally { await q(`DELETE FROM platform_config WHERE key = 'sasha.phone.voice_presets'`); phoneSettings.clear(); }
  });
});

// ── owner decisions 2026-10-12 (round 3) ────────────────────────────────────────────────────────────────
describe('round 3 authoritative rules and tool times', () => {
  test('every tool timestamp also comes as a ready-to-say local time in the auction\'s own zone (Sasha never converts UTC)', async () => {
    const { _internal } = tools;
    expect(_internal).toBeTruthy();
    const out = await tools.run('get_platform_rules', { topic: 'contact' }, {});
    expect(JSON.stringify(out)).toMatch(/Monday through Friday, 10:00 AM to 5:00 PM Eastern Time/);
    // The walker: a UTC instant inside an object that carries the auction's timezone.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'services', 'sasha', 'tools.js'), 'utf8');
    expect(src).toMatch(/out\[k \+ '_local'\] = l/);
    const p = engine.systemPrompt({ channel: 'phone' });
    expect(p).toMatch(/Always say the _local version exactly as given, minutes included \(1:07, not 1:00 or "about 1"\); never convert or round a time yourself/);
  });
  test('local time conversion is DST-correct for an Eastern auction (21:07 UTC on Oct 12 is 5:07 PM EDT)', () => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    expect(f.format(new Date('2026-10-12T21:07:00Z'))).toBe('5:07 PM EDT');
  });
  test('Individual Seller pickup windows are final; seller accommodation goes through a team message, never promised', () => {
    const t = platformFacts.getFacts('pickup').pickup.facts.join('\n');
    expect(t).toMatch(/the published pickup date and pickup window are part of the terms of the purchase and are final/);
    expect(t).toMatch(/does not by itself give a right to another pickup time, a cancellation, a refund or a reversal/);
    expect(t).toMatch(/For a VERIFIED buyer with a PAID purchase, use contact_seller_about_pickup \(it sends the seller a request; it is never an extension or an entitlement\)/);
    expect(t).toMatch(/Share the buyer's name and callback number with the seller only if the buyer explicitly agrees/);
    expect(t).toMatch(/Never promise that the seller will accommodate/);
  });
  test('storefronts are Professional Seller only; storefront payment mechanics are never assumed', () => {
    const all = platformFacts.getFacts('all');
    expect(all.selling.facts.join('\n')).toMatch(/Individual Sellers do not have Storefronts and cannot sell fixed-price items/);
    expect(all.storefront.facts.join('\n')).toMatch(/Never say storefront purchases are charged to the card on file like auction purchases/);
  });
  test('account is free, bidder privacy is not "anonymous", forgot-password flow, hours, discounts, directory', () => {
    const all = platformFacts.getFacts('all');
    expect(all.account.facts.join('\n')).toMatch(/Creating an Advantage\.Bid account is free/);
    expect(all.account.facts.join('\n')).toMatch(/"Forgot your password\?".*"Send reset link".*expires after 60 minutes/);
    expect(all.bidding.facts.join('\n')).toMatch(/your identity isn't publicly displayed to other bidders while you're bidding\. Never say bidding is anonymous/);
    expect(all.contact.facts.join('\n')).toMatch(/never say help is available "anytime, day or night"/);
    expect(all.programs.facts.join('\n')).toMatch(/Advantage\.Bid does not currently offer discounts, promo codes or fee waivers; say "currently"/);
    expect(all.programs.facts.join('\n')).toMatch(/does not currently offer in-home or on-site photography/);
    expect(all.programs.facts.join('\n')).toMatch(/Sellers do not list items in the directory/);
  });
  test('the help index no longer treats the "ships nationwide" landing page as a policy source', () => {
    expect(require('../../src/services/sasha/knowledge/helpIndex').HELP_PAGES).not.toContain('shipping-available.html');
  });
});

// ── owner clarifications 2026-10-12 (round 4) ───────────────────────────────────────────────────────────
describe('round 4: tool not final authority, listing review, money wording, spoken addresses', () => {
  test('every channel carries the decision hierarchy (answer, look up, defer, never invent)', () => {
    for (const c of ['phone', 'chat', 'email']) {
      const p = engine.systemPrompt({ channel: c });
      expect(p).toMatch(/You are an Advantage\.Bid customer-service tool, not the final authority/);
      expect(p).toMatch(/If authoritative sources conflict, don't pick one/);
      expect(p).toMatch(/When a source does not support a detail, do not make it up/);
    }
    const ph = engine.systemPrompt({ channel: 'phone' });
    expect(ph).toMatch(/VERIFIED CALLERS' OWN QUESTIONS: .*call the matching get_my_\* tool first/);
    expect(ph).toMatch(/When a caller only tells you who they are .* acknowledge it in one short sentence and ask what they would like to know/);
    expect(ph).toMatch(/When a caller asks for a callback or a message and gives a name, a number and the gist, take the message: do not insist on helping first/);
  });
  test('no lot is described as individually reviewed; money wording follows the rules', () => {
    const all = platformFacts.getFacts('all');
    expect(all.selling.facts.join('\n')).toMatch(/Advantage\.Bid does not manually review, verify, authenticate, inspect or approve every individual lot/);
    expect(all.bidding.facts.join('\n')).toMatch(/the buyer's premium and any applicable sales tax are added on top of the winning bid/);
    expect(all.payment.facts.join('\n')).toMatch(/Buyers do not review or approve the total before that automatic charge/);
    expect(all.seller_fees.facts.join('\n')).toMatch(/never give reasons for how a fee or price is set \(for example volume or business size\) and never say a fee applies "regardless"/);
    const faq = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'public', 'buyer-faq.html'), 'utf8');
    expect(faq).not.toMatch(/reviews all lot submissions/);
    expect(faq).toMatch(/does not inspect, authenticate, or individually review every item/);
    expect(require('../../src/services/sasha/knowledge/helpIndex').HELP_PAGES).not.toContain('promote-estate-sale.html');
  });
  test('spoken output: a bare site name becomes "the Advantage.Bid website" unless the caller asked for the address; the brand is untouched', () => {
    const { speakable, SentenceChunker } = require('../../src/services/sasha/phone/speech');
    expect(speakable('Sign in at bid.advantage.bid to see it.')).toBe('Sign in at the Advantage.Bid website to see it.');
    expect(speakable('Visit www.advantage.bid today.')).toBe('Visit the Advantage.Bid website today.');
    expect(speakable('Sign in at bid.advantage.bid to see it.', { allowDomain: true })).toBe('Sign in at bid.advantage.bid to see it.');
    expect(speakable('Advantage.Bid is the marketplace.')).toBe('Advantage.Bid is the marketplace.');
    expect(new SentenceChunker().push('Go to bid.advantage.bid now. Then ')).toEqual(['Go to the Advantage.Bid website now.']);
  });
  test('the caller asking for the website lets the address be spoken; otherwise it is never spoken', async () => {
    for (const [said, expectDomain] of [['How do I sign up?', false], ['What is your website address?', true]]) {
      const m = model([{ text: 'Just go to bid.advantage.bid and choose sign in.' }]);
      const s = await sim.start({ actorId: ADMIN }, { client: m.client });
      const r = await sim.say(s.call_id, ADMIN, said);
      const spoken = r.turn.filter((x) => x.type === 'text' && x.token).map((x) => x.token).join(' ');
      expect(/bid\.advantage\.bid/.test(spoken)).toBe(expectDomain);
      await sim.end(s.call_id, ADMIN);
    }
  });
});

// ── certification corrections 2026-10-14 (the 11 remaining FAILs) ─────────────────────────────────────────
describe('round 5: tool corrections and authoritative wording for the remaining certification failures', () => {
  test('string timestamps get a ready-to-say local time too (the ISO pattern matches real ISO strings)', () => {
    const out = tools._internal.withLocalTimes({ timezone: 'America/New_York', to: '2026-10-13T05:07:00.000Z' }, 'America/New_York');
    expect(out.to_local).toMatch(/1:07 AM EDT/);
  });
  test('get_my_invoices lists the items won on each invoice, so Sasha never guesses which purchase an item belongs to', async () => {
    const buyer = (await q(`INSERT INTO users (email, role, full_name) VALUES ('r5-buyer@example.org','buyer','R5 Buyer') RETURNING id`))[0].id;
    const other = (await q(`INSERT INTO users (email, role, full_name) VALUES ('r5-other@example.org','buyer','R5 Other') RETURNING id`))[0].id;
    const a1 = (await q(`INSERT INTO auctions (title, state) VALUES ('R5 Paid Sale','closed') RETURNING id`))[0].id;
    const a2 = (await q(`INSERT INTO auctions (title, state) VALUES ('R5 Unpaid Sale','closed') RETURNING id`))[0].id;
    await q(`INSERT INTO lots (auction_id, lot_number, title, state, winning_buyer_user_id) VALUES ($1,1,'Oak Chairs','closed',$2), ($1,2,'Not Mine','closed',$3), ($4,1,'Baseball Cards','closed',$2)`, [a1, buyer, other, a2]);
    await q(`INSERT INTO buyer_auction_invoices (invoice_number, buyer_user_id, auction_id, status, total_cents) VALUES ('R5-1',$1,$2,'paid',1000), ('R5-2',$1,$3,'payment_required',2000)`, [buyer, a1, a2]);
    const out = await tools.run('get_my_invoices', {}, { userId: buyer });
    const byNo = Object.fromEntries(out.invoices.map((i) => [i.invoice, i]));
    expect(byNo['R5-1'].items_won).toEqual(['Oak Chairs']);
    expect(byNo['R5-2'].items_won).toEqual(['Baseball Cards']);
    expect(byNo['R5-2'].status).toMatch(/payment required/);
  });
  test('send_payment_link refuses a storefront order number in code (payment links are for auction invoices only)', async () => {
    await q(`CREATE TABLE IF NOT EXISTS marketplace_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_user_id uuid, order_number text)`);
    const buyer = (await q(`INSERT INTO users (email, role, full_name) VALUES ('r5-store@example.org','buyer','R5 Store') RETURNING id`))[0].id;
    await q(`INSERT INTO marketplace_orders (buyer_user_id, order_number) VALUES ($1, 'SO-5001')`, [buyer]);
    const s = await sim.start({ actorId: ADMIN }, {});
    const call = (await q(`SELECT * FROM cs_calls WHERE id = $1`, [s.call_id]))[0];
    const out = await require('../../src/services/sasha/phone/phoneTools').run('send_payment_link', { invoice_number: 'so-5001', delivery: 'email' }, { userId: buyer, phone: { call, sessionId: null, textingAvailable: false, deps: {} } });
    expect(out.sent).toBe(false);
    expect(out.note).toMatch(/storefront order, not an auction invoice, so no payment link was sent/);
    const audit = await q(`SELECT detail FROM cs_phone_audit WHERE call_id = $1 AND event_type = 'payment_link_refused'`, [s.call_id]);
    expect(JSON.stringify(audit)).toMatch(/storefront order/);
    await sim.end(s.call_id, ADMIN);
  });
  test('while auction text alerts are off, no fact offers a way to sign up for or turn on texts', () => {
    const off = platformFacts.getFacts('account', { processingBps: 300, auctionTextAlerts: false }).account.facts.join('\n');
    expect(off).not.toMatch(/SMS notifications are opt-in only/);
    expect(off).not.toMatch(/add-card\.html; notification preferences/);   // the old combined line
    expect(off).toMatch(/Email notification preferences are in the account settings\. There is no text-alert setting to turn on right now/);
    expect(off).toMatch(/nothing to sign up for, opt in to, turn on or turn back on \(not in account settings or anywhere else\)/);
    const on = platformFacts.getFacts('account', { processingBps: 300, auctionTextAlerts: true }).account.facts.join('\n');
    expect(on).toMatch(/SMS notifications are opt-in only/);
    expect(on).toMatch(/including opting in to auction text alerts, are in the account settings/);
  });
  test('tax license questions get the not-a-tax-advisor answer in buyer AND seller rule sets', () => {
    const all = platformFacts.getFacts('all');
    expect(all.payment.facts.join('\n')).toMatch(/Sales tax license, permit or registration questions .* never answer yes or no/);
    expect(all.seller_fees.facts.join('\n')).toMatch(/never answer it yes or no and never say Advantage\.Bid handles it for them/);
  });
  test('no sale guarantee, no payout speed, no invented reasons, office or watchlist location, account changes without a reason', () => {
    const all = platformFacts.getFacts('all');
    expect(all.selling.facts.join('\n')).toMatch(/NO SALE GUARANTEE .* never agree that everything sells/);
    expect(all.payouts.facts.join('\n')).toMatch(/never characterize how fast money arrives \("usually quick"/);
    expect(all.pickup.facts.join('\n')).toMatch(/State it as the rule only: no Advantage\.Bid source gives a reason for it/);
    expect(all.pickup.facts.join('\n')).toMatch(/Which purchase an item belongs to: never assume\. Match the item .* items_won/);
    expect(all.contact.facts.join('\n')).toMatch(/no "we handle everything by phone and email"/);
    expect(all.account.facts.join('\n')).toMatch(/Never say where the option is or what it looks like/);
    expect(all.account.facts.join('\n')).toMatch(/you can't make account changes on a call\. .* Never give a reason \(no "for security reasons"\)/);
  });
  test('the phone prompt carries length, nothing-extra and always-on-a-call rules; chat and email are unchanged; ceiling stays 1024', () => {
    const ph = engine.systemPrompt({ channel: 'phone' });
    expect(ph).toMatch(/LENGTH: keep each answer well under 60 spoken words/);
    expect(ph).toMatch(/NOTHING EXTRA: say only what your sources state/);
    expect(ph).toMatch(/ALWAYS ON A CALL: payment links are only for unpaid AUCTION invoices/);
    expect(ph).toMatch(/Never assume which purchase an item belongs to/);
    for (const c of ['chat', 'email']) expect(engine.systemPrompt({ channel: c })).not.toMatch(/NOTHING EXTRA|ALWAYS ON A CALL|LENGTH: keep each answer/);
    expect(engine.PHONE_MAX_OUTPUT_TOKENS).toBe(1024);
  });
  test('certification fixture: the two verified seller-request scenarios use different buyers (the real daily limit is unchanged)', () => {
    const list = require('../../certification/sasha-phone/scenarios').expand().filter((s) => s.subject === 'pickup.verified-seller-request');
    expect(list.map((s) => s.auth)).toEqual(['buyerA', 'buyerC']);
    expect(require('../../src/services/sasha/phone/phoneTools').SELLER_CONTACT_DAILY_LIMIT).toBe(1);
  });
});

// ── human referral for unverifiable answers (owner directive 2026-10-14) ───────────────────────────────────────
describe('round 6: refer instead of guessing; verified facts stated exactly', () => {
  test('phone prompt: unknown answers are neither confirmed nor denied, and go to a team message without a promised time', () => {
    const ph = engine.systemPrompt({ channel: 'phone' });
    expect(ph).toMatch(/REFER, DON'T GUESS: when your rules and tools don't state the answer, don't confirm it and don't deny it/);
    expect(ph).toMatch(/offer to take a message so the Advantage\.Bid team can follow up \(request_callback\)/);
    expect(ph).toMatch(/never promise when anyone will respond \("right away", "today"\)/);
    expect(ph).toMatch(/never say whether you can see the caller's number/);
    expect(ph).toMatch(/never say a buyer can review or approve the total before that charge/);
    expect(ph).toMatch(/A soft close is triggered by a bid with 2 minutes or less remaining, never "one minute"/);
    for (const c of ['chat', 'email']) expect(engine.systemPrompt({ channel: c })).not.toMatch(/REFER, DON'T GUESS/);
  });
  test('seller-menu calls preload the storefront rules (the flat storefront fee is a stated fact, not a referral)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'services', 'sasha', 'phone', 'callSession.js'), 'utf8');
    expect(src).toMatch(/seller: \['selling', 'seller_benefits', 'seller_fees', 'payouts', 'storefront', 'programs', 'contact'\]/);
    expect(platformFacts.getFacts('storefront').storefront.facts.join('\n')).toMatch(/flat 11% seller fee on the item selling price only/);
  });
});

describe('bidding facts match the bidding engine', () => {
  test('every bid is resolved as a maximum bid (bidService), and Sasha may say so', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'services', 'bidService.js'), 'utf8');
    expect(src).toMatch(/A manual bid \(amount\) is treated as a max bid equal to the submitted amount/);
    expect(platformFacts.getFacts('bidding').bidding.facts.join('\n')).toMatch(/Every bid works as a maximum bid/);
    expect(engine.systemPrompt({ channel: 'phone' })).not.toMatch(/Never say every bid is automatically a maximum bid/);
  });
});
