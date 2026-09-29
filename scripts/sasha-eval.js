#!/usr/bin/env node
/*
 * sasha-eval.js — behavioural regression check for Sasha against the REAL model and the real rules/tools.
 * Read-only: records no run, creates no conversation or handoff, sends nothing. Needs ANTHROPIC_API_KEY and
 * DATABASE_URL (tools read public data), e.g.:
 *   railway run node scripts/sasha-eval.js            (each scenario runs RUNS times; default 2)
 *
 * Scenarios (owner review 2026-09-29):
 *   1. "How do auctions work as a seller?" with no seller type known → one short clarifying question, no mixed rules.
 *   2. Known Individual Seller → individual rules; never told they can set a starting price.
 *   3. Known Professional Seller → professional capabilities (starting bids / reserves / own premium).
 *   4. 30-lot minimum → stated as the rule; no exception offered or suggested.
 *   5. Explicit comparison request → both seller types explained.
 */
const path = require('path');
const root = path.join(__dirname, '..');
const engine = require(path.join(root, 'src/services/sasha/engine'));
const conversations = require(path.join(root, 'src/services/sasha/conversationService'));
const db = require(path.join(root, 'src/db'));

const RUNS = Number(process.env.RUNS || 2);
const origQuery = db.query.bind(db);
db.query = (sql, p) => {
  if (/INSERT INTO cs_ai_runs/.test(sql)) return Promise.resolve({ rows: [{ id: null }] });   // record nothing
  if (/SELECT seller_type FROM seller_profiles WHERE user_id = \$1/.test(sql)) {             // simulated signed-in sellers
    const t = { 'eval-individual': 'private', 'eval-professional': 'auction_house' }[p[0]];
    return Promise.resolve({ rows: t ? [{ seller_type: t }] : [] });
  }
  return origQuery(sql, p);
};
conversations.requestHandoff = async () => {};

const EXCEPTION = /exception|waive|fewer than 30[^.]*(contact|call|reach out|ask)|(contact|call|reach out to|ask) (us|our team|staff|support)[^.]*(fewer|under|less than) 30/i;
const SETS_START = /(you|sellers?) (can|may|get to) (also )?(set|choose|pick)[^.]{0,40}(starting (bid|price)|opening bid|reserve)/i;
const scenarios = [
  { name: '1 unknown type → clarify', ctx: { channel: 'chat' }, turns: ['How do auctions work as a seller?'],
    check: (t) => ({ asks_question: /\?/.test(t), short: t.length < 600, no_starting_price: !/starting (bid|price)|reserve/i.test(t), no_exception: !EXCEPTION.test(t),
      not_both_fee_models: !(/3% (payment )?processing/i.test(t) && /agreement/i.test(t)) }) },
  { name: '2 known individual', ctx: { channel: 'chat', userId: 'eval-individual' }, turns: ['How do auctions work as a seller?'],
    check: (t) => ({ no_seller_set_start: !SETS_START.test(t), mentions_30: /30/.test(t), no_exception: !EXCEPTION.test(t),
      no_professional_dump: !/professional seller/i.test(t) || /not|only/i.test(t) }) },
  { name: '3 known professional', ctx: { channel: 'chat', userId: 'eval-professional' }, turns: ['How do auctions work as a seller? What can I control on my lots?'],
    check: (t) => ({ pro_controls: /starting (bid|price)|reserve/i.test(t), own_premium: /premium/i.test(t), no_exception: !EXCEPTION.test(t) }) },
  { name: '4 fewer than 30 lots', ctx: { channel: 'chat' }, turns: ["I only have about 12 items to sell. Can I still run an auction with that?"],
    check: (t) => ({ states_30_rule: /30/.test(t), no_exception: !EXCEPTION.test(t) }) },
  { name: '5 comparison requested', ctx: { channel: 'chat' }, turns: ["What's the difference between an Individual Seller and a Professional Seller?"],
    check: (t) => ({ covers_individual: /individual/i.test(t), covers_professional: /professional/i.test(t), no_exception: !EXCEPTION.test(t) }) },
];

(async () => {
  let failed = 0;
  for (const s of scenarios) {
    for (let i = 1; i <= RUNS; i++) {
      conversations.transcriptForModel = async () => s.turns.map((b) => ({ author_type: 'customer', body_text: b }));
      const r = await engine.respond({ conversationId: '00000000-0000-0000-0000-000000000000', ctx: { ...s.ctx } });
      const text = r.text || '';
      const c = s.check(text);
      const ok = r.outcome === 'replied' && Object.values(c).every(Boolean);
      if (!ok) failed++;
      console.log(`\n=== ${s.name} (run ${i}) ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(c)}\n${text || r.error}`);
    }
  }
  console.log(`\nRESULT: ${failed ? 'FAIL (' + failed + ')' : 'PASS'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
