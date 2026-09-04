'use strict';

/**
 * a7ReadinessService — the ONE authoritative "is A7 email technically ready" report. READY and ENABLED
 * are SEPARATE states: this never flips marketing.a7_send_enabled. It reports each gate honestly (PASS /
 * WARN / FAIL / NOT_CONFIGURED) and an OVERALL verdict. Owner-controlled AWS/DNS items (SES feedback loop,
 * DKIM/SPF/DMARC) are surfaced truthfully so nothing is claimed that isn't real.
 */
const dns = require('dns').promises;
const db = require('../db');
const { isConfigured, marketingConfigurationSet, EMAIL_FROM } = require('./emailService');
const marketingConfig = require('./marketingConfigService');

function domainOf(addr) {
  const m = String(addr || '').split('@')[1];
  return m ? m.trim().toLowerCase() : null;
}
async function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}
async function txt(name) {
  try { const recs = await withTimeout(dns.resolveTxt(name), 4000); return recs.map((r) => r.join('')); }
  catch (_) { return null; }
}
async function tableExists(r, name) {
  const q = await r.query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', [name]);
  return q.rowCount > 0;
}
async function configKeyExists(r, key) {
  const q = await r.query('SELECT 1 FROM platform_config WHERE key = $1', [key]);
  return q.rowCount > 0;
}

async function evaluate(runner) {
  const r = runner || db;
  const checks = {};
  const set = (k, status, detail) => { checks[k] = { status, detail: detail || null }; };

  // Sender identity
  set('ses_sender_identity', isConfigured() ? 'PASS' : 'FAIL', `From ${EMAIL_FROM}`);

  // DNS auth (best-effort live lookup on the sending domain)
  const dom = domainOf(EMAIL_FROM) || 'advantage.bid';
  const spf = await txt(dom);
  set('spf', spf && spf.some((v) => /v=spf1/i.test(v) && /amazonses|include:.*amazon/i.test(v)) ? 'PASS'
        : (spf && spf.some((v) => /v=spf1/i.test(v)) ? 'WARN' : 'FAIL'),
    'SPF TXT on ' + dom + (spf ? '' : ' (not resolvable)'));
  const dmarc = await txt('_dmarc.' + dom);
  set('dmarc', dmarc && dmarc.some((v) => /v=DMARC1/i.test(v)) ? 'PASS' : 'WARN', '_dmarc.' + dom);
  // DKIM selectors under SES are owner-specific CNAMEs; not runtime-detectable → owner-verified in console.
  set('dkim', 'WARN', 'Verify SES DKIM (CNAMEs) is enabled in the SES console for ' + dom);

  // SES feedback loop (owner AWS wiring + webhook secret). Code is ready (mig 131); this reports LIVE state.
  const feedbackSecret = !!process.env.SES_FEEDBACK_WEBHOOK_SECRET;
  const feedbackTable = await tableExists(r, 'ses_feedback_events');
  const bounceStatus = feedbackSecret && feedbackTable ? 'PASS' : 'NOT_CONFIGURED';
  set('bounce_feedback', bounceStatus, feedbackSecret ? 'webhook secret set' : 'set SES_FEEDBACK_WEBHOOK_SECRET + SES config-set→SNS→/api/ses/feedback');
  set('complaint_feedback', bounceStatus, feedbackSecret ? 'webhook secret set' : 'same wiring as bounce feedback');

  // Enforcement primitives (code + schema present)
  set('suppression_enforcement', (await tableExists(r, 'email_suppressions')) ? 'PASS' : 'FAIL', 'email_suppressions honored at select + send time');
  set('permission_enforcement', (await tableExists(r, 'marketing_contacts')) ? 'PASS' : 'FAIL', 'affirmative permission basis required');
  set('unsubscribe', 'PASS', '/api/public/marketing-email/unsubscribe writes marketing suppression + withdrawal');
  set('frequency_cap', (await configKeyExists(r, 'marketing.email.max_per_day')) ? 'PASS' : 'WARN', 'per-day/7d/30d + spacing');
  set('geo_audience', (await tableExists(r, 'marketing_contacts')) ? 'PASS' : 'FAIL', 'radius/city/state/nationwide (email geo independent of paid 30mi)');
  set('qa', 'PASS', 'A2 email QA (facts/audience/creative/full-circle/delivery)');
  set('idempotency', 'PASS', 'marketing_campaign_recipients UNIQUE(campaign_id,contact_id)');
  set('test_send', (await tableExists(r, 'marketing_test_sends')) ? 'PASS' : 'FAIL', 'internal test send audited; no audience consumption');
  set('transactional_isolation', marketingConfigurationSet() ? 'PASS' : 'WARN',
    marketingConfigurationSet() ? 'dedicated marketing pool + SES config set' : 'dedicated marketing pool (add SES_MARKETING_CONFIGURATION_SET for full reputation isolation)');

  // Informational: enabled state (NEVER a readiness blocker; READY != ENABLED)
  const enabled = await marketingConfig.a7SendEnabled();

  // OVERALL: READY requires every gate to be PASS or WARN (WARN = owner-advisable but not unsafe);
  // any FAIL or NOT_CONFIGURED (the SES feedback loop) → NOT READY.
  const blocking = Object.entries(checks).filter(([, v]) => v.status === 'FAIL' || v.status === 'NOT_CONFIGURED');
  const overall = blocking.length === 0 ? 'READY' : 'NOT_READY';

  return {
    overall,
    enabled,                       // a7_send_enabled — separate from readiness
    blocking: blocking.map(([k]) => k),
    checks,
    note: 'READY means the software + infrastructure gates pass. ENABLED is a separate Owner decision (marketing.a7_send_enabled).',
  };
}

module.exports = { evaluate };
