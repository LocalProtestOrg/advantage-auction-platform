'use strict';

/**
 * Verified bidder phones, opt-in auction texts, and their gates (migration 189), against a real Postgres (PGlite).
 * No SMS, email or Twilio is reached: code delivery and text delivery are injected test senders.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
jest.mock('../../src/db', () => require('./pgHarness').dbAdapter(() => global.__PG));
jest.mock('../../src/services/termsService', () => ({ hasAcceptedCurrentTerms: async () => true }));
jest.mock('../../src/services/cardService', () => ({ hasCardOnFile: async () => true }));
jest.mock('../../src/services/conversionService', () => ({ emit: () => {} }));
jest.mock('../../src/services/buyerLifecycleEnrollmentService', () => ({ enroll: async () => ({}) }));
jest.setTimeout(60000);

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { createDb } = require('./pgHarness');
const phone = require('../../src/services/accountPhoneService');
const consent = require('../../src/services/smsConsentService');
const sms = require('../../src/services/auctionSmsService');
const registration = require('../../src/services/auctionRegistrationService');
const scenarios = require('../../src/services/auctionSmsScenarios');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
let seq = 0; const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;
let nextPhone = 100;
const freshNumber = () => `(551) 62${String(++nextPhone).slice(-1)}-${String(1000 + nextPhone)}`;

beforeAll(async () => { global.__PG = await createDb(); });
afterAll(async () => { await global.__PG.close(); });

const setCfg = (key, value) => q(`INSERT INTO platform_config (key, value, category) VALUES ($1, $2::jsonb, 'x') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);

/** A local code sender for tests (the "handset"): records codes; nothing leaves the process. */
function sender() { const codes = []; return { codes, s: { local: true, deliver: async (to, c) => { codes.push({ to, c }); } } }; }

async function user({ phone: ph = null, verified = false, password = null, active = true } = {}) {
  const email = `bidder-${uniq()}@buyers.org`;
  const e164 = verified ? require('../../src/lib/phoneNumber').normalizeUsPhone(ph).e164 : null;
  const hash = password ? await bcrypt.hash(password, 4) : null;
  return (await q(`INSERT INTO users (email, password_hash, phone, phone_verified_e164, phone_verified_at, is_active)
    VALUES ($1,$2,$3,$4, CASE WHEN $4::text IS NOT NULL THEN now() END, $5) RETURNING id, email`, [email, hash, verified ? e164 : ph, e164, active]))[0];
}
async function verifyByCode(userId, number, extra = {}) {
  const t = sender();
  await phone.start(userId, { phone: number, ...extra }, { sender: t.s });
  return phone.confirm(userId, { code: t.codes[t.codes.length - 1].c });
}
async function auctionWithLot({ state = 'active', startInMin = 60, lotState = 'open', closesInMin = 120 } = {}) {
  const sellerId = (await q(`INSERT INTO users (email, role) VALUES ($1,'seller') RETURNING id`, ['seller-' + uniq() + '@x.org']))[0].id;
  const sp = (await q(`INSERT INTO seller_profiles (user_id, seller_type) VALUES ($1,'private') RETURNING id`, [sellerId]))[0];
  const a = (await q(`INSERT INTO auctions (seller_id, title, city, address_state, state, start_time, end_time) VALUES ($1,'Henderson Estate','Dayton','OH',$2,
    now() + ($3 || ' minutes')::interval, now() + interval '1 day') RETURNING *`, [sp.id, state, String(startInMin)]))[0];
  const lot = (await q(`INSERT INTO lots (auction_id, lot_number, title, state, closes_at, starting_bid_cents) VALUES ($1, 42, 'Walnut Dresser', $2, now() + ($3 || ' minutes')::interval, 100) RETURNING *`,
    [a.id, lotState, String(closesInMin)]))[0];
  return { a, lot };
}
/** What the page showed: the current consent version and the last 4 digits of the verified number. */
async function shown(userId) {
  const u = (await q(`SELECT phone_verified_e164 FROM users WHERE id = $1`, [userId]))[0];
  return { consentVersion: consent.CONSENT_VERSION, shownLast4: u && u.phone_verified_e164 ? u.phone_verified_e164.slice(-4) : null };
}
async function optIn(userId, type, source = 'notification_settings') {
  await setCfg('auction_sms.offer_opt_in', true);
  return consent.set(userId, type, true, { source, ...(await shown(userId)) });
}
/** A verified, opted-in bidder who has bid on the lot and been outbid by someone else. */
async function outbidBidder(lot, type = 'outbid') {
  const u = await user({ phone: freshNumber(), verified: true });
  await optIn(u.id, type);
  await q(`INSERT INTO bids (lot_id, bidder_user_id, amount_cents) VALUES ($1,$2,500)`, [lot.id, u.id]);
  const other = await user({});
  await q(`UPDATE lots SET current_winner_user_id = $2 WHERE id = $1`, [lot.id, other.id]);
  return u;
}
const textSender = () => { const sent = []; return { sent, fn: async (to, body) => { sent.push({ to, body }); return { sent: true, ref: 'SM' + sent.length }; } }; };
const smsRows = (userId) => q(`SELECT kind, status, suppress_reason, lot_id, auction_id FROM auction_sms_messages WHERE user_id = $1 ORDER BY created_at, id`, [userId]);

