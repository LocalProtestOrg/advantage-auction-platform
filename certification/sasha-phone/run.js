#!/usr/bin/env node
'use strict';

/**
 * Phone Sasha Certification Suite — deliberate pre-release check (NOT part of the deploy gate: it makes real model calls).
 *
 *   npm run certify:sasha-phone                          # code-default settings, local ANTHROPIC_API_KEY
 *   railway run npm run certify:sasha-phone -- --mirror-prod   # same settings + approved guidance as production (read-only)
 *   BILLABLE: real model calls. Without --approved it only prints the cost estimate and exits (owner rule 2026-10-14).
 *   options: --approved (run after owner approval)   --filter <text>  only scenarios whose id/category contains text   --limit <n>   --concurrency <n> (default 5)
 *            --no-judge (deterministic checks only)   --list (print the scenario bank and exit)
 *
 * Each scenario is a simulated phone call through the REAL Phone Sasha path (simulator → ConversationRelay translator →
 * PhoneCall → engine with the production model → real tools) against an in-memory database with fictional fixtures.
 * Nothing is sent, charged, changed or exposed outside this process (see harness.js). Reports go to ./reports/.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });   // model key; every other credential is scrubbed in harness.boot
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : dflt; };

(async () => {
  const started = Date.now();
  const scenarios = require('./scenarios').expand();
  if (opt('list', false)) { for (const s of scenarios) console.log(`${s.id}\t${s.category}\t${s.auth}\t${s.route}\t${s.turns.join(' || ')}`); console.log(scenarios.length + ' scenarios'); return; }
  // BILLABLE: every scenario makes real model calls (Sasha, plus the judge unless --no-judge). Owner rule 2026-10-14:
  // estimate first and run only with explicit approval. Without --approved this prints the estimate and exits.
  {
    let n = scenarios;
    const f = opt('filter', null); if (f) n = n.filter((s) => s.id.includes(f) || s.category.includes(f));
    const lim = Number(opt('limit', 0)); if (lim) n = n.slice(0, lim);
    const est = estimateCostUsd(n.length, !opt('no-judge', false));
    console.log(`[certify] BILLABLE run: ${n.length} scenarios · estimated model cost $${est.low.toFixed(2)}–$${est.high.toFixed(2)} (Sasha ${process.env.SASHA_MODEL || 'claude-sonnet-5'}${opt('no-judge', false) ? '' : ' + judge ' + require('./judge').JUDGE_MODEL()})`);
    if (!opt('approved', false)) { console.log('[certify] Not started. Get the owner\'s approval for this cost, then rerun with --approved.'); return; }
  }
  const harness = require('./harness');
  const env = await harness.boot({ mirrorProd: !!opt('mirror-prod', false) });
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required (Sasha and the judge are real model calls).');
  const F = await harness.seedFixtures();
  const truth = await require('./truth').build();
  const { fill } = require('./truth');
  const { deterministic, judge, JUDGE_MODEL } = require('./judge');
  const R = (p) => require(path.join(harness.ROOT, 'src', p));
  const sim = R('services/sasha/phone/phoneSimulator');
  const tools = R('services/sasha/tools');
  const Anthropic = require('@anthropic-ai/sdk');
  const judgeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 90000 });

  // Capture every tool call (name, input, output) per simulated call.
  const toolLog = new Map();
  const realRun = tools.run;
  tools.run = async (name, input, ctx) => {
    const out = await realRun(name, input, ctx);
    const id = ctx && ctx.phone && ctx.phone.call && ctx.phone.call.id;
    if (id) { if (!toolLog.has(id)) toolLog.set(id, []); toolLog.get(id).push({ name, input, output: out }); }
    return out;
  };

  // --trace (forces concurrency 1): record each phone model request's stop reason, content-block types and output
  // tokens, so truncated or empty turns can be attributed to the reply-length cap versus a real model error.
  const tracing = !!opt('trace', false); let traceSink = null;
  if (tracing) {
    const engine = R('services/sasha/engine');
    const real = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 45000 });
    engine._setClient({ messages: { create: async (params, o) => {
      const res = await real.messages.create(params, o);
      if (!params.stream) return res;
      const rec = { max_tokens: params.max_tokens, blocks: [], stop: null, output_tokens: null, text_chars: 0 };
      if (traceSink) traceSink.push(rec);
      return (async function* () {
        for await (const ev of res) {
          if (ev.type === 'content_block_start') rec.blocks.push(ev.content_block.type + (ev.content_block.name ? ':' + ev.content_block.name : ''));
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') rec.text_chars += ev.delta.text.length;
          if (ev.type === 'message_delta') { rec.stop = (ev.delta && ev.delta.stop_reason) || rec.stop; if (ev.usage) rec.output_tokens = ev.usage.output_tokens; }
          yield ev;
        }
      })();
    } } });
  }

  const users = { buyerA: F.buyerA, buyerB: F.buyerB, buyerC: F.buyerC, buyerNoPhone: F.buyerNoPhone, sellerInd: F.sellerIndUser, sellerPro: F.sellerProUser };
  const phones = { buyerA: '+12025550111', buyerB: '+12025550122', buyerC: '+12025550155', sellerInd: '+12025550133', sellerPro: '+12025550144', stranger: '+12025550199' };

  async function verifyAs(callId, who) {
    const call = (await harness.q(`SELECT * FROM cs_calls WHERE id = $1`, [callId]))[0];
    const v = (await harness.q(`INSERT INTO cs_phone_verifications (call_id, target_user_id, identifier_type, identifier_hash, provider, status, expires_at, verified_at)
      VALUES ($1,$2,'email','certification','local_test','approved', now() + interval '5 minutes', now()) RETURNING id`, [callId, users[who]]))[0];
    await harness.q(`INSERT INTO cs_phone_sessions (call_id, conversation_id, user_id, verification_id, expires_at) VALUES ($1,$2,$3,$4, now() + interval '20 minutes')`,
      [callId, call.conversation_id, users[who], v.id]);
    await harness.q(`UPDATE cs_calls SET verification_state = 'verified', verified_user_id = $2 WHERE id = $1`, [callId, users[who]]);
  }

  async function runOne(scn) {
    const run = { turns: [], tools: [], errors: [], callbacks: 0, handset: 0, mailbox: 0, trace: [] };
    if (tracing) traceSink = run.trace;
    const s = await sim.start({ actorId: F.admin, callerNumber: scn.callerId ? (phones[scn.callerId] || scn.callerId) : null, routingReason: scn.route === 'none' ? null : scn.route }, {});
    if (!s.started) { run.errors.push('simulated call did not start: ' + s.refused); return run; }
    try {
      if (scn.auth !== 'none') await verifyAs(s.call_id, scn.auth);
      const say = async (text) => {
        const r = await sim.say(s.call_id, F.admin, fill(text, truth.tokens));
        const said = r.turn.filter((m) => m.type === 'text' && m.token).map((m) => m.token.trim()).join(' ');
        run.turns.push({ caller: fill(text, truth.tokens), sasha: said });
      };
      for (const text of scn.turns) await say(text);
      // A caller answering Sasha's confirmation question ("May I send a code?", "Is that the right number?"): played only
      // while the action the scenario expects has not happened yet, as a real caller would reply.
      const b = scn.behavior || {};
      const expected = [...(b.toolsRequired || []), ...(b.toolsAnyOf || [])];
      const usedNow = () => (toolLog.get(s.call_id) || []).map((t) => t.name);
      for (const text of b.confirmTurns || []) {
        const need = (b.toolsRequired || []).some((t) => !usedNow().includes(t)) || (b.toolsAnyOf && !b.toolsAnyOf.some((t) => usedNow().includes(t)));
        if (!expected.length || !need) break;
        await say(text);
      }
      const st = await sim.state(s.call_id, F.admin);
      for (const x of st.runs || []) if (x.outcome === 'error') run.errors.push(x.outcome_reason || 'error');
      run.callbacks = (st.handoffs || []).filter((h) => h.callback_requested).length;
      run.handset = (st.handset || []).length; run.mailbox = (st.mailbox || []).length;
      run.cost_usd = st.cost_usd;
      const callRow = (await harness.q(`SELECT conversation_id FROM cs_calls WHERE id = $1`, [s.call_id]))[0];
      run.modelRuns = await harness.q(`SELECT outcome, outcome_reason, tools_used, input_tokens, cache_read_tokens, output_tokens, cost_micro_usd, latency_ms FROM cs_ai_runs WHERE conversation_id = $1 ORDER BY created_at`, [callRow.conversation_id]);
    } catch (e) { run.errors.push(e.message); }
    finally { run.tools = toolLog.get(s.call_id) || []; await sim.end(s.call_id, F.admin).catch(() => {}); }
    return run;
  }

  let list = scenarios;
  const filter = opt('filter', null); if (filter) list = list.filter((s) => s.id.includes(filter) || s.category.includes(filter));
  const limit = Number(opt('limit', 0)); if (limit) list = list.slice(0, limit);
  const useJudge = !opt('no-judge', false);
  const conc = tracing ? 1 : Math.max(1, Math.min(10, Number(opt('concurrency', 5))));
  console.log(`[certify] ${list.length} scenarios · concurrency ${conc} · judge ${useJudge ? JUDGE_MODEL() : 'off'} · mirror ${env.mirror ? JSON.stringify(env.mirror) : 'off (code defaults)'} · ${env.scrubbed} credentials removed from this process`);

  const results = []; let next = 0; let done = 0;
  async function worker() {
    for (;;) {
      const i = next++; if (i >= list.length) return;
      const scn = list[i];
      const run = await runOne(scn);
      const det = deterministic(scn, run, harness.CANARIES);
      let j = null;
      if (useJudge) j = await judge(judgeClient, { ...scn, must: (scn.must || []).map((x) => fill(x, truth.tokens)), mustNot: (scn.mustNot || []).map((x) => fill(x, truth.tokens)) }, run, truth, harness.ROOT);
      let verdict = j ? j.verdict : (det.fails.length ? 'FAIL' : det.warns.length ? 'WARNING' : 'PASS');
      // Deterministic failures are always FAIL. A grader error is never a Sasha failure: it stays GRADER_ERROR (rerun it).
      if (det.fails.length) verdict = 'FAIL'; else if (det.warns.length && verdict === 'PASS') verdict = 'WARNING';
      results.push({ scn, run, det, judge: j, verdict });
      done++; if (done % 10 === 0 || done === list.length) console.log(`[certify] ${done}/${list.length}  PASS ${results.filter((r) => r.verdict === 'PASS').length} · WARNING ${results.filter((r) => r.verdict === 'WARNING').length} · FAIL ${results.filter((r) => r.verdict === 'FAIL').length} · GRADER_ERROR ${results.filter((r) => r.verdict === 'GRADER_ERROR').length}`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  results.sort((a, b) => list.indexOf(a.scn) - list.indexOf(b.scn));

  const outDir = path.join(__dirname, 'reports'); fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const meta = { started: new Date(started).toISOString(), seconds: Math.round((Date.now() - started) / 1000), model: process.env.SASHA_MODEL || 'claude-sonnet-5', judge: useJudge ? JUDGE_MODEL() : null,
    mirror: env.mirror, truth: truth.tokens, scenarios: list.length, compare: null, usage: usageSummary(results) };
  console.log(`[certify] actual model usage: Sasha $${meta.usage.sasha.cost_usd.toFixed(2)} · judge $${meta.usage.judge.cost_usd.toFixed(2)} · total $${meta.usage.total_usd.toFixed(2)}`);
  const cmp = opt('compare', null);
  if (cmp && cmp !== true) { try { const prev = JSON.parse(fs.readFileSync(cmp, 'utf8')); meta.compare = { file: path.basename(cmp), started: prev.meta.started, results: prev.results.map((x) => ({ id: x.id, verdict: x.verdict, turns: x.turns, deterministic: x.deterministic })) }; } catch (e) { console.warn('[certify] compare file unreadable:', e.message); } }
  fs.writeFileSync(path.join(outDir, `sasha-phone-${stamp}.json`), JSON.stringify({ meta, results: results.map((r) => ({ id: r.scn.id, category: r.scn.category, risk: r.scn.risk, verdict: r.verdict,
    auth: r.scn.auth, route: r.scn.route, turns: r.run.turns, tools: r.run.tools.map((t) => ({ name: t.name, input: t.input, output: t.output })), errors: r.run.errors, modelRuns: r.run.modelRuns || [], trace: r.run.trace,
    deterministic: r.det, judge: r.judge,
    expectations: { must: r.scn.must, mustNot: r.scn.mustNot, prohibited: r.scn.prohibited, behavior: r.scn.behavior, truthTopics: r.scn.truthTopics } })) }, null, 1));
  const md = require('./report').markdown(meta, results, truth);
  const mdPath = path.join(outDir, `sasha-phone-${stamp}.md`);
  fs.writeFileSync(mdPath, md); fs.writeFileSync(path.join(outDir, 'latest.md'), md);
  console.log(`[certify] report: ${path.relative(process.cwd(), mdPath)}`);
  await harness.close();
  process.exit(results.some((r) => r.verdict === 'FAIL') ? 1 : 0);
})().catch((e) => { console.error('[certify] aborted:', e && e.stack || e); process.exit(2); });

/**
 * Per-scenario cost, from measured runs (2026-10-14, 329 scenarios): judge (claude-opus-5-5, $4/$20 per Mtok, cache
 * read $0.20, write $5) recorded $5.91 = ~$0.018 per scenario; Sasha (claude-sonnet-5, $2/$10, cache read $0.20, write
 * $2.50) output was $0.49, input estimated $1.50–$5.00 from the cached ~10–14K-token prompt. Update after measured runs.
 */
