'use strict';

/**
 * Twilio ConversationRelay adapter (message translation only; NOT mounted on any route in this release).
 *
 * Twilio → us (one WebSocket per call, JSON messages):
 *   { type: 'setup', callSid, from, to, ... }            call connected
 *   { type: 'prompt', voicePrompt, last }                caller speech (we act on last === true)
 *   { type: 'dtmf', digit }                              one keypad digit
 *   { type: 'interrupt', utteranceUntilInterrupt, ... }  caller talked over Sasha
 *   { type: 'error', description }
 * us → Twilio:
 *   { type: 'text', token, last }                        text to speak (we send whole sentences)
 *   { type: 'end', handoffData }                         end the AI session; Twilio then requests the <Connect action> URL
 *
 * The same translator runs the simulator (provider 'simulated'), so the protocol path is exercised end to end without
 * a telephone. A Retell adapter would map Retell's events onto the same PhoneCall API; Sasha itself does not change.
 */

const { PhoneCall } = require('../callSession');

const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

class RelaySession {
  /**
   * @param send(obj)   deliver one outbound message to the provider (WebSocket send, or the simulator's buffer)
   * @param opts        { provider: 'twilio_cr' | 'simulated', simulatedBy, deps }
   */
  constructor(send, opts = {}) {
    this.send = send; this.provider = opts.provider || 'twilio_cr'; this.simulatedBy = opts.simulatedBy || null;
    this.deps = { ...(opts.deps || {}), onSpeak: (text, meta) => this.send({ type: 'text', token: text + ' ', last: false, kind: meta && meta.kind }) };
    this.call = null; this.dtmf = ''; this.ended = false;
  }

  async onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'setup') return this.setup(msg);
    if (!this.call || this.ended) return;
    if (msg.type === 'prompt') {
      if (msg.last === false) return;   // partial transcript
      const r = await this.call.utterance(String(msg.voicePrompt || ''));
      this.send({ type: 'text', token: '', last: true });
      return r;
    }
    if (msg.type === 'dtmf') {
      const d = String(msg.digit || '');
      if (d === '#' || d === '*') { const code = this.dtmf; this.dtmf = ''; return this.finishTurn(await this.call.keypad(code)); }
      if (/^\d$/.test(d)) { this.dtmf += d; if (this.dtmf.length === 6) { const code = this.dtmf; this.dtmf = ''; return this.finishTurn(await this.call.keypad(code)); } }
      return null;
    }
    if (msg.type === 'interrupt') { this.call.interrupt(); return { interrupted: true }; }
    if (msg.type === 'error') { console.error('[sasha-phone] provider error', String(msg.description || '').slice(0, 200)); return null; }
    return null;
  }

  finishTurn(r) { this.send({ type: 'text', token: '', last: true }); return r; }

  async setup(msg) {
    try {
      const r = await PhoneCall.start({ provider: this.provider, providerCallId: msg.callSid || ('sim-' + Date.now()), callerNumber: msg.from || null,
        calledNumber: msg.to || null, simulated: this.provider === 'simulated', simulatedBy: this.simulatedBy }, this.deps);
      if (r.queued) { this.ended = true; this.send({ type: 'end', handoffData: JSON.stringify({ action: 'queue', reason: 'capacity' }) }); return r; }
      this.call = r.call;
      this.send({ type: 'text', token: '', last: true });
      return r;
    } catch (e) {
      this.ended = true;
      this.send({ type: 'end', handoffData: JSON.stringify({ action: 'unavailable', reason: e.code || 'error' }) });
      return { refused: true, code: e.code || 'error' };
    }
  }

  /** Caller hung up / socket closed. */
  async close(reason = 'caller_hung_up') {
    if (this.call && !this.ended) { this.ended = true; return this.call.end(reason); }
    return null;
  }
}

/** TwiML that connects an answered call to the relay (used once a provider route exists). Voice comes from settings. */
function connectTwiml({ wsUrl, actionUrl, greeting, voice = {} }) {
  const attrs = [`url="${xmlEsc(wsUrl)}"`, greeting ? `welcomeGreeting="${xmlEsc(greeting)}"` : '', `language="${xmlEsc(voice.language || 'en-US')}"`,
    voice.tts_provider ? `ttsProvider="${xmlEsc(voice.tts_provider)}"` : '', voice.voice ? `voice="${xmlEsc(voice.voice)}"` : '', 'interruptible="speech"', 'dtmfDetection="true"']
    .filter(Boolean).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${xmlEsc(actionUrl)}"><ConversationRelay ${attrs} /></Connect></Response>`;
}

/** TwiML when every line is busy: hold in a queue (music) instead of a busy signal. */
function queueTwiml({ waitUrl, queueName = 'sasha' }) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Enqueue waitUrl="${xmlEsc(waitUrl)}">${xmlEsc(queueName)}</Enqueue></Response>`;
}

/** TwiML after the relay session ends (the <Connect action> request). No live transfer yet: confirm the callback and hang up. */
function afterSessionTwiml(handoffData) {
  let h = {}; try { h = JSON.parse(handoffData || '{}'); } catch (_e) { h = {}; }
  const say = h.action === 'unavailable' ? 'Sorry, our phone assistant is not available right now. Please email info at advantage dot bid, and our team will help.'
    : 'Thank you for calling Advantage.Bid. Goodbye.';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEsc(say)}</Say><Hangup/></Response>`;
}

module.exports = { RelaySession, connectTwiml, queueTwiml, afterSessionTwiml };
