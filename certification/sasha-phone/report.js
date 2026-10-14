'use strict';

/**
 * Readable certification report (Markdown): summary, call-health metrics (empty / holding-only / ceiling-stopped turns,
 * protected-information leaks, spoken length), comparison with an earlier run, pass rates by category and risk, then
 * every FAIL, WARNING and GRADER_ERROR with the evidence.
 */

const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const { HOLDING } = require('./judge');
const VERDICTS = ['PASS', 'WARNING', 'FAIL', 'GRADER_ERROR'];

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
function pctile(arr, p) { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }

/** Call-health numbers for one run (works for this run's results and for a stored earlier run). */
function health(items) {
  let turns = 0, empty = 0, holding = 0, ceiling = 0, ceilingKnown = true, leaks = 0, banned = 0; const lens = [];
  for (const r of items) {
    for (const t of r.turns || []) {
      turns++; const s = String(t.sasha || '').trim();
      if (!s) empty++; else if (HOLDING.test(s)) holding++;
      if (s) lens.push(words(s));
    }
    if (r.modelRuns) ceiling += r.modelRuns.filter((m) => m.outcome_reason === 'output_ceiling').length;
    else {   // earlier runs did not store the run log: count the old 200-token warning instead
      ceilingKnown = false;
      const w = ((r.deterministic && r.deterministic.warns) || []).find((x) => /200\+ output tokens/.test(x));
      if (w) ceiling += Number((/^(\d+)/.exec(w) || [0, 0])[1]);
    }
    const f = (r.deterministic && r.deterministic.fails) || [];
    leaks += f.filter((x) => /private or protected detail spoken|account tool returned data to an unverified caller/.test(x)).length;
    banned += f.filter((x) => /banned public wording/.test(x)).length;
  }
  return { turns, empty, holding, ceiling, ceilingKnown, leaks, banned, avgWords: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
    p90Words: pctile(lens, 0.9), maxWords: lens.length ? Math.max(...lens) : 0, over100: lens.filter((n) => n > 100).length };
}

