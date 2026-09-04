'use strict';

/**
 * marketingSendService — the marketing email send path. Two entry points:
 *
 *   testSend()      — SAFE internal test. Sends a rendered campaign ONLY to explicitly-provided internal/
 *                     test addresses. Does NOT touch the subscriber audience, does NOT consume campaign
 *                     recipients, does NOT record deliverable/package fulfillment, does NOT pollute
 *                     production metrics or Growth experiments. Audited to marketing_test_sends. This is
 *                     NOT A7 autonomous sending and is allowed while the gate is off.
 *
 *   sendCampaignLive() — the REAL production marketing send. Fully GATED: it refuses unless
 *                     marketing.a7_send_enabled is true (currently false → inert). No bypass. Every
 *                     recipient is re-checked at send time via audienceEligibilityService.
 *
 * All marketing mail uses the dedicated marketing SES stream (separate pool + optional config set) so a
 * marketing burst can never damage transactional deliverability.
 */
const db = require('../db');
const { sendEmail } = require('./emailService');
const audience = require('./audienceEligibilityService');
const marketingConfig = require('./marketingConfigService');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Safe internal TEST send. `rendered` = { subject, html, text, headers }.
 * @param {object} opts { campaignClass, eventKind, eventRef, rendered, toAddresses:[], sentBy }
 */
async function testSend({ campaignClass = 'LOCAL_EVENT_ALERT', eventKind = null, eventRef = null, rendered, toAddresses, sentBy = null } = {}, runner) {
  const r = runner || db;
  const list = Array.isArray(toAddresses) ? toAddresses.map((a) => String(a || '').trim()).filter(Boolean) : [];
  if (!list.length) return { ok: false, reason: 'no_test_addresses' };
  if (list.length > 10) return { ok: false, reason: 'too_many_test_addresses' };   // internal test, not a blast
  if (!list.every((a) => EMAIL_RE.test(a))) return { ok: false, reason: 'invalid_test_address' };
  if (!rendered || !rendered.subject || !rendered.html) return { ok: false, reason: 'nothing_to_send' };

  const subject = `[TEST] ${rendered.subject}`;
  const results = [];
  for (const to of list) {
    try {
      const res = await sendEmail({
        to, subject, html: rendered.html, text: rendered.text,
        headers: rendered.headers, mailStream: 'marketing',
      });
      results.push({ to, ...res });
    } catch (e) { results.push({ to, error: e.message }); }
  }
  // Audit (never consumes subscriber audience or campaign recipients).
  await r.query(
    `INSERT INTO marketing_test_sends (campaign_class, event_kind, event_ref, subject, to_addresses, sent_by, provider_result)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [campaignClass, eventKind, eventRef, subject, list, sentBy, JSON.stringify(results)]).catch(() => {});
  return { ok: true, test: true, sent: results.length, results };
}

/**
 * GATED production marketing send. Refuses unless a7_send_enabled. Provided for completeness/readiness;
 * INERT in this phase. Requires a persisted campaignId + a validated audience spec. Every candidate is
 * re-checked at send time; recipients are idempotent via marketing_campaign_recipients.
 */
async function sendCampaignLive({ campaignId, marketingClass = 'local_event_alert', geoStrategy = null, rendered, buildUnsubscribeUrl } = {}, runner) {
  const enabled = await marketingConfig.a7SendEnabled();
  if (!enabled) {
    const err = new Error('A7 live sending is disabled (marketing.a7_send_enabled=false)');
    err.code = 'A7_DISABLED';
    throw err;
  }
  if (!campaignId) throw new Error('campaignId required for a live send');
  if (!rendered || !rendered.subject || !rendered.html) throw new Error('rendered campaign required');
  const r = runner || db;

  // Candidate universe: permissioned, non-demo contacts (the audience specification, not a raw dump).
  const { rows: candidates } = await r.query(
    `SELECT id, normalized_email, preferred_email, address_state, city, zip, latitude, longitude,
            is_demo, permission_basis, permission_scope
       FROM marketing_contacts
      WHERE is_demo = false AND permission_basis IN ('platform_relationship','explicit_opt_in','follower_optin')`);

  let sent = 0; let skipped = 0;
  for (const contact of candidates) {
    const decision = await audience.evaluateContact({ contact, campaignId, marketingClass, geoStrategy }, r);
    if (!decision.eligible) { skipped++; continue; }
    // Reserve the recipient row FIRST (idempotency); if it already exists, skip.
    const ins = await r.query(
      `INSERT INTO marketing_campaign_recipients (campaign_id, contact_id, status)
       VALUES ($1,$2,'queued') ON CONFLICT (campaign_id, contact_id) DO NOTHING RETURNING id`,
      [campaignId, contact.id]);
    if (!ins.rowCount) { skipped++; continue; }
    const to = contact.preferred_email || contact.normalized_email;
    const unsubUrl = typeof buildUnsubscribeUrl === 'function' ? buildUnsubscribeUrl(contact) : null;
    const headers = Object.assign({}, rendered.headers || {},
      unsubUrl ? { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {});
    try {
      await sendEmail({ to, subject: rendered.subject, html: rendered.html, text: rendered.text, headers, mailStream: 'marketing' });
      await r.query(`UPDATE marketing_campaign_recipients SET status='sent' WHERE campaign_id=$1 AND contact_id=$2`, [campaignId, contact.id]);
      await r.query(`INSERT INTO marketing_email_events (campaign_id, contact_id, normalized_email, event_type) VALUES ($1,$2,$3,'attempted')`, [campaignId, contact.id, contact.normalized_email]).catch(() => {});
      sent++;
    } catch (e) {
      await r.query(`UPDATE marketing_campaign_recipients SET status='failed' WHERE campaign_id=$1 AND contact_id=$2`, [campaignId, contact.id]).catch(() => {});
      skipped++;
    }
  }
  return { ok: true, sent, skipped, candidates: candidates.length };
}

module.exports = { testSend, sendCampaignLive };
