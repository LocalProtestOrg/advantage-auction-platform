'use strict';

/**
 * marketingDirectorService — the read-only decision-support layer for the Marketing Director (A1) and the
 * growth agents (A10/A11/A12 hold `propose_audience`). It answers WHAT opportunity / WHO / WHY / HOW
 * STRONG / WHAT audience / WHAT geography / WHAT category / WHAT exclusions / WHAT channels / WHAT
 * conversion / WHAT success — WITHOUT executing any marketing.
 *
 * Least-access: agents receive an audience DEFINITION + size + rationale + summaries, never raw
 * clickstream. Reuses the agent roster (src/constants/marketingAgents) and the destination contract.
 */
const db = require('../db');
const audiences = require('../lib/behavioralAudiences');
const destinations = require('../lib/audienceDestinations');
const membership = require('./audienceMembershipService');
const agents = require('../constants/marketingAgents');

// The audience opportunity brief an agent may receive (no raw events).
async function opportunityBrief(audienceKey, runner) {
  const r = runner || db;
  const def = audiences.get(audienceKey);
  if (!def) return null;
  const countMap = await membership.counts(r);
  const size = countMap[audienceKey] || 0;

  // Signal summary: which signal types + levels currently back this audience (aggregate, not per-person).
  const driver = def.qualifying[0];
  const sig = (await r.query(
    `SELECT count(*)::int AS n, coalesce(round(avg(level)::numeric,2),0) AS avg_level, max(last_observed_at) AS most_recent
       FROM marketing_signals WHERE signal_type = $1 AND active = true`, [driver.signal])).rows[0];

  const channelReadiness = def.allowed_channels.map((c) => {
    const d = destinations.get(c);
    return { channel: c, enabled: false, kind: d ? d.kind : null };   // all external OFF this phase
  });

  return {
    audience_key: audienceKey,
    family: def.family,
    opportunity: def.purpose,
    who: `${size} member(s) currently qualified`,
    why: `qualifying signal ${driver.signal} (min level ${driver.minLevel || 1})`,
    evidence_strength: { qualified_signals: sig.n, avg_level: Number(sig.avg_level), most_recent: sig.most_recent },
    audience_size: size,
    geography: def.geography,
    category: def.category,
    exclusions: def.conversion_exit,
    allowed_channels: def.allowed_channels,
    channel_readiness: channelReadiness,
    intended_conversion: def.success_outcome,
    success_definition: `member performs ${def.success_outcome} (then exits the audience)`,
    version: audiences.VERSION,
  };
}

async function allBriefs(runner) {
  const out = [];
  for (const k of audiences.KEYS) out.push(await opportunityBrief(k, runner));
  return out.filter(Boolean);
}

// Input an agent would pass to the Growth Lab experiment service (reuses marketing_experiments.audience).
function experimentInput(audienceKey, proposedByAgent) {
  const def = audiences.get(audienceKey);
  if (!def) return null;
  const agent = agents.get(proposedByAgent);
  return {
    audience: audienceKey,                 // marketing_experiments.audience (free text) accepts the key
    campaignClass: def.family === 'seller' ? 'seller' : (def.family === 'professional' ? 'professional_seller' : 'buyer'),
    proposedByAgent: proposedByAgent || null,
    proposer_can_propose_audience: !!(agent && agents.agentCan(proposedByAgent, 'propose_audience')),
    primary_metric: def.success_outcome,
    channels: def.allowed_channels,
    note: 'Growth Lab preregistration/MDE/attribution/stop-rules remain authoritative; behavioral data must not create false causal claims.',
  };
}

// Least-access check: which agents may receive audience briefs vs act on them.
function agentAccess(code) {
  const a = agents.get(code);
  if (!a) return { code, exists: false };
  return {
    code, name: a.name,
    can_receive_briefs: ['A1', 'A2', 'A10', 'A11', 'A12', 'A14'].includes(code),
    can_propose_audience: agents.agentCan(code, 'propose_audience'),
    can_publish: agents.canPublish ? agents.canPublish(code) : false,
    raw_clickstream: false,   // NEVER — no agent gets raw events
  };
}

module.exports = { opportunityBrief, allBriefs, experimentInput, agentAccess };
