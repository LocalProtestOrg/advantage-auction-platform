'use strict';

/**
 * outreachSendService — the piece the Event Partner programme was missing.
 *
 * Everything else existed: cohorts, approved templates, the four-lock send gate, suppression,
 * authorization tokens, the public authorization page. Nothing actually SENT the invitation, so the
 * programme could never leave the building.
 *
 * WHAT ONE SEND INVOLVES, in this order, failing closed at every step:
 *
 *   1. relationship segmentation — the company must be ELIGIBLE_UNAFFILIATED. A claimed listing, an
 *      existing partner, a Professional Seller, a suppressed address or an ambiguous identity stops
 *      here and is never emailed.
 *   2. an organization record to scope the authorization to (created unpublished — a prospect must
 *      never appear in the public professionals directory just because we wrote to them).
 *   3. an invitation + a cryptographic authorization token bound to THIS company and THIS recipient.
 *   4. cohortService.evaluateSend — the Owner's gate, checked at SEND time, not queue time.
 *   5. delivery through the Event Partner SES stream, which carries its own configuration set so the
 *      programme's reputation is isolated from bids, invoices and password resets.
 *
 * The cohort's `max_sends` is the hard ceiling. It is enforced by the gate, and again here, so a
 * caller cannot loop past it.
 */

const db = require('../../db');
const configService = require('../configService');
const emailService = require('../emailService');
const auditService = require('../auditService');
const { normalizeEmail } = require('../../lib/emailNormalize');
const cohortService = require('./cohortService');
const authorizationService = require('./authorizationService');
const segmentation = require('./relationshipSegmentationService');

const PUBLIC_BASE = 'https://bid.advantage.bid';

/** Slug for an organization created from a prospect. Stable and collision-resistant enough. */
function slugFor(name, domain) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  const suffix = String(domain || '').replace(/[^a-z0-9]/g, '').slice(0, 10);
  return (base || 'partner') + (suffix ? '-' + suffix : '');
}

/**
 * The organization an authorization hangs off. Created UNPUBLISHED and unverified: writing to a
 * company is not a claim that it is a verified Advantage.Bid professional, and it must not surface
 * in the public directory (which requires profile_data->>'published' = 'true').
 */
