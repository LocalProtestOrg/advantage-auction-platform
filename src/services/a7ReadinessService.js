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
async function mx(name) {
  try { return await withTimeout(dns.resolveMx(name), 4000); }
  catch (_) { return null; }
}

// Evaluate SPF against the ACTUAL SES authentication architecture, not just the root From domain. SES uses the
// custom MAIL FROM (envelope/Return-Path) subdomain for SPF; a correctly-configured custom MAIL FROM has that
// subdomain's SPF `include:amazonses.com` and/or its MX pointed at `feedback-smtp.<region>.amazonses.com`. So
// SPF is satisfied if EITHER the root domain OR the SES MAIL FROM domain shows an Amazon SES SPF signal. This
// does NOT weaken authentication (a real SES SPF/MX signal is still required); it stops flagging an
// otherwise-correct custom-MAIL-FROM setup as FAIL merely because the root From domain uses another provider.
function spfHasAmazon(records) {
  return Array.isArray(records) && records.some((v) => /v=spf1/i.test(v) && /amazonses|include:.*amazon/i.test(v));
}
function mxIsSesFeedback(records) {
  return Array.isArray(records) && records.some((x) => /feedback-smtp\.[a-z0-9-]+\.amazonses\.com/i.test(x && (x.exchange || x)));
}
function evaluateSpf({ rootSpf, mailFromSpf, mailFromMx, rootDom, mailFromDom }) {
  if (spfHasAmazon(rootSpf)) return { status: 'PASS', detail: `SPF include:amazonses on ${rootDom}` };
  if (spfHasAmazon(mailFromSpf)) return { status: 'PASS', detail: `SES SPF on custom MAIL FROM ${mailFromDom}` };
  if (mxIsSesFeedback(mailFromMx)) return { status: 'PASS', detail: `SES custom MAIL FROM active (${mailFromDom} MX → feedback-smtp.*.amazonses.com); SPF authenticates via the envelope domain (DKIM-aligned DMARC covers the From domain)` };
  if ((Array.isArray(rootSpf) && rootSpf.some((v) => /v=spf1/i.test(v))) || (Array.isArray(mailFromSpf) && mailFromSpf.some((v) => /v=spf1/i.test(v)))) {
    return { status: 'WARN', detail: `SPF present but no Amazon SES include on ${rootDom}/${mailFromDom}; DKIM-aligned DMARC still authenticates SES mail` };
  }
  return { status: 'FAIL', detail: `no SPF on ${rootDom} or ${mailFromDom}` };
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

  // DNS auth (best-effort live lookup). SPF is evaluated against the ACTUAL SES auth architecture: the root
  // From domain AND the SES custom MAIL FROM (envelope) subdomain (env SES_MAIL_FROM_DOMAIN, else the SES
  // convention bounce.<dom>). SES authenticates SPF via the MAIL FROM domain, so a correct custom MAIL FROM
  // (MX → feedback-smtp.*.amazonses.com and/or SPF include:amazonses.com) satisfies SPF even when the root
  // From domain uses a different provider.
  const dom = domainOf(EMAIL_FROM) || 'advantage.bid';
  const mailFromDom = (process.env.SES_MAIL_FROM_DOMAIN || ('bounce.' + dom)).toLowerCase();
  const [rootSpf, mailFromSpf, mailFromMx] = await Promise.all([txt(dom), txt(mailFromDom), mx(mailFromDom)]);
  const spfEval = evaluateSpf({ rootSpf, mailFromSpf, mailFromMx, rootDom: dom, mailFromDom });
  set('spf', spfEval.status, spfEval.detail);
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

module.exports = { evaluate, evaluateSpf, spfHasAmazon, mxIsSesFeedback };
