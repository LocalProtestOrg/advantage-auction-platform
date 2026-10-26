'use strict';

/**
 * Silence handling on a live Phone Sasha call (owner request 2026-10-26).
 *
 * The clock only runs while Sasha is waiting for the caller: it is paused while a caller turn is being answered, and
 * every caller sound (partial or final speech, a keypad press, a barge-in) stops it. When Sasha finishes, it restarts
 * after an estimate of how long her last words take to play, since Twilio does not report when playback ends.
 *
 *   wait (sasha.phone.silence_check_seconds, default 45)   → "Are you still there?"
 *   wait (sasha.phone.silence_hangup_seconds, default 30)  → disconnect line, then the normal goodbye and hang-up
 *
 * If the caller's last words asked for time ("hold on", "let me find my invoice"), the next wait is
 * sasha.phone.silence_hold_seconds (default 120) instead. silence_check_seconds = 0 turns the feature off.
 * Both spoken lines are fixed text: no model request, no cost.
 */

const CHECK_IN = 'Are you still there?';
const DISCONNECT = 'It sounds like we got disconnected. Please call us back anytime.';

// Rough playback time per spoken character at Sasha's voice speed (about 15 characters a second), capped so a long
// answer can never hold the clock off for more than a minute.
const MS_PER_CHAR = 65;
const MAX_PLAYBACK_MS = 60000;

const HOLD = /\b(hold on|hang on|one (sec|second|moment|minute)|just a (sec|second|moment|minute)|give me (a|one) (sec|second|moment|minute)|wait a (sec|second|moment|minute)|bear with me|let me (find|grab|get|check|look|pull|go)|i need to (find|grab|get|check|look))\b/i;
const asksForTime = (text) => HOLD.test(String(text || ''));

function playbackMs(chars, msPerChar = MS_PER_CHAR) { return Math.min(MAX_PLAYBACK_MS, Math.max(0, Number(chars) || 0) * msPerChar); }

class SilenceWatch {
  /**
   * @param relay  the RelaySession (sayLine(text), silenceEnd(), ended)
   * @param opts   { checkMs, hangupMs, holdMs, msPerChar, setTimeout, clearTimeout }
   */
  constructor(relay, opts = {}) {
    this.relay = relay;
    this.checkMs = opts.checkMs; this.hangupMs = opts.hangupMs; this.holdMs = opts.holdMs;
    this.msPerChar = opts.msPerChar == null ? MS_PER_CHAR : opts.msPerChar;
    this.setT = opts.setTimeout || setTimeout; this.clearT = opts.clearTimeout || clearTimeout;
    this.timer = null; this.stage = 'idle'; this.pending = 0; this.hold = false; this.stopped = !(this.checkMs > 0);
  }

  _clear() { if (this.timer) { this.clearT(this.timer); this.timer = null; } }
  _set(ms, fn) {
    this._clear();
    this.timer = this.setT(() => { this.timer = null; fn(); }, ms);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  /** The caller made a sound (speech, keypad, barge-in): stop the clock and forget any check-in already asked. */
  activity() { if (this.stopped) return; this._clear(); this.stage = 'idle'; }

  /** A caller turn was queued for an answer. */
  turnStarted(text) { if (this.stopped) return; this.activity(); this.pending++; if (text != null) this.hold = asksForTime(text); }

  /** A caller turn finished (answered, recovered or failed); spokenChars = what Sasha said in reply. */
  turnFinished(spokenChars) { if (this.stopped) return; this.pending = Math.max(0, this.pending - 1); if (this.pending === 0) this.waiting(spokenChars); }

  /** Sasha is now waiting for the caller (after the greeting or an answer). */
  waiting(spokenChars = 0) {
    if (this.stopped || this.pending > 0 || this.relay.ended) return;
    const wait = this.hold ? this.holdMs : this.checkMs;
    this.hold = false; this.stage = 'waiting';
    this._set(playbackMs(spokenChars, this.msPerChar) + wait, () => this._checkIn());
  }

  _checkIn() {
    if (this.stopped || this.pending > 0 || this.relay.ended) return;
    this.stage = 'checked_in';
    Promise.resolve(this.relay.sayLine(CHECK_IN)).catch((e) => console.error('[voice-relay] silence check-in', e.message));
    this._set(playbackMs(CHECK_IN.length, this.msPerChar) + this.hangupMs, () => this._disconnect());
  }

  // The disconnect line plays in full before the session ends; a caller who speaks up while it plays keeps the call.
  _disconnect() {
    if (this.stopped || this.pending > 0 || this.relay.ended) return;
    this.stage = 'ending';
    Promise.resolve(this.relay.sayLine(DISCONNECT)).catch((e) => console.error('[voice-relay] silence disconnect', e.message));
    this._set(playbackMs(DISCONNECT.length, this.msPerChar), () => {
      if (this.stopped || this.pending > 0 || this.relay.ended) return;
      this.stopped = true;
      Promise.resolve(this.relay.silenceEnd()).catch((e) => console.error('[voice-relay] silence end', e.message));
    });
  }

  stop() { this.stopped = true; this._clear(); }
}

/** Seconds from phone settings → milliseconds for one call. */
function fromSettings(s, overrides = {}) {
  const sec = (k, d) => Math.max(0, Number(s && s[k] != null ? s[k] : d)) * 1000;
  return { checkMs: sec('silence_check_seconds', 45), hangupMs: sec('silence_hangup_seconds', 30), holdMs: sec('silence_hold_seconds', 120), ...overrides };
}

module.exports = { SilenceWatch, fromSettings, asksForTime, playbackMs, CHECK_IN, DISCONNECT, MS_PER_CHAR, MAX_PLAYBACK_MS };
