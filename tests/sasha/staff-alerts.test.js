'use strict';

/**
 * Staff notifications for actionable Sasha messages (owner request 2026-10-15; migration 196), against a real Postgres
 * (PGlite): the message is in the staff inbox first; one email per address and one detail-free text per number per
 * message; no duplicates; delivery failures keep the message and are retried; simulated calls and non-production
 * environments never notify; the notice works from inside Sasha's guarded request_human tool.
 */
jest.mock('../../src/db', () => require('../sasha-phone/pgHarness').dbAdapter(() => global.__PG));

const fs = require('fs');
const path = require('path');
const { createDb } = require('../sasha-phone/pgHarness');
const alerts = require('../../src/services/sasha/staffAlertService');
const conversations = require('../../src/services/sasha/conversationService');

const q = (sql, p) => global.__PG.query(sql, p || []).then((r) => r.rows);
const sent = { email: [], sms: [] };
let failEmail = 0;
const transports = {
  email: async (m) => { if (failEmail > 0) { failEmail--; throw new Error('SES throttled'); } sent.email.push(m); return { id: 'ses-' + sent.email.length }; },
  sms: async (m) => { sent.sms.push(m); return { id: 'SM' + sent.sms.length }; },
};
async function settle(pred, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; }
async function chat(name = 'Pat Customer', email = 'pat@example.com') {
  const c = await conversations.createConversation({ channel: 'chat', customerName: name, customerEmail: email, subject: 'Pickup question' });
  await conversations.addMessage(c.id, { direction: 'inbound', author: 'customer', text: 'My pickup slot is wrong, please call me.' });
  return c;
}

jest.setTimeout(30000);
beforeAll(async () => {
  global.__PG = await createDb();
  await global.__PG.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '196_sasha_staff_alerts.sql'), 'utf8'));
  await alerts.setRecipients({ emails: ['owner@example.com', 'info@example.com'], sms: ['(832) 555-0142'] });
}, 60000);
afterAll(() => alerts._setTransportsForTest(null));
beforeEach(() => { alerts._setTransportsForTest(transports); sent.email.length = 0; sent.sms.length = 0; failEmail = 0; });

test('recipients are validated and normalised', async () => {
  expect(await alerts.recipients()).toEqual({ emails: ['owner@example.com', 'info@example.com'], sms: ['+18325550142'] });
  await expect(alerts.setRecipients({ emails: ['ok@example.com', 'a@b.co, c@d.co'] })).rejects.toThrow(/single valid address/);
  await expect(alerts.setRecipients({ sms: ['12345'] })).rejects.toThrow(/US mobile/);
});

