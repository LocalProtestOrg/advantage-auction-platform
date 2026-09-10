'use strict';

/**
 * paidGrowthReport — the Owner's paid-growth report (paid-growth-policy.json owner_report): weekly digest, state-change
 * digest, monthly summary. Plain sentences; numbers carry their confidence state; no dashboard needed to understand it.
 *
 * STRUCTURAL EXCLUSION: this module reads ONLY the paid-growth ledger and first-party facts listed in DATA_SOURCES.
 * It never reads the Marketing Package ledger, so package internal economics (60/40 policy, seller-package margins,
 * media costs attributed to package fulfilment, Growth Pool mechanics, unused-capacity economics, confidential provider
 * mechanics) cannot appear. assertOwnerSafe() is a second, output-side check that throws if any such term slips in.
 * Assisted-service pricing is never stated (custom after evaluation).
 */
const db = require('../../db');

const DATA_SOURCES = Object.freeze([
  'marketing_paid_growth_proposals', 'marketing_paid_campaign_states', 'marketing_paid_director_actions', 'marketing_paid_cost_facts',
  'marketing_conversion_events', 'marketing_attribution_touches', 'analytics_events', 'platform_config:marketing.paid_growth.*',
]);
const FORBIDDEN_SOURCES = /marketing_package|package_purchase|growth_pool|marketing_obligation|marketing_allocation|media_margin/i;
const FORBIDDEN_OUTPUT = [/60\s*\/\s*40/, /margin/i, /growth pool/i, /package econom/i, /profitab/i, /unused capacity/i, /\b40\s?%/, /commission/i, /internal director reasoning/i];

function assertOwnerSafe(obj) {
  const seen = [];
  (function walk(v, p) {
    if (v == null) return;
    if (typeof v === 'string') { for (const re of FORBIDDEN_OUTPUT) if (re.test(v)) seen.push(p + ': ' + re.source); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']')); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { for (const re of FORBIDDEN_OUTPUT) if (re.test(k)) seen.push(p + '.' + k + ' (key)'); walk(x, p + '.' + k); }
  })(obj, '$');
  if (seen.length) { const e = new Error('Owner report contains excluded content: ' + seen.join('; ')); e.code = 'OWNER_REPORT_EXCLUDED_CONTENT'; throw e; }
  return true;
}

/** Guarded query: refuses any SQL touching a source outside the paid-growth / first-party allowlist. */
async function q(r, sql, p) {
  if (FORBIDDEN_SOURCES.test(sql)) throw new Error('paidGrowthReport may not read ' + sql.match(FORBIDDEN_SOURCES)[0]);
  return (await r.query(sql, p)).rows;
}

const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const monthBounds = (month) => { const s = new Date(month + (month.length === 7 ? '-01' : '') + 'T00:00:00Z'); const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1)); return [s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]; };
const STATE_WORDS = { NO_DATA: 'no data yet', INSUFFICIENT_DATA: 'not enough data to judge', EARLY_SIGNAL: 'an early signal (not yet reliable)', MEANINGFUL_SIGNAL: 'a meaningful signal', WINNER: 'a winner', LOSER: 'not working' };

function narrative(c, stateRow, actions) {
  const f = c.facts || {}; const st = stateRow ? stateRow.signal_state : 'NO_DATA';
  const funnel = f.funnel || {};
  const after = `${f.sessions || 0} visits → ${f.engaged_sessions || 0} engaged → ${funnel.registrations || 0} registrations → ${funnel.intent || 0} showed intent → ${funnel.marketplace_actions || 0} marketplace actions → ${funnel.outcomes || 0} outcomes`;
  const last = actions[0];
  return {
    campaign: c.campaign_key,
    WHY_WE_ARE_RUNNING_IT: c.why || 'Launched from an approved proposal.',
    WHAT_WE_HAVE_LEARNED: `The campaign is currently ${STATE_WORDS[st] || st}.` + (stateRow && stateRow.facts && stateRow.facts.conversions != null ? ` ${stateRow.facts.conversions} first-party outcomes so far.` : ''),
    WHAT_IT_COST: `${usd(f.spend_cents)} spent (${f.impressions || 0} impressions, ${f.clicks || 0} clicks, as the platform reported them).`,
    WHAT_HAPPENED_AFTER_THE_CLICK: after + '. Outcomes are counted from Advantage.Bid records, not from the ad platform.',
    WHAT_THE_DIRECTOR_IS_DOING_NEXT: last ? `${last.action.replace(/_/g, ' ').toLowerCase()} — ${(last.evidence && last.evidence.note) || 'recorded with its evidence'}.` : 'Continue to the next checkpoint.',
    confidence: st,
  };
}

