/* BuyerChime — THE single source of truth for live-bidding sounds.
 *
 * Consolidation: buyer-nav.js previously shipped a SECOND, competing implementation
 * that overwrote this global (dropping isMuted/setMuted), used a different storage
 * key ('bidSound'), and defaulted OFF. That collision threw
 * "window.BuyerChime.isMuted is not a function" on every live auction page and left
 * the Lot Detail sound toggle dead. There is now exactly one implementation, one
 * storage key, and one preference shared by the Auction Gallery and Lot Detail.
 *
 * Approved behavior:
 *   - available to all viewers; DEFAULT ON (a user who never chose hears sounds)
 *   - the toggle stays visible; users can turn sounds OFF, and OFF sticks
 *   - one preference across every page
 *   - distinct sounds: bid vs outbid vs anti-snipe extension
 *
 * Autoplay-safe: the AudioContext is created/resumed only after the first user
 * gesture (pointer/touch/key), which satisfies mobile + desktop autoplay policies.
 * Synthesized tones (no asset files).
 *   play('bid')      → pleasant rising two-tone chime (a bid landed / you're winning)
 *   play('outbid')   → lower descending tone (you've been outbid)
 *   play('extended') → triple pulse (anti-snipe extension)
 *
 * Any page with a sound control should listen for the 'buyerchime:change' event and
 * repaint, so multiple toggles on one page (Lot Detail has its own AND the nav's)
 * never disagree.
 */
(function () {
  'use strict';

  var KEY        = 'aac_sound_muted';   // '1' = muted. Absent = never chosen = ON.
  var LEGACY_KEY = 'bidSound';          // retired buyer-nav key: 'on' | 'off'.
  var THROTTLE_MS = 800;                // carried over from buyer-nav: a burst of
                                        // events must not stack into a noise pile.

  var ctx = null, unlocked = false, muted = false, lastPlay = 0;

  // Resolve the stored preference. A user who explicitly chose OFF under the old
  // buyer-nav toggle keeps that choice; everyone else defaults ON.
  try {
    var stored = localStorage.getItem(KEY);
    if (stored === null) {
      var legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy === 'off')     { muted = true;  localStorage.setItem(KEY, '1'); }
      else if (legacy === 'on') { muted = false; localStorage.setItem(KEY, '0'); }
      // No preference at all → default ON (muted stays false).
    } else {
      muted = stored === '1';
    }
  } catch (e) { /* private mode / storage disabled → default ON, in-memory only */ }

  function ensureCtx() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ignore */ } }
    return ctx;
  }
  function unlock() {
    if (unlocked) return; unlocked = true;
    var c = ensureCtx(); if (!c) return;
    try { var o = c.createOscillator(), g = c.createGain(); g.gain.value = 0; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.01); } catch (e) { /* ignore */ }
  }
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { passive: true });
  });

  function tone(freqs, dur, type, peak) {
    if (muted) return;
    var c = ensureCtx(); if (!c) return;
    var t0 = c.currentTime;
    freqs.forEach(function (f, i) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = f;
      var start = t0 + i * 0.07;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(peak || 0.15, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(g); g.connect(c.destination);
      o.start(start); o.stop(start + dur + 0.03);
    });
  }

  function announce() {
    try { window.dispatchEvent(new CustomEvent('buyerchime:change', { detail: { muted: muted } })); }
    catch (e) { /* CustomEvent unsupported → toggles simply repaint on their own click */ }
  }

  window.BuyerChime = {
    play: function (kind) {
      try {
        if (muted) return;
        // Live bidding can deliver several signals at once (lot:update + a targeted
        // winning/outbid). Collapse them so one event never sounds twice.
        var now = Date.now();
        if (now - lastPlay < THROTTLE_MS) return;
        lastPlay = now;
        if (kind === 'bid') tone([659.25, 880.0], 0.20, 'sine', 0.16);            // E5 → A5, gentle
        else if (kind === 'outbid') tone([311.13, 207.65], 0.30, 'triangle', 0.18); // Eb4 → Ab3, lower
        else if (kind === 'extended') tone([523.25, 523.25, 698.46], 0.15, 'sine', 0.14); // C5 pulse ×2 + F5
      } catch (e) { /* never let audio break bidding */ }
    },
    setMuted: function (m) {
      muted = !!m;
      try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
      announce();
      return muted;
    },
    isMuted: function () { return muted; },
    // Retained for the retired buyer-nav API shape: enabled() === !isMuted().
    enabled: function () { return !muted; },
    toggle: function () { return this.setMuted(!muted); }
  };
})();
