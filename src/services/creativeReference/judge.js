'use strict';

/**
 * creativeReference/judge — Deliverable 7 B2: judged principles (40 points) by a vision model. The judge receives the
 * candidate render, the principle-profile text and the family — NEVER a reference image. Ten items scored 0–4 with a
 * one-line reason each; two runs; averaged; a disagreement > 8 points is flagged. Model + prompt version are recorded.
 * Uses the platform's existing Anthropic SDK dependency; when no key is configured the judge reports available:false
 * and the scorer proceeds measurable-only (never fabricated).
 */
const fs = require('fs');

const PROMPT_VERSION = 'p3p-judge-v1';
const DEFAULT_MODEL = process.env.CREATIVE_JUDGE_MODEL || 'claude-sonnet-5';
const ITEMS = [
  'Hierarchy clarity: the eye enters at the presenter, moves to one title, then to the merchandise.',
  'Staging: merchandise looks staged by a set designer (heavy things sit, art hangs, small things forward) / arranged for comparison (lineup) / the room is inviting and legible (environmental) / representative items are grounded (acquisition).',
  'Objects (or the photograph) have confident scale variation and at least one clear anchor.',
  'Typography is confident and, where expressive, truthful to the event.',
  'Colour comes from the merchandise; the ground and panels stay quiet.',
  'Nothing reads as filler: no slogans, icon piles, words on merchandise, duplicate URLs.',
  'It reads at thumbnail size (headline + wordmark legible when small).',
  'It would not be mistaken for a template with swapped merchandise (editorial irregularity).',
  'It does not evoke any specific competitor or seller identity (answer 0 if it does).',
  'Overall: would the Owner say "good" (0), "much better" (2), "love this" (4)? Justify via items 1–9.',
];

function buildPrompt(profile, family, campaignClass) {
  return [
    `You are the calibration judge for Advantage.Bid's creative engine. Score the attached advertisement render on PRINCIPLE ADHERENCE, not similarity to anything.`,
    `Campaign class: ${campaignClass}. Family: ${family}. ${campaignClass.includes('acquisition') ? 'This is an acquisition creative: "merchandise-forward" means representative items present and grounded, not auction lots.' : ''}`,
    `Principle profile the creative was briefed with:`, JSON.stringify(profile, null, 1),
    `Score each of the ten items 0-4 (integers) with a short reason (at most 15 words; never use double quotes inside a reason). Reply ONLY with compact JSON on one line: {"items":[{"n":1,"score":0,"reason":"..."}, ... 10 items], "notes":"..."}`,
    ITEMS.map((t, i) => `${i + 1}. ${t}`).join('\n'),
  ].join('\n\n');
}

// Tolerant parse: strict JSON first; otherwise recover the ten (n, score) pairs by pattern. Scores are never invented:
// fewer than ten recoverable items → the run fails and the judge reports available:false.
function parseJudgeJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch (_) { /* fall through */ }
  const items = [];
  for (const r of text.matchAll(/"n"\s*:\s*(\d{1,2})\s*,\s*"score"\s*:\s*([0-4])(?:\s*,\s*"reason"\s*:\s*"([^"\n]{0,300}))?/g)) items.push({ n: Number(r[1]), score: Number(r[2]), reason: (r[3] || '').trim() });
  if (items.length < 10) throw new Error('judge output unparseable (' + items.length + ' items)');
  return { items: items.slice(0, 10), notes: 'recovered by pattern (strict JSON parse failed)' };
}

async function runOnce(client, model, pngPath, prompt) {
  const b64 = fs.readFileSync(pngPath).toString('base64');
  const res = await client.messages.create({
    model, max_tokens: 3000,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }, { type: 'text', text: prompt }] }],
  });
  const text = (res.content || []).map((c) => c.text || '').join('');
  const parsed = parseJudgeJson(text);
  const items = (parsed.items || []).slice(0, 10).map((it, i) => ({ n: i + 1, score: Math.max(0, Math.min(4, Number(it.score) || 0)), reason: String(it.reason || '').slice(0, 300) }));
  return { items, total: items.reduce((a, it) => a + it.score, 0), notes: String(parsed.notes || '').slice(0, 500), usage: res.usage ? { in: res.usage.input_tokens, out: res.usage.output_tokens } : null };
}

