'use strict';

/**
 * outreachSender — builds and (only when every gate passes) sends one Claimed Listing message.
 *
 * One send, in order, failing closed at every step:
 *   1 idempotency   a message row keyed org:cycle:step is claimed first; a repeat is a no-op
 *   2 gate          sendGate.evaluate (all nine locks) — at SEND time
 *   3 token         a NEW claim link bound to the listing's published address (invalidates the previous one)
 *   4 render        the APPROVED template version bound to the cohort; unknown variables, foreign links,
 *                   em dashes or a missing postal address abort the send
 *   5 deliver       SES on the claimed_listing stream (own configuration set), From listings@, Reply-To on
 *                   the reply subdomain, RFC 8058 one-click List-Unsubscribe, no tracking pixel
 *   6 record        message sent + SES id, funnel `sent`, sequence advanced, cohort sends_used
 * A provider error marks the message failed and schedules a retry with backoff; a step is never skipped.
 *
 * `shadow: true` runs steps 2 and 4 with a placeholder link and records NOTHING and sends NOTHING.
 */

const crypto = require('crypto');
const db = require('../../db');
const emailService = require('../emailService');
const auditService = require('../auditService');
const { normalizeEmail } = require('../../lib/emailNormalize');
const unsub = require('../../lib/listingUnsubscribeToken');
const templates = require('./templates');
const sendGate = require('./sendGate');
const claimLinks = require('./claimLinkService');
const events = require('./claimEvents');
const listingContext = require('./listingContext');

const PUBLIC_BASE = 'https://bid.advantage.bid';
const REPLY_DOMAIN = (process.env.LISTING_REPLY_DOMAIN || process.env.EVENT_PARTNER_REPLY_DOMAIN || 'reply.advantage.bid').toLowerCase();
const REPLY_MAILBOX = (process.env.LISTING_REPLY_MAILBOX || 'listings').toLowerCase();
const RETRY_MINUTES = [15, 60, 240, 1440];

/** Listing reply keys are 'l' + 24 hex: never confusable with an Event Partner key (24 hex, no prefix). */
const mintReplyKey = () => 'l' + crypto.randomBytes(12).toString('hex');
const replyAddressFor = (key) => `${REPLY_MAILBOX}+${key}@${REPLY_DOMAIN}`;
const LISTING_REPLY_KEY_RE = /^l[0-9a-f]{24}$/;

function areaFor(org) {
  const st = listingContext.usStateCode(org.state);
  const market = require('./scoringService').strategicMarket(org);
  if (market === 'houston') return 'the Houston area';
  if (market === 'ny_tristate') return 'the New York area';
  return st ? listingContext.US_STATES[st].replace(/\b\w/g, (c) => c.toUpperCase()) : 'your area';
}

function thirdBullet(org) {
  const prof = org.bd_metadata && String(org.bd_metadata.profession_id || '');
  if (prof === '5') return 'list your appraisal specialties and service area so people can find you';
  if (prof === '3') return 'post your upcoming auctions so local bidders can find them';
  return 'post your upcoming estate sales and auctions so local buyers can find them';
}

