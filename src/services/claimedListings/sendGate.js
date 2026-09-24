'use strict';

/**
 * sendGate — checked at SEND time for every Claimed Listing message. ALL must pass (handoff section 5):
 *
 *   1 program     claimed_listings.sending_enabled = true and the programme is not auto-paused
 *   2 cohort      member of an APPROVED, unexpired cohort bound to APPROVED template versions
 *   3 eligibility re-screen now = ELIGIBLE_UNCLAIMED_LISTING (or mid-sequence with no stop condition)
 *   4 journey     the company's journey is CLAIMED_LISTING
 *   5 lock        the company contact lock is free or held by the system for this sequence
 *   6 caps        cohort max_sends and daily_cap, global daily cap, one message per recipient domain per
 *                 24h, minimum spacing between sends
 *   7 window      Tue-Thu 09:30-11:30 in the recipient's local time (from the listing's state)
 *   8 health      7-day stream bounce < 3% and complaint < 0.1% (min 50 delivered; below that any complaint
 *                 pauses)
 *   9 config      SES configuration set, verified From identity, postal address, unsubscribe secret, a rep
 *
 * Any failure: do not send, and record the reasons. Every lookup error is a failure (fail closed).
 * `evaluate` never sends; its only write is refreshing the listing's persisted eligibility decision. The
 * sender and the shadow run both call it; a run over many listings passes one shared context.
 */

const db = require('../../db');
const emailService = require('../emailService');
const unsub = require('../../lib/listingUnsubscribeToken');
const eligibility = require('./eligibilityService');
const identity = require('../acquisition/companyIdentityService');
const listingContext = require('./listingContext');

const TZ_BY_STATE = {
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York',
  ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', NH: 'America/New_York',
  NJ: 'America/New_York', NY: 'America/New_York', NC: 'America/New_York', OH: 'America/New_York', PA: 'America/New_York',
  RI: 'America/New_York', SC: 'America/New_York', VT: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  IN: 'America/Indiana/Indianapolis', KY: 'America/New_York', AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago',
  IA: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', NE: 'America/Chicago', ND: 'America/Chicago', OK: 'America/Chicago', SD: 'America/Chicago',
  TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago', AZ: 'America/Phoenix', CO: 'America/Denver',
  ID: 'America/Boise', MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu', PR: 'America/Puerto_Rico',
};
const DEFAULT_TZ = 'America/Chicago';

