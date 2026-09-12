'use strict';

/**
 * replyClassifier — decides what an inbound Event Partner reply IS, and what may safely happen next.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a classification never becomes an authorization.
 *
 * Not one branch below can return an action that grants, broadens or re-scopes permission. The
 * strongest thing an affirmative reply can produce is `resend_authorization_link` — the company still
 * has to click the deterministic, single-use, evidence-backed link from Phase 1. "Sure, go ahead" in
 * an email is a reason to send a link, never a permission record. `authorization_method` stays limited
 * to its four approved evidence types and a classifier verdict is not one of them.
 *
 * The second rule: classification may only ever move state in the STOPPING direction automatically.
 * Suppress, stop, ignore, escalate — all safe, because the worst case is that we do less. Anything
 * that would do MORE (authorize, change the authorized domain, activate collection) is either routed
 * to the deterministic token flow or escalated to a human.
 *
 * Two tiers, and the difference matters:
 *   DETERMINISTIC — RFC-defined headers, delivery-status reports, explicit opt-out tokens, and our own
 *                   registry state. Confidence 1.0. These drive automated action.
 *   HEURISTIC     — phrase matching over the body, with an explicit precedence order. Advisory. It can
 *                   trigger the safe stopping actions and link re-sends, and escalates when unsure.
 *
 * There is no model call here. Classification is rule-based on purpose: it is auditable, reproducible,
 * and cannot be prompt-injected by the contents of an inbound email. If a language model is ever added
 * it must sit BEHIND this file as a triage aid for QUESTION/UNKNOWN only, and must never widen the
 * action set.
 */

const CLASSES = Object.freeze([
  'YES_AFFIRMATIVE',
  'QUESTION',
  'CORRECTED_WEBSITE',
  'WRONG_CONTACT',
  'ALREADY_AUTHORIZED',
  'DECLINE',
  'STOP_UNSUBSCRIBE',
  'OUT_OF_OFFICE',
  'HARD_BOUNCE',
  'SOFT_BOUNCE',
  'LEGAL_RIGHTS',
  'UNKNOWN',
  'HUMAN_REQUIRED',
]);

/**
 * The complete set of actions this module may ever recommend. Exported so a test can assert that no
 * authorizing, domain-changing, collection-activating or ownership-granting verb was ever added.
 */
const ACTIONS = Object.freeze([
  'suppress_outreach',            // terminal: stop contacting this address
  'stop_outreach',                // stop this campaign for this company
  'ignore',                       // not a real reply (auto-responder)
  'resend_authorization_link',    // the ONLY response to an affirmative reply
  'confirm_already_authorized',   // reassure; nothing further needed
  'propose_domain_change',        // a PROPOSAL for a human; never applied
  'draft_reply',                  // draft only, gated, never auto-sent in 2A
  'escalate',                     // human queue
  'deliverability_hard',          // hard-bounce pipeline
  'deliverability_soft',          // soft-bounce retry budget
  'none',
]);

// Actions that must never appear here. Asserted by the test suite.
const FORBIDDEN_ACTIONS = Object.freeze([
  'authorize', 'grant_authorization', 'broaden_authorization', 'change_authorized_domain',
  'activate_source', 'grant_claim', 'grant_ownership', 'spend', 'publish',
]);

const lower = (s) => String(s == null ? '' : s).toLowerCase();

/** Header lookup that tolerates any casing and either an object map or a [{Name,Value}] array. */
function header(headers, name) {
  if (!headers) return null;
  const want = lower(name);
  if (Array.isArray(headers)) {
    const hit = headers.find((h) => h && lower(h.Name || h.name) === want);
    return hit ? (hit.Value != null ? hit.Value : hit.value) : null;
  }
  for (const k of Object.keys(headers)) if (lower(k) === want) return headers[k];
  return null;
}

// ── Tier 1: deterministic signals ───────────────────────────────────────────────────────────────

/**
 * RFC 3834 and the de-facto auto-responder headers. An out-of-office is NOT a reply: it must not
 * advance a conversation, must not count as engagement, and must not reset a follow-up timer.
 */
