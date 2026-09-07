#!/usr/bin/env node
/**
 * send-owner-alert-test.js — perform the CONTROLLED owner-alert SMS smoke test.
 *
 * Sends ONE clearly-labeled TEST message to OWNER_ALERT_PHONE_E164 through the real ownerAlertService /
 * Twilio transport. Creates NO auction, estate sale, marketing purchase, or financial record. If Twilio /
 * OWNER_ALERT_PHONE_E164 are not configured, it does not send and reports "not configured" (exit 0) — so
 * this is always safe to run. Prints the ALERT TYPE + OUTCOME only — never the phone number or body.
 *
 * Usage:   railway run node scripts/send-owner-alert-test.js ["optional short note"]
 */
const ownerAlerts = require('../src/services/ownerAlertService');

(async () => {
  const note = process.argv.slice(2).join(' ').trim() || 'operational alerts smoke test';
  const configured = ownerAlerts.ownerAlertConfigured();
  console.log('[owner-alert-test] configured (OWNER_ALERT_PHONE_E164 + valid E.164):', configured);
  const result = await ownerAlerts.sendTestAlert({ note });
  console.log('[owner-alert-test] result:', JSON.stringify(result));
  if (result.skipped && result.reason === 'not_configured') {
    console.log('[owner-alert-test] NOT SENT — set Twilio (SID/token + Messaging Service or from-number) and OWNER_ALERT_PHONE_E164S / OWNER_ALERT_PHONE_E164, then re-run.');
  } else if (result.sent > 0) {
    console.log(`[owner-alert-test] SENT — delivered to ${result.sent} of ${result.attempted} configured owner-alert recipient(s). failed=${result.failed || 0}`);
  } else if (result.skipped) {
    console.log(`[owner-alert-test] SKIPPED (${result.reason}) — already delivered to all recipients for this test key.`);
  }
  process.exit(0);
})().catch((e) => { console.error('[owner-alert-test] error:', e.message); process.exit(1); });
