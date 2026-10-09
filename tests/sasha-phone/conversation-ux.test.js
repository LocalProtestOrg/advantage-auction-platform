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

// ── seller content after live call #4 (2026-10-09) ────────────────────────────────────────────────────
describe('seller guidance: lot minimum, dimensions, easy listing, benefits, marketing, payouts', () => {
  const facts = (t) => platformFacts.getFacts(t)[t].facts.join('\n');
  test('30-lot rule: sensible grouping of items that belong together only, never unrelated items to reach the minimum', () => {
    const s = facts('selling');
    expect(s).toMatch(/every auction needs at least 30 lots to be submitted or published/);
    expect(s).toMatch(/Items that naturally belong together can sensibly be offered as one lot/);
    expect(s).toMatch(/never suggest combining unrelated items just to reach 30/);
    expect(s).not.toMatch(/smaller pieces can be grouped into one lot/);
    expect(s).not.toMatch(/group (several|a few)[^.]*to (help )?reach/i);
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
    expect(b).toMatch(/Online Buy Now checkout for storefront items is not available yet/);   // gate is off in this environment
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
    expect(c.callState(null)).toMatch(/Texting: NOT available \(the caller is not verified\)\. Do not offer to text anything/);
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
    expect(m.calls[0].system.map((b) => b.text).join('\n')).toMatch(/Texting: NOT available \(the caller is not verified\)/);
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