function markdown(meta, results, truth) {
  const count = (arr, v) => arr.filter((r) => r.verdict === v).length;
  const L = [];
  L.push('# Phone Sasha Certification Report', '');
  L.push(`Run ${meta.started} · ${meta.scenarios} scenarios · ${meta.seconds}s · Sasha model ${meta.model} · judge ${meta.judge || 'off'}`);
  L.push(`Configuration: ${meta.mirror ? `production settings and guidance mirrored read-only (${meta.mirror.config_rows} settings, ${meta.mirror.kb_articles} guidance articles, ${meta.mirror.at})` : 'code defaults (not mirrored from production)'}`, '');
  const ge = count(results, 'GRADER_ERROR');
  L.push(`**PASS ${count(results, 'PASS')} · WARNING ${count(results, 'WARNING')} · FAIL ${count(results, 'FAIL')}**${ge ? ` · GRADER_ERROR ${ge} (not graded; not counted against Sasha)` : ''} (${Math.round(100 * count(results, 'PASS') / Math.max(1, results.length))}% pass)`, '');
  L.push('Authoritative values used (read live at run time): ' + Object.entries(meta.truth).map(([k, v]) => `${k} = ${v}`).join(' · '), '');

  const now = health(results.map((r) => ({ turns: r.run.turns, modelRuns: r.run.modelRuns || [], deterministic: r.det })));
  const prev = meta.compare ? health(meta.compare.results) : null;
  if (meta.usage) {
    const u = meta.usage; const k = (n) => Math.round(n / 1000).toLocaleString('en-US') + 'K';
    L.push(`Model usage (actual, billable): Sasha ${esc(meta.model)} ${u.sasha.model_requests_turns} turns, ${k(u.sasha.input_tokens)} input + ${k(u.sasha.cache_read_tokens)} cached input + ${k(u.sasha.output_tokens)} output tokens = $${u.sasha.cost_usd.toFixed(2)} · judge ${esc(meta.judge || 'off')} ${u.judge.calls} calls, ${k(u.judge.input_tokens)} input + ${k(u.judge.cache_read_tokens)} cached + ${k(u.judge.output_tokens)} output tokens = $${u.judge.cost_usd.toFixed(2)} · **total $${u.total_usd.toFixed(2)}**`, '');
  }
  L.push('## Call health', '', `| Measure | This run${prev ? ` | Earlier run (${esc(meta.compare.file)})` : ''} |`, `|---|---|${prev ? '---|' : ''}`);
  const row = (label, a, b) => L.push(`| ${label} | ${a}${prev ? ` | ${b}` : ''} |`);
  row('Caller turns', now.turns, prev && prev.turns);
  row('Empty responses', now.empty, prev && prev.empty);
  row('Holding-phrase-only responses', now.holding, prev && prev.holding);
  row('Replies stopped by the technical output ceiling', now.ceiling, prev && (prev.ceilingKnown ? prev.ceiling : `${prev.ceiling} (turns at the old 200-token cap)`));
  row('Protected-information leaks (deterministic)', now.leaks, prev && prev.leaks);
  row('Banned public wording / internal names spoken', now.banned, prev && prev.banned);
  row('Spoken words per turn: average / 90th percentile / max', `${now.avgWords} / ${now.p90Words} / ${now.maxWords}`, prev && `${prev.avgWords} / ${prev.p90Words} / ${prev.maxWords}`);
  row('Turns over 100 spoken words', now.over100, prev && prev.over100);

  if (meta.compare) {
    const before = new Map(meta.compare.results.map((x) => [x.id, x.verdict]));
    const c = (v, arr) => arr.filter((x) => x.verdict === v).length;
    L.push('', '## Comparison with the earlier run', '', `Earlier run ${meta.compare.started}: PASS ${c('PASS', meta.compare.results)} · WARNING ${c('WARNING', meta.compare.results)} · FAIL ${c('FAIL', meta.compare.results)}`);
    const moves = {}; for (const r of results) { const k = `${before.get(r.scn.id) || 'new'} → ${r.verdict}`; moves[k] = (moves[k] || 0) + 1; }
    L.push('', '| Earlier → now | Scenarios |', '|---|---|', ...Object.entries(moves).sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`));
    const regressed = results.filter((r) => before.get(r.scn.id) === 'PASS' && r.verdict !== 'PASS');
    if (regressed.length) L.push('', 'Previously PASS, now not: ' + regressed.map((r) => `${r.scn.id} (${r.verdict})`).join(', '));
  }

  // Every spoken turn over 100 words, for a conversational-length review (the output ceiling is technical, not a length target).
  const long = [];
  for (const r of results) r.run.turns.forEach((t, i) => { const n = words(t.sasha); if (n > 100) long.push({ id: r.scn.id, turn: i + 1, n, caller: t.caller, sasha: t.sasha }); });
  if (long.length) {
    L.push('', `## Turns over 100 spoken words (${long.length})`, '', '| Scenario | Turn | Words | Caller asked |', '|---|---|---|---|');
    for (const x of long.sort((a, b) => b.n - a.n)) L.push(`| ${esc(x.id)} | ${x.turn} | ${x.n} | ${esc(x.caller)} |`);
  }

  L.push('', '## Pass rate by category', '', '| Category | Scenarios | PASS | WARNING | FAIL | Pass rate |', '|---|---|---|---|---|---|');
  const cats = [...new Set(results.map((r) => r.scn.category))];
  const rows = cats.map((c) => { const rs = results.filter((r) => r.scn.category === c); return { c, n: rs.length, p: count(rs, 'PASS'), w: count(rs, 'WARNING'), f: count(rs, 'FAIL') }; })
    .sort((a, b) => (a.p / a.n) - (b.p / b.n));
  for (const r of rows) L.push(`| ${esc(r.c)} | ${r.n} | ${r.p} | ${r.w} | ${r.f} | ${Math.round(100 * r.p / r.n)}% |`);
  L.push('', '## Pass rate by risk', '', '| Risk | Scenarios | PASS | WARNING | FAIL |', '|---|---|---|---|---|');
  for (const k of ['high', 'medium', 'low']) { const rs = results.filter((r) => (r.scn.risk || 'medium') === k); if (rs.length) L.push(`| ${k} | ${rs.length} | ${count(rs, 'PASS')} | ${count(rs, 'WARNING')} | ${count(rs, 'FAIL')} |`); }
  const causes = {}; for (const r of results.filter((x) => x.verdict === 'WARNING' || x.verdict === 'FAIL')) { const c = (r.judge && r.judge.cause) || (r.det.fails.length ? 'sasha_answer' : 'none'); causes[c] = (causes[c] || 0) + 1; }
  L.push('', '## What kind of problems (WARNING and FAIL)', '', ...Object.entries(causes).map(([c, n]) => `- ${c.replace(/_/g, ' ')}: ${n}`));
  const handling = {}; for (const r of results) { const h = (r.judge && r.judge.handling) || 'not graded'; const k = `${h} (${r.verdict})`; handling[k] = (handling[k] || 0) + 1; }
  L.push('', '## How Sasha handled each call', '', ...Object.entries(handling).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k.replace(/_/g, ' ')}: ${n}`));
  for (const v of ['FAIL', 'WARNING', 'GRADER_ERROR']) {
    const rs = results.filter((r) => r.verdict === v);
    if (!rs.length) continue;
    L.push('', `## ${v} (${rs.length})`);
    for (const r of rs) {
      L.push('', `### ${r.scn.id} · ${r.scn.category} · ${r.scn.risk || 'medium'} risk`, '');
      L.push(`Caller: ${r.scn.context || ''} · authentication: ${r.scn.auth} · IVR route: ${r.scn.route}`, '');
      for (const t of r.run.turns) { L.push(`> **Caller:** ${t.caller}`, '>', `> **Sasha:** ${t.sasha || '(said nothing)'}`, ''); }
      if (r.run.tools.length) L.push('Tools: ' + r.run.tools.map((t) => '`' + t.name + '`' + (t.output && t.output.error ? ' (refused/error)' : '')).join(', '), '');
      L.push('**Expected:** ' + [...(r.scn.must || []).map((m) => 'must: ' + m), ...(r.scn.mustNot || []).map((m) => 'must not: ' + m)].join(' · '), '');
      if (r.det.fails.length) L.push('**Deterministic failures:** ' + r.det.fails.join('; '), '');
      if (r.det.warns.length) L.push('**Deterministic warnings:** ' + r.det.warns.join('; '), '');
      if (r.judge) {
        L.push(`**Why:** ${r.judge.summary || ''}`);
        if ((r.judge.missing_required || []).length) L.push('- Missing: ' + r.judge.missing_required.join('; '));
        if ((r.judge.prohibited_found || []).length) L.push('- Prohibited: ' + r.judge.prohibited_found.join('; '));
        if ((r.judge.invented_claims || []).length) L.push('- Invented: ' + r.judge.invented_claims.join('; '));
        L.push(`- Likely cause: ${String(r.judge.cause || 'none').replace(/_/g, ' ')}`);
        if (r.judge.recommended_correction) L.push(`- Recommended correction: ${r.judge.recommended_correction}`);
      }
      L.push(`- Source of truth: ${(r.scn.truthTopics || []).map((t) => `${t} (${truth.sources[t] || 'platform rules'})`).join('; ') || 'tool results / authentication rules'}`);
    }
  }
  return L.join('\n') + '\n';
}

module.exports = { markdown, health, VERDICTS };
