'use strict';

/**
 * messageScreening.js — layered screening of storefront item messages (owner requirements 2026-10-16, eBay-style;
 * design storefront-messaging-and-widget-design-2026-10-16.md §3). Pure, deterministic, versioned rules (no DB).
 *
 *   L1 explicit contact details (phone, email, web address, social handle)        → MASKED in the delivered text
 *   L2 disguised contact details (spelled-out / separated digits, letters for digits, "bob at gmail dot com",
 *      "s m i t h @ g m a i l", "myshop dot com", look-alike letters, invisible characters) → MASKED
 *   L3 off-platform payment (Venmo, Zelle, Cash App, wire, crypto, "pay me directly", "cash only") → HELD for review
 *   L4 indirect diversion ("Google my business and call me", "find me on Facebook", "contact the store for a better
 *      price", "5% off in person", "skip the fee", another marketplace or social network, an outside checkout link)
 *      → HELD for review
 *
 * Screening never punishes anyone: a held message waits for a person, and the sender may rephrase. Legitimate talk about
 * condition, measurements, photos, authenticity, shipping, pickup, inspections and an on-platform price change passes.
 * Ambiguous mentions (e.g. "I saw this on Facebook") are held rather than guessed at — a person decides.
 * Circumvention cannot be prevented completely; these rules make the on-platform path the easy one.
 *
 *   screen(text) → { text, masked: [kinds], hold: [rule ids], version }
 *     text  — what the other party may see (cleaned of invisible characters, contact details replaced by markers)
 */

const VERSION = 'msg-screen-2026-10-26.3';

const MARK = { phone: '[phone number hidden]', email: '[email hidden]', link: '[link hidden]', handle: '[username hidden]' };

// Invisible / formatting characters used to split words past simple filters.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
// Look-alike letters (Cyrillic / Greek) → Latin, one character for one character so positions stay aligned.
const HOMOGLYPH = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j',
  'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H',
  'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'ο': 'o', 'α': 'a', 'ε': 'e',
  'ι': 'i', 'κ': 'k', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'Ο': 'O', 'Α': 'A',
  'Β': 'B', 'Ε': 'E', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X', 'Ζ': 'Z',
};

// Text used for matching: same length as the delivered text (1:1 character map), lower case, look-alikes folded.
function matchView(s) {
  let out = '';
  for (const ch of s) {
    const m = HOMOGLYPH[ch] || ch;
    const l = m.toLowerCase();
    out += l.length === m.length ? l : m;
  }
  return out;
}
// For phone detection only: letters standing in for digits inside a digit group ("l23", "12O") become digits.
function digitView(view) {
  return view.replace(/[a-z0-9]+/g, (t) => (/\d/.test(t) && /^[\dlio]+$/.test(t) ? t.replace(/[li]/g, '1').replace(/o/g, '0') : t));
}

const PHONE_GROUPS = new Set(['3,4', '3,3,4', '3,7', '6,4', '1,3,3,4', '1,3,7', '1,6,4', '3,3,2,2', '1,3,3,2,2']);
const NUM_WORDS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const ALLOWED_HOSTS = /^(?:[a-z0-9-]+\.)*advantage\.bid$/;
const TLD = '(?:com|net|org|biz|info|co|us|io|me|ly|shop|store|online|site|app|xyz|ca|uk|page|link|gl)';
const TLD_STRONG = '(?:com|net|org|biz|info)';               // unambiguous enough to accept "myshop .com"
const spaced = (w) => w.split('').join('[\\s-]*');              // "gmail" → "g\s*m\s*a\s*i\s*l"
const PROVIDERS = ['gmail', 'googlemail', 'yahoo', 'ymail', 'hotmail', 'outlook', 'aol', 'icloud', 'protonmail', 'proton', 'msn', 'comcast', 'gmx']
  .map(spaced).join('|');
const SQUASHED_PROVIDERS = /^(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|aol|icloud|protonmail|proton|msn|comcast|gmx)/;
const SOCIAL ='(?:facebook|fb|instagram|insta|ig|tik\\s*tok|snap\\s*chat|twitter|whats\\s*app|telegram|craigslist|offer\\s*up|etsy|ebay|nextdoor|mercari|poshmark|chairish|1stdibs|kijiji|shopify|linked\\s*in)';