// ── account phone verification ───────────────────────────────────────────────────────────────────────
describe('account phone verification (website, 4-digit)', () => {
  test('success: the exact number is stored as E.164 and marked verified; codes are 4 digits and only hashed', async () => {
    const u = await user({ phone: '551 620 1111' });
    expect(phone.isVerified((await q(`SELECT * FROM users WHERE id = $1`, [u.id]))[0])).toBe(false);   // present ≠ verified
    const t = sender();
    expect(await phone.start(u.id, { phone: '(551) 620-2222' }, { sender: t.s })).toMatchObject({ sent: true, phone_last4: '2222', expires_in_minutes: 5 });
    expect(t.codes[0].c).toMatch(/^\d{4}$/);
    expect(t.codes[0].to).toBe('+15516202222');
    const row = (await q(`SELECT code_hash, status FROM account_phone_verifications WHERE user_id = $1`, [u.id]))[0];
    expect(row.code_hash).not.toContain(t.codes[0].c);
    expect(await phone.confirm(u.id, { code: t.codes[0].c })).toMatchObject({ verified: true, phone_last4: '2222', changed: false });
    const after = (await q(`SELECT phone, phone_verified_e164, phone_verified_at FROM users WHERE id = $1`, [u.id]))[0];
    expect(after).toMatchObject({ phone: '+15516202222', phone_verified_e164: '+15516202222' });
    expect(phone.isVerified(after)).toBe(true);
    expect((await q(`SELECT count(*)::int n FROM sms_consents WHERE user_id = $1`, [u.id]))[0].n).toBe(0);   // verification never opts anyone in
  });
  test('wrong code: 3 tries per code; expired; replay of a used code refused', async () => {
    const u = await user({}); const t = sender();
    await phone.start(u.id, { phone: freshNumber() }, { sender: t.s });
    const wrong = t.codes[0].c === '0000' ? '1111' : '0000';
    await expect(phone.confirm(u.id, { code: wrong })).rejects.toMatchObject({ code: 'WRONG_CODE', attempts_left: 2 });
    await expect(phone.confirm(u.id, { code: wrong })).rejects.toMatchObject({ code: 'WRONG_CODE', attempts_left: 1 });
    await expect(phone.confirm(u.id, { code: wrong })).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    await expect(phone.confirm(u.id, { code: t.codes[0].c })).rejects.toMatchObject({ code: 'NO_CODE' });
    const u2 = await user({}); const t2 = sender();
    await phone.start(u2.id, { phone: freshNumber() }, { sender: t2.s });
    await q(`UPDATE account_phone_verifications SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u2.id]);
    await expect(phone.confirm(u2.id, { code: t2.codes[0].c })).rejects.toMatchObject({ code: 'EXPIRED' });
    const u3 = await user({});
    const t3 = sender();
    await phone.start(u3.id, { phone: freshNumber() }, { sender: t3.s });
    await phone.confirm(u3.id, { code: t3.codes[0].c });
    await expect(phone.confirm(u3.id, { code: t3.codes[0].c })).rejects.toMatchObject({ code: 'NO_CODE' });   // replay
  });
  test('resend limit (3 per 30 min), per-number limit across accounts (5 per hour) and lockout after two exhausted codes', async () => {
    const u = await user({}); const t = sender();
    for (let i = 0; i < 3; i++) await phone.start(u.id, { phone: freshNumber() }, { sender: t.s });
    await expect(phone.start(u.id, { phone: freshNumber() }, { sender: t.s })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const shared = freshNumber();
    for (let i = 0; i < 5; i++) await phone.start((await user({})).id, { phone: shared }, { sender: sender().s });
    await expect(phone.start((await user({})).id, { phone: shared }, { sender: sender().s })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const v = await user({});
    await q(`INSERT INTO account_phone_verifications (user_id, phone_e164, phone_hash, provider, status, expires_at) VALUES ($1,'+15550000000','h','local_test','failed', now()),($1,'+15550000000','h','local_test','failed', now())`, [v.id]);
    await expect(phone.start(v.id, { phone: freshNumber() }, { sender: sender().s })).rejects.toMatchObject({ code: 'LOCKED' });
  });
  test('invalid, international and fictional numbers are refused', async () => {
    const u = await user({});
    for (const bad of ['123-456-7890', '+44 20 7946 0958', '202-555-0101', '555 1234']) {
      await expect(phone.start(u.id, { phone: bad }, { sender: sender().s })).rejects.toMatchObject({ code: 'INVALID_PHONE' });
    }
  });
  test('changing a VERIFIED number needs the password, re-verifies the new number, records the change and emails a notice', async () => {
    const u = await user({ phone: '(551) 620-3333', verified: true, password: 'correct horse' });
    const t = sender();
    await expect(phone.start(u.id, { phone: '(551) 620-4444' }, { sender: t.s })).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    await expect(phone.start(u.id, { phone: '(551) 620-4444', currentPassword: 'nope' }, { sender: t.s })).rejects.toMatchObject({ code: 'PASSWORD_INCORRECT' });
    await phone.start(u.id, { phone: '(551) 620-4444', currentPassword: 'correct horse' }, { sender: t.s });
    // Until the new number is confirmed, the OLD verification stays (nothing changed yet).
    expect((await q(`SELECT phone FROM users WHERE id = $1`, [u.id]))[0].phone).toBe('+15516203333');
    const mail = { sendEmail: jest.fn(async () => ({})) };
    expect(await phone.confirm(u.id, { code: t.codes[0].c }, { emailService: mail })).toMatchObject({ verified: true, changed: true, phone_last4: '4444' });
    const after = (await q(`SELECT phone, phone_verified_e164, phone_changed_at FROM users WHERE id = $1`, [u.id]))[0];
    expect(after).toMatchObject({ phone: '+15516204444', phone_verified_e164: '+15516204444' });
    expect(after.phone_changed_at).toBeTruthy();
    expect(mail.sendEmail.mock.calls[0][0].subject).toMatch(/phone number was changed/);
    expect((await q(`SELECT event_type FROM audit_log WHERE entity_id = $1 ORDER BY created_at`, [u.id])).map((r) => r.event_type)).toContain('account.phone_changed');
  });
  test('any other change to the stored number un-verifies it (verification is bound to the exact number)', async () => {
    const u = await user({ phone: '(551) 620-5555', verified: true });
    await q(`UPDATE users SET phone = '(551) 620-6666' WHERE id = $1`, [u.id]);   // e.g. an admin correction
    expect(phone.isVerified((await q(`SELECT * FROM users WHERE id = $1`, [u.id]))[0])).toBe(false);
    expect(read('src/routes/auth.js')).toMatch(/code: 'VERIFIED_PHONE_CHANGE'/);
    expect(read('src/routes/adminUsers.js')).toMatch(/An admin can correct a phone number but cannot VERIFY one/);
  });
  test('shared numbers: two accounts may verify the same household number, but it never identifies either one by phone', async () => {
    const n = freshNumber();
    const a = await user({}); const b = await user({});
    await verifyByCode(a.id, n); const rb = await verifyByCode(b.id, n);
    expect(rb.shared_with_other_accounts).toBe(true);
    expect(await require('../../src/services/sasha/phone/verification').findAccount({ phone: n })).toEqual({ status: 'ambiguous' });
  });
  test('no code sender configured → verification is "not available" (production today) and the requirement cannot be switched on', async () => {
    const u = await user({});
    await expect(phone.start(u.id, { phone: freshNumber() })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(phone.setConfig({ required: true, verification_enabled: true }, { actorId: u.id })).rejects.toMatchObject({ code: 'NOT_READY' });
    await expect(phone.setConfig({ required: true }, { actorId: u.id }, { sender: sender().s })).rejects.toMatchObject({ code: 'NOT_READY' });   // must enable verification first
    expect((await phone.config()).required).toBe(false);
  });
});

// ── bidder requirement ───────────────────────────────────────────────────────────────────────────────
describe('verified phone required to bid (gate)', () => {
  test('requirement OFF (today): registration works exactly as before without a phone', async () => {
    const { a } = await auctionWithLot();
    const u = await user({});
    expect((await registration.registerForAuction(u.id, a.id, { pickupAcknowledged: true })).status).toBe('active');
  });
  test('requirement ON: a new bidder cannot register without a verified phone; verifying lets them register; existing data is never marked verified', async () => {
    const actor = await user({});
    await phone.setConfig({ verification_enabled: true }, { actorId: actor.id });
    await phone.setConfig({ required: true }, { actorId: actor.id }, { sender: sender().s });
    const { a } = await auctionWithLot();
    const legacy = await user({ phone: '(551) 620-7777' });   // historical phone, never verified
    await expect(registration.registerForAuction(legacy.id, a.id, { pickupAcknowledged: true })).rejects.toMatchObject({ code: 'PHONE_VERIFICATION_REQUIRED' });
    expect((await registration.getRegistrationStatus(legacy.id, a.id))).toMatchObject({ can_bid: false, phone_required: true, phone_verified: false });
    await verifyByCode(legacy.id, '(551) 620-7777');
    expect((await registration.registerForAuction(legacy.id, a.id, { pickupAcknowledged: true })).status).toBe('active');
    expect(await registration.assertCanBid(legacy.id, a.id)).toEqual({ ok: true });
  });
  test('requirement ON: a registration made BEFORE it was turned on keeps bidding (no one is cut off mid-auction)', async () => {
    const { a } = await auctionWithLot();
    const old = await user({});
    await q(`INSERT INTO auction_buyers (auction_id, user_id, paddle_number, pickup_acknowledged, status, registered_at) VALUES ($1,$2,101,true,'active', now() - interval '3 days')`, [a.id, old.id]);
    expect(await registration.assertCanBid(old.id, a.id)).toEqual({ ok: true });
    const fresh = await user({});
    await q(`INSERT INTO auction_buyers (auction_id, user_id, paddle_number, pickup_acknowledged, status, registered_at) VALUES ($1,$2,102,true,'active', now())`, [a.id, fresh.id]);
    expect(await registration.assertCanBid(fresh.id, a.id)).toMatchObject({ ok: false, code: 'PHONE_VERIFICATION_REQUIRED' });
    await setCfg('bidder_phone.required', false); await setCfg('bidder_phone.verification_enabled', false);
  });
  test('the bid pages send unverified bidders to verify, and the registration route passes optional text consent through', () => {
    expect(read('public/auction-view.html')).toMatch(/Verify your mobile number to bid/);
    expect(read('public/lot.html')).toMatch(/Verify Mobile Number/);
    expect(read('src/routes/auctions.js')).toMatch(/smsOptIn: req\.body && req\.body\.sms_opt_in/);
    expect(read('src/middleware/htmlAuthGate.js')).toMatch(/'\/verify-phone\.html', '\/notifications\.html'/);
  });
});

// ── consent ──────────────────────────────────────────────────────────────────────────────────────────
describe('optional text-alert consent', () => {
  test('opt-in needs the program to be offered AND a verified phone; opt-out always works; every change is an event', async () => {
    await setCfg('auction_sms.offer_opt_in', false);
    const v = await user({ phone: freshNumber(), verified: true });
    await expect(consent.set(v.id, 'outbid', true, { source: 'notification_settings', ...(await shown(v.id)) })).rejects.toMatchObject({ code: 'NOT_OFFERED' });
    await setCfg('auction_sms.offer_opt_in', true);
    const unv = await user({ phone: freshNumber() });
    await expect(consent.set(unv.id, 'outbid', true, { source: 'notification_settings', consentVersion: consent.CONSENT_VERSION, shownLast4: '0000' })).rejects.toMatchObject({ code: 'PHONE_NOT_VERIFIED' });
    expect(await consent.set(v.id, 'outbid', true, { source: 'notification_settings', ip: '1.2.3.4', ...(await shown(v.id)) })).toEqual({ changed: true, opted_in: true });
    expect(await consent.isOptedIn(v.id, 'watched_closing')).toBe(false);   // independent types
    await setCfg('auction_sms.offer_opt_in', false);
    expect(await consent.set(v.id, 'outbid', false, { source: 'notification_settings' })).toEqual({ changed: true, opted_in: false });   // opt-out even when not offered
    const row = (await q(`SELECT status, opted_in_at, opted_out_at, source, consent_text, phone_e164_at_opt_in FROM sms_consents WHERE user_id = $1`, [v.id]))[0];
    expect(row.status).toBe('opted_out'); expect(row.opted_in_at).toBeTruthy(); expect(row.opted_out_at).toBeTruthy();
    expect(row.consent_text).toBe(consent.recordText('outbid', 'notification_settings', (await shown(v.id)).shownLast4));
    expect(row.consent_text.startsWith('Text message alerts: Outbid alerts: Yes, text me Advantage.Bid outbid alerts')).toBe(true);
    expect(row.consent_text).toContain('Message frequency varies. Msg & data rates may apply. Reply STOP');
    expect(row.consent_text).toContain('Terms (https://bid.advantage.bid/terms.html) · Privacy Policy (https://bid.advantage.bid/privacy.html)');
    const ev = await q(`SELECT action, source, phone_last4, ip_hash FROM sms_consent_events WHERE user_id = $1 ORDER BY created_at`, [v.id]);
    expect(ev.map((e) => e.action)).toEqual(['opt_in', 'opt_out']);
    expect(ev[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  test('registration opt-in records consent with the auction as context (only ticked boxes)', async () => {
    await setCfg('auction_sms.offer_opt_in', true);
    const { a } = await auctionWithLot();
    const u = await user({ phone: freshNumber(), verified: true });
    const sh = await shown(u.id);
    const reg = await registration.registerForAuction(u.id, a.id, { pickupAcknowledged: true, smsOptIn: { outbid: true, consent_version: sh.consentVersion, shown_last4: sh.shownLast4 } });
    expect(reg.sms_alerts).toEqual({ recorded: true });
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(true);
    expect(await consent.isOptedIn(u.id, 'watched_closing')).toBe(false);
    const row = (await q(`SELECT source, source_context, surface, consent_version, terms_last_updated, privacy_last_updated, consent_text FROM sms_consents WHERE user_id = $1`, [u.id]))[0];
    expect(row).toMatchObject({ source: 'auction_registration', source_context: { auction_id: a.id }, surface: 'auction_registration', consent_version: consent.CONSENT_VERSION,
      terms_last_updated: consent.LEGAL.terms_last_updated, privacy_last_updated: consent.LEGAL.privacy_last_updated });
    expect(row.consent_text).toBe(consent.recordText('outbid', 'auction_registration', sh.shownLast4));
    expect(row.consent_text).toMatch(/^Optional text alerts from Advantage.Bid: Yes, text me Advantage.Bid outbid alerts .* Not required to register or bid./);
  });
  test('STOP opts the sender out of every alert type on every account with that verified number; HELP answers', async () => {
    const n = freshNumber();
    const a = await user({}); const b = await user({});
    await verifyByCode(a.id, n); await verifyByCode(b.id, n);
    await optIn(a.id, 'outbid'); await optIn(b.id, 'watched_closing');
    const e164 = require('../../src/lib/phoneNumber').normalizeUsPhone(n).e164;
    expect(await consent.handleInboundKeyword(e164, 'help')).toMatchObject({ action: 'help' });
    expect(await consent.handleInboundKeyword(e164, ' Stop ')).toMatchObject({ action: 'stop', accounts: 2, changed: 2 });
    expect(await consent.isOptedIn(a.id, 'outbid')).toBe(false);
    expect(await consent.isOptedIn(b.id, 'watched_closing')).toBe(false);
    expect((await q(`SELECT source FROM sms_consent_events WHERE user_id = $1 AND action = 'opt_out'`, [a.id]))[0].source).toBe('sms_keyword');
  });
});

// ── outbid texts ─────────────────────────────────────────────────────────────────────────────────────
describe('outbid texts', () => {
  beforeAll(async () => { await setCfg('auction_sms.enabled', true); });
  afterAll(async () => { await setCfg('auction_sms.enabled', false); });
  test('legitimate outbid → one concise text with the authoritative lot link', async () => {
    const { lot } = await auctionWithLot();
    const u = await outbidBidder(lot);
    await sms.onOutbid({ userId: u.id, lot });
    const t = textSender();
    await sms.processPending({}, { sender: t.fn });
    const e164 = (await q(`SELECT phone_verified_e164 FROM users WHERE id = $1`, [u.id]))[0].phone_verified_e164;
    const mine = t.sent.filter((x) => x.to === e164);
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toMatch(new RegExp(`You've been outbid on Lot 42, Walnut Dresser\\. View the lot and bid again: https?://[^ ]+/lot\\.html\\?lotId=${lot.id} Reply STOP to opt out\\.$`));
    expect(mine[0].body).not.toMatch(/@|\$\d|paddle|invoice/i);   // no private account details
  });
  test('5-minute cooldown per bidder + lot: a bidding war sends ONE text; outbids inside the window are suppressed and never queued', async () => {
    const { lot } = await auctionWithLot();
    const u = await outbidBidder(lot);
    const t = textSender();
    await sms.onOutbid({ userId: u.id, lot }); await sms.processPending({}, { sender: t.fn });
    for (let i = 0; i < 4; i++) { await sms.onOutbid({ userId: u.id, lot }); await sms.processPending({}, { sender: t.fn }); }
    const rows = await smsRows(u.id);
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'suppressed').map((r) => r.suppress_reason)).toEqual(['cooldown', 'cooldown', 'cooldown', 'cooldown']);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(0);
    // After the cooldown, a new outbid is eligible again.
    await q(`UPDATE auction_sms_messages SET sent_at = now() - interval '6 minutes' WHERE user_id = $1 AND status = 'sent'`, [u.id]);
    await sms.onOutbid({ userId: u.id, lot }); await sms.processPending({}, { sender: t.fn });
    expect((await smsRows(u.id)).filter((r) => r.status === 'sent')).toHaveLength(2);
  });
  test('different lots do not share a cooldown', async () => {
    const one = await auctionWithLot(); const two = await auctionWithLot();
    const u = await outbidBidder(one.lot);
    await q(`INSERT INTO bids (lot_id, bidder_user_id, amount_cents) VALUES ($1,$2,500)`, [two.lot.id, u.id]);
    await q(`UPDATE lots SET current_winner_user_id = gen_random_uuid() WHERE id = $1`, [two.lot.id]);
    const t = textSender();
    await sms.onOutbid({ userId: u.id, lot: one.lot }); await sms.onOutbid({ userId: u.id, lot: two.lot });
    await sms.processPending({}, { sender: t.fn });
    expect((await smsRows(u.id)).filter((r) => r.status === 'sent')).toHaveLength(2);
  });
  test('no consent or unverified phone → nothing is recorded or sent', async () => {
    const { lot } = await auctionWithLot();
    const noConsent = await user({ phone: freshNumber(), verified: true });
    const unverified = await user({ phone: freshNumber() });
    expect(await sms.onOutbid({ userId: noConsent.id, lot })).toEqual({ skipped: 'not_eligible' });
    expect(await sms.onOutbid({ userId: unverified.id, lot })).toEqual({ skipped: 'not_eligible' });
    expect((await smsRows(noConsent.id)).length + (await smsRows(unverified.id)).length).toBe(0);
  });
  test('stale at send time: regained the high bid, lot closed, auction closed, opted out, phone changed → suppressed, not sent', async () => {
    const cases = [
      ['regained_high_bid', async (u, lot) => q(`UPDATE lots SET current_winner_user_id = $2 WHERE id = $1`, [lot.id, u.id])],
      ['lot_closed', async (u, lot) => q(`UPDATE lots SET state = 'closed' WHERE id = $1`, [lot.id])],
      ['auction_not_live', async (u, lot) => q(`UPDATE auctions SET state = 'closed' WHERE id = $1`, [lot.auction_id])],
      ['no_consent', async (u) => consent.set(u.id, 'outbid', false, { source: 'notification_settings' })],
      ['phone_not_verified', async (u) => q(`UPDATE users SET phone = '(551) 699-0000' WHERE id = $1`, [u.id])],
    ];
    for (const [reason, mutate] of cases) {
      const { lot } = await auctionWithLot();
      const u = await outbidBidder(lot);
      await sms.onOutbid({ userId: u.id, lot });
      await mutate(u, lot);
      const t = textSender();
      await sms.processPending({}, { sender: t.fn });
      expect([reason, (await smsRows(u.id))[0]]).toEqual([reason, expect.objectContaining({ status: 'suppressed', suppress_reason: reason })]);
    }
  });
  test('duplicate worker execution sends once (rows are claimed with SKIP LOCKED)', async () => {
    const { lot } = await auctionWithLot();
    const u = await outbidBidder(lot);
    await sms.onOutbid({ userId: u.id, lot });
    const t = textSender();
    await Promise.all([sms.processPending({}, { sender: t.fn }), sms.processPending({}, { sender: t.fn })]);
    expect((await smsRows(u.id)).filter((r) => r.status === 'sent')).toHaveLength(1);
  });
  test('switch OFF (production today): the bid hook records and sends nothing', async () => {
    await setCfg('auction_sms.enabled', false);
    const { lot } = await auctionWithLot();
    const u = await outbidBidder(lot);
    expect(await sms.onOutbid({ userId: u.id, lot })).toEqual({ skipped: 'disabled' });
    expect(await sms.processPending()).toEqual({ skipped: 'disabled' });
    expect(await sms.scheduleWatchedReminders()).toEqual({ skipped: 'disabled' });
    await setCfg('auction_sms.enabled', true);
  });
  test('enabled but not live-ready (no A2P confirmation / sender) → suppressed "not_ready", never sent', async () => {
    const { lot } = await auctionWithLot();
    const u = await outbidBidder(lot);
    await sms.onOutbid({ userId: u.id, lot });
    await sms.processPending();   // real delivery path
    expect((await smsRows(u.id))[0]).toMatchObject({ status: 'suppressed', suppress_reason: 'not_ready' });
  });
});

