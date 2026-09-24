'use strict';

/**
 * toolboxService — the Claimed Listings tab in the Sales & Marketing Toolbox (handoff section 7).
 *
 * Rows join everything a rep needs about a directory listing in one place, from every programme:
 * company, location, website, phone, email (MASKED until the row is opened), listing status, journey,
 * eligibility decision + reason, tier/score, outreach status, last contact (any programme, any channel),
 * next action, engagement, claim status + proof, assigned rep, contact lock holder, Pro Seller status and
 * notes. NO package economics or financial fields appear anywhere (financial RBAC is preserved).
 */

const db = require('../../db');
const listingContext = require('./listingContext');
const eligibility = require('./eligibilityService');
const scoring = require('./scoringService');
const { maskEmail } = require('./claimLinkService');

async function rows({ decision = null, tier = null, q = null, market = null, limit = 500 } = {}, runner = db) {
  const ctx = await listingContext.load(runner);
  const orgIds = ctx.listings.map((e) => e.entity_id);
  const persisted = new Map((await runner.query(
    `SELECT organization_id, decision, reason, evaluated_at FROM listing_outreach_eligibility_decisions WHERE organization_id = ANY($1::uuid[])`, [orgIds])).rows
    .map((r) => [r.organization_id, r]));
  const scores = new Map((await runner.query(`SELECT organization_id, score, tier FROM listing_outreach_scores WHERE organization_id = ANY($1::uuid[])`, [orgIds])).rows
    .map((r) => [r.organization_id, r]));
  const seqs = new Map((await runner.query(
    `SELECT DISTINCT ON (organization_id) organization_id, state, step, next_send_at, last_sent_at, stop_reason, cycle_no
       FROM listing_outreach_sequences WHERE organization_id = ANY($1::uuid[]) ORDER BY organization_id, cycle_no DESC`, [orgIds])).rows.map((r) => [r.organization_id, r]));
  const engagement = new Map((await runner.query(
    `SELECT organization_id,
            count(*) FILTER (WHERE event_key = 'page_view' AND NOT is_automated AND NOT is_internal)::int AS visits,
            count(*) FILTER (WHERE event_key = 'claim_started' AND NOT is_internal)::int AS claim_started,
            count(*) FILTER (WHERE event_key = 'link_fetch')::int AS link_fetches
       FROM listing_claim_events WHERE organization_id = ANY($1::uuid[]) GROUP BY organization_id`, [orgIds])).rows.map((r) => [r.organization_id, r]));
  const tasks = new Map((await runner.query(
    `SELECT DISTINCT ON (organization_id) organization_id, task_type, due_at FROM listing_tasks
      WHERE organization_id = ANY($1::uuid[]) AND status IN ('open','in_progress') ORDER BY organization_id, due_at ASC NULLS LAST`, [orgIds])).rows
    .map((r) => [r.organization_id, r]));
  const claimsProof = new Map((await runner.query(
    `SELECT DISTINCT ON (organization_id) organization_id, proof_method, created_at FROM organization_claim_attempts
      WHERE organization_id = ANY($1::uuid[]) AND outcome = 'granted' ORDER BY organization_id, created_at DESC`, [orgIds])).rows.map((r) => [r.organization_id, r]));
  const activation = new Map((await runner.query(
    `SELECT organization_id, activated_at, profile_completed_at FROM listing_activation_progress WHERE organization_id = ANY($1::uuid[])`, [orgIds])).rows
    .map((r) => [r.organization_id, r]));
  const lastActivity = new Map((await runner.query(
    `SELECT organization_id, max(occurred_at) AS at, count(*) FILTER (WHERE activity_type = 'note')::int AS notes
       FROM organization_activity WHERE organization_id = ANY($1::uuid[]) GROUP BY organization_id`, [orgIds])).rows.map((r) => [r.organization_id, r]));
  const reps = new Map((await runner.query(
    `SELECT r.organization_id, u.full_name FROM organization_reps r JOIN users u ON u.id = r.user_id
      WHERE r.organization_id = ANY($1::uuid[]) AND r.is_primary = true`, [orgIds])).rows.map((r) => [r.organization_id, r.full_name]));

  const out = [];
  const needle = q ? String(q).toLowerCase() : null;
  for (const e of ctx.listings) {
    const o = e.row;
    const cluster = ctx.snap.clusterFor('organization', e.entity_id);
    const live = eligibility.decide(e, ctx);
    const p = persisted.get(o.id);
    const d = p || live;
    const s = scores.get(o.id) || scoring.scoreListing(e, ctx);
    const mkt = scoring.strategicMarket(o);
    if (decision && d.decision !== decision) continue;
    if (tier && s.tier !== tier) continue;
    if (market && mkt !== market) continue;
    if (needle && !String(o.name || '').toLowerCase().includes(needle) && !String(o.city || '').toLowerCase().includes(needle)) continue;
    const companyId = ctx.companyIdOf(cluster);
    const lock = companyId ? ctx.locks.get(companyId) : null;
    const seq = seqs.get(o.id);
    const eng = engagement.get(o.id) || {};
    const act = activation.get(o.id);
    const listingStatus = o.profile_data && o.profile_data.hidden_by_request === true ? 'hidden'
      : act && act.activated_at ? 'activated' : o.has_owner ? 'claimed' : o.bd_sync_status === 'removed' ? 'removed' : 'unclaimed';
    const prospectRep = cluster && cluster.members.find((m) => m.entity_type === 'sales_prospect' && m.row.assigned_rep_user_id);
    const t = tasks.get(o.id);
    const last = [lastActivity.get(o.id) && lastActivity.get(o.id).at, seq && seq.last_sent_at].filter(Boolean).sort().pop() || null;
    out.push({
      organization_id: o.id, company_id: companyId, company: o.name, city: o.city, state: o.state, website: o.website_url || null,
      phone: o.contact_phone || null, email_masked: maskEmail(o.contact_email), listing_status: listingStatus,
      journey: cluster ? cluster.journey : null, journey_source: cluster ? cluster.journey_source : null,
      eligibility: d.decision, eligibility_reason: d.reason, eligibility_evaluated_at: p ? p.evaluated_at : null,
      tier: s.tier, score: s.score, market: mkt,
      outreach: seq ? { state: seq.state, step: seq.step, cycle: seq.cycle_no, last_sent_at: seq.last_sent_at, next_send_at: seq.next_send_at, stop_reason: seq.stop_reason } : null,
      last_contact_at: last, next_action: t ? { type: t.task_type, due_at: t.due_at } : null,
      engagement: { visits: eng.visits || 0, claim_started: eng.claim_started || 0, link_fetches: eng.link_fetches || 0 },
      claim: o.has_owner ? { status: 'claimed', proof_method: (claimsProof.get(o.id) || {}).proof_method || null } : { status: 'unclaimed' },
      assigned_rep: reps.get(o.id) || (prospectRep ? 'prospect rep assigned' : null),
      lock: lock ? { holder_type: lock.holder_type, holder: lock.holder_name || (lock.holder_type === 'system' ? 'Automated sequence' : null), since: lock.acquired_at } : null,
      pro_seller: !!(o.linked_seller_profile_id || (cluster && cluster.members.some((m) => m.entity_type === 'seller_profile'))),
      notes: (lastActivity.get(o.id) || {}).notes || 0,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Full detail for an opened row (the address is revealed here) plus the one company timeline. */
async function companyDetail(organizationId, runner = db) {
  const o = (await runner.query(
    `SELECT id, name, city, state, contact_email, contact_phone, website_url, description, lifecycle_state, bd_listing_id, crm_stage, acquisition
       FROM organizations WHERE id = $1`, [organizationId])).rows[0];
  if (!o) return null;
  const link = (await runner.query(`SELECT company_id FROM company_identity_links WHERE entity_type = 'organization' AND entity_id = $1`, [String(organizationId)])).rows[0];
  const companyId = link ? link.company_id : null;
  const members = companyId ? (await runner.query(`SELECT entity_type, entity_id FROM company_identity_links WHERE company_id = $1`, [companyId])).rows : [];
  const orgIds = [organizationId, ...members.filter((m) => m.entity_type === 'organization').map((m) => m.entity_id)];
  const prospectIds = members.filter((m) => m.entity_type === 'sales_prospect').map((m) => m.entity_id);
  const timeline = (await runner.query(
    `SELECT * FROM (
       SELECT occurred_at AS at, 'activity' AS source, activity_type AS kind, channel, direction, subject AS summary FROM organization_activity WHERE organization_id = ANY($1::uuid[])
       UNION ALL SELECT created_at, 'sales_note', activity_type, NULL, NULL, left(body, 200) FROM sales_prospect_notes WHERE prospect_id = ANY($2::uuid[])
       UNION ALL SELECT created_at, 'sales_email', status, 'email', 'outbound', subject FROM sales_outreach_emails WHERE prospect_id = ANY($2::uuid[])
       UNION ALL SELECT COALESCE(sent_at, created_at), 'listing_message', COALESCE(classification, status), 'email', direction,
                        COALESCE(template_key, '') || CASE WHEN subject IS NOT NULL THEN ': ' || subject ELSE '' END
                  FROM listing_outreach_messages WHERE organization_id = ANY($1::uuid[])
       UNION ALL SELECT COALESCE(sent_at, created_at), 'event_partner', status, 'email', 'outbound', 'Event Partner programme message (summary only)'
                  FROM event_partner_cohort_members WHERE organization_id = ANY($1::uuid[])
       UNION ALL SELECT created_at, 'claim_attempt', outcome, NULL, NULL, proof_method || COALESCE(' / ' || denial_code, '') FROM organization_claim_attempts WHERE organization_id = ANY($1::uuid[])
       UNION ALL SELECT occurred_at, 'funnel', event_key, NULL, NULL, CASE WHEN is_automated THEN 'automated' ELSE NULL END FROM listing_claim_events WHERE organization_id = ANY($1::uuid[])
     ) t ORDER BY at DESC LIMIT 200`, [orgIds, prospectIds.length ? prospectIds : ['00000000-0000-0000-0000-000000000000']])).rows;
  const tasks = (await runner.query(`SELECT id, task_type, status, priority, due_at, summary, payload, created_at FROM listing_tasks WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 50`, [organizationId])).rows;
  const lock = companyId ? (await runner.query(
    `SELECT l.holder_type, l.acquired_at, l.expires_at, u.full_name AS holder_name, l.holder_user_id FROM company_contact_locks l LEFT JOIN users u ON u.id = l.holder_user_id
      WHERE l.company_id = $1 AND l.expires_at > now()`, [companyId])).rows[0] : null;
  const pending = (await runner.query(`SELECT id, field, old_value, new_value, created_at FROM organization_profile_change_requests WHERE organization_id = $1 AND status = 'pending'`, [organizationId])).rows;
  return { organization: o, company_id: companyId, linked_records: members, lock: lock || null, tasks, pending_changes: pending, timeline };
}

module.exports = { rows, companyDetail };
