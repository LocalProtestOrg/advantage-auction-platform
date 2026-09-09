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
