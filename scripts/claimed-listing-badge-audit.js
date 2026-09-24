#!/usr/bin/env node
/* claimed-listing-badge-audit.js — READ-ONLY verification of directory listings that display a paid
   membership plan badge (Phase 6). Nothing is written anywhere: BD is read through its read-only API,
   Railway is read with SELECTs only.

   For every directory record whose plan is not the free "Claim Listing" plan (subscription_id 7) or the
   general user account, the audit collects evidence that the business really joined:
     - directory: a real login (last_login after the epoch), billing evidence (order/invoice/transactions/
       revenue present, subscription marked active), sign-up origin;
     - Railway: an active professional membership, an organization owner, a negotiated pricing agreement,
       a linked professional seller profile.
   A record with ANY evidence is PRESERVED (legitimate membership or private agreement). A record with none
   is a CORRECTION CANDIDATE: move it to the Claim Listing plan (Owner decision O3; the BD-side change is
   applied by the BD agent from docs/marketing/claimed-listing/bd-agent-handoff.md, never by this script).

   Output contains business names and BD user ids only (public directory data). No email, phone, card or
   billing values are printed — only whether evidence exists.

   Usage: node scripts/claimed-listing-badge-audit.js [--out=report.json] */
const fs = require('fs');
const transport = require('../src/services/bdRestTransport');
const db = require('../src/db');

const CLAIM_PLAN_ID = '7';
// Plan names come from each record's own subscription_schema (BD's plan definition), not a guess.
const SYSTEM_PLANS = new Set(['4', '5']);   // Admin / Blog Author, General User Account: not business membership badges
const arg = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : null; };
// BD returns placeholder shapes for records without billing (a 5-character string for transactions, a
// 3-key object for revenue), so evidence is only a real positive id or a non-empty transaction list.
const positiveId = (v) => v != null && /^\d+$/.test(String(v).trim()) && Number(v) > 0;
// Advantage.Bid's own directory listing is not an imported third-party business.
const isOwnListing = (r) => /^(aac|advantage auction( company)?|advantage\.bid)$/i.test(String(r.company || '').trim());
const nonEmptyList = (v) => Array.isArray(v) && v.length > 0;
const planName = (r) => (r.subscription_schema && typeof r.subscription_schema === 'object' && r.subscription_schema.subscription_name)
  || r.subscription_name || ('plan ' + r.subscription_id);
const planPaid = (r) => !!(r.subscription_schema && typeof r.subscription_schema === 'object'
  && (r.subscription_schema.profile_type === 'paid' || Number(r.subscription_schema.monthly_amount) > 0 || Number(r.subscription_schema.yearly_amount) > 0));

(async () => {
  const bd = await transport.fetchAllListings({ max: 5000 });
  const paid = bd.records.filter((r) => String(r.subscription_id) !== CLAIM_PLAN_ID && !SYSTEM_PLANS.has(String(r.subscription_id)));
  const ids = paid.map((r) => String(r.user_id));
  const rail = (await db.query(
    `SELECT o.bd_listing_id, o.id, o.name, o.lifecycle_state, o.linked_seller_profile_id, o.is_platform_tenant,
            EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active') AS has_owner,
            EXISTS (SELECT 1 FROM professional_memberships pm WHERE pm.organization_id = o.id AND pm.status IN ('active','trialing','past_due')) AS has_membership,
            EXISTS (SELECT 1 FROM professional_pricing_agreements pa WHERE pa.organization_id = o.id) AS has_pricing_agreement
       FROM organizations o WHERE o.bd_listing_id = ANY($1)`, [ids]).catch(async () => (await db.query(
    `SELECT o.bd_listing_id, o.id, o.name, o.lifecycle_state, o.linked_seller_profile_id, o.is_platform_tenant,
            EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active') AS has_owner,
            EXISTS (SELECT 1 FROM professional_memberships pm WHERE pm.organization_id = o.id AND pm.status IN ('active','trialing','past_due')) AS has_membership,
            false AS has_pricing_agreement
       FROM organizations o WHERE o.bd_listing_id = ANY($1)`, [ids])))).rows;
  const byBd = new Map(rail.map((r) => [String(r.bd_listing_id), r]));

  const rows = paid.map((r) => {
    const o = byBd.get(String(r.user_id)) || null;
    const loggedIn = !!(r.last_login && !String(r.last_login).startsWith('1970'));
    const billing = ['orderid', 'invoiceid', 'productids'].filter((f) => positiveId(r[f])).concat(nonEmptyList(r.transactions) ? ['transactions'] : []);
    const evidence = [];
    if (loggedIn) evidence.push('directory login');
    if (billing.length) evidence.push('directory billing record (' + billing.join(',') + ')');
    if (String(r.is_subscription_active) === '1' && billing.length) evidence.push('active paid subscription');
    if (o && o.has_owner) evidence.push('Railway organization owner');
    if (o && o.has_membership) evidence.push('Railway professional membership');
    if (o && o.has_pricing_agreement) evidence.push('negotiated pricing agreement');
    if (o && o.linked_seller_profile_id) evidence.push('linked professional seller');
    if ((o && o.is_platform_tenant) || isOwnListing(r)) evidence.push('Advantage.Bid own listing');
    if (String(r.sign_up_origin || '') === 'Self Signup') evidence.push('self sign-up (not a bulk import)');
    return {
      bd_user_id: String(r.user_id), company: r.company || r.full_name, plan_id: String(r.subscription_id),
      plan: planName(r), plan_is_paid: planPaid(r), profession_id: String(r.profession_id),
      signup_date: r.signup_date || null, sign_up_origin: r.sign_up_origin || null,
      organization_id: o ? o.id : null, lifecycle_state: o ? o.lifecycle_state : null,
      evidence, verdict: evidence.length ? 'PRESERVE' : (planPaid(r) ? 'CORRECTION_CANDIDATE' : 'NO_PAID_BADGE'),
      correction: evidence.length || !planPaid(r) ? null : { from_plan: String(r.subscription_id), from_plan_name: planName(r), to_plan: CLAIM_PLAN_ID, to_plan_name: 'Claim Listing' },
    };
  });
  const summary = rows.reduce((m, r) => { const k = r.plan + ' / ' + r.verdict; m[k] = (m[k] || 0) + 1; return m; }, {});
  const report = { generated_at: new Date().toISOString(), directory_records: bd.records.length, non_claim_plan_business_records: rows.length,
    correction_candidates: rows.filter((r) => r.verdict === 'CORRECTION_CANDIDATE').length, summary, rows };
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
  for (const r of rows) console.log(r.verdict.padEnd(21), r.bd_user_id.padStart(4), r.plan.padEnd(30), r.company, r.evidence.length ? '[' + r.evidence.join('; ') + ']' : '');
})().then(() => db.pool.end()).catch((e) => { console.error(e.message); process.exitCode = 1; });