async function ensureOrganizationForProspect(prospect, runner = db) {
  const domain = segmentation.rootDomain(prospect.website || prospect.website_domain);
  if (!domain) return { ok: false, reason: 'no company website domain — cannot scope an authorization' };

  const existing = (await runner.query(
    `SELECT id, name, bd_listing_id, source FROM organizations
      WHERE lower(regexp_replace(COALESCE(website_url,''), '^https?://(www\\.)?', '')) LIKE $1
         OR lower(name) = lower($2) LIMIT 1`, [domain + '%', prospect.company_name])).rows[0];
  if (existing) {
    // Journey lock (migration 169): a directory listing belongs to the Claimed Listing journey. Attaching
    // an Event Partner invitation to it would make it token-only claimable by a cold invitation — the
    // collision the Owner prohibited. Refuse unless the company has ALREADY entered Event Partner.
    // Fails closed: if the journey cannot be determined, refuse.
    if (existing.bd_listing_id || existing.source === 'bd_import') {
      let journey = null;
      try {
        const snap = await require('../acquisition/companyIdentityService').snapshot(runner);
        const c = snap.clusterFor('organization', String(existing.id));
        journey = c ? c.journey : null;
      } catch (e) { journey = 'UNKNOWN'; }
      if (journey !== 'EVENT_PARTNER') {
        return { ok: false, code: 'LISTING_JOURNEY',
          reason: existing.name + ' is a directory listing in the Claimed Listing journey; it cannot receive a cold Event Partner invitation' };
      }
    }
    return { ok: true, organizationId: existing.id, created: false };
  }

  const slug = slugFor(prospect.company_name, domain);
  const row = (await runner.query(
    `INSERT INTO organizations (name, slug, website_url, contact_email, contact_phone,
        verification_status, profile_data)
     VALUES ($1,$2,$3,$4,$5,'unverified',$6::jsonb)
     ON CONFLICT (slug) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [prospect.company_name, slug, 'https://' + domain, prospect.business_email || null,
     prospect.business_phone || null,
     // published:false is the important part — an outreach prospect is not a directory listing.
     JSON.stringify({ published: false, source: 'event_partner_outreach_prospect' })])).rows[0];
  return { ok: true, organizationId: row.id, created: true };
}

/** Render the approved template. Only these placeholders exist; anything else stays literal. */
function render(template, vars) {
  const fill = (s) => String(s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
    (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  return { subject: fill(template.subject), text: fill(template.body_text), html: fill(template.body_html) };
}

/**
 * Send one invitation. Returns a structured outcome; never throws into a batch.
 * `dryRun` performs every check and renders the message but does not contact the provider.
 */
async function sendOne({ cohortId, prospect, actorId = null, dryRun = false, runner = db } = {}) {
  const outcome = { company: prospect.company_name, email: prospect.business_email, steps: {} };
  try {
    // 1. Relationship segmentation — the hard requirement.
    const decision = await segmentation.resolve(prospect, {}, runner);
    outcome.decision = decision.decision;
    outcome.decision_reason = decision.reason;
    if (decision.decision !== segmentation.DECISIONS.ELIGIBLE) {
      outcome.sent = false; outcome.skipped = decision.decision;
      return outcome;
    }
    outcome.steps.segmentation = 'ELIGIBLE_UNAFFILIATED';

    // 2. The Owner's send gate, BEFORE anything is written. A dry run must never create records,
    //    and a blocked send must not leave an invitation behind.
    const gate = await cohortService.evaluateSend({
      cohortId, recipientEmail: prospect.business_email }, runner);
    outcome.gate = { allowed: gate.allowed, blocked_by: gate.blockedBy || gate.blocked_by || [] };
    if (!gate.allowed) { outcome.sent = false; outcome.skipped = 'GATE_BLOCKED'; return outcome; }

    // 3. Render from the APPROVED template version (still no writes).
    const cohort = await cohortService.getCohort(cohortId, runner);
    const tpl = (await runner.query('SELECT * FROM event_partner_templates WHERE id = $1', [cohort.template_id])).rows[0];
    if (!tpl || tpl.status !== 'approved') { outcome.sent = false; outcome.skipped = 'TEMPLATE_NOT_APPROVED'; return outcome; }
    outcome.template = tpl.template_key + ' v' + tpl.version;

    if (dryRun) {
      const preview = render(tpl, { company: prospect.company_name, authorize_url: PUBLIC_BASE + '/authorize-event-promotion.html?token=<issued at send>' });
      outcome.sent = false; outcome.dry_run = true; outcome.subject = preview.subject;
      outcome.preview_text = preview.text;
      return outcome;
    }

    // 4. Organization scope (unpublished) — only now, when a real send is going to happen.
    const org = await ensureOrganizationForProspect(prospect, runner);
    if (!org.ok) { outcome.sent = false; outcome.skipped = 'NO_ORG_SCOPE'; outcome.error = org.reason; return outcome; }
    outcome.organization_id = org.organizationId;
    outcome.steps.organization = org.created ? 'created (unpublished)' : 'existing';

    // 5. Invitation + authorization token bound to this company and recipient.
    let authorization;
    try {
      authorization = await authorizationService.createInvitation({
        organizationId: org.organizationId, companyName: prospect.company_name,
        domain: segmentation.rootDomain(prospect.website || prospect.website_domain),
        invitedEmail: prospect.business_email, actorId,
        notes: 'first Event Partner outreach cohort',
      });
    } catch (e) {
      if (e.code === 'ALREADY_REGISTERED') { outcome.sent = false; outcome.skipped = 'ALREADY_REGISTERED'; return outcome; }
      throw e;
    }
    outcome.authorization_id = authorization.id;

    const token = await authorizationService.issueAuthorizationToken(authorization.id, {
      purpose: 'authorize', recipientEmail: prospect.business_email, actorId });
    const rawToken = token.token || token.raw_token || token.value;
    if (!rawToken) { outcome.sent = false; outcome.skipped = 'NO_TOKEN'; return outcome; }
    const link = PUBLIC_BASE + '/authorize-event-promotion.html?token=' + encodeURIComponent(rawToken);
    outcome.steps.token = 'issued';
    const msg = render(tpl, { company: prospect.company_name, authorize_url: link });
    outcome.subject = msg.subject;

    // 6. Deliver on the Event Partner stream.
    const fromAddress = await configService.get(null, 'event_partners.from_address');
    const send = await emailService.sendEmail({
      to: prospect.business_email, subject: msg.subject, html: msg.html, text: msg.text,
      mailStream: 'event_partner',
      ...(fromAddress ? { fromAddress } : {}),
    });
    outcome.provider_accepted = !!(send && (send.messageId || send.ok !== false));
    outcome.provider_message_id = (send && send.messageId) || null;

    if (outcome.provider_accepted) {
      await runner.query(
        `UPDATE event_partner_cohort_members SET status='sent', sent_at=now(), updated_at=now()
          WHERE cohort_id=$1 AND recipient_email_normalized=$2`,
        [cohortId, normalizeEmail(prospect.business_email)]);
      await runner.query(
        `UPDATE event_partner_cohorts SET sends_used = sends_used + 1, updated_at=now() WHERE id=$1`, [cohortId]);
      await runner.query(
        `UPDATE sales_prospects SET contact_status='contacted', last_contact_at=now(), updated_at=now() WHERE id=$1`,
        [prospect.id]).catch(() => {});
      await auditService.logEvent(runner, {
        eventType: 'event_partner.outreach_sent', entityType: 'authorized_event_source',
        entityId: authorization.id, actorId,
        metadata: { cohort_id: cohortId, company: prospect.company_name, template: outcome.template,
          provider_message_id: outcome.provider_message_id },
      }).catch(() => {});
    }
    outcome.sent = outcome.provider_accepted;
    return outcome;
  } catch (e) {
    outcome.sent = false; outcome.error = e.message;
    return outcome;
  }
}

/**
 * Send a bounded batch. `max` is a hard stop that is checked before every send, so the cohort
 * ceiling cannot be exceeded by a retry, a duplicate prospect, or a caller looping.
 */
async function sendCohort({ cohortId, prospects, max, actorId = null, dryRun = false, runner = db } = {}) {
  const cohort = await cohortService.getCohort(cohortId, runner);
  if (!cohort) return { ok: false, reason: 'unknown cohort' };
  const ceiling = Math.min(Number(max) || 0, Number(cohort.max_sends) || 0);
  const results = [];
  let sent = 0;
  for (const p of prospects) {
    if (sent >= ceiling) { results.push({ company: p.company_name, sent: false, skipped: 'COHORT_CEILING_REACHED' }); continue; }
    const r = await sendOne({ cohortId, prospect: p, actorId, dryRun, runner });
    results.push(r);
    if (r.sent) sent += 1;
  }
  return { ok: true, ceiling, attempted: results.filter((r) => !r.skipped || r.skipped === 'GATE_BLOCKED').length,
    sent, results };
}

module.exports = { slugFor, ensureOrganizationForProspect, render, sendOne, sendCohort, PUBLIC_BASE };