// Replace [start, end) ranges (merged when they overlap) with markers.
function applyMasks(text, ranges) {
  if (!ranges.length) return text;
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) { if (r.end > last.end) last.end = r.end; continue; }
    merged.push({ ...r });
  }
  let out = ''; let pos = 0;
  for (const r of merged) { out += text.slice(pos, r.start) + MARK[r.kind]; pos = r.end; }
  return out + text.slice(pos);
}
// Widen a range over what would otherwise be left behind: an opening bracket before a phone number, and the front part
// of a disguised email ("bob dot smith at …", "b o b [at] …").
function widen(view, r) {
  if (r.kind === 'phone' && r.start > 0 && view[r.start - 1] === '(') r.start--;
  if (r.kind === 'email') {
    const before = view.slice(Math.max(0, r.start - 80), r.start);
    const m = /(?:[a-z0-9_%+-]+\s*(?:\.|\bdot\b|_|-)\s*)+$/.exec(before) || /(?:(?:^|[\s._-])[a-z0-9])+[\s._-]*$/.exec(before);
    if (m) r.start -= m[0].replace(/^[\s._-]/, '').length;
  }
  return r;
}

function collect(re, view, kind, ranges, test) {
  re.lastIndex = 0; let m;
  while ((m = re.exec(view))) {
    if (!test || test(m)) ranges.push({ start: m.index, end: m.index + m[0].length, kind });
    if (m[0].length === 0) re.lastIndex++;
  }
}