function estimateCostUsd(scenarios, withJudge) {
  const sasha = [0.006, 0.017]; const judge = withJudge ? 0.018 : 0;
  return { low: scenarios * (sasha[0] + judge), high: scenarios * (sasha[1] + judge * 1.2) };
}

/** Actual usage: Sasha from her own run ledger (cs_ai_runs cost, same prices as production), the judge from API usage. */
function usageSummary(results) {
  const s = { model_requests_turns: 0, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const j = { calls: 0, input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, cost_usd: 0 };
  for (const r of results) {
    for (const m of r.run.modelRuns || []) {
      s.model_requests_turns++; s.input_tokens += m.input_tokens || 0; s.cache_read_tokens += m.cache_read_tokens || 0;
      s.output_tokens += m.output_tokens || 0; s.cost_usd += Number(m.cost_micro_usd || 0) / 1e6;
    }
    const u = r.judge && r.judge.usage;
    if (u) {
      j.calls++; j.input_tokens += u.input_tokens || 0; j.cache_read_tokens += u.cache_read_input_tokens || 0;
      j.cache_write_tokens += u.cache_creation_input_tokens || 0; j.output_tokens += u.output_tokens || 0;
    }
  }
  const P = { in: Number(process.env.CERT_JUDGE_PRICE_INPUT_PER_MTOK || 4), out: Number(process.env.CERT_JUDGE_PRICE_OUTPUT_PER_MTOK || 20), read: 0.2, write: 5 };
  j.cost_usd = (j.input_tokens * P.in + j.output_tokens * P.out + j.cache_read_tokens * P.read + j.cache_write_tokens * P.write) / 1e6;
  return { sasha: s, judge: j, total_usd: s.cost_usd + j.cost_usd };
}
