'use strict';

/**
 * wss://…/api/voice/relay — Twilio ConversationRelay WebSocket for live Phone Sasha calls (migration 191).
 *
 * The HTTP upgrade is accepted only when ALL of these hold; otherwise it is refused before any WebSocket exists:
 *   1. the live line is on (sasha.phone.enabled AND sasha.phone.provider = 'twilio_cr');
 *   2. the handshake carries a valid X-Twilio-Signature for our auth token;
 *   3. the URL carries a valid, unexpired relay ticket (minted only in reply to a Twilio-signed menu request).
 * The session is then bound to the ticket's CallSid (the setup message must match) and menu choice.
 *
 * One RelaySession per socket drives the existing PhoneCall (verification, scoped session, redaction, tools, budgets,
 * audit, escalation). sasha.phone.session_max_minutes ends the call politely. Closing the socket ends the call.
 * Payload limit 64 KB; malformed messages are ignored. Nothing about the caller's words is logged here.
 */

const { WebSocketServer } = require('ws');
const phoneSettings = require('./phoneSettings');
const line = require('./voiceLine');
const signature = require('../../../lib/twilioSignature');
const { RelaySession } = require('./adapters/conversationRelay');

const PATHS = new Set(['/api/voice/relay', '/api/voice/relay/']);

function reject(socket, status, text) {
  try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_e) { /* ignore */ }
  socket.destroy();
}

/** Decide whether a handshake may become a relay session. Exported for tests. */
async function admit(req, deps = {}) {
  if (!process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_ACCOUNT_SID) return { ok: false, status: 503, text: 'Service Unavailable' };
  if (!(await phoneSettings.relayLineOn())) return { ok: false, status: 503, text: 'Service Unavailable' };
  if (!signature.validUpgradeRequest(req, deps)) return { ok: false, status: 403, text: 'Forbidden' };
  const t = new URL(req.url, 'http://x').searchParams.get('t');
  const ticket = line.verifyTicket(t, deps.now);
  if (!ticket) return { ok: false, status: 403, text: 'Forbidden' };
  return { ok: true, ticket };
}

/**
 * Twilio validates outbound messages strictly: any field it does not know rejects the whole message (error 64107,
 * "Unexpected fields"), so nothing is spoken. Internal labels (e.g. `kind`, used by the admin tester) never go to Twilio.
 */
// Only fields in Twilio's documented outbound schema. interruptible: caller speech stops this text's playback;
// preemptible: a later message may replace it (the talk-cycle replacement itself is set on <ConversationRelay>).
const ALLOWED_FIELDS = { text: ['type', 'token', 'last', 'interruptible', 'preemptible'], end: ['type', 'handoffData'] };
function toTwilio(obj) {
  const allowed = obj && ALLOWED_FIELDS[obj.type];
  if (!allowed) return null;
  const out = {};
  for (const k of allowed) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Wire one accepted socket to a RelaySession. */
async function bind(ws, ticket, deps = {}) {
  const s = await phoneSettings.load();
  const send = (obj) => { const m = toTwilio(obj); if (m && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const relay = new RelaySession(send, { provider: 'twilio_cr', routingReason: ticket.reason, expectCallSid: ticket.callSid, providerGreeting: true, deps: deps.callDeps || {} });
  let queue = Promise.resolve();
  const timer = setTimeout(() => { queue = queue.then(() => relay.timeLimit()).catch((e) => console.error('[voice-relay] time limit', e.message)); },
    s.session_max_minutes * 60 * 1000);
  if (timer.unref) timer.unref();
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(String(data)); } catch (_e) { return; }
    // Interruptions act immediately; everything else is handled in order.
    if (msg && msg.type === 'interrupt') { relay.onMessage(msg).catch(() => {}); return; }
    // A new final caller turn supersedes the answer still being generated: stop it now, so the new turn is not
    // queued behind obsolete speech.
    if (msg && msg.type === 'prompt' && msg.last !== false && relay.call && relay.call.busy) relay.call.interrupt({ source: 'new_prompt' });
    queue = queue.then(() => relay.onMessage(msg)).catch((e) => console.error('[voice-relay] message failed', e.message));
  });
  ws.on('close', () => { clearTimeout(timer); queue = queue.then(() => relay.close('caller_hung_up')).catch(() => {}); });
  ws.on('error', () => { /* close follows */ });
  return relay;
}

function attach(server, deps = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const path = String(req.url || '').split('?')[0];
    if (!PATHS.has(path)) return;   // not ours (Socket.IO handles its own path)
    admit(req, deps).then((a) => {
      if (!a.ok) { console.log('[voice-relay] handshake refused:', a.status); return reject(socket, a.status, a.text); }
      wss.handleUpgrade(req, socket, head, (ws) => { bind(ws, a.ticket, deps).catch((e) => { console.error('[voice-relay] bind failed', e.message); try { ws.close(1011); } catch (_e) { /* ignore */ } }); });
    }).catch((e) => { console.error('[voice-relay] handshake error', e.message); reject(socket, 500, 'Internal Server Error'); });
  });
  return wss;
}

module.exports = { attach, admit, bind, toTwilio, ALLOWED_FIELDS, PATHS };