/** @returns {object} { available, model, prompt_version, runs[], average, disagreement, flagged, error? } */
async function judge({ pngPath, profile, family, campaignClass, client = null, model = DEFAULT_MODEL } = {}) {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) return { available: false, reason: 'no vision-judge credential configured', model, prompt_version: PROMPT_VERSION };
    try { const Anthropic = require('@anthropic-ai/sdk'); client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
    catch (e) { return { available: false, reason: 'sdk unavailable: ' + e.message, model, prompt_version: PROMPT_VERSION }; }
  }
  const prompt = buildPrompt(profile, family, campaignClass);
  try {
    const a = await runOnce(client, model, pngPath, prompt);   // two independent runs (model sampling varies)
    const b = await runOnce(client, model, pngPath, prompt);
    const average = Math.round(((a.total + b.total) / 2) * 100) / 100;
    const disagreement = Math.abs(a.total - b.total);
    return { available: true, model, prompt_version: PROMPT_VERSION, runs: [a, b], average, disagreement, flagged: disagreement > 8, items: ITEMS };
  } catch (e) {
    return { available: false, reason: 'judge call failed: ' + String(e.message || e).slice(0, 200), model, prompt_version: PROMPT_VERSION };
  }
}

module.exports = { judge, buildPrompt, ITEMS, PROMPT_VERSION, DEFAULT_MODEL };

// ── Phase 3P.1 judge v2 (prompt p3p1-judge-v2) ─────────────────────────────────────────────────────────────────
// Items 1–10 from 3P are kept except item 2, replaced by three named PHYSICAL questions (Mission 5); plus the three
// COMPREHENSION questions (Mission 8), "can you name the platform at a glance" (Mission 7), the readability question
// (3P.2 copy density) and, for generic creative, the masquerade question (3P.2 authentic media). A "yes" to "passing
// through" or "wrong size" is a hard fail independent of the numeric audit — the two systems check each other.
const PROMPT_VERSION_V2 = 'p3p1-judge-v2';
const ITEMS_V2 = ITEMS.filter((_, i) => i !== 1);

function buildPromptV2({ profile, family, campaignClass, generic, expect }) {
  return [
    `You are the calibration judge for Advantage.Bid's creative engine. Judge the attached advertisement on PRINCIPLE ADHERENCE and physical believability — not similarity to anything.`,
    `Campaign class: ${campaignClass}. Family: ${family}. ${generic ? 'This is GENERIC creative: any merchandise shown is representative, never lots from a specific sale.' : 'This advertises a real event.'}`,
    `Principle profile:`, JSON.stringify(profile || {}, null, 1),
    `Score these nine items 0-4 (integers) with a reason of at most 15 words (no double quotes inside reasons):`,
    ITEMS_V2.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    `Then answer the physical questions: P1 Is any object passing through another object? (yes/no + names) P2 Is any object the wrong size for what it is, relative to the largest piece? (yes/no + name) P3 Does every small object rest on something or sit clearly in front? (yes/no).`,
    `Comprehension at phone-feed size: C1 What kind of event is this (or "not an event")? C2 Who is running it? C3 When? C4 Can you name the platform at a glance? C5 In one sentence, what is this ad asking me to do (from headline + button only)?${generic ? ' C6 Does this look like it is showing real items from a specific sale? (yes/no)' : ''}`,
    `Reply ONLY with compact JSON on one line: {"items":[{"n":1,"score":0,"reason":"..."}, ... 9 items],"physical":{"through":"no","through_names":"","wrong_size":"no","wrong_size_name":"","supported":"yes"},"comprehension":{"event_type":"...","who":"...","when":"...","platform":"...","ask":"...","masquerade":"no"},"notes":"..."}`,
  ].join('\n\n');
}

