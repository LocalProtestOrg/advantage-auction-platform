#!/usr/bin/env node
/* generate-ring-audio.js — writes public/audio/connecting-ring.wav: ONE standard US telephone ringback cycle, played
   between the Phone Sasha menu and Sasha (the "connecting you to a representative" moment).

   US ringback (ANSI T1.401 / North American precise tone plan): 440 Hz + 480 Hz together, 2 s on. One cycle here is
   2.0 s of tone + 0.5 s of silence = 2.5 s. Kept subtle: about -18 dBFS per tone with 15 ms fades (no clicks).
   Format: 8 kHz, mono, 16-bit PCM WAV (telephone band; Twilio <Play> supports it). Deterministic: same bytes every run. */
const fs = require('fs'); const path = require('path');

const RATE = 8000; const ON_S = 2.0; const OFF_S = 0.5; const AMP = 0.125; const FADE_S = 0.015;
const total = Math.round((ON_S + OFF_S) * RATE); const on = Math.round(ON_S * RATE); const fade = Math.round(FADE_S * RATE);
const pcm = Buffer.alloc(total * 2);
for (let i = 0; i < total; i++) {
  let v = 0;
  if (i < on) {
    const t = i / RATE;
    const env = Math.min(1, i / fade, (on - 1 - i) / fade);
    v = env * AMP * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t));
  }
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
const out = path.join(__dirname, '..', 'public', 'audio', 'connecting-ring.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, pcm]));
console.log('wrote', path.relative(process.cwd(), out), (44 + pcm.length) + ' bytes', ((ON_S + OFF_S)).toFixed(1) + ' s');