function directoryUrl(org) {
  // Same rule as the marketplace cards: the synced directory slug, rejected when malformed.
  const p = String((org.bd_metadata && org.bd_metadata.bd_profile_path) || '').trim().replace(/^\/+/, '');
  if (p && !/[<>"'\\\s]/.test(p) && !/^https?:/i.test(p)) return 'https://www.advantage.bid/' + p.split('/').map(encodeURIComponent).join('/');
  return PUBLIC_BASE + '/claim-listing.html?org=' + org.id;
}

async function repFor(cohort, runner) {
  if (!cohort || !cohort.assigned_rep_user_id) return null;
  return (await runner.query(
    `SELECT p.display_name, p.outreach_email FROM sales_rep_profiles p WHERE p.user_id = $1 AND p.outreach_enabled = true`,
    [cohort.assigned_rep_user_id])).rows[0] || null;
}

/** Variables for a listing message. `claimLink` / `unsubLink` are the real ones or shadow placeholders. */
function variablesFor(org, { rep, claimLink, optionsLink, unsubLink, postalAddress, recipient, cohortKey, templateKey, version }) {
  const [first, ...rest] = String((rep && rep.display_name) || 'The Advantage.Bid team').split(' ');
  const utm = 'utm_source=advantage_bid&utm_medium=email&utm_campaign=claimed_listing_' + cohortKey + '&utm_content=' + templateKey + '_v' + version;
  const withUtm = (u) => u + (u.indexOf('?') >= 0 ? '&' : '?') + utm;
  return {
    greeting: 'Hello', company: org.name, area: areaFor(org), city: org.city || 'local', state: org.state || '',
    phone: org.contact_phone || 'not listed', website_or_none_listed: org.website_url || 'none listed', no_website: !org.website_url,
    listing_url: withUtm(directoryUrl(org)), claim_link: withUtm(claimLink), listing_options_link: optionsLink,
    unsubscribe_link: unsubLink, recipient_email: recipient, postal_address: postalAddress, third_bullet: thirdBullet(org),
    rep_first_name: first, rep_full_name: [first].concat(rest).join(' '),
  };
}

async function loadOrg(organizationId, runner) {
  return (await runner.query(
    `SELECT id, name, city, state, lat, lng, contact_email, contact_phone, website_url, bd_metadata FROM organizations WHERE id = $1`,
    [organizationId])).rows[0] || null;
}

/**
 * Send (or shadow-render) the message for `stepKey` of a sequence.
 * Returns { sent, shadow, gate, subject, preview, error, reason }.
 */
async function sendStep({ sequence, stepKey, stepNo, shadow = false, now = new Date(), shared = {} }, runner = db) {
  const org = await loadOrg(sequence.organization_id, runner);
  if (!org) return { sent: false, reason: 'listing not found' };
  const recipient = normalizeEmail(org.contact_email || '');
  const cohort = sequence.cohort_id ? (await runner.query(`SELECT * FROM listing_outreach_cohorts WHERE id = $1`, [sequence.cohort_id])).rows[0] : null;
  const gate = await sendGate.evaluate({ organizationId: org.id, sequence: sequence.id ? sequence : null, cohortId: sequence.cohort_id,
    recipientEmail: recipient, now, stepKey }, runner, shared);
  const templateId = cohort && cohort.template_versions ? cohort.template_versions[stepKey] : null;
  const tpl = templateId ? (await runner.query(`SELECT * FROM listing_outreach_templates WHERE id = $1`, [templateId])).rows[0] : null;
  const postal = String(((await runner.query(`SELECT value FROM platform_config WHERE key = 'company.postal_address'`)).rows[0] || {}).value || '').trim();
  const rep = await repFor(cohort, runner);
  const cohortKey = cohort ? String(cohort.name || cohort.id).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) : 'none';

  if (shadow) {
    // Render with placeholders so the Owner can read exactly what would go out. Nothing is written or sent.
    let preview = null; let renderError = null;
    const src = tpl || Object.assign({ template_key: stepKey, version: 0 }, (() => { const c = templates.CATALOGUE[stepKey]; return c ? { subject: c.subject, preheader: c.preheader, body_text: c.text, stream: c.stream } : null; })());
    try {
      const v = variablesFor(org, { rep, claimLink: PUBLIC_BASE + '/claim/SHADOW-TOKEN', optionsLink: PUBLIC_BASE + '/claim/SHADOW-TOKEN#options',
        unsubLink: PUBLIC_BASE + '/api/public/listing-outreach/unsubscribe?t=SHADOW', postalAddress: postal || '[postal address required]',
        recipient: claimLinks.maskEmail(recipient), cohortKey, templateKey: stepKey, version: src.version || 0 });
      preview = templates.render(src, v);
    } catch (e) { renderError = e.message; }
    return { sent: false, shadow: true, gate, template: tpl ? stepKey + ' v' + tpl.version + ' (' + tpl.status + ')' : stepKey + ' (catalogue draft)',
      subject: preview && preview.subject, preview: preview && preview.text, render_error: renderError };
  }

  if (!gate.allowed) return { sent: false, gate, reason: 'gate: ' + gate.blocked_by.join(', ') };
  if (!tpl || tpl.status !== 'approved') return { sent: false, gate, reason: 'template not approved' };

  // 1. Idempotency: claim the (org, cycle, step) slot before anything else.
  const idem = org.id + ':' + sequence.cycle_no + ':' + stepNo;
  const replyKey = mintReplyKey();
  const slot = (await runner.query(
    `INSERT INTO listing_outreach_messages (sequence_id, organization_id, company_id, direction, template_key, template_version,
        recipient_email_normalized, status, idempotency_key, reply_key)
     VALUES ($1,$2,$3,'outbound',$4,$5,$6,'queued',$7,$8)
     ON CONFLICT (idempotency_key) DO UPDATE SET status = 'queued'   -- keeps the error text (a prior soft bounce stays visible)
       WHERE listing_outreach_messages.status = 'failed'
     RETURNING id, reply_key`,
    [sequence.id, org.id, sequence.company_id, tpl.template_key, tpl.version, recipient, idem, replyKey])).rows[0];
  if (!slot) return { sent: false, gate, reason: 'already sent or in flight (idempotent)' };

  try {
    // 3. A new claim link (invalidates the previous one).
    const issued = await claimLinks.issueToken(org.id, { channel: 'outreach', reason: 'listing outreach ' + stepKey }, runner);
    const claimLink = PUBLIC_BASE + '/claim/' + encodeURIComponent(issued.token);
    const unsubToken = unsub.sign({ email: recipient, organizationId: org.id });
    const unsubLink = PUBLIC_BASE + '/api/public/listing-outreach/unsubscribe?t=' + encodeURIComponent(unsubToken);
    const v = variablesFor(org, { rep, claimLink, optionsLink: PUBLIC_BASE + '/claim/' + encodeURIComponent(issued.token) + '#options',
      unsubLink, postalAddress: postal, recipient, cohortKey, templateKey: tpl.template_key, version: tpl.version });
    const msg = templates.render(tpl, v);
    const cfg = (await runner.query(`SELECT key, value FROM platform_config WHERE key IN ('claimed_listings.from_address','claimed_listings.from_name')`)).rows
      .reduce((m, r) => { m[r.key] = r.value; return m; }, {});

    // 5. Deliver.
    const res = await emailService.sendEmail({
      to: recipient, subject: msg.subject, html: msg.html, text: msg.text, mailStream: 'claimed_listing',
      fromAddress: cfg['claimed_listings.from_address'], fromName: cfg['claimed_listings.from_name'],
      replyTo: replyAddressFor(slot.reply_key),
      headers: { 'List-Unsubscribe': '<' + unsubLink + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    if (!res || res.skipped || !res.messageId) throw new Error(res && res.skipped ? 'email transport not configured' : 'provider did not accept the message');
    const sesId = String(res.messageId).replace(/^</, '').replace(/>$/, '').split('@')[0];

    // 6. Record.
    await runner.query(
      `UPDATE listing_outreach_messages SET status = 'sent', token_id = $2, ses_message_id = $3, subject = $4, body_text = $5, body_html = $6, sent_at = now()
        WHERE id = $1`, [slot.id, issued.tokenId, sesId, msg.subject, msg.text, msg.html]);
    if (cohort) await runner.query(`UPDATE listing_outreach_cohorts SET sends_used = sends_used + 1, status = 'active', updated_at = now() WHERE id = $1`, [cohort.id]);
    await events.record('sent', { organizationId: org.id, companyId: sequence.company_id, sequenceId: sequence.id, messageId: slot.id,
      tokenId: issued.tokenId, email: recipient, meta: { template: tpl.template_key + ' v' + tpl.version }, idempotencyKey: 'sent:' + slot.id }, runner);
    await auditService.logEvent(runner, { eventType: 'claimed_listing.outreach_sent', entityType: 'organization', entityId: org.id, actorId: null,
      metadata: { sequence_id: sequence.id, step: stepKey, template_version: tpl.version, ses_message_id: sesId } }).catch(() => {});
    return { sent: true, gate, messageId: slot.id, sesMessageId: sesId };
  } catch (e) {
    await runner.query(`UPDATE listing_outreach_messages SET status = 'failed', error = $2 WHERE id = $1`, [slot.id, String(e.message).slice(0, 500)]);
    return { sent: false, gate, error: e.message, retryInMinutes: RETRY_MINUTES[Math.min((sequence.retry_count || 0), RETRY_MINUTES.length - 1)] };
  }
}

/**
 * CL_SELF_REQUEST: the visitor asked for a claim link to the address on the listing. Sends only with an
 * APPROVED template, the email transport and the claimed_listing configuration set in place.
 */
async function sendSelfRequest({ organizationId }, runner = db) {
  const tpl = (await runner.query(
    `SELECT * FROM listing_outreach_templates WHERE template_key = 'CL_SELF_REQUEST' AND status = 'approved' ORDER BY version DESC LIMIT 1`)).rows[0];
  if (!tpl) return { sent: false, reason: 'no approved CL_SELF_REQUEST template' };
  if (!emailService.isConfigured() || !emailService.claimedListingConfigurationSet()) return { sent: false, reason: 'claimed_listing stream not configured' };
  const org = await loadOrg(organizationId, runner);
  const recipient = normalizeEmail((org && org.contact_email) || '');
  if (!recipient) return { sent: false, reason: 'no address' };
  const issued = await claimLinks.issueToken(org.id, { channel: 'self_request', reason: 'self-service claim request' }, runner);
  const v = { company: org.name, claim_link: PUBLIC_BASE + '/claim/' + encodeURIComponent(issued.token)
    + '?utm_source=directory&utm_medium=listing&utm_campaign=claim_button&utm_content=CL_SELF_REQUEST_v' + tpl.version };
  const msg = templates.render(tpl, v);
  const cfg = (await runner.query(`SELECT key, value FROM platform_config WHERE key IN ('claimed_listings.from_address','claimed_listings.from_name')`)).rows
    .reduce((m, r) => { m[r.key] = r.value; return m; }, {});
  const res = await emailService.sendEmail({ to: recipient, subject: msg.subject, html: msg.html, text: msg.text, mailStream: 'claimed_listing',
    fromAddress: cfg['claimed_listings.from_address'], fromName: cfg['claimed_listings.from_name'] });
  if (!res || res.skipped || !res.messageId) return { sent: false, reason: 'provider did not accept the message' };
  await runner.query(
    `INSERT INTO listing_outreach_messages (organization_id, direction, template_key, template_version, token_id, ses_message_id,
       recipient_email_normalized, status, subject, body_text, sent_at)
     VALUES ($1,'outbound','CL_SELF_REQUEST',$2,$3,$4,$5,'sent',$6,$7, now())`,
    [org.id, tpl.version, issued.tokenId, String(res.messageId).replace(/^</, '').replace(/>$/, '').split('@')[0], recipient, msg.subject, msg.text]);
  return { sent: true };
}

module.exports = { sendStep, sendSelfRequest, variablesFor, mintReplyKey, replyAddressFor, LISTING_REPLY_KEY_RE, directoryUrl, areaFor, thirdBullet, RETRY_MINUTES };
