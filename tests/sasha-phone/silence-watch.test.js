'use strict';

/**
 * Silence handling on live Phone Sasha calls (silenceWatch.js): check-in after a quiet wait, disconnect after a second
 * wait, a longer wait when the caller asked for a moment, and the clock paused while Sasha answers. Fake timers; no
 * database, no model, no network.
 */

const { SilenceWatch, fromSettings, asksForTime, playbackMs, CHECK_IN, DISCONNECT, MAX_PLAYBACK_MS } = require('../../src/services/sasha/phone/silenceWatch');
const phoneSettings = require('../../src/services/sasha/phone/phoneSettings');

const S = 1000;
function fakeRelay() {
  const r = { ended: false, said: [], ends: 0 };
  r.sayLine = jest.fn(async (t) => { r.said.push(t); });
  r.silenceEnd = jest.fn(async () => { r.ends++; r.ended = true; });
  return r;
}
// msPerChar 0: playback estimates are tested separately, so the waits below are exact.
const mk = (relay, o = {}) => new SilenceWatch(relay, { checkMs: 45 * S, hangupMs: 30 * S, holdMs: 120 * S, msPerChar: 0, ...o });

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('silence watch', () => {
  test('45 s of silence → "Are you still there?"; 30 s more → disconnect line, then the call ends', () => {
    const r = fakeRelay(); const w = mk(r);
    w.waiting(0);
    jest.advanceTimersByTime(44.9 * S); expect(r.said).toEqual([]);
    jest.advanceTimersByTime(0.2 * S); expect(r.said).toEqual([CHECK_IN]);
    jest.advanceTimersByTime(29.7 * S); expect(r.said).toEqual([CHECK_IN]);
    jest.advanceTimersByTime(0.4 * S); expect(r.said).toEqual([CHECK_IN, DISCONNECT]);
    jest.advanceTimersByTime(1); expect(r.silenceEnd).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(600 * S); expect(r.silenceEnd).toHaveBeenCalledTimes(1);   // nothing further
  });

  test('the caller answering the check-in keeps the call going and restarts the full wait', () => {
    const r = fakeRelay(); const w = mk(r);
    w.waiting(0);
    jest.advanceTimersByTime(46 * S); expect(r.said).toEqual([CHECK_IN]);
    w.turnStarted('Yes, sorry, I am here.');
    jest.advanceTimersByTime(300 * S); expect(r.said).toEqual([CHECK_IN]);   // paused while Sasha answers
    w.turnFinished(0);
    jest.advanceTimersByTime(44 * S); expect(r.said).toEqual([CHECK_IN]);
    jest.advanceTimersByTime(2 * S); expect(r.said).toEqual([CHECK_IN, CHECK_IN]);
    expect(r.silenceEnd).not.toHaveBeenCalled();
  });

  test('speaking while the disconnect line plays keeps the call', () => {
    const r = fakeRelay(); const w = mk(r, { msPerChar: 65 });
    w.waiting(0);
    jest.advanceTimersByTime((45 + 30) * S + playbackMs(CHECK_IN.length) + 10); expect(r.said).toEqual([CHECK_IN, DISCONNECT]);
    w.activity();   // partial speech / barge-in during the line
    jest.advanceTimersByTime(60 * S);
    expect(r.silenceEnd).not.toHaveBeenCalled();
  });

  test('"hold on, let me find my invoice" allows 120 s before checking in, once', () => {
    const r = fakeRelay(); const w = mk(r);
    expect(asksForTime('Hold on, let me find my invoice.')).toBe(true);
    w.turnStarted('Hold on, let me find my invoice.'); w.turnFinished(0);
    jest.advanceTimersByTime(119 * S); expect(r.said).toEqual([]);
    jest.advanceTimersByTime(2 * S); expect(r.said).toEqual([CHECK_IN]);
    w.turnStarted('Found it. It is invoice 1042.'); w.turnFinished(0);
    jest.advanceTimersByTime(46 * S); expect(r.said).toEqual([CHECK_IN, CHECK_IN]);   // back to the normal wait
  });

  test('ordinary questions are not treated as a request for time', () => {
    for (const t of ['How do I hold a lot for pickup?', 'When is pickup?', 'Can I get a refund?', 'What does one dollar start mean?']) expect(asksForTime(t)).toBe(false);
    for (const t of ['One moment please', 'hang on a sec', 'Just a minute.', 'Give me a second', 'let me check my email', 'bear with me']) expect(asksForTime(t)).toBe(true);
  });

  test('the clock never runs while a turn is being answered, however long it takes', () => {
    const r = fakeRelay(); const w = mk(r);
    w.waiting(0);
    jest.advanceTimersByTime(20 * S);
    w.turnStarted('Question?');
    jest.advanceTimersByTime(900 * S);
    expect(r.said).toEqual([]);
    w.turnStarted('Another question?');   // barge-in: two turns overlap
    w.turnFinished(0);                    // the first one finishing does not start the clock
    jest.advanceTimersByTime(900 * S); expect(r.said).toEqual([]);
    w.turnFinished(0);
    jest.advanceTimersByTime(46 * S); expect(r.said).toEqual([CHECK_IN]);
  });

  test('keypad digits and partial speech reset the clock', () => {
    const r = fakeRelay(); const w = mk(r);
    w.waiting(0);
    jest.advanceTimersByTime(40 * S); w.activity(); w.waiting(0);
    jest.advanceTimersByTime(40 * S); w.turnStarted(null); w.turnFinished(0);   // one keypad digit
    jest.advanceTimersByTime(40 * S);
    expect(r.said).toEqual([]);
  });

  test('the wait starts after Sasha\'s words have played (estimate, capped at one minute)', () => {
    expect(playbackMs(150)).toBe(150 * 65);
    expect(playbackMs(100000)).toBe(MAX_PLAYBACK_MS);
    const r = fakeRelay(); const w = mk(r, { msPerChar: 65 });
    w.waiting(200);   // a 200-character answer ≈ 13 s of speech
    jest.advanceTimersByTime(45 * S + 12 * S); expect(r.said).toEqual([]);
    jest.advanceTimersByTime(2 * S); expect(r.said).toEqual([CHECK_IN]);
  });

  test('silence_check_seconds = 0 turns it off; a hang-up or an already-ended call stops it', () => {
    const off = fakeRelay(); const w0 = mk(off, { checkMs: 0 });
    w0.waiting(0); jest.advanceTimersByTime(3600 * S); expect(off.said).toEqual([]);

    const hung = fakeRelay(); const w1 = mk(hung);
    w1.waiting(0); w1.stop(); jest.advanceTimersByTime(3600 * S); expect(hung.said).toEqual([]);

    const ended = fakeRelay(); const w2 = mk(ended);
    w2.waiting(0); ended.ended = true; jest.advanceTimersByTime(3600 * S); expect(ended.said).toEqual([]);
  });

  test('settings: defaults 45 / 30 / 120 s, admin-editable within limits', () => {
    expect(fromSettings(phoneSettings.DEFAULTS)).toEqual({ checkMs: 45 * S, hangupMs: 30 * S, holdMs: 120 * S });
    expect(phoneSettings.NUM.silence_check_seconds).toEqual([0, 600]);
    expect(phoneSettings.NUM.silence_hangup_seconds).toEqual([10, 300]);
    expect(phoneSettings.NUM.silence_hold_seconds).toEqual([30, 600]);
  });
});
