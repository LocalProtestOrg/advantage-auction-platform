#!/usr/bin/env node
/* twilio-verify-selftest.js — Owner self-test of the Twilio Verify service, run in YOUR OWN terminal.
 *
 *   railway run node scripts/twilio-verify-selftest.js                 # full test: texts a code to the number you type
 *   railway run node scripts/twilio-verify-selftest.js --service-only  # read-only: checks the Verify service settings, sends nothing
 *
 * Safety:
 *   - Talks ONLY to Twilio Verify. Never opens the database, never reads or writes customer tables, never changes a switch.
 *   - Your phone number and the code are typed at prompts in your terminal; they are never passed as arguments (so they
 *     are not in shell history) and never printed. Output shows only the last 4 digits, the service's code length, and
 *     PASS / FAIL. The Service SID and Twilio credentials are never printed.
 *   - Refuses fictional (555-01xx), invalid and non-US numbers. Sends at most one code per run.
 */
const readline = require('readline');
const { normalizeUsPhone } = require('../src/lib/phoneNumber');

const SID = process.env.TWILIO_VERIFY_SERVICE_SID || '';
const ACC = process.env.TWILIO_ACCOUNT_SID || '';
const TOK = process.env.TWILIO_AUTH_TOKEN || '';
const SERVICE_ONLY = process.argv.includes('--service-only');

function fail(msg) { console.log('FAIL: ' + msg); process.exit(1); }
async function twilio(method, path, form) {
  const res = await fetch('https://verify.twilio.com/v2/Services/' + encodeURIComponent(SID) + path, {
    method, headers: { Authorization: 'Basic ' + Buffer.from(ACC + ':' + TOK).toString('base64'), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) fail(`Twilio returned HTTP ${res.status}${j && j.code ? ' (Twilio error ' + j.code + ')' : ''}. Nothing else was changed.`);
  return j;
}
function ask(rl, q) { return new Promise((r) => rl.question(q, (a) => r(String(a || '').trim()))); }

(async () => {
  if (!SID || !SID.startsWith('VA')) fail('TWILIO_VERIFY_SERVICE_SID is missing or does not start with VA (run this with: railway run ...).');
  if (!ACC || !TOK) fail('Twilio account credentials are not available in this environment.');

  const svc = await twilio('GET', '');
  console.log(`Verify service reached. Code length: ${svc.code_length}. Name: ${svc.friendly_name}.`);
  if (Number(svc.code_length) !== 4) fail('The service code length is not 4. Change it to 4 digits in the Twilio console first.');
  if (SERVICE_ONLY) { console.log('PASS (service check only; no code was sent).'); return; }

  if (!process.stdin.isTTY) fail('Run this in your own interactive terminal (not through the assistant).');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const raw = await ask(rl, 'Your mobile number (US, typed here only): ');
  const n = normalizeUsPhone(raw);
  if (n.status !== 'ok' || n.fictional) { rl.close(); fail('That is not a valid US mobile number.'); }
  const last4 = n.e164.slice(-4);
  const yes = await ask(rl, `Send one 4-digit code to the number ending in ${last4}? (y/n): `);
  if (!/^y(es)?$/i.test(yes)) { rl.close(); console.log('Cancelled. Nothing was sent.'); return; }

  const start = await twilio('POST', '/Verifications', { To: n.e164, Channel: 'sms' });
  console.log(`Code requested for the number ending in ${last4} (status: ${start.status}). It expires in a few minutes.`);
  const code = await ask(rl, 'Enter the 4-digit code from the text: ');
  rl.close();
  if (!/^\d{4}$/.test(code)) fail('The code must be exactly 4 digits. Run the test again if you want another try.');
  const check = await twilio('POST', '/VerificationCheck', { To: n.e164, Code: code });
  if (check.status === 'approved') console.log(`PASS: Twilio Verify approved the 4-digit code for the number ending in ${last4}.`);
  else fail(`Twilio did not approve the code (status: ${check.status}). You can run the test again.`);
})().catch((e) => fail('Unexpected error: ' + String(e && e.message || e).replace(/VA[0-9a-f]{32}|AC[0-9a-f]{32}|\+?\d{10,}/gi, '[hidden]')));