// ── watched-auction closing reminders ────────────────────────────────────────────────────────────────
describe('watched-auction closing reminders', () => {
  beforeAll(async () => { await setCfg('auction_sms.enabled', true); });
  afterAll(async () => { await setCfg('auction_sms.enabled', false); });
  async function watcher(lot, { opt = true } = {}) {
    const u = await user({ phone: freshNumber(), verified: true });
    if (opt) await optIn(u.id, 'watched_closing');
    await q(`INSERT INTO watchlists (user_id, lot_id) VALUES ($1,$2)`, [u.id, lot.id]);
    return u;
  }
  test('one reminder about 60 minutes before lots begin closing, with the auction link; re-scans and soft-close extensions never add another', async () => {
    const { a, lot } = await auctionWithLot({ startInMin: 58 });
    const u = await watcher(lot);
    const t = textSender();
    await sms.scheduleWatchedReminders(); await sms.processPending({}, { sender: t.fn });
    const mine = (await smsRows(u.id)).filter((r) => r.kind === 'watched_closing');
    expect(mine.map((r) => r.status)).toEqual(['sent']);
    expect(t.sent.find((x) => /watching begins closing/.test(x.body)).body).toMatch(new RegExp(`/auction-view\\.html\\?auctionId=${a.id} Reply STOP to opt out\\.$`));
    await q(`UPDATE lots SET closes_at = closes_at + interval '2 minutes', extension_count = 1 WHERE id = $1`, [lot.id]);   // anti-snipe
    await sms.scheduleWatchedReminders(); await sms.processPending({}, { sender: t.fn });
    expect((await smsRows(u.id)).filter((r) => r.kind === 'watched_closing')).toHaveLength(1);
  });
  test('only watchers who opted in with a verified phone; auctions not yet due are left alone', async () => {
    const { lot } = await auctionWithLot({ startInMin: 58 });
    const noOpt = await watcher(lot, { opt: false });
    const later = await auctionWithLot({ startInMin: 180 });
    const early = await watcher(later.lot);
    await sms.scheduleWatchedReminders();
    expect(await smsRows(noOpt.id)).toHaveLength(0);
    expect(await smsRows(early.id)).toHaveLength(0);
  });
  test('rescheduled after queueing → suppressed; the new time gets its own reminder when due', async () => {
    const { a, lot } = await auctionWithLot({ startInMin: 58 });
    const u = await watcher(lot);
    await sms.scheduleWatchedReminders();
    await q(`UPDATE auctions SET start_time = now() + interval '3 hours' WHERE id = $1`, [a.id]);
    const t = textSender();
    await sms.processPending({}, { sender: t.fn });
    expect((await smsRows(u.id))[0]).toMatchObject({ status: 'suppressed', suppress_reason: 'rescheduled' });
    await q(`UPDATE auctions SET start_time = now() + interval '59 minutes' WHERE id = $1`, [a.id]);
    await sms.scheduleWatchedReminders(); await sms.processPending({}, { sender: t.fn });
    expect((await smsRows(u.id)).map((r) => r.status)).toEqual(['suppressed', 'sent']);
  });
  test('cancelled/unpublished, stopped watching, or opted out before send → suppressed', async () => {
    const cases = [
      ['auction_not_live', async (u, a) => q(`UPDATE auctions SET state = 'draft' WHERE id = $1`, [a.id])],
      ['not_watching', async (u) => q(`DELETE FROM watchlists WHERE user_id = $1`, [u.id])],
      ['no_consent', async (u) => consent.set(u.id, 'watched_closing', false, { source: 'notification_settings' })],
    ];
    for (const [reason, mutate] of cases) {
      const { a, lot } = await auctionWithLot({ startInMin: 58 });
      const u = await watcher(lot);
      await sms.scheduleWatchedReminders();
      await mutate(u, a);
      await sms.processPending({}, { sender: textSender().fn });
      expect([reason, (await smsRows(u.id))[0]]).toEqual([reason, expect.objectContaining({ status: 'suppressed', suppress_reason: reason })]);
    }
  });
  test('duplicate scheduler + sender runs produce one reminder', async () => {
    const { lot } = await auctionWithLot({ startInMin: 58 });
    const u = await watcher(lot);
    await Promise.all([sms.scheduleWatchedReminders(), sms.scheduleWatchedReminders()]);
    const t = textSender();
    await Promise.all([sms.processPending({}, { sender: t.fn }), sms.processPending({}, { sender: t.fn })]);
    expect((await smsRows(u.id)).filter((r) => r.status === 'sent')).toHaveLength(1);
  });
});

