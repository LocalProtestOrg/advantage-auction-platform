'use strict';

/**
 * Turning Sasha's streamed text into speech (pure).
 *   SentenceChunker  buffers streamed tokens and releases whole sentences, so text-to-speech can start on the first
 *                    sentence while the model is still writing (decimals like $3.50 and "e.g." do not split).
 *   speakable()      last-line defence for anything spoken: no markdown, bullets, URLs, internal ids or em dashes.
 *                    The phone prompt asks for speakable text in the first place; this only catches slips.
 *   pickFiller()     short, varied "one moment" phrases while a lookup runs (never the same one twice in a row).
 */

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// A bare site name ("bid.advantage.bid", "www.advantage.bid"), lower-case only so the brand "Advantage.Bid" is never touched.
const BARE_DOMAIN = /\b(?:https?:\/\/)?(?:www|bid)\.advantage\.bid\b(?!\/)/g;
/** opts.allowDomain: the caller asked for the website address, so a bare site name may be spoken. */
/**
 * Spoken form of the brand and its addresses (owner direction 2026-10-14): always "Advantage dot Bid", never "period"
 * or a silent dot. Text-to-speech engines read "Advantage.Bid" inconsistently, so every spoken path converts it here;
 * written text (transcripts, settings, web pages) keeps "Advantage.Bid".
 */
function spokenBrand(t) {
  return String(t == null ? '' : t)
    .replace(/\bAdvantage\.Bid\b/g, 'Advantage dot Bid')
    .replace(/\b([a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*)@advantage\.bid\b/gi, (m, user) => `${user.replace(/\./g, ' dot ')} at advantage dot bid`)
    .replace(/\b(?:(www|bid)\.)?advantage\.bid\b/gi, (m, sub) => (sub ? sub.toLowerCase() + ' dot ' : '') + 'advantage dot bid');
}

function speakable(t, opts = {}) {
  const out = String(t || '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[*\-•]|\d+[.)])\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/https?:\/\/[^\s)]+/gi, 'our website')
    .replace(/\b(?:www\.|bid\.)?advantage\.bid\/[^\s)]+/gi, 'our website')
    .replace(UUID_RE, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
  return spokenBrand(opts.allowDomain ? out : out.replace(BARE_DOMAIN, 'the Advantage.Bid website').replace(/\bthe the Advantage\.Bid website\b/g, 'the Advantage.Bid website'));
}

class SentenceChunker {
  constructor(opts = {}) { this.buf = ''; this.opts = opts; }
  /** Add streamed text; returns the complete sentences now available (possibly none). */
  push(delta) {
    this.buf += String(delta || '');
    const out = [];
    for (;;) {
      const m = /([.!?])(["')\]]?)(\s+)(?=\S)/.exec(this.buf);
      if (!m) break;
      const end = m.index + m[1].length + m[2].length;
      const before = this.buf.slice(0, end);
      // Not a sentence end: a decimal ("$3.50"), an initial ("J. Smith") or a common abbreviation.
      if (m[1] === '.' && /(\b(?:e\.g|i\.e|etc|Mr|Mrs|Ms|Dr|St|No|vs|approx|a\.m|p\.m)|\b[A-Z])\.$/.test(before)) {
        const rest = this.buf.slice(end); const j = rest.search(/[.!?]\s+\S/);
        if (j < 0) break;
        const cut = end + j + 1;
        out.push(this.buf.slice(0, cut)); this.buf = this.buf.slice(cut).replace(/^\s+/, '');
        continue;
      }
      out.push(before); this.buf = this.buf.slice(end + m[3].length);
    }
    return out.map((x) => speakable(x, this.opts)).filter(Boolean);
  }
  flush() { const s = speakable(this.buf, this.opts); this.buf = ''; return s ? [s] : []; }
}

const FILLERS = ['One moment while I check that for you.', 'Let me look that up.', 'Give me just a second.', 'Let me check on that.',
  'One moment, please.', 'I\'m pulling that up now.'];
function pickFiller(last) {
  const choices = FILLERS.filter((f) => f !== last);
  return choices[Math.floor(Math.random() * choices.length)];
}

module.exports = { speakable, spokenBrand, SentenceChunker, pickFiller, FILLERS };
