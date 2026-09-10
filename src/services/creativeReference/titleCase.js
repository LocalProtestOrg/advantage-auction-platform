'use strict';

/**
 * creativeReference/titleCase — Phase 3P.1 Mission 9 (port of docs/marketing/phase3p1/reference/title_case.py, driven by
 * config/capitalization-rules.json). titleCase(text, role): title style for headline / event type / event title / CTA /
 * major labels / day labels / place names; sentence style for support / help / legal / disclosure / session hours;
 * fixed tokens (Advantage.Bid, Lewis & Maese, …) keep their casing. Owner-approved messages pass through untouched in
 * their canonical casing. Phase 3P.2 (E16): an uppercase display headline is allowed only as a deliberate brief choice
 * (headline_case 'uppercase_display'); support lines are never uppercase.
 */
const CFG = require('../../../docs/marketing/phase3p1/config/capitalization-rules.json');

const TC = CFG.title_case.lowercase_unless_first_or_last;
const SMALL = new Set([...TC.articles, ...TC.coordinating_conjunctions, ...TC.short_prepositions_max_3_letters, 'with']);
const FIXED = new Map(CFG.fixed_case_tokens.map((t) => [t.toLowerCase(), t]));
const TITLE_ROLES = new Set(CFG.apply_to_roles.concat(['event_type_line', 'event_title_line', 'label', 'eyebrow', 'subheadline', 'slogan', 'benefits', 'lot_number', 'presenter']));
const SENTENCE_ROLES = new Set(CFG.sentence_case_roles.concat(['time', 'availability', 'disclosure', 'catalogue_size', 'relationship_text']));

function core(w, keepDots) { return w.toLowerCase().replace(keepDots ? /^[^\w]+|[^\w.]+$/g : /^[^\w]+|[^\w]+$/g, ''); }
function fixedOf(w) { const c = core(w, true); return FIXED.has(c) ? w.toLowerCase().replace(c, FIXED.get(c)) : null; }

function capWord(w) {
  const f = fixedOf(w); if (f) return f;
  if (w.includes('-')) return w.split('-').map((p) => (p ? capWord(p) : p)).join('-');
  const m = /^([^\w]*)(\w)([\s\S]*)$/.exec(w);
  if (!m) return w;
  return m[1] + m[2].toUpperCase() + m[3].toLowerCase();
}

// Short all-caps tokens in mixed-case copy are abbreviations (state codes "TX", "NY", "NJ"; "NYC", "USA", "LLC") and keep
// their casing — "Houston, TX" must never become "Houston, Tx". An all-uppercase source string is not trusted this way.
const ABBREV = /^[A-Z]{2,3}$/;
const STATES = new Set('al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy'.split(' '));
// "Katy, tx" → "Katy, TX": a two-letter state code right after "City," is always uppercase.
function stateAfterComma(words, i) { if (i === 0 || !/,$/.test(words[i - 1])) return null; if (i + 1 < words.length && !/^\d{5}/.test(words[i + 1]) && !/^[·|—–-]$/.test(words[i + 1])) return null; const m = /^([a-zA-Z]{2})([^\w]*)$/.exec(words[i]); return m && STATES.has(m[1].toLowerCase()) ? m[1].toUpperCase() + m[2] : null; }
function keepAbbrev(w, mixed) { if (!mixed) return false; const c = w.replace(/^[^\w]+|[^\w]+$/g, ''); return ABBREV.test(c); }

function titleCase(text, role = 'headline') {
  const s = String(text == null ? '' : text);
  const mixed = /[a-z]/.test(s);
  if (SENTENCE_ROLES.has(role)) {
    return s.split(' ').map((w, i) => {
      const f = fixedOf(w); if (f) return f;
      if (keepAbbrev(w, mixed)) return w;
      const st = stateAfterComma(s.split(' '), i); if (st) return st;
      if (i === 0) return capWord(w);
      return (w !== w.toUpperCase() || w.length <= 2) ? w : w.toLowerCase();
    }).join(' ');
  }
  const words = s.split(' '); const n = words.length;
  return words.map((w, i) => {
    const c = core(w, false);
    if (keepAbbrev(w, mixed)) return w;
    const st = stateAfterComma(words, i); if (st) return st;
    const firstOrLast = i === 0 || i === n - 1;
    const afterBreak = i > 0 && /[:—–]$/.test(words[i - 1]);
    if (!firstOrLast && !afterBreak && SMALL.has(c) && !FIXED.has(c)) return w.toLowerCase();
    return capWord(w);
  }).join(' ');
}

/** Apply the role rule to every copy string of a brief (Owner-approved messages keep their canonical casing). */
function applyToCopy(copy, roles, { approved = [], uppercaseDisplay = false } = {}) {
  const canon = new Map(approved.map((t) => [t.toLowerCase(), t]));
  const changes = [];
  const out = {};
  for (const [k, v] of Object.entries(copy || {})) {
    if (typeof v !== 'string' || !v) { out[k] = v; continue; }
    const role = roles[k] || k;
    let next;
    if (canon.has(v.toLowerCase())) next = canon.get(v.toLowerCase());
    else if (role === 'headline' && uppercaseDisplay) next = v.toUpperCase();
    else next = TITLE_ROLES.has(role) || SENTENCE_ROLES.has(role) ? titleCase(v, role) : v;
    if (next !== v) changes.push({ field: k, role, before: v, after: next });
    out[k] = next;
  }
  return { copy: out, changes };
}

/** Post-render hygiene: a headline drawn all-uppercase (not a deliberate display choice) or all-lowercase is a violation. */
function hygiene(drawn, { uppercaseDisplay = false } = {}) {
  const violations = [];
  for (const d of drawn || []) {
    const t = String(d.text || '').trim(); if (!t || !/[a-z]/i.test(t)) continue;
    const letters = t.replace(/[^A-Za-z]/g, '');
    const isUpper = letters && letters === letters.toUpperCase(); const isLower = letters && letters === letters.toLowerCase();
    if (['headline', 'event_type', 'event_title', 'title'].includes(d.role)) {
      if (isUpper && !uppercaseDisplay && letters.length > 3) violations.push({ role: d.role, text: t, rule: 'headline set fully uppercase (title style is the default; uppercase only as a deliberate display choice)' });
      if (isLower) violations.push({ role: d.role, text: t, rule: 'headline set fully lowercase' });
      if (d.role === 'headline' && !uppercaseDisplay && titleCase(t, 'headline') !== t && !FIXED.has(t.toLowerCase())) violations.push({ role: d.role, text: t, rule: 'headline not in title style (expected "' + titleCase(t, 'headline') + '")' });
    }
    if (['support', 'help'].includes(d.role) && isUpper && letters.length > 6) violations.push({ role: d.role, text: t, rule: 'support line never uppercase' });
  }
  return { pass: violations.length === 0, violations };
}

module.exports = { titleCase, applyToCopy, hygiene, CFG };