test('a new hand-off: in the inbox first, then ONE email per address and ONE detail-free text per number', async () => {
  const c = await chat();
  const r = await conversations.requestHandoff(c.id, { reasonCode: 'customer_request', reasonText: 'Wants a person about pickup.', createdBy: 'customer' });
  expect(r.created).toBe(true);
  expect(await q(`SELECT status FROM cs_handoffs WHERE id = $1`, [r.handoffId])).toEqual([{ status: 'open' }]);
  await settle(async () => (await q(`SELECT count(*)::int n FROM cs_staff_alerts WHERE handoff_id = $1 AND status = 'sent'`, [r.handoffId]))[0].n === 3);
  expect(sent.email.map((m) => m.to).sort()).toEqual(['info@example.com', 'owner@example.com']);
  expect(sent.sms.map((m) => m.to)).toEqual(['+18325550142']);
  const mail = sent.email[0];
  expect(mail.subject).toMatch(/A customer needs a person: Customer asked for a person \(Ref /);
  expect(mail.text).toContain('Pat Customer'); expect(mail.text).toContain('pat@example.com');
  expect(mail.text).toContain('My pickup slot is wrong'); expect(mail.text).toMatch(/admin\/sasha-inbox\.html\?c=[0-9a-f-]{36}/);
  expect(mail.html).not.toMatch(/<script/i);
  const text = sent.sms[0].message;
  expect(text).toMatch(/^Advantage\.Bid: a customer needs a person \(website chat, Ref [A-Z0-9]+\)/);
  expect(text).not.toMatch(/Pat|pat@|pickup slot|@example/);
  const log = await q(`SELECT channel, status, attempts, provider_message_id FROM cs_staff_alerts WHERE handoff_id = $1 ORDER BY channel, recipient`, [r.handoffId]);
  expect(log.every((l) => l.status === 'sent' && l.attempts === 1 && l.provider_message_id)).toBe(true);
});

test('no duplicates: a repeated hand-off request and concurrent notifies for the same message send nothing more', async () => {
  const c = await chat('Dee', 'dee@example.com');
  const r = await conversations.requestHandoff(c.id, { reasonCode: 'uncertain', reasonText: 'Could not answer.', createdBy: 'system' });
  await settle(async () => sent.email.length === 2 && sent.sms.length === 1);
  const again = await conversations.requestHandoff(c.id, { reasonCode: 'uncertain', reasonText: 'Still could not answer.', createdBy: 'system' });
  expect(again).toEqual({ handoffId: r.handoffId, created: false });
  await Promise.all([alerts.notify(r.handoffId), alerts.notify(r.handoffId), alerts.notify(r.handoffId)]);
  await new Promise((res) => setTimeout(res, 100));
  expect(sent.email).toHaveLength(2); expect(sent.sms).toHaveLength(1);
  expect((await q(`SELECT count(*)::int n FROM cs_staff_alerts WHERE handoff_id = $1`, [r.handoffId]))[0].n).toBe(3);
});

test('a delivery failure keeps the message, is logged, and is retried until it goes through', async () => {
  failEmail = 2;   // both emails fail the first time
  const c = await chat('Lee', 'lee@example.com');
  const { handoffId } = await conversations.requestHandoff(c.id, { reasonCode: 'dispute', reasonText: 'Charge dispute.', createdBy: 'sasha' });
  await settle(async () => (await q(`SELECT count(*)::int n FROM cs_staff_alerts WHERE handoff_id = $1 AND status IN ('sent','failed')`, [handoffId]))[0].n === 3);
  const failed = await q(`SELECT recipient, last_error, attempts FROM cs_staff_alerts WHERE handoff_id = $1 AND status = 'failed'`, [handoffId]);
  expect(failed).toHaveLength(2); expect(failed[0].last_error).toMatch(/SES throttled/);
  expect((await q(`SELECT status FROM cs_handoffs WHERE id = $1`, [handoffId]))[0].status).toBe('open');   // message preserved
  const r = await alerts.retryFailed();
  expect(r.sent).toBe(2);
  const rows = await q(`SELECT status, attempts FROM cs_staff_alerts WHERE handoff_id = $1 AND channel = 'email'`, [handoffId]);
  expect(rows.every((x) => x.status === 'sent' && x.attempts === 2)).toBe(true);
  expect(sent.sms).toHaveLength(1);   // the text was not re-sent
});

test('after the maximum attempts a delivery is marked gave_up (and the message is still in the inbox)', async () => {
  alerts._setTransportsForTest({ email: async () => { throw new Error('down'); }, sms: async () => { throw new Error('down'); } });
  const c = await chat('Max', 'max@example.com');
  const { handoffId } = await conversations.requestHandoff(c.id, { reasonCode: 'other', reasonText: 'x', createdBy: 'system', notify: false });
  await alerts.notify(handoffId);
  for (let i = 0; i < alerts.MAX_ATTEMPTS; i++) await alerts.retryFailed();
  const rows = await q(`SELECT status, attempts FROM cs_staff_alerts WHERE handoff_id = $1`, [handoffId]);
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.status === 'gave_up' && r.attempts === alerts.MAX_ATTEMPTS)).toBe(true);
  expect((await q(`SELECT count(*)::int n FROM cs_handoffs WHERE id = $1`, [handoffId]))[0].n).toBe(1);
});

