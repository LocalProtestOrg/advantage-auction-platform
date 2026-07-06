/* BuyerChime — lightweight WebAudio sounds for the live bidding experience.
 * Referenced by lot.html + auction-view.html (previously undefined → silent).
 * Autoplay-safe: the AudioContext is created/resumed only after the first user
 * gesture (pointer/touch/key), which satisfies mobile + desktop autoplay policies.
 * Synthesized tones (no asset files). Mute persists in localStorage.
 *   play('bid')      → pleasant rising two-tone chime (a bid landed / you're winning)
 *   play('outbid')   → lower descending tone (you've been outbid)
 *   play('extended') → triple pulse (anti-snipe extension) */
(function () {
  'use strict';
  var ctx = null, unlocked = false, muted = false;
  try { muted = localStorage.getItem('aac_sound_muted') === '1'; } catch (e) { /* ignore */ }

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

  window.BuyerChime = {
    play: function (kind) {
      try {
        if (kind === 'bid') tone([659.25, 880.0], 0.20, 'sine', 0.16);            // E5 → A5, gentle
        else if (kind === 'outbid') tone([311.13, 207.65], 0.30, 'triangle', 0.18); // Eb4 → Ab3, lower
        else if (kind === 'extended') tone([523.25, 523.25, 698.46], 0.15, 'sine', 0.14); // C5 pulse ×2 + F5
      } catch (e) { /* never let audio break bidding */ }
    },
    setMuted: function (m) { muted = !!m; try { localStorage.setItem('aac_sound_muted', muted ? '1' : '0'); } catch (e) { /* ignore */ } return muted; },
    isMuted: function () { return muted; },
    toggle: function () { return this.setMuted(!muted); }
  };
})();