function parseV2(text) {
  const m = text.match(/\{[\s\S]*\}/);
  const j = JSON.parse(m ? m[0] : text);
  const items = (j.items || []).slice(0, 9).map((it, i) => ({ n: i + 1, score: Math.max(0, Math.min(4, Number(it.score) || 0)), reason: String(it.reason || '').slice(0, 300) }));
  if (items.length < 9) throw new Error('judge v2 output incomplete');
  return { items, physical: j.physical || {}, comprehension: j.comprehension || {}, notes: String(j.notes || '').slice(0, 500) };
}

/** Two runs; points = 36 from nine items + 4 for the physical block (no / no / yes). */
async function judgeV2({ pngPath, profile, family, campaignClass, generic = false, expect = {}, client = null, model = DEFAULT_MODEL } = {}) {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) return { available: false, reason: 'no vision-judge credential configured', model, prompt_version: PROMPT_VERSION_V2 };
    try { const Anthropic = require('@anthropic-ai/sdk'); client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
    catch (e) { return { available: false, reason: 'sdk unavailable: ' + e.message, model, prompt_version: PROMPT_VERSION_V2 }; }
  }
  const prompt = buildPromptV2({ profile, family, campaignClass, generic, expect });
  const b64 = fs.readFileSync(pngPath).toString('base64');
  const runs = [];
  for (let i = 0; i < 2; i++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await client.messages.create({ model, max_tokens: 3000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }, { type: 'text', text: prompt }] }] });
        const p = parseV2((res.content || []).map((c) => c.text || '').join(''));
        const phys = p.physical || {};
        const physPts = (String(phys.through).toLowerCase().startsWith('no') ? 1.5 : 0) + (String(phys.wrong_size).toLowerCase().startsWith('no') ? 1.5 : 0) + (String(phys.supported).toLowerCase().startsWith('yes') ? 1 : 0);
        runs.push(Object.assign(p, { total: p.items.reduce((a, it) => a + it.score, 0) + physPts, physical_points: physPts })); break;
      } catch (_) { /* retry once, then the run is absent */ }
    }
  }
  if (!runs.length) return { available: false, reason: 'judge call failed', model, prompt_version: PROMPT_VERSION_V2 };
  const avg = Math.round((runs.reduce((a, r) => a + r.total, 0) / runs.length) * 100) / 100;
  const yes = (k) => runs.some((r) => String((r.physical || {})[k] || '').toLowerCase().startsWith('yes'));
  const lastC = runs[runs.length - 1].comprehension || {};
  const norm = (s) => String(s || '').toLowerCase();
  const comprehension = {
    event_type_ok: expect.event_type ? norm(lastC.event_type).includes(norm(expect.event_type)) : null,
    who_ok: expect.who ? norm(lastC.who).includes(norm(expect.who).split(' ')[0]) : null,
    when_ok: expect.when ? norm(lastC.when).includes(norm(expect.when).split(' ').slice(-1)[0]) : null,
    platform_ok: norm(lastC.platform).includes('advantage'),
    masquerade: generic ? runs.some((r) => norm((r.comprehension || {}).masquerade).startsWith('yes')) : null,
    answers: lastC,
  };
  return { available: true, model, prompt_version: PROMPT_VERSION_V2, runs, points: avg, average: avg, disagreement: runs.length > 1 ? Math.abs(runs[0].total - runs[1].total) : 0,
           flagged: runs.length > 1 && Math.abs(runs[0].total - runs[1].total) > 8, physical_yes: { through: yes('through'), wrong_size: yes('wrong_size') }, comprehension, items: ITEMS_V2 };
}

module.exports.judgeV2 = judgeV2;
module.exports.buildPromptV2 = buildPromptV2;
module.exports.PROMPT_VERSION_V2 = PROMPT_VERSION_V2;