function detectAutoResponder(msg) {
  const h = msg.headers;
  const autoSubmitted = lower(header(h, 'auto-submitted'));
  if (autoSubmitted && autoSubmitted !== 'no') return { hit: true, signal: 'auto-submitted:' + autoSubmitted };
  const precedence = lower(header(h, 'precedence'));
  if (['auto_reply', 'bulk', 'junk'].indexOf(precedence) !== -1) return { hit: true, signal: 'precedence:' + precedence };
  if (header(h, 'x-autoreply') || header(h, 'x-autorespond') || header(h, 'x-auto-response-suppress')) {
    return { hit: true, signal: 'x-autoreply header' };
  }
  // Microsoft/Exchange out-of-office marker.
  if (lower(header(h, 'x-ms-exchange-inbox-rules-loop'))) return { hit: true, signal: 'exchange-ooo' };
  const subj = lower(msg.subject);
  if (/^(out of (the )?office|automatic reply|autoreply|auto-reply|away from|on vacation|abwesenheit)/.test(subj.trim())) {
    return { hit: true, signal: 'subject:auto-reply' };
  }
  return { hit: false };
}

/**
 * A delivery-status notification. multipart/report with report-type=delivery-status is the RFC 3462
 * container; the enclosed Status field carries the RFC 3463 class — 5.x.x permanent, 4.x.x transient.
 * Providers also give us a parsed bounce type, which we trust when present.
 */
function detectBounce(msg) {
  const providerType = lower(msg.bounceType || msg.provider_bounce_type);
  if (providerType) {
    if (/perm|hard|suppress|invalid|unsubscribe|blocked|spamnotification/.test(providerType)) {
      return { hit: true, hard: true, signal: 'provider:' + providerType };
    }
    if (/trans|soft|defer|delay|throttl|dnsError|full/i.test(providerType)) {
      return { hit: true, hard: false, signal: 'provider:' + providerType };
    }
  }
  const ctype = lower(header(msg.headers, 'content-type'));
  const isReport = ctype.indexOf('multipart/report') !== -1 && ctype.indexOf('delivery-status') !== -1;
  const body = String(msg.textBody || '');
  const status = body.match(/status:\s*([245])\.\d{1,3}\.\d{1,3}/i);
  const fromDaemon = /(mailer-daemon|postmaster)@/i.test(String(msg.fromEmail || ''));
  if (isReport || status || (fromDaemon && /undeliver|delivery (has )?failed|returned to sender/i.test(body))) {
    const cls = status ? status[1] : null;
    if (cls === '5') return { hit: true, hard: true, signal: 'dsn:5.x.x' };
    if (cls === '4') return { hit: true, hard: false, signal: 'dsn:4.x.x' };
    // A report we cannot grade is treated as TRANSIENT — never suppress an address on a guess.
    return { hit: true, hard: false, signal: isReport ? 'dsn:ungraded' : 'daemon:undeliverable' };
  }
  return { hit: false };
}

/**
 * An explicit, unambiguous opt-out. Deliberately narrow: only standalone words/phrases whose sole
 * meaning is "stop", so "please stop by our showroom" cannot suppress a company by accident.
 */
function detectStop(msg) {
  if (msg.oneClickUnsubscribe === true) return { hit: true, signal: 'list-unsubscribe:one-click' };
  const body = lower(msg.textBody).replace(/\s+/g, ' ').trim();
  const subj = lower(msg.subject).replace(/\s+/g, ' ').trim();
  // A bare "stop"/"unsubscribe" as essentially the whole message.
  if (/^(stop|unsubscribe|remove me|opt out|optout)[.!]?$/.test(body) || /^(stop|unsubscribe)[.!]?$/.test(subj)) {
    return { hit: true, signal: 'bare opt-out' };
  }
  const phrases = [
    'unsubscribe me', 'please unsubscribe', 'remove me from your list', 'remove me from your mailing',
    'take me off your list', 'take me off your mailing', 'do not contact me', "don't contact me",
    'do not email me', "don't email me", 'stop emailing me', 'stop contacting me', 'no more emails',
    'opt me out', 'delete my email',
  ];
  const hit = phrases.find((p) => body.indexOf(p) !== -1);
  return hit ? { hit: true, signal: 'phrase:' + hit } : { hit: false };
}

// ── Tier 2: heuristic body signals, in strict precedence order ──────────────────────────────────

const LEGAL_PHRASES = [
  'our attorney', 'our lawyer', 'legal counsel', 'cease and desist', 'cease & desist',
  'copyright', 'infringement', 'intellectual property', 'trademark', 'dmca',
  'unauthorized use', 'without our permission', 'without permission', 'legal action', 'sue you',
  'gdpr', 'ccpa', 'data protection', 'right to be forgotten', 'terms of service violation',
  'scrap', 'scraping our', 'do not use our content', 'remove our content', 'take down our',
];