// ── tester scenarios, wiring, wording, safety ────────────────────────────────────────────────────────
describe('tester scenarios, wiring and safety', () => {
  test('every tester scenario produces the expected decision (same rules as the sender)', () => {
    const want = { outbid_opted_in: ['SENT'], outbid_not_opted_in: ['suppressed: no_consent'], outbid_unverified_phone: ['suppressed: phone_not_verified'],
      outbid_first_then_cooldown: ['SENT', 'suppressed: cooldown', 'suppressed: cooldown', 'suppressed: cooldown', 'suppressed: cooldown'],
      outbid_after_cooldown: ['SENT', 'suppressed: cooldown', 'SENT'], outbid_regained_before_send: ['suppressed: regained_high_bid'], outbid_lot_closed: ['suppressed: lot_closed'],
      outbid_opt_out_before_send: ['suppressed: no_consent'], watched_one_hour: ['SENT'], watched_duplicate: ['SENT', 'suppressed: already_sent'],
      watched_rescheduled: ['suppressed: rescheduled'], watched_cancelled: ['suppressed: auction_not_live'], watched_opt_out: ['suppressed: no_consent'],
      watched_soft_close: ['SENT', 'suppressed: already_sent'] };
    for (const s of scenarios.list()) expect([s.key, scenarios.run(s.key).steps.filter((x) => x.decision).map((x) => x.decision)]).toEqual([s.key, want[s.key]]);
  });
  test('the outbid hook runs AFTER the bid commits and cannot affect it; the old single-flag SMS path is gone', () => {
    const bid = read('src/services/bidService.js');
    expect(bid.indexOf("require('./auctionSmsService').onOutbid")).toBeGreaterThan(bid.indexOf("await client.query('COMMIT');"));
    expect(bid).toMatch(/Promise\.resolve\(\)\.then\(\(\) => require\('\.\/auctionSmsService'\)\.onOutbid[\s\S]*?\.catch\(/);
    const worker = read('src/workers/notificationWorker.js');
    expect(worker).not.toMatch(/userInfo\.sms_enabled && userInfo\.sms_consent/);
    expect(worker).toMatch(/auctionSmsService'\)\.processPending/);
  });
  test('migration 189 ships every new switch OFF and tightens Phone Sasha codes for 4 digits', () => {
    const m = read('db/migrations/189_bidder_phone_sms_paylinks.sql');
    for (const k of ['bidder_phone.required', 'bidder_phone.verification_enabled', 'auction_sms.enabled', 'auction_sms.a2p_confirmed', 'auction_sms.offer_opt_in']) {
      expect(m).toMatch(new RegExp(`\\('${k.replace('.', '\\.')}', 'false'::jsonb`));
    }
    expect(m).toMatch(/sasha\.phone\.code_ttl_minutes' AND value = '10'/);
    expect(m).toMatch(/sasha\.phone\.code_max_attempts' AND value = '5'/);
  });
  test('public pickup wording matches the product: the full address is emailed after payment', () => {
    const view = read('public/auction-view.html'); const faq = read('public/buyer-faq.html');
    expect(view).not.toMatch(/exact street number is shown after your payment is verified/);
    expect(view).toMatch(/Winning bidders receive the full pickup address by email once their payment is confirmed\./);
    expect(faq).not.toMatch(/released in your account/);
    expect(faq).toMatch(/we email you the full pickup address along with your pickup details/);
  });
  test('Super Admin gates on the new tester and switch endpoints', () => {
    const r = read('src/routes/adminSasha.js');
    expect(r).toMatch(/router\.post\('\/phone\/sim\/test-accounts', superAdminOnly/);
    expect(r).toMatch(/router\.post\('\/phone\/sms-scenarios\/:key', superAdminOnly/);
    expect(r).toMatch(/router\.post\('\/phone\/bidder-sms-settings', superAdminOnly/);
    expect(r).toMatch(/Confirm the A2P campaign covers these texts before turning them on/);
  });
});

// ── consent versions, STOP/START/HELP sync, do-not-text list (migration 190) ─────────────────────────
describe('versioned consent, STOP / START / HELP sync and the do-not-text list', () => {
  const supp = require('../../src/services/smsSuppressionService');
  const inbound = require('../../src/routes/smsInbound');
  const e164Of = (n) => require('../../src/lib/phoneNumber').normalizeUsPhone(n).e164;
  let sidSeq = 0; const sid = () => 'SM' + String(++sidSeq).padStart(32, '0');

  test('verifying a phone never creates text-alert consent', async () => {
    const u = await user({});
    await verifyByCode(u.id, freshNumber());
    expect(await q(`SELECT * FROM sms_consents WHERE user_id = $1`, [u.id])).toHaveLength(0);
    expect(await consent.get(u.id)).toMatchObject({ outbid: { opted_in: false }, watched_closing: { opted_in: false } });
  });
  test('opt-in is refused for a stale page (wrong version or a different number shown) and for any source other than the two website pages', async () => {
    await setCfg('auction_sms.offer_opt_in', true);
    const u = await user({ phone: freshNumber(), verified: true });
    const sh = await shown(u.id);
    await expect(consent.set(u.id, 'outbid', true, { source: 'notification_settings', consentVersion: 'sms-alerts-v1', shownLast4: sh.shownLast4 })).rejects.toMatchObject({ code: 'STALE_CONSENT' });
    await expect(consent.set(u.id, 'outbid', true, { source: 'notification_settings', consentVersion: sh.consentVersion, shownLast4: '9999' })).rejects.toMatchObject({ code: 'STALE_CONSENT' });
    await expect(consent.set(u.id, 'outbid', true, { source: 'notification_settings' })).rejects.toMatchObject({ code: 'STALE_CONSENT' });
    for (const source of ['admin', 'sms_keyword']) await expect(consent.set(u.id, 'outbid', true, { source, ...sh })).rejects.toMatchObject({ code: 'BAD_SOURCE' });
    expect(await q(`SELECT * FROM sms_consents WHERE user_id = $1`, [u.id])).toHaveLength(0);
  });
  test('a stale registration choice never undoes the registration; nothing is recorded and the page is told why', async () => {
    await setCfg('auction_sms.offer_opt_in', true);
    const { a } = await auctionWithLot();
    const u = await user({ phone: freshNumber(), verified: true });
    const r = await registration.registerForAuction(u.id, a.id, { pickupAcknowledged: true, smsOptIn: { outbid: true, consent_version: 'old', shown_last4: '0000' } });
    expect(r.status).toBe('active');
    expect(r.sms_alerts).toMatchObject({ recorded: false, message: expect.stringMatching(/Reload/) });
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(false);
  });
  test('outbid and watched-closing consent are separate rows, each with its own exact wording', async () => {
    const u = await user({ phone: freshNumber(), verified: true });
    await optIn(u.id, 'watched_closing', 'auction_registration');
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(false);
    expect(await consent.isOptedIn(u.id, 'watched_closing')).toBe(true);
    const rows = await q(`SELECT sms_type, consent_text FROM sms_consents WHERE user_id = $1`, [u.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].consent_text).toMatch(/Yes, text me Advantage\.Bid reminders about 1 hour before lots begin closing in auctions I watch/);
  });
  test('the registration panel offer carries the exact wording to render; the bid gate exposes it', async () => {
    await setCfg('auction_sms.offer_opt_in', true);
    const { a } = await auctionWithLot();
    const u = await user({ phone: freshNumber(), verified: true });
    const g = await registration.getRegistrationStatus(u.id, a.id);
    expect(g.sms_offer).toMatchObject({ offer: true, current: { outbid: false, watched_closing: false } });
    const p = g.sms_offer.presentation;
    expect(p).toMatchObject({ consent_version: consent.CONSENT_VERSION, heading: 'Optional text alerts from Advantage.Bid', phone_last4: (await shown(u.id)).shownLast4,
      links: [{ text: 'Terms', href: '/terms.html' }, { text: 'Privacy Policy', href: '/privacy.html' }] });
    expect(p.labels.outbid).toBe('Yes, text me Advantage.Bid outbid alerts (at most one text per lot every 5 minutes).');
    expect(p.disclosure).toMatch(/^Optional\. Not required to register or bid\. Texts go to your verified number ending in \d{4}\. Message frequency varies\. Msg & data rates may apply\. Reply STOP to opt out, HELP for help\./);
    await setCfg('auction_sms.offer_opt_in', false);
    expect((await registration.getRegistrationStatus(u.id, a.id)).sms_offer).toEqual({ offer: false });
  });
  test('a consent counts only for the number it was given for: a new verified number stops alerts until the customer opts in again', async () => {
    const u = await user({ password: 'pw-123456' });
    await verifyByCode(u.id, freshNumber());
    await optIn(u.id, 'outbid');
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(true);
    await verifyByCode(u.id, freshNumber(), { currentPassword: 'pw-123456' });
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(false);
    expect((await consent.get(u.id)).outbid).toMatchObject({ opted_in: false, needs_reconfirm: true });
    await optIn(u.id, 'outbid');
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(true);
  });
  test('STOP: number suppressed, both alert types off; opt-in refused while suppressed; START releases the number but does NOT turn alerts back on', async () => {
    const n = freshNumber(); const e164 = e164Of(n);
    const u = await user({}); await verifyByCode(u.id, n);
    await optIn(u.id, 'outbid'); await optIn(u.id, 'watched_closing');
    expect(await inbound.processInbound({ MessageSid: sid(), From: e164, Body: 'stop' })).toMatchObject({ status: 'processed', action: 'stop', accounts: 1, changed: 2 });
    expect(await supp.isSuppressed(e164)).toBe(true);
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(false);
    expect(await consent.isOptedIn(u.id, 'watched_closing')).toBe(false);
    await expect(optIn(u.id, 'outbid')).rejects.toMatchObject({ code: 'NUMBER_OPTED_OUT' });
    expect(await inbound.processInbound({ MessageSid: sid(), From: e164, Body: 'START' })).toMatchObject({ status: 'processed', action: 'start' });
    expect(await supp.isSuppressed(e164)).toBe(false);
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(false);   // still off: START never re-enables alerts
    expect(await consent.isOptedIn(u.id, 'watched_closing')).toBe(false);
    await optIn(u.id, 'outbid');                                   // the customer opts in again on the website
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(true);
  });
  test('HELP / INFO and other messages change nothing and create no consent; the message body is never stored', async () => {
    const n = freshNumber(); const e164 = e164Of(n);
    const u = await user({}); await verifyByCode(u.id, n);
    for (const Body of ['HELP', 'info', 'what is my bid status? card 4111 1111 1111 1111']) await inbound.processInbound({ MessageSid: sid(), From: e164, Body });
    expect(await q(`SELECT * FROM sms_consents WHERE user_id = $1`, [u.id])).toHaveLength(0);
    expect(await supp.isSuppressed(e164)).toBe(false);
    const rows = await q(`SELECT * FROM sms_inbound_events WHERE from_last4 = $1 ORDER BY created_at`, [e164.slice(-4)]);
    expect(rows.map((r) => r.action)).toEqual(['help', 'help', 'other']);
    expect(JSON.stringify(rows)).not.toMatch(/4111|bid status/);
    expect(JSON.stringify(rows)).not.toContain(e164);
  });
  test('each provider message id is processed once (retries are harmless)', async () => {
    const n = freshNumber(); const e164 = e164Of(n);
    const u = await user({}); await verifyByCode(u.id, n); await optIn(u.id, 'outbid');
    const id = sid();
    expect(await inbound.processInbound({ MessageSid: id, From: e164, Body: 'STOP' })).toMatchObject({ status: 'processed' });
    expect(await inbound.processInbound({ MessageSid: id, From: e164, Body: 'STOP' })).toEqual({ status: 'duplicate' });
    expect((await q(`SELECT count(*)::int n FROM sms_consent_events WHERE user_id = $1 AND action = 'opt_out'`, [u.id]))[0].n).toBe(1);
  });
  test('the webhook refuses unsigned or badly signed requests and answers signed ones with empty TwiML', async () => {
    const prev = { a: process.env.TWILIO_ACCOUNT_SID, t: process.env.TWILIO_AUTH_TOKEN };
    const res = () => { const r = { code: null, body: null, type() { return r; }, status(c) { r.code = c; return r; }, send(b) { r.body = b; return r; } }; return r; };
    const req = (sig, body) => ({ originalUrl: '/api/sms/inbound', body, get: (h) => ({ 'x-twilio-signature': sig, host: 'bid.advantage.bid' })[h.toLowerCase()] });
    try {
      delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_ACCOUNT_SID;
      let r = res(); await inbound.handler()(req('sig', {}), r); expect(r.code).toBe(503);
      process.env.TWILIO_ACCOUNT_SID = 'AC_test_placeholder'; process.env.TWILIO_AUTH_TOKEN = 'test-token-placeholder';
      const seen = [];
      const validateRequest = (token, sig, url) => { seen.push(url); return sig === 'good' && token === 'test-token-placeholder'; };
      r = res(); await inbound.handler({ validateRequest })(req(undefined, { MessageSid: sid(), From: '+15516201234', Body: 'STOP' }), r); expect(r.code).toBe(403);
      r = res(); await inbound.handler({ validateRequest })(req('bad', { MessageSid: sid(), From: '+15516201234', Body: 'STOP' }), r); expect(r.code).toBe(403);
      r = res(); await inbound.handler({ validateRequest })(req('good', { MessageSid: sid(), From: '+15516209876', Body: 'HELP' }), r);
      expect(r.code).toBe(200); expect(r.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      expect(seen).toContain('https://bid.advantage.bid/api/sms/inbound');
    } finally {
      if (prev.a === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = prev.a;
      if (prev.t === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = prev.t;
    }
    expect(read('server.js')).toMatch(/app\.use\('\/api\/sms', require\('\.\/src\/routes\/smsInbound'\)\)/);
  });
  test('a suppressed number is never texted an alert, even when a sender is available', async () => {
    await setCfg('auction_sms.enabled', true);
    try {
      const { lot } = await auctionWithLot();
      const u = await outbidBidder(lot);
      const e164 = (await q(`SELECT phone_verified_e164 FROM users WHERE id = $1`, [u.id]))[0].phone_verified_e164;
      await sms.onOutbid({ userId: u.id, lot });
      await supp.suppress(e164, { reason: 'admin' });
      const t = textSender();
      await sms.processPending({}, { sender: t.fn });
      expect(t.sent.filter((x) => x.to === e164)).toHaveLength(0);
      expect((await q(`SELECT suppress_reason FROM auction_sms_messages WHERE user_id = $1`, [u.id])).map((r) => r.suppress_reason)).toContain('number_opted_out');
    } finally { await setCfg('auction_sms.enabled', false); }
  });
  test('a provider "unsubscribed recipient" error (21610) is treated exactly like STOP', async () => {
    const n = freshNumber(); const e164 = e164Of(n);
    const u = await user({}); await verifyByCode(u.id, n); await optIn(u.id, 'outbid');
    expect(await supp.handleSendError(Object.assign(new Error('unsubscribed'), { code: 21610 }), e164)).toBe(true);
    expect(await supp.isSuppressed(e164)).toBe(true);
    expect(await consent.isOptedIn(u.id, 'outbid')).toBe(false);
    expect(await supp.handleSendError(Object.assign(new Error('other'), { code: 30003 }), e164)).toBe(false);
    const row = (await q(`SELECT reason FROM sms_suppressions WHERE phone_last4 = $1 AND status = 'suppressed'`, [e164.slice(-4)]))[0];
    expect(row.reason).toBe('provider_unsubscribed');
  });
  test('the two website pages render the server wording verbatim with unchecked boxes and Terms / Privacy links', () => {
    const bu = read('public/widgets/shared/bid-utils.js');
    expect(bu).toMatch(/cb\.checked = false/);
    expect(bu).toMatch(/sp\.textContent = p\.labels\[k\]/);
    expect(bu).toMatch(/out\.consent_version = wrap\.getAttribute\('data-consent-version'\)/);
    expect(bu).not.toMatch(/Text me if I am outbid/);
    const nt = read('public/notifications.html');
    expect(nt).toMatch(/body\.consent_version = state\.presentation\.consent_version/);
    expect(nt).toMatch(/pr\.links/);
  });
  test('Terms and Privacy: SMS consent is not bundled, the program is disclosed, mobile data is not shared for marketing, and only "Advantage.Bid" is named', () => {
    const terms = read('public/terms.html'); const privacy = read('public/privacy.html');
    for (const doc of [terms, privacy, read('public/data-deletion.html')]) expect(doc).not.toMatch(/Advantage Auction Company|\bAAC\b/i);
    expect(terms).toMatch(/\*\*Text messages are not part of this consent\.\*\* Advantage\.Bid sends text messages only as described in Section 6A\./);
    expect(terms).toMatch(/## 6A\. Text Messages \(SMS\)/);
    expect(terms).not.toMatch(/may contact you by email, phone, text message/);
    expect(privacy).not.toMatch(/you consent to receive transactional communications including/);
    expect(privacy).toMatch(/does not sign you up for text messages/);
    expect(privacy).toMatch(/We do not sell, rent, or share your mobile phone number, or your text message opt-in data and consent, with third parties or affiliates for their marketing or promotional purposes\./);
    expect(privacy).toMatch(/with service providers who deliver our text messages/);
    for (const doc of [terms, privacy]) { expect(doc).toMatch(/Message frequency varies/); expect(doc).toMatch(/Reply STOP/); expect(doc).toMatch(/HELP/); }
  });
});
