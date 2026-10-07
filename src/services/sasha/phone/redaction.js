'use strict';

/**
 * Phone transcript safety (pure). Applied to every caller utterance BEFORE it is stored or shown to the model:
 *   - a verification code is extracted for Railway to check and replaced with "[verification code]" (never stored,
 *     never given to the model, never in the audit log);
 *   - card-like data (a 13-19 digit number passing the Luhn check, a long digit run said near card words, or digits
 *     after "CVV" / "security code" / "expiration") is replaced with "[card details removed]".
 * Speech-to-text writes numbers as words or digits ("four two four two", "4242 4242"), so both are handled.
 */

const { CODE_LENGTH } = require('../../../lib/verificationCode');
const STRICT_DIGIT = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const DIGIT_WORD = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|double|triple|\\d)';
const SPOKEN_RUN = new RegExp('\\b' + DIGIT_WORD + '(?:[\\s,.-]+' + DIGIT_WORD + '){2,}\\b', 'gi');

/** "four two four two" → "4 2 4 2"; "double five" → "5 5". Only runs of 3+ number words change (keeps "one or two"). */
function normalizeSpokenDigits(text) {
  return String(text || '').replace(SPOKEN_RUN, (run) => {
    const words = run.toLowerCase().split(/[\s,.-]+/).filter(Boolean);
    const res = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if ((w === 'double' || w === 'triple') && i + 1 < words.length) { const d = STRICT_DIGIT[words[i + 1]] || words[i + 1]; for (let k = 0; k < (w === 'double' ? 2 : 3); k++) res.push(d); i++; }
      else if (w === 'double' || w === 'triple') res.push(w);
      else res.push(STRICT_DIGIT[w] || w);
    }
    return res.join(' ');
  });
}

/** Runs of digits that may be separated by single spaces, dashes, dots or commas ("4242 4242 4242 4242", "1-2-3"). */
function digitRuns(text) {
  const runs = [];
  const re = /\d(?:[\s.,-]{0,2}\d)*/g;
  let m;
  while ((m = re.exec(text))) runs.push({ raw: m[0], digits: m[0].replace(/\D/g, ''), index: m.index });
  return runs;
}

function luhn(d) {
  let sum = 0; let alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = Number(d[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}

const CARD_WORDS = /\b(card|credit|debit|visa|mastercard|master card|amex|american express|discover|cvv|cvc|security code|expir\w*|exp date)\b/i;
const SECRET_LEAD = /\b(cvv|cvc|cid|security code|expiration( date)?|expiry|exp(?:\.|iration)? date|expires)\b\D{0,20}/i;

/**
 * Clean one caller utterance.
 * opts.expectCode: a verification code is outstanding → a 4-digit run is taken as the code.
 * Returns { text, code, cardDetected }: `text` is safe to store and to give the model.
 */
function cleanUtterance(raw, { expectCode = false } = {}) {
  let text = normalizeSpokenDigits(String(raw || '').slice(0, 4000));
  let code = null; let cardDetected = false;
  // Card numbers first (a 16-digit card must never be mistaken for a code).
  for (const r of digitRuns(text).sort((a, b) => b.index - a.index)) {
    const isCard = (r.digits.length >= 13 && r.digits.length <= 19 && luhn(r.digits)) || (r.digits.length >= 12 && CARD_WORDS.test(text));
    if (isCard) { cardDetected = true; text = text.slice(0, r.index) + '[card details removed]' + text.slice(r.index + r.raw.length); }
  }
  // CVV / expiration digits after a card word.
  if (SECRET_LEAD.test(text)) {
    const before = text;
    text = text.replace(new RegExp(SECRET_LEAD.source + '(\\d[\\d\\s/.-]{1,8}\\d|\\d{3,4})', 'gi'), (m, ...g) => m.replace(/\d[\d\s/.-]*\d|\d+/g, '[card details removed]'));
    if (text !== before) cardDetected = true;
  }
  if (expectCode) {
    const four = digitRuns(text).filter((r) => r.digits.length === CODE_LENGTH);
    if (four.length) {
      code = four[0].digits;
      text = text.slice(0, four[0].index) + '[verification code]' + text.slice(four[0].index + four[0].raw.length);
    }
  }
  return { text: text.trim(), code, cardDetected };
}

/** Defence in depth for anything Sasha says: never echo a long digit run that looks like a card. */
function scrubOutbound(text) {
  return String(text || '').replace(/\d(?:[\s.-]?\d){12,18}/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[removed]' : m));
}

module.exports = { cleanUtterance, normalizeSpokenDigits, scrubOutbound, luhn, _digitRuns: digitRuns };