/** Local weekday (0=Sun) and minutes-after-midnight at `now` in `tz`. Pure. */
function localClock(now, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now).reduce((m, p) => { m[p.type] = p.value; return m; }, {});
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { day, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/** Is `now` inside the send window for a listing in `state`? Pure. */
function inWindow(now, state, window = { days: [2, 3, 4], start: '09:30', end: '11:30' }) {
  const tz = TZ_BY_STATE[listingContext.usStateCode(state)] || DEFAULT_TZ;
  const { day, minutes } = localClock(now, tz);
  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
  return { ok: (window.days || []).includes(day) && minutes >= toMin(window.start) && minutes < toMin(window.end), tz, day, minutes };
}

/** Stream health from the last 7 days of SES feedback on the claimed_listing stream. */
async function streamHealth(runner, thresholds) {
  const r = (await runner.query(
    `SELECT count(*) FILTER (WHERE lower(event_type) = 'delivery')::int AS delivered,
            count(*) FILTER (WHERE lower(event_type) = 'bounce' AND lower(COALESCE(bounce_subtype,'')) <> 'transient')::int AS hard_bounces,
            count(*) FILTER (WHERE lower(event_type) = 'complaint')::int AS complaints
       FROM ses_feedback_events WHERE mail_stream = 'claimed_listing' AND received_at > now() - interval '7 days'`)).rows[0] || {};
  const t = Object.assign({ bounce_max: 0.03, complaint_max: 0.001, min_sample: 50 }, thresholds || {});
  const delivered = r.delivered || 0;
  if (delivered < t.min_sample) {
    return { ok: (r.complaints || 0) === 0, delivered, complaints: r.complaints, hard_bounces: r.hard_bounces, rule: 'below sample: any complaint pauses' };
  }
  const bounceRate = (r.hard_bounces || 0) / delivered;
  const complaintRate = (r.complaints || 0) / delivered;
  return { ok: bounceRate < t.bounce_max && complaintRate < t.complaint_max, delivered, bounce_rate: bounceRate, complaint_rate: complaintRate };
}

async function config(runner) {
  const rows = (await runner.query(`SELECT key, value FROM platform_config WHERE key LIKE 'claimed_listings.%' OR key IN ('company.postal_address')`)).rows;
  return rows.reduce((m, r) => { m[r.key] = r.value; return m; }, {});
}

/**
 * Evaluate every lock for one prospective send. Returns { allowed, checks: [{ name, ok, detail }], permanent }.
 * `permanent` = a failure that should STOP the sequence (eligibility, journey), as opposed to one that
 * should simply wait (window, caps, spacing, switch off).
 * input: { organizationId, sequence (or null for the first step), cohortId, recipientEmail, now }
 */
async function evaluate({ organizationId, sequence = null, cohortId, recipientEmail, now = new Date(), stepKey = null }, runner = db, shared = {}) {
  const checks = [];
  const add = (name, ok, detail, permanent = false) => checks.push({ name, ok: !!ok, detail, permanent: !ok && permanent });
  try {
    const cfg = await config(runner);

    // 1. Programme switch.
    add('program', cfg['claimed_listings.sending_enabled'] === true && !cfg['claimed_listings.paused_reason'],
      cfg['claimed_listings.paused_reason'] ? 'auto-paused: ' + cfg['claimed_listings.paused_reason']
        : cfg['claimed_listings.sending_enabled'] === true ? 'on' : 'claimed_listings.sending_enabled is off');

    // 2. Cohort + approved template versions.
    const cohort = cohortId ? (await runner.query(`SELECT * FROM listing_outreach_cohorts WHERE id = $1`, [cohortId])).rows[0] : null;
    const member = cohort ? (await runner.query(
      `SELECT * FROM listing_outreach_cohort_members WHERE cohort_id = $1 AND organization_id = $2`, [cohortId, organizationId])).rows[0] : null;
    const cohortLive = !!cohort && ['approved', 'active'].includes(cohort.status) && !!cohort.approved_by
      && (!cohort.expires_at || new Date(cohort.expires_at) > now);
    let templatesOk = false;
    let tplDetail = 'no template bound';
    if (cohort) {
      const ids = Object.values(cohort.template_versions || {});
      const need = stepKey ? [cohort.template_versions[stepKey]] : ids;
      const approved = ids.length ? (await runner.query(
        `SELECT id FROM listing_outreach_templates WHERE id = ANY($1::uuid[]) AND status = 'approved'`, [ids])).rows.map((r) => r.id) : [];
      templatesOk = need.length > 0 && need.every((id) => id && approved.includes(id));
      tplDetail = templatesOk ? 'approved' : 'template for ' + (stepKey || 'the sequence') + ' is not an approved version';
    }
    add('cohort', cohortLive && !!member && templatesOk,
      !cohort ? 'not in a cohort' : !cohortLive ? 'cohort is ' + cohort.status + (cohort.approved_by ? '' : ' (not approved)') : !member ? 'not a member of this cohort' : tplDetail);

    // 3. Eligibility re-screen (a live sequence may continue while no stop condition applies).
    let d;
    if (shared.ctx) {
      const ent = shared.ctx.listings.find((e) => e.entity_id === String(organizationId));
      d = ent ? eligibility.decide(ent, shared.ctx) : { decision: null, reason: 'not a directory listing' };
    } else {
      d = await eligibility.rescreen(organizationId, runner);
    }
    const midSequence = sequence && ['active', 'queued'].includes(sequence.state) && d.decision === 'EXCLUDE_RECENT_OUTREACH';
    add('eligibility', d.decision === eligibility.DECISIONS.ELIGIBLE || midSequence, d.decision ? d.decision + ': ' + d.reason : d.reason, !d.error);

    // 4. Journey.
    const snap = (shared.ctx && shared.ctx.snap) || (await identity.snapshot(runner));
    const cluster = snap.clusterFor('organization', String(organizationId));
    add('journey', cluster && cluster.journey === 'CLAIMED_LISTING', cluster ? 'journey ' + (cluster.journey || 'none') : 'no company record', true);

    // 5. Contact lock.
    const companyId = cluster ? cluster.companyId : null;
    const lock = companyId ? (await runner.query(`SELECT * FROM company_contact_locks WHERE company_id = $1 AND expires_at > now()`, [companyId])).rows[0] : null;
    const lockOk = !lock || (lock.holder_type === 'system' && sequence && lock.sequence_id === sequence.id);
    add('lock', lockOk, lock ? (lock.holder_type === 'user' ? 'a team member holds the contact lock' : 'held by another sequence') : 'free');

    // 6. Caps.
    const globalCap = Number(cfg['claimed_listings.daily_cap']) || 10;
    const spacing = Number(cfg['claimed_listings.min_send_spacing_seconds']) || 90;
    const counts = (await runner.query(
      `SELECT count(*) FILTER (WHERE sent_at > now() - interval '24 hours')::int AS global_24h,
              count(*) FILTER (WHERE sent_at > now() - interval '24 hours' AND sequence_id IN (SELECT id FROM listing_outreach_sequences WHERE cohort_id = $1))::int AS cohort_24h,
              count(*) FILTER (WHERE sent_at > now() - interval '24 hours' AND split_part(recipient_email_normalized,'@',2) = $2)::int AS domain_24h,
              max(sent_at) AS last_sent
         FROM listing_outreach_messages WHERE direction = 'outbound' AND status = 'sent'`,
      [cohortId || null, String(recipientEmail || '').toLowerCase().split('@')[1] || ''])).rows[0] || {};
    const capIssues = [];
    if (cohort && cohort.sends_used >= cohort.max_sends) capIssues.push('cohort max_sends reached');
    if (cohort && counts.cohort_24h >= cohort.daily_cap) capIssues.push('cohort daily cap reached');
    if (counts.global_24h >= globalCap) capIssues.push('global daily cap reached');
    if (counts.domain_24h >= 1) capIssues.push('one message per recipient domain per 24h');
    if (counts.last_sent && (now.getTime() - new Date(counts.last_sent).getTime()) < spacing * 1000) capIssues.push('minimum ' + spacing + 's spacing');
    add('caps', capIssues.length === 0, capIssues.length ? capIssues.join('; ') : 'within caps');

    // 7. Send window.
    const org = (await runner.query(`SELECT state FROM organizations WHERE id = $1`, [organizationId])).rows[0] || {};
    const w = inWindow(now, org.state, cfg['claimed_listings.send_window'] || undefined);
    add('window', w.ok, (w.ok ? 'inside' : 'outside') + ' the send window (' + w.tz + ')');

    // 8. Stream health.
    const h = await streamHealth(runner, cfg['claimed_listings.health']);
    add('health', h.ok, JSON.stringify(h));

    // 9. Config present.
    const missing = [];
    if (!emailService.claimedListingConfigurationSet()) missing.push('SES configuration set (SES_CLAIMED_LISTING_CONFIGURATION_SET)');
    const from = String(cfg['claimed_listings.from_address'] || '').toLowerCase();
    const verifiedDomain = String(emailService.EMAIL_FROM || '').split('@')[1] || '';
    if (!from || !verifiedDomain || !from.endsWith('@' + verifiedDomain.toLowerCase())) missing.push('From identity on the verified domain');
    if (!String(cfg['company.postal_address'] || '').trim()) missing.push('postal address (company.postal_address)');
    if (!unsub.configured()) missing.push('unsubscribe secret (LISTING_OUTREACH_UNSUB_SECRET)');
    if (!emailService.isConfigured()) missing.push('email transport');
    if (cohort && !cohort.assigned_rep_user_id) missing.push('assigned rep on the cohort');
    add('config', missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : 'complete');
  } catch (e) {
    add('evaluation', false, 'gate evaluation failed: ' + e.message);
  }
  const allowed = checks.length > 0 && checks.every((c) => c.ok);
  return { allowed, checks, blocked_by: checks.filter((c) => !c.ok).map((c) => c.name), permanent: checks.some((c) => c.permanent) };
}

module.exports = { evaluate, inWindow, localClock, streamHealth, TZ_BY_STATE, DEFAULT_TZ };