const DECLINE_PHRASES = [
  'not interested', 'no thanks', 'no thank you', 'we will pass', "we'll pass", 'we pass',
  'not at this time', 'not right now', 'we are not interested', "we're not interested",
  'please do not', 'we decline', 'no, we', 'not for us', 'we do not want', "we don't want",
  'not something we', 'we already have', 'we are all set', "we're all set", 'no need',
];

const AFFIRMATIVE_PHRASES = [
  'yes', 'yes please', 'sure', 'sounds good', 'go ahead', 'please do', 'that works',
  'we are interested', "we're interested", 'i am interested', "i'm interested", 'sign us up',
  'sign me up', 'count us in', 'please proceed', "let's do it", 'lets do it', 'happy to',
  'that would be great', 'sounds great', 'absolutely', 'definitely', 'approved', 'you have permission',
  'you may', 'feel free to', 'ok to', 'okay to', 'authorize', 'authorization', 'permission granted',
];

const WRONG_CONTACT_PHRASES = [
  'no longer with', 'not the right person', 'wrong person', 'wrong department',
  'i have forwarded', 'forwarding this to', 'please contact', 'you should contact',
  'i do not handle', "i don't handle", 'not my department', 'left the company', 'has retired',
  'reach out to', 'better contact',
];

const QUESTION_PHRASES = [
  'how does', 'how do you', 'how would', 'what is', "what's the", 'what does', 'is there a cost',
  'is it free', 'how much', 'what happens', 'can you explain', 'could you explain', 'tell me more',
  'more information', 'more info', 'who are you', 'never heard of', 'is this legitimate',
  'is this a scam', 'do we need', 'will you', 'which events', 'how often',
];

function anyPhrase(body, list) {
  for (const p of list) if (body.indexOf(p) !== -1) return p;
  return null;
}

/**
 * Pull candidate URLs out of a reply so a corrected website can be PROPOSED. Extraction is
 * deliberately generous and validation is strict elsewhere — this only produces candidates for a
 * human to approve, because changing the authorized domain changes the scope of permission.
 */
