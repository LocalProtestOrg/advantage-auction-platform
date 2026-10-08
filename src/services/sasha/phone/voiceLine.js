'use strict';

/**
 * Phone Sasha's live Twilio voice line (migration 191): what a caller hears before and after Sasha.
 *
 *   incoming call ─► line OFF, or caller not on the staff test list (access_mode 'staff_only')
 *                      → short "not available" message, call ends (never forwarded to anyone)
 *                ─► Advantage.Bid routing menu (1 buyer · 2 seller · 3 pickup · 4 other; no "operator" option)
 *   menu choice  ─► all lines busy / daily phone budget reached → short message, call ends
 *                ─► <Connect><ConversationRelay> to wss://…/api/voice/relay with a short-lived signed ticket bound to the
 *                   Twilio CallSid and the menu choice; Twilio speaks Sasha's greeting (welcomeGreeting) immediately
 *   session ends ─► <Connect action> → goodbye, or a short apology if the session failed. Never a <Dial>.
 *
 * The ticket is an HMAC over { CallSid, reason, expiry } with a server secret; it can only be minted in reply to a
 * Twilio-signed menu request, expires in 2 minutes, and is checked again (with the Twilio signature) on the WebSocket.
 */

const crypto = require('crypto');
const phoneSettings = require('./phoneSettings');

const REASONS = { 1: 'buyer', 2: 'seller', 3: 'pickup', 4: 'other' };
const TICKET_TTL_MS = 2 * 60 * 1000;
const MESSAGES = {
  unavailable: 'Thank you for calling Advantage.Bid. This line is not available right now. Please email info at advantage dot bid, and our team will help. Goodbye.',
  busy: 'Thank you for calling Advantage.Bid. All of our lines are busy right now. Please call back in a few minutes, or email info at advantage dot bid. Goodbye.',
  failed: 'I\'m sorry, we\'re having trouble with this call. Please call back in a few minutes, or email info at advantage dot bid, and our team will help. Goodbye.',
  goodbye: 'Thank you for calling Advantage.Bid. Goodbye.',
  retry: 'Sorry, I didn\'t catch that.',
};

const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** <Say voice> for the menu: the same voice as Sasha where Twilio's <Say> supports it. */
function sayVoice(voice = {}) {
  const p = String(voice.tts_provider || '').toLowerCase();
  if (p === 'google' && voice.voice) return 'Google.' + voice.voice;
  if (p === 'amazon' && voice.voice) return 'Polly.' + voice.voice;
  return 'Google.' + phoneSettings.DEFAULTS.voice.voice;   // ElevenLabs voices are not available to <Say>
}
const say = (text, voice) => `<Say voice="${xmlEsc(sayVoice(voice))}">${xmlEsc(text)}</Say>`;

function sayAndHangup(text, voice) { return `<?xml version="1.0" encoding="UTF-8"?><Response>${say(text, voice)}<Hangup/></Response>`; }

/** The routing menu. Lines are separate <Say> verbs (natural pacing) with a short pause after the welcome line. */
function menuTwiml(s, { actionUrl, retry = false }) {
  const lines = phoneSettings.menuLines(s);
  const parts = [];
  if (retry) parts.push(say(MESSAGES.retry, s.voice));
  else if (s.call_notice) parts.push(say(s.call_notice, s.voice));
  lines.forEach((l, i) => { if (retry && i === 0) return; parts.push(say(l, s.voice)); if (i === 0) parts.push('<Pause length="1"/>'); });
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf" numDigits="1" timeout="7" actionOnEmptyResult="true" action="${xmlEsc(actionUrl)}" method="POST">${parts.join('')}</Gather></Response>`;
}

/** Connect the caller to Sasha. Twilio speaks the greeting itself the moment the relay connects (no model latency). */
function connectTwiml(s, { wsUrl, actionUrl, reason }) {
  const v = s.voice || {};
  const attrs = [`url="${xmlEsc(wsUrl)}"`, `welcomeGreeting="${xmlEsc(s.greeting)}"`, `language="${xmlEsc(v.language || 'en-US')}"`,
    v.tts_provider ? `ttsProvider="${xmlEsc(v.tts_provider)}"` : '', v.voice ? `voice="${xmlEsc(v.voice)}"` : '', 'interruptible="any"', 'dtmfDetection="true"']
    .filter(Boolean).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${xmlEsc(actionUrl)}"><ConversationRelay ${attrs}>`
    + `<Parameter name="reason" value="${xmlEsc(reason)}"/></ConversationRelay></Connect></Response>`;
}

/** After the relay session (the <Connect action> request). Never transfers or dials anyone. */
function afterTwiml(s, { handoffData, sessionStatus }) {
  let h = {}; try { h = JSON.parse(handoffData || '{}'); } catch (_e) { h = {}; }
  const text = h.action === 'busy' ? MESSAGES.busy
    : h.action === 'unavailable' || sessionStatus === 'failed' ? MESSAGES.failed
      : MESSAGES.goodbye;
  return sayAndHangup(text, s.voice);
}

// ── relay tickets ────────────────────────────────────────────────────────────────────────────────────────
function secret() {
  const base = process.env.SASHA_PHONE_RELAY_SECRET || ((process.env.TWILIO_AUTH_TOKEN || '') + ':' + (process.env.JWT_SECRET || ''));
  return crypto.createHash('sha256').update('sasha-relay-ticket:' + base).digest();
}
const b64 = (buf) => Buffer.from(buf).toString('base64url');

function issueTicket({ callSid, reason }, now = Date.now()) {
  const payload = b64(JSON.stringify({ cs: String(callSid), r: reason, exp: now + TICKET_TTL_MS }));
  return payload + '.' + b64(crypto.createHmac('sha256', secret()).update(payload).digest());
}

function verifyTicket(ticket, now = Date.now()) {
  const [payload, sig] = String(ticket || '').split('.');
  if (!payload || !sig) return null;
  const want = b64(crypto.createHmac('sha256', secret()).update(payload).digest());
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  let t; try { t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_e) { return null; }
  if (!t || !t.cs || !Object.values(REASONS).includes(t.r) || !(Number(t.exp) > now)) return null;
  return { callSid: t.cs, reason: t.r };
}

/** What to do with a new incoming call. Pure: the route supplies the facts. */
function decideIncoming({ lineOn, accessMode, callerAllowed }) {
  if (!lineOn) return { action: 'unavailable', reason: 'line_off' };
  if (accessMode !== 'public' && !callerAllowed) return { action: 'unavailable', reason: 'not_on_test_list' };
  return { action: 'menu' };
}

module.exports = { REASONS, MESSAGES, menuTwiml, connectTwiml, afterTwiml, sayAndHangup, sayVoice, issueTicket, verifyTicket, decideIncoming, TICKET_TTL_MS };