test('a phone callback is notified once WITH the callback number in the email and WITHOUT it in the text', async () => {
  const conv = await conversations.createConversation({ channel: 'phone', customerName: 'Caller Kim' });
  const call = (await q(`INSERT INTO cs_calls (conversation_id, provider, provider_call_id, is_simulated, status) VALUES ($1, 'twilio_cr', 'CA-test-1', false, 'in_progress') RETURNING *`, [conv.id]))[0];
  const escalation = require('../../src/services/sasha/phone/escalation');
  await escalation.requestCallback(call, { number: '+17135550188', reason: 'customer_request', summary: 'Caller Kim wants a call back about invoice AAC-C-000123.' }, {});
  await settle(async () => sent.email.length === 2 && sent.sms.length === 1);
  expect(sent.email[0].subject).toMatch(/^\[Advantage\.Bid\] Callback requested/);
  expect(sent.email[0].text).toContain('Call back on: +17135550188');
  expect(sent.sms[0].message).toMatch(/callback requested \(phone call, Ref /);
  expect(sent.sms[0].message).not.toMatch(/7135550188|0188|Kim|AAC/);
  const kinds = await q(`SELECT DISTINCT kind FROM cs_staff_alerts a JOIN cs_handoffs h ON h.id = a.handoff_id WHERE h.conversation_id = $1`, [conv.id]);
  expect(kinds).toEqual([{ kind: 'callback' }]);   // one message, not a hand-off notice plus a callback notice
});

test('simulated calls never notify', async () => {
  const conv = await conversations.createConversation({ channel: 'phone' });
  const call = (await q(`INSERT INTO cs_calls (conversation_id, provider, provider_call_id, is_simulated, status) VALUES ($1, 'simulated', 'SIM-1', true, 'in_progress') RETURNING *`, [conv.id]))[0];
  await require('../../src/services/sasha/phone/escalation').requestCallback(call, { number: '+17135550100', reason: 'customer_request', summary: 'x' }, { staffAlerts: [] });
  const { handoffId } = await conversations.requestHandoff(conv.id, { reasonCode: 'other', reasonText: 'y', createdBy: 'system' });
  await alerts.notify(handoffId);
  await new Promise((r) => setTimeout(r, 100));
  expect(sent.email).toHaveLength(0); expect(sent.sms).toHaveLength(0);
});

test('outside production (and the certification harness) nothing is sent or logged', async () => {
  alerts._setTransportsForTest(null);   // NODE_ENV is 'test'
  const c = await chat('Env', 'env@example.com');
  const { handoffId } = await conversations.requestHandoff(c.id, { reasonCode: 'other', reasonText: 'z', createdBy: 'system', notify: false });
  expect(await alerts.notify(handoffId)).toEqual({ notified: false, reason: 'notifications send in production only' });
  expect((await q(`SELECT count(*)::int n FROM cs_staff_alerts WHERE handoff_id = $1`, [handoffId]))[0].n).toBe(0);
});

test('a hand-off made by Sasha\'s guarded request_human tool still notifies; the tool gains no extra write permission', async () => {
  const tools = require('../../src/services/sasha/tools');   // installs the write guard on the database
  void tools;
  const guard = require('../../src/services/sasha/toolGuard');
  const c = await chat('Gus', 'gus@example.com');
  const r = await guard.run('request_human', () => conversations.requestHandoff(c.id, { reasonCode: 'customer_request', reasonText: 'Wants a person.', createdBy: 'customer' }));
  await settle(async () => sent.email.length === 2 && sent.sms.length === 1);
  expect(sent.email).toHaveLength(2);
  // Inside the tool's scope, writing the alert log directly is still refused.
  await expect(guard.run('request_human', () => require('../../src/db').query(
    `INSERT INTO cs_staff_alerts (handoff_id, kind, channel, recipient) VALUES ($1, 'handoff', 'email', 'x@example.com')`, [r.handoffId]))).rejects.toThrow(/is not permitted to write to "cs_staff_alerts"/);
});

test('a Super Admin test notice uses the real path and leaves a resolved, clearly-labelled test in the inbox', async () => {
  const out = await alerts.sendTest(null);
  expect(out).toMatchObject({ notified: true, sent: 3, failed: 0 });
  const conv = (await q(`SELECT subject, status, handoff_state FROM cs_conversations WHERE ref = $1`, [out.ref]))[0];
  expect(conv).toEqual({ subject: 'Staff notification test - no action needed', status: 'resolved', handoff_state: 'resolved' });
  expect(sent.sms[0].message).toMatch(/Ref /);
});

test('the delivery log masks recipients', async () => {
  const log = await alerts.recentDeliveries({ limit: 5 });
  expect(log.length).toBeGreaterThan(0);
  for (const r of log) expect(r.recipient).toMatch(/^(.\*\*\*@|…\d{4}$)/);
});