function extractUrls(text) {
  const out = [];
  const re = /\b((?:https?:\/\/)?(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(?:\/[^\s<>"')]*)?)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const raw = m[1].replace(/[.,;:)\]}>'"]+$/, '');
    // Ignore our own domains and bare email domains.
    if (/advantage\.bid$/i.test(raw.replace(/^https?:\/\//, '').split('/')[0])) continue;
    if (out.indexOf(raw) === -1) out.push(raw);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * classify(msg, ctx) → verdict
 *
 * @param {object} msg  { subject, textBody, htmlBody, headers, fromEmail, bounceType,
 *                        oneClickUnsubscribe }
 * @param {object} ctx  { authorizationStatus, authorizedDomain } — our own registry facts
 * @returns {{classification, source, confidence, signals, action, requiresHuman, extracted}}
 */
function classify(msg, ctx) {
  msg = msg || {}; ctx = ctx || {};
  const signals = [];
  const body = lower(msg.textBody || msg.htmlBody).replace(/\s+/g, ' ');
  const verdict = (classification, source, confidence, action, requiresHuman, extracted) => ({
    classification, source, confidence, action,
    requiresHuman: !!requiresHuman,
    signals: signals.slice(),
    extracted: extracted || null,
  });

  // ── Deterministic first. These are facts, not readings. ───────────────────────────────────────

  const bounce = detectBounce(msg);
  if (bounce.hit) {
    signals.push(bounce.signal);
    return bounce.hard
      ? verdict('HARD_BOUNCE', 'deterministic', 1, 'deliverability_hard', false)
      : verdict('SOFT_BOUNCE', 'deterministic', 1, 'deliverability_soft', false);
  }

  const auto = detectAutoResponder(msg);
  if (auto.hit) {
    signals.push(auto.signal);
    // Ignored on purpose: an auto-reply is not engagement and must not advance anything.
    return verdict('OUT_OF_OFFICE', 'deterministic', 1, 'ignore', false);
  }

  const stop = detectStop(msg);
  if (stop.hit) {
    signals.push(stop.signal);
    // Suppresses OUTREACH only. It does not revoke an authorized source and does not touch consumer
    // marketing consent — those are separate records and separate company decisions.
    return verdict('STOP_UNSUBSCRIBE', 'deterministic', 1, 'suppress_outreach', false);
  }

  // ── Heuristic, in precedence order. Order is the safety property here. ────────────────────────

  // 1. Legal or rights concerns outrank everything, including an apparent yes. A message that says
  //    "yes, but our attorney wants to review the terms" is a legal matter, not a green light.
  const legal = anyPhrase(body, LEGAL_PHRASES);
  if (legal) {
    signals.push('legal:' + legal);
    return verdict('LEGAL_RIGHTS', 'heuristic', 0.9, 'escalate', true);
  }

  // 2. Decline outranks affirmative, so "no, we're already interested in something else" stops.
  const decline = anyPhrase(body, DECLINE_PHRASES);
  if (decline) {
    signals.push('decline:' + decline);
    return verdict('DECLINE', 'heuristic', 0.8, 'stop_outreach', false);
  }

  // 3. Already authorized — our own state, so this is close to deterministic.
  const AUTHORIZED = ['authorized', 'source_configured', 'collecting', 'paused'];
  if (ctx.authorizationStatus && AUTHORIZED.indexOf(ctx.authorizationStatus) !== -1
      && anyPhrase(body, AFFIRMATIVE_PHRASES)) {
    signals.push('registry:' + ctx.authorizationStatus);
    return verdict('ALREADY_AUTHORIZED', 'deterministic', 1, 'confirm_already_authorized', false);
  }

  // 4. Wrong contact — record it, stop mailing this person, do not treat as interest or refusal.
  const wrong = anyPhrase(body, WRONG_CONTACT_PHRASES);
  if (wrong) {
    signals.push('wrong_contact:' + wrong);
    return verdict('WRONG_CONTACT', 'heuristic', 0.7, 'escalate', true, { urls: extractUrls(msg.textBody) });
  }

  // 5. A corrected website. Changing the authorized domain re-scopes permission, so this is only ever
  //    a proposal for a human — never applied, and never a substitute for re-authorization.
  const urls = extractUrls(msg.textBody);
  const mentionsSite = /\b(our (website|site|url) is|correct (website|url)|actual (website|url)|use this (website|url)|new website|wrong (website|url)|that('s| is) not our)\b/.test(body);
  if (mentionsSite && urls.length) {
    const differs = urls.some((u) => {
      const host = u.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();
      return !ctx.authorizedDomain || (host !== ctx.authorizedDomain && !host.endsWith('.' + ctx.authorizedDomain));
    });
    if (differs) {
      signals.push('corrected_website');
      return verdict('CORRECTED_WEBSITE', 'heuristic', 0.75, 'propose_domain_change', true, { urls });
    }
  }

  // 6. Affirmative. The strongest available response is a LINK. This is the single most important
  //    branch in the file: interest never becomes permission here.
  const yes = anyPhrase(body, AFFIRMATIVE_PHRASES);
  const asksQuestion = anyPhrase(body, QUESTION_PHRASES) || /\?/.test(String(msg.textBody || ''));
  if (yes && !asksQuestion) {
    signals.push('affirmative:' + yes);
    return verdict('YES_AFFIRMATIVE', 'heuristic', 0.8, 'resend_authorization_link', false);
  }
  if (yes && asksQuestion) {
    // Interested AND asking something. Send the link (harmless, and it is what they want) but flag it
    // so a human can answer the question too.
    signals.push('affirmative:' + yes, 'question');
    return verdict('YES_AFFIRMATIVE', 'heuristic', 0.6, 'resend_authorization_link', true);
  }

  // 7. A question with no clear intent — draft/template a reply where an approved FAQ covers it,
  //    otherwise a human answers. Drafting is itself gated and never auto-sends in Phase 2A.
  if (asksQuestion) {
    signals.push('question');
    return verdict('QUESTION', 'heuristic', 0.6, 'draft_reply', true);
  }

  // 8. Anything else. No state change, ever.
  if (!body.trim()) signals.push('empty body');
  return verdict('UNKNOWN', 'heuristic', 0.2, 'escalate', true);
}

module.exports = {
  CLASSES, ACTIONS, FORBIDDEN_ACTIONS, classify,
  // exported for targeted tests
  detectAutoResponder, detectBounce, detectStop, extractUrls, header,
};