async function monthly({ month = new Date().toISOString().slice(0, 7) } = {}, runner) {
  const r = runner || db;
  const [from, to] = monthBounds(month);
  const ceilingRow = (await q(r, `SELECT value FROM platform_config WHERE key='marketing.paid_growth.monthly_ceiling_usd'`))[0];
  const ceilingCents = Math.round(Number(ceilingRow ? ceilingRow.value : 1000) * 100);
  const proposals = await q(r, `SELECT market, audience, campaign, objective, channel, budget_cents, success_signal, measurement_ready, unmeasurable, rationale, state
      FROM marketing_paid_growth_proposals WHERE month = $1::date AND state <> 'SUPERSEDED' ORDER BY created_at`, [from]);
  const cost = await q(r, `SELECT provider, campaign_key, COALESCE(SUM(spend_cents),0)::bigint spend_cents FROM marketing_paid_cost_facts WHERE fact_date >= $1 AND fact_date < $2 GROUP BY 1,2`, [from, to]);
  const states = await q(r, `SELECT campaign_key, signal_state, meaningful_checkpoints, facts, last_state_change_at FROM marketing_paid_campaign_states`);
  const actions = await q(r, `SELECT campaign_key, action, state_before, state_after, evidence, created_at FROM marketing_paid_director_actions WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at DESC`, [from, to]);
  const facts = await require('../measurement/outcomeAttributionService').campaignFacts({ from, to: new Date(new Date(to).getTime() - 86400000).toISOString().slice(0, 10) }, r);
  const recommended = proposals.reduce((a, p) => a + Number(p.budget_cents || 0), 0);
  const actual = cost.reduce((a, c) => a + Number(c.spend_cents || 0), 0);
  const group = (key) => { const m = {}; for (const p of proposals) { const k = p[key] || 'unassigned'; m[k] = m[k] || { recommended_cents: 0 }; m[k].recommended_cents += Number(p.budget_cents || 0); } return m; };
  const byCampaign = {}; for (const c of cost) byCampaign[c.campaign_key] = { actual_cents: Number(c.spend_cents) };
  const material = facts.filter((f) => f.spend_cents > 0 || f.sessions > 0);
  const report = {
    kind: 'monthly_summary', month, mode: 'shadow',
    header: { MONTHLY_AUTHORITY: usd(ceilingCents), RECOMMENDED_SPEND: usd(recommended), ACTUAL_SPEND: usd(actual), REMAINING_AUTHORITY: usd(Math.max(0, ceilingCents - actual)) },
    allocation_by: { objective: group('objective'), geography: group('market'), audience: group('audience'), channel: group('channel'), campaign: Object.assign(group('campaign'), byCampaign) },
    measurement: { ready: proposals.length ? proposals.every((p) => p.measurement_ready) : false, not_yet_measurable: [...new Set(proposals.flatMap((p) => p.unmeasurable || []))] },
    campaigns: material.map((f) => narrative({ campaign_key: f.campaign_key, facts: f }, states.find((s) => s.campaign_key === f.campaign_key), actions.filter((a) => a.campaign_key === f.campaign_key))),
    proposals: proposals.map((p) => ({ market: p.market, campaign: p.campaign, objective: p.objective, channel: p.channel, budget: usd(p.budget_cents), success_signal: p.success_signal, state: p.state, why: p.rationale })),
  };
  report.text = render(report);
  assertOwnerSafe(report);
  return report;
}