// ── L1 + L2: contact details to mask ───────────────────────────────────────────────────────────────────
function contactRanges(view) {
  const ranges = [];
  const AT = '\\s*[\\[({<]?\\s*(?:@|\\bat\\b)\\s*[\\])}>]?\\s*';
  const DOT = '\\s*[\\[({<]?\\s*(?:\\.|\\bdot\\b)\\s*[\\])}>]?\\s*';
  // URLs and web addresses (anything but Advantage.Bid's own pages)
  collect(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/g, view, 'link', ranges, (m) => {
    const host = m[0].replace(/^https?:\/\//, '').split(/[/?#:]/)[0];
    return !ALLOWED_HOSTS.test(host);
  });
  collect(new RegExp(`\\b[a-z0-9][a-z0-9-]{1,62}(?:\\.[a-z0-9-]{2,62})*\\.${TLD}\\b(?:/[^\\s]*)?`, 'g'), view, 'link', ranges,
    (m) => !ALLOWED_HOSTS.test(m[0].split('/')[0]));
  collect(new RegExp(`\\b[a-z0-9-]{2,}\\s+\\.\\s*${TLD_STRONG}\\b|\\b[a-z0-9-]{2,}\\s*\\.\\s+${TLD_STRONG}\\b`, 'g'), view, 'link', ranges);   // "myshop .com"
  collect(new RegExp(`\\b[a-z0-9-]{2,}\\s*[\\[({<]?\\s*\\bd[o0]t\\s*${TLD}(?![a-z0-9-])`, 'g'), view, 'link', ranges);                                  // "myshop dot com", "dotcom"
  // Emails, plain and disguised
  collect(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g, view, 'email', ranges);
  collect(new RegExp(`[a-z0-9._%+-]+${AT}[a-z0-9-]+${DOT}${TLD}\\b`, 'g'), view, 'email', ranges);                   // bob at gmail dot com
  collect(new RegExp(`[a-z0-9._%+-]+${AT}(?:${PROVIDERS})\\b`, 'g'), view, 'email', ranges);                          // bob at gmail
  // s m i t h @ g m a i l — only when the spaced letters after the "at" spell a mail provider or end in a domain ending
  // (so "2 x 4 at 6 x 8" and "A B at C D street" are left alone)
  collect(new RegExp(`(?:\\b[a-z0-9]\\b[\\s._-]*){2,}${AT}((?:\\b[a-z]\\b[\\s._-]*){2,})`, 'g'), view, 'email', ranges,
    (m) => { const w = m[1].replace(/[^a-z]/g, ''); return SQUASHED_PROVIDERS.test(w) || /(?:com|net|org)$/.test(w); });
  // Social handles: @name (emails were taken above)
  collect(/(^|[^a-z0-9._%+-])@[a-z0-9_.]{3,30}\b/g, view, 'handle', ranges);
  // Phone numbers, including spelled-out, separated and letter-for-digit forms: a run of digit tokens (digits or number
  // words) joined only by separators. Measurements ("36 x 24"), prices ("$1,250.00"), sizes ("10 12 14") and years
  // ("1950 1960") are not phone-shaped and pass; a single unbroken 7–9 digit number (an inventory or serial number) too.
  const dv = digitView(view);
  const toks = []; const tre = /\d+|[a-z]+/g; let tm;
  while ((tm = tre.exec(dv))) toks.push({ t: tm[0], start: tm.index, end: tm.index + tm[0].length });
  const isDigitTok = (x) => /^\d+$/.test(x.t) || Object.prototype.hasOwnProperty.call(NUM_WORDS, x.t);
  const SEP = /^[\s\p{Pd}._/\\|()+*•·:,]*$/u;                // spaces, any dash, dots, commas, brackets …
  for (let i = 0; i < toks.length; i++) {
    if (!isDigitTok(toks[i])) continue;
    let j = i; const seps = [];
    while (j + 1 < toks.length && isDigitTok(toks[j + 1]) && SEP.test(dv.slice(toks[j].end, toks[j + 1].start))) {
      seps.push(dv.slice(toks[j].end, toks[j + 1].start)); j++;
    }
    const run = toks.slice(i, j + 1);
    const digits = run.map((x) => (/^\d+$/.test(x.t) ? x.t : NUM_WORDS[x.t])).join('');
    const hasWords = run.some((x) => !/^\d+$/.test(x.t));
    const lens = run.map((x) => x.t.length);
    // a price or an amount written with thousands separators ("$1,250,000", "1,250,000.00") is not a phone number
    const price = toks[i].start > 0 && dv[toks[i].start - 1] === '$';
    const thousands = !hasWords && seps.length > 0 && /^,$/.test(seps[0]) && lens[0] <= 3 && lens.slice(1).every((n, k) => n === 3 || (seps[k] === '.' && n <= 2));
    if (price || thousands) { i = j; continue; }
    let phone = false;
    if (hasWords) phone = digits.length >= 7 && digits.length <= 15;
    else if (run.length === 1) phone = digits.length >= 10 && digits.length <= 11;
    else if (lens.every((n) => n === 1)) phone = digits.length >= 7;
    else phone = PHONE_GROUPS.has(lens.join(','));   // real phone groupings only: 555-0199, 713-555-0199, 555-1234567, 1-713-555-0199, 713-555-01-99
    if (phone) { ranges.push({ start: run[0].start, end: run[run.length - 1].end, kind: 'phone' }); i = j; }
  }
  return ranges;
}

// Spaced-out single letters ("v e n m o", "c.a.s.h a.p.p") squashed so brand names can be found.
function squashedRuns(view) {
  const out = [];
  const re = /(?:\b[a-z]\b[\s.\-_*·•]*){4,}/g; let m;
  while ((m = re.exec(view))) out.push(m[0].replace(/[^a-z]/g, ''));
  return out.join(' ');
}

// ── L3 + L4: rules that hold a message for review ──────────────────────────────────────────────────────
const HOLD_RULES = [
  // L3 off-platform payment
  ['L3.payment_app', /\b(?:venmo|zelle|cash\s*app|cashapp|paypal|pay\s*pal|apple\s*cash|google\s*pay|western\s*union|money\s*gram|moneygram|wise\.com|e-?transfer|interac)\b|\bchime\s+(?:app|bank|account|transfer|pay(?:ment)?)\b|\b(?:pay|send|via|by|through|on|use|with)\s+chime\b/],
  ['L3.crypto', /\b(?:bitcoin|crypto|cryptocurrency|ethereum|usdt|tether|usdc|litecoin|dogecoin|crypto\s*wallet)\b|\b(?:pay|send|in|via|accept|take)\s+(?:btc|eth)\b/],
  ['L3.wire_or_check', /\bwire\s+(?:transfer|me|you|us|it|the\s+(?:money|funds|payment)|payment)\b|\b(?:bank|direct)\s+transfer\b|\bmoney\s+order\b|\bcashier'?s?\s+check\b|\bcertified\s+check\b/],
  ['L3.pay_directly', /\bpay\s+(?:me|us|our\s+(?:store|shop|company|business))\s+(?:directly|direct|in\s*cash|cash|outside|off)\b|\b(?:direct|private)\s+payment\b|\bpay\s+(?:outside|off)\s+(?:of\s+)?(?:the\s+)?(?:site|platform|app|advantage)/],
  ['L3.cash_only', /\b(?:accept|take|prefer|want)\s+cash\b|\bcash\s+only\b|\bcash\s+(?:if|when)\s+you\s+(?:come|pick|stop)|\b(?:pay|paying|bring)\s+(?:in\s+)?cash\b|\bcash\s+(?:at|on)\s+pick\s*-?\s*up\b/],
  // L4 indirect diversion / contact requests
  ['L4.search_us', /\b(?:google|search(?:\s+for)?|look\s*up|lookup)\s+(?:my|our|the)\s+(?:business|company|store|shop|name|website|site|page|number|phone|contact|profile)\b|\b(?:google|look)\s+(?:us|me)\s*(?:up)?\b/],
  ['L4.find_elsewhere', new RegExp(`\\b(?:find|message|add|follow|dm|contact|reach|text|ping|search)\\s+(?:me|us|[a-z0-9&'.-]+(?:\\s+[a-z0-9&'.-]+){0,4})\\s+(?:on|at|through|via)\\s+(?:${SOCIAL}|messenger|our\\s+(?:website|site|page))\\b`)],
  ['L4.other_platform', new RegExp(`\\b(?:on|at|via|through|from)\\s+(?:my|our|the)?\\s*${SOCIAL}\\b|\\b${SOCIAL}\\s*[:\\-]\\s*\\S|\\b(?:insta|ig|fb|tiktok)\\s+@?[a-z0-9_.]{3,}|\\b(?:my|our)\\s+(?:${SOCIAL}|online|web\\s*site|website)\\s+(?:shop|store|page|listing|site|account)\\b`)],
  ['L4.my_social', new RegExp(`\\b(?:my|our)\\s+${SOCIAL}\\b|\\bgoogle\\s+(?:it|us|me|them|that)\\b`)],
  ['L4.other_app',/\b(?:whats\s*app|telegram|signal\s+app|we\s*chat|kik)\b|\b(?:facebook|fb)\s+messenger\b|\b(?:on|via|through|by)\s+messenger\b|\bmessenger\s+(?:me|us)\b/],
  ['L4.call_text_email', /\b(?:call|text|phone|email|e-mail|ring)\s+(?:me|us|our\s+(?:store|shop|office|number)|the\s+(?:store|shop|office))\b|\bgive\s+(?:me|us)\s+a\s+(?:call|ring|text)\b|\b(?:my|our)\s+(?:cell|phone\s*number|number|email(?:\s+address)?|e-mail)\s+(?:is|:)/],
  ['L4.contact_directly', /\b(?:contact|reach|call|email|message)\s+(?:me|us|our\s+(?:store|shop|company|office)|the\s+(?:store|shop|company))\s+directly\b|\b(?:deal|buy|sell|trade)\s+(?:with\s+(?:me|us)\s+)?directly\b/],
  ['L4.off_platform', /\b(?:outside|off)\s+(?:of\s+)?(?:the|this)\s+(?:site|platform|app|website)\b|\boff\s*-?\s*platform\b|\bwithout\s+advantage\b|\b(?:skip|avoid|save|dodge|get\s+around|cut\s+out)\s+(?:the\s+|their\s+|all\s+the\s+)?(?:fee|fees|commission|middle\s*man)\b/],
  ['L4.own_checkout', /\b(?:my|our)\s+own\s+(?:checkout|website|site|store|shop|payment\s+page)\b|\b(?:buy|order|purchase|check\s*out)\s+(?:it\s+|this\s+)?(?:directly\s+)?(?:from|on|through|at)\s+(?:my|our)\s+(?:website|site|online\s+store|web\s*store|shop\s+page|store\s+page)\b|\bpayment\s+link\b|\bcheckout\s+(?:page|link)\b/],
];
// L4 discount-for-going-elsewhere: a discount term and an elsewhere term in the same sentence. Seeing, inspecting or
// picking the item up in person is ordinary and is removed from the sentence before the elsewhere test.
const DISCOUNT = /\b\d{1,2}\s*(?:%|percent)(?:\s*off)?|\$\s*\d+\s*off\b|\b(?:\d+|[a-z]+(?:ty|teen|ten|five|hundred))\s*(?:dollars|bucks)\s+off\b|\bdiscount\b|\bbetter\s+(?:price|deal|offer)\b|\bcheaper\b|\bknock\b.*\boff\b|\bless\s+(?:if|when)\b|\bsave\s+you\b/;
const ELSEWHERE = /\bin\s*-?\s*person\b|\bin\s*-?\s*store\b|\bdirectly\b|\bdirect\b|\bcome\s+(?:by|in|to\s+(?:our|the)\s+(?:store|shop|warehouse))\b|\bstop\s+by\b|\bcash\b|\bour\s+(?:store|shop|website|site)\b|\boutside\b|\boff\s+(?:the\s+)?(?:site|platform)\b|\bcontact\s+(?:me|us|our)\b|\bcall\s+(?:me|us)\b/;
const ORDINARY_IN_PERSON = /\b(?:see|view|inspect|look\s+at|check(?:\s+out)?|examine|pick(?:\s*-?\s*up)?|picking(?:\s+up)?|collect|meet|local)\b[^.!?]{0,30}?\bin\s*-?\s*person\b/g;
// Outside checkout / payment links are held as well as masked.
const CHECKOUT_LINK = /(?:checkout|cart|pay|invoice|order|buy|shopify|square\.link|squareup|paypal\.me|venmo\.com|buy\.stripe|etsy\.com|ebay\.com)/;

// Digits used as letters inside a word ("v3nmo", "z3lle") read as letters, for the hold rules only.
function letterView(view) {
  return view.replace(/[a-z0-9$@]+/g, (t) => (/[a-z]/.test(t) && /[0-9$@]/.test(t)
    ? t.replace(/3/g, 'e').replace(/0/g, 'o').replace(/1/g, 'i').replace(/4/g, 'a').replace(/[5$]/g, 's').replace(/@/g, 'a') : t));
}
function holdRules(view, linkTexts) {
  const hits = [];
  const squashed = squashedRuns(view);
  const lv = letterView(view);
  for (const [id, re] of HOLD_RULES) if (re.test(view) || re.test(lv) || (squashed && re.test(squashed))) hits.push(id);
  for (const sentence of view.split(/[.!?\n;]+/)) {
    if (DISCOUNT.test(sentence) && ELSEWHERE.test(sentence.replace(ORDINARY_IN_PERSON, ' '))) { hits.push('L4.discount_elsewhere'); break; }
  }
  if (linkTexts.some((t) => CHECKOUT_LINK.test(t))) hits.push('L4.outside_checkout_link');
  return [...new Set(hits)];
}

function screen(input) {
  const original = String(input == null ? '' : input);
  // Delivered text: Unicode-normalised, invisible characters removed, control characters (except newlines) dropped.
  const text = original.normalize('NFKC').replace(INVISIBLE, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  const view = matchView(text);
  const ranges = contactRanges(view).map((r) => widen(view, r));
  const linkTexts = ranges.filter((r) => r.kind === 'link' || r.kind === 'email').map((r) => view.slice(r.start, r.end));
  const delivered = applyMasks(text, ranges.map((r) => ({ ...r })));
  const masked = Object.keys(MARK).filter((k) => delivered.includes(MARK[k])).sort();
  const hold = holdRules(view, linkTexts);
  // a hidden username together with a social network name is a request to continue elsewhere
  if (masked.includes('handle') && new RegExp(`\\b${SOCIAL}\\b`).test(view)) hold.push('L4.social_handle');
  return { text: delivered, masked, hold: [...new Set(hold)], version: VERSION };
}

module.exports = { screen, VERSION, MARK };