function render(rep) {
  const h = rep.header;
  const lines = [];
  lines.push(`Paid growth — ${rep.month}`);
  lines.push(`Monthly authority ${h.MONTHLY_AUTHORITY}. Recommended ${h.RECOMMENDED_SPEND}. Spent ${h.ACTUAL_SPEND}. Remaining ${h.REMAINING_AUTHORITY}.`);
  if (!rep.measurement.ready) lines.push(`No paid campaign is running. Measurement is not ready yet, so the Director recommends ${h.RECOMMENDED_SPEND}. Still to verify: ${rep.measurement.not_yet_measurable.join(', ') || 'the readiness audit'}.`);
  lines.push('Paid advertising stays off until you turn a channel on.');
  for (const c of rep.campaigns) lines.push(`${c.campaign}: ${c.WHAT_IT_COST} ${c.WHAT_HAPPENED_AFTER_THE_CLICK} ${c.WHAT_WE_HAVE_LEARNED} Next: ${c.WHAT_THE_DIRECTOR_IS_DOING_NEXT}`);
  for (const p of rep.proposals || []) lines.push(`Proposal — ${p.campaign} (${p.market}, ${p.channel}): ${p.budget}. Judged on ${p.success_signal.replace(/_/g, ' ')}. ${p.why || ''}`.trim());
  return lines.join('\n');
}

async function weekly({ since = new Date(Date.now() - 7 * 86400000) } = {}, runner) {
  const r = runner || db;
  const d = new Date(since).toISOString().slice(0, 10);
  const cost = await q(r, `SELECT COALESCE(SUM(spend_cents),0)::bigint s FROM marketing_paid_cost_facts WHERE fact_date >= $1`, [d]);
  const changes = await q(r, `SELECT campaign_key, action, state_before, state_after, created_at FROM marketing_paid_director_actions WHERE created_at >= $1 AND state_after IS NOT NULL ORDER BY created_at DESC`, [since]);
  const conv = await q(r, `SELECT conversion_key, count(*)::int n FROM marketing_conversion_events WHERE occurred_at >= $1 GROUP BY 1 ORDER BY 1`, [since]);
  const rep = { kind: 'weekly_digest', since: d, spent: usd(cost[0].s), state_changes: changes.map((c) => `${c.campaign_key}: ${STATE_WORDS[c.state_before] || c.state_before || 'new'} → ${STATE_WORDS[c.state_after] || c.state_after} (${c.action.replace(/_/g, ' ').toLowerCase()})`),
    first_party_outcomes: conv };
  rep.text = [`Paid growth — week since ${d}`, `Spent ${rep.spent}.`, rep.state_changes.length ? 'Changes: ' + rep.state_changes.join('; ') + '.' : 'No campaign changed state.',
    'Advantage.Bid outcomes this week: ' + (conv.length ? conv.map((c) => `${c.n} ${c.conversion_key.replace(/_/g, ' ')}`).join(', ') : 'none recorded') + '.'].join('\n');
  assertOwnerSafe(rep);
  return rep;
}

async function stateChanges({ since } = {}, runner) {
  const r = runner || db;
  const rows = await q(r, `SELECT campaign_key, action, state_before, state_after, evidence, created_at FROM marketing_paid_director_actions WHERE created_at >= $1 AND state_after IS NOT NULL AND state_after IS DISTINCT FROM state_before ORDER BY created_at`, [since || new Date(Date.now() - 86400000)]);
  const rep = { kind: 'state_change_digest', changes: rows.map((x) => ({ campaign: x.campaign_key, from: x.state_before, to: x.state_after, action: x.action, why: ((x.evidence && x.evidence.reasons) || []).join(' ') })) };
  assertOwnerSafe(rep);
  return rep;
}

module.exports = { monthly, weekly, stateChanges, render, assertOwnerSafe, DATA_SOURCES, FORBIDDEN_OUTPUT, FORBIDDEN_SOURCES };
