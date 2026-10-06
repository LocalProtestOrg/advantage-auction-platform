'use strict';

/**
 * R-1 Seller Activation (migration 187): stage logic from platform facts, 72h / 7d timing, caps, every guard (fail
 * closed), Auction Partner relationship ownership, shadow mode sends nothing, live re-evaluation before send,
 * duplicate prevention, Sasha outbound composition (no em dashes, verified facts only) and the pro-signup funnel fix.
 * No network: db, email and Sasha settings are stubbed.
 */

delete process.env.PUBLIC_APP_URL;
const fs = require('fs');
const path = require('path');

let ROUTES = [];
const calls = [];
const route = (re, fn) => ROUTES.push([re, fn]);
async function mockQ(sql, params) {
  calls.push({ sql, params });
  for (const [re, fn] of ROUTES) if (re.test(sql)) { const r = await fn(sql, params); return Object.assign({ rows: [], rowCount: (r && r.rows || []).length }, r); }
  return { rows: [], rowCount: 0 };
}
jest.mock('../src/db', () => ({
  query: jest.fn((s, p) => mockQ(s, p)),
  connect: jest.fn(async () => ({ query: (s, p) => mockQ(s, p), release: () => {} })),
}));

const sa = require('../src/services/sellerActivationService');
const sashaSettings = require('../src/services/sasha/settings');

beforeEach(() => { ROUTES = []; calls.length = 0; sashaSettings.clear(); });

const NOW = new Date('2026-10-07T15:00:00Z');   // Wednesday 11:00 ET
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();
const CFG = { ...sa.DEFAULTS, enabled: true, mode: 'shadow' };
const LIVE = { ...CFG, mode: 'live' };
const seller = (o = {}) => Object.assign({ seller_profile_id: '11111111-1111-4111-8111-111111111111', user_id: '22222222-2222-4222-8222-222222222222',
  seller_type: 'private', display_name: 'Pat Seller', created_at: hoursAgo(200), email: 'pat.seller@gmail.com', full_name: 'Pat Seller', role: 'seller',
  staff_role: null, user_is_demo: false, sp_is_demo: false, user_active: true, marketing_internal: false, agreement_waived_at: null,
  agreement_signed_at: hoursAgo(100), verification_flag: false, verification_status: null, verification_approved: false, verification_updated_at: null,
  published_auctions: 0, submitted_auctions: 0, draft_auctions: 0, rejected_auctions: 0, total_auctions: 0, submitted_ever: 0, last_auction_at: null,
  last_lot_at: null, draft_id: null, draft_title: null, draft_timezone: null, draft_state: null, draft_lots: null, default_pickup_state: 'NJ' }, o);
const hist = (o = {}) => Object.assign({ touches_total: 0, touches_by_stage: {}, sent_today: 0 }, o);
const run = (f, h = hist(), cfg = CFG, now = NOW) => { const s = sa.computeStage(f); return { s, d: sa.decide(f, s, h, cfg, now) }; };

// ── stages ────────────────────────────────────────────────────────────────────────────────────────────
describe('stage logic (computed from platform facts)', () => {
  test('unsigned agreement → onboarding incomplete, seller-owned, "finish setup" check-in', () => {
    const { s, d } = run(seller({ agreement_signed_at: null }));
    expect(s).toMatchObject({ stage: 'onboarding_incomplete', blocker: 'agreement_unsigned', next_owner: 'seller', message_category: 'onboarding_incomplete' });
    expect(d.decision).toBe('would_contact');
  });
  test('waived agreement counts as onboarding complete', () => {
    expect(run(seller({ agreement_signed_at: null, agreement_waived_at: hoursAgo(300) })).s.stage).toBe('ready_no_auction');
  });
  test('ready with no auction → "start your first auction"', () => {
    const { s, d } = run(seller());
    expect(s).toMatchObject({ stage: 'ready_no_auction', blocker: 'no_auction_created', next_owner: 'seller', message_category: 'ready_no_auction' });
    expect(d.decision).toBe('would_contact');
  });
  test('stalled draft → draft started, "finish your draft"', () => {
    const { s, d } = run(seller({ draft_auctions: 1, total_auctions: 1, draft_id: 'a1', draft_title: 'Estate contents', draft_lots: 12, last_auction_at: hoursAgo(90), last_lot_at: hoursAgo(80) }));
    expect(s).toMatchObject({ stage: 'draft_started', blocker: 'draft_incomplete', message_category: 'draft_stalled' });
    expect(d.decision).toBe('would_contact');
  });
  test('auction returned for changes is seller-owned', () => {
    expect(run(seller({ rejected_auctions: 1, total_auctions: 1, submitted_ever: 1, draft_id: 'a1', draft_state: 'rejected' })).s.blocker).toBe('auction_returned_for_changes');
  });
  test('submitted auction → Advantage.Bid owns the next action: staff attention, never a nudge', () => {
    const { s, d } = run(seller({ submitted_auctions: 1, submitted_ever: 1, total_auctions: 1 }));
    expect(s).toMatchObject({ stage: 'submitted_waiting', next_owner: 'advantage' });
    expect(d).toMatchObject({ decision: 'staff_attention', guard: 'ADVANTAGE_OWNS_NEXT_ACTION', needs_staff_attention: true });
  });
  test('verification documents waiting on Advantage.Bid review → staff attention, no nudge', () => {
    const { s, d } = run(seller({ seller_type: 'auction_house', verification_status: 'submitted', verification_updated_at: hoursAgo(120) }));
    expect(s).toMatchObject({ stage: 'onboarding_incomplete', blocker: 'verification_review_pending', next_owner: 'advantage' });
    expect(d.decision).toBe('staff_attention');
  });
  test('published → activated; outreach ends', () => {
    const { s, d } = run(seller({ published_auctions: 1, total_auctions: 1, submitted_ever: 1 }));
    expect(s.stage).toBe('activated');
    expect(d).toMatchObject({ decision: 'complete', guard: 'ACTIVATED' });
  });
  test('Professional Seller: verification documents needed is a seller-owned setup step; approved verification moves on', () => {
    const pro = seller({ seller_type: 'estate_sale_company', verification_status: 'open', verification_updated_at: hoursAgo(100) });
    expect(run(pro).s).toMatchObject({ stage: 'onboarding_incomplete', blocker: 'verification_documents_needed', next_owner: 'seller' });
    expect(run(pro).d.decision).toBe('would_contact');
    expect(run({ ...pro, verification_approved: true }).s.stage).toBe('ready_no_auction');
  });
  test('last progress is the latest of signup, signature, verification, auction and lot activity', () => {
    const s = sa.computeStage(seller({ draft_auctions: 1, draft_id: 'a', last_auction_at: hoursAgo(60), last_lot_at: hoursAgo(10) }));
    expect(s.last_progress_at).toBe(hoursAgo(10));
  });
});

// ── timing ────────────────────────────────────────────────────────────────────────────────────────────
describe('timing: 72h first check-in, 7 days for the second, progress resets the clock', () => {
  test('71h of no progress waits; 73h is due', () => {
    expect(run(seller({ agreement_signed_at: hoursAgo(71), created_at: hoursAgo(80) })).d).toMatchObject({ decision: 'waiting', guard: 'NOT_DUE' });
    expect(run(seller({ agreement_signed_at: hoursAgo(73), created_at: hoursAgo(80) })).d.decision).toBe('would_contact');
  });
  test('second check-in only 7 days after the first in the same stage', () => {
    const f = seller({ agreement_signed_at: hoursAgo(400), created_at: hoursAgo(500) });
    const h6 = hist({ touches_total: 1, touches_by_stage: { ready_no_auction: 1 }, last_touch_at: hoursAgo(6 * 24), last_stage_touch_at: hoursAgo(6 * 24) });
    expect(run(f, h6).d).toMatchObject({ decision: 'waiting', guard: 'COOLDOWN' });
    const h8 = hist({ touches_total: 1, touches_by_stage: { ready_no_auction: 1 }, last_touch_at: hoursAgo(8 * 24), last_stage_touch_at: hoursAgo(8 * 24) });
    expect(run(f, h8).d).toMatchObject({ decision: 'would_contact', attempt: 2, stage_attempt: 2 });
  });
  test('progress after a check-in resets the clock to 72h from that progress', () => {
    const f = seller({ agreement_signed_at: hoursAgo(400), draft_auctions: 1, draft_id: 'a', last_auction_at: hoursAgo(20) });
    const h = hist({ touches_total: 1, touches_by_stage: { ready_no_auction: 1 }, last_touch_at: hoursAgo(9 * 24) });
    expect(run(f, h).d).toMatchObject({ decision: 'waiting', guard: 'NOT_DUE' });
  });
  test('a new stage never gets a check-in within 72h of the previous one (cooldown across stages)', () => {
    const f = seller({ agreement_signed_at: hoursAgo(100) });
    const h = hist({ touches_total: 1, touches_by_stage: { onboarding_incomplete: 1 }, last_touch_at: hoursAgo(30) });
    expect(run(f, h).d).toMatchObject({ decision: 'waiting', guard: 'COOLDOWN' });
  });
});

// ── caps and guards ───────────────────────────────────────────────────────────────────────────────────
describe('guards (each blocks contact)', () => {
  const due = seller({ agreement_signed_at: null });
  test.each([
    ['opted out', { opted_out: true }, 'ACTIVATION_OPT_OUT'],
    ['suppression list', { suppressed: 'global: unsubscribe' }, 'SUPPRESSION_LIST'],
    ['known bounce', { bounced: true }, 'KNOWN_BOUNCE'],
    ['seller replied', { replied: true }, 'SELLER_REPLIED'],
    ['Sasha conversation taken over by staff', { takeover: true }, 'HUMAN_TAKEOVER'],
    ['open or staff-owned conversation', { open_conversation: 'Ref SABC123, open' }, 'OPEN_CONVERSATION'],
    ['recent human communication', { recent_human: 'staff email 2026-10-01' }, 'RECENT_HUMAN_CONTACT'],
    ['staff relationship owner', { staff_owner: 'contact lock until 2026-10-19' }, 'STAFF_RELATIONSHIP_OWNER'],
    ['another programme holds the company', { other_programme: 'claimed listing sequence' }, 'OTHER_PROGRAMME_CONTACT'],
    ['an earlier send failed', { send_failed: true }, 'PREVIOUS_SEND_FAILED'],
  ])('%s', (_n, h, guard) => {
    const d = run(due, hist(h)).d;
    expect(d.guard).toBe(guard);
    expect(d.decision).not.toBe('would_contact');
  });
  test('a real seller with a malformed account email is staff attention, never excluded and never guessed', () => {
    for (const email of ['laviedavelineshop.com', 'cjeannot05301955']) {
      expect(run(seller({ email })).d).toMatchObject({ decision: 'staff_attention', guard: 'INVALID_ACCOUNT_EMAIL', needs_staff_attention: true });
    }
  });
  test('a failed safety lookup blocks contact (fail closed)', () => {
    expect(run(due, hist({ lookup_error: 'timeout' })).d).toMatchObject({ decision: 'suppressed', guard: 'LOOKUP_FAILED' });
  });
  test('max 2 per stage and 3 per seller', () => {
    expect(run(due, hist({ touches_total: 2, touches_by_stage: { onboarding_incomplete: 2 }, last_touch_at: hoursAgo(900) })).d.guard).toBe('STAGE_CAP');
    expect(run(seller(), hist({ touches_total: 3, touches_by_stage: { onboarding_incomplete: 2, draft_started: 1 }, last_touch_at: hoursAgo(900) })).d.guard).toBe('SELLER_CAP');
  });
  test('daily cap holds live sends', () => {
    expect(run(due, hist({ sent_today: 6 }), LIVE).d).toMatchObject({ decision: 'waiting', guard: 'DAILY_CAP' });
  });
  test.each([
    ['demo user', { user_is_demo: true }, 'DEMO_ACCOUNT'], ['demo seller profile', { sp_is_demo: true }, 'DEMO_ACCOUNT'],
    ['admin', { role: 'admin' }, 'INTERNAL_ACCOUNT'], ['staff', { staff_role: 'sales_rep' }, 'INTERNAL_ACCOUNT'],
    ['internal domain', { email: 'ty@advantage.bid' }, 'INTERNAL_ACCOUNT'], ['internal contact', { marketing_internal: true }, 'INTERNAL_ACCOUNT'],
    ['test address', { email: 'qa.test.seller@gmail.com' }, 'TEST_ACCOUNT'], ['example address', { email: 'seller@example.com' }, 'TEST_ACCOUNT'],
    ['inactive', { user_active: false }, 'INACTIVE_ACCOUNT'], ['SES simulator', { email: 'oat-seller-1@simulator.amazonses.com' }, 'TEST_ACCOUNT'],
  ])('excluded: %s', (_n, o, guard) => {
    expect(run(seller({ agreement_signed_at: null, ...o })).d).toMatchObject({ decision: 'excluded', guard });
  });
});

describe('Auction Partners stay with the relationship owner', () => {
  test('an Auction Partner seller is never nudged: staff attention for Ty, regardless of any contact lock', () => {
    const d = run(seller({ seller_type: 'auction_house', verification_status: 'open' }), hist({ auction_partner: { id: 'fp1', name: 'Ashbury', released: false, owner_user_id: 'ty' } })).d;
    expect(d).toMatchObject({ decision: 'staff_attention', guard: 'AUCTION_PARTNER_RELATIONSHIP_OWNER', needs_staff_attention: true });
  });
  test('the Auction Partner rule outranks every other path, including a submitted auction', () => {
    const d = run(seller({ submitted_auctions: 1, submitted_ever: 1 }), hist({ auction_partner: { id: 'fp1', name: 'Ashbury', released: false } })).d;
    expect(d.guard).toBe('AUCTION_PARTNER_RELATIONSHIP_OWNER');
  });
  test('only after Ty explicitly releases the partner may Sasha check in', () => {
    const d = run(seller({ agreement_signed_at: null }), hist({ auction_partner: { id: 'fp1', name: 'Ashbury', released: true } })).d;
    expect(d.decision).toBe('would_contact');
  });
  test('an Auction Partner prospect with no seller account is never evaluated: R-1 reads seller profiles only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sellerActivationService.js'), 'utf8');
    expect(src).toMatch(/FROM seller_profiles sp JOIN users u ON u\.id = sp\.user_id/);
    expect(src).not.toMatch(/FROM founding_partners[^`]*JOIN users/);
  });
  test('a prospect who signs up through the normal path is matched by business email, corporate domain or company link', async () => {
    const f = seller({ email: 'owner@ashburylane.com' });
    route(/FROM founding_partners/, () => ({ rows: [{ id: 'fp1', company_id: 'co1', seller_profile_id: null, organization_id: null, status: 'prospect', display_name: 'Ashbury Lane', relationship_owner_user_id: 'ty', sasha_assist_released_at: null }] }));
    route(/FROM company_identities WHERE lower\(corporate_email_domain\)/, () => ({ rows: [{ id: 'co1', d: 'ashburylane.com' }] }));
    route(/count\(\*\)::int n FROM seller_activation_touches/, () => ({ rows: [{ n: 0 }] }));
    const h = (await sa.loadHistory([f], CFG, require('../src/db'), NOW)).get(f.seller_profile_id);
    expect(h.auction_partner).toMatchObject({ id: 'fp1', released: false });
    expect(sa.decide(f, sa.computeStage(f), h, CFG, NOW).guard).toBe('AUCTION_PARTNER_RELATIONSHIP_OWNER');
  });
});

// ── history facts from the Shared Inbox and ledger ───────────────────────────────────────────────────
describe('history facts', () => {
  const f = seller();
  const base = () => { route(/count\(\*\)::int n FROM seller_activation_touches/, () => ({ rows: [{ n: 0 }] })); };
  test('reply after the first check-in is detected (Shared Inbox)', async () => {
    base();
    route(/FROM seller_activation_touches\s+WHERE seller_profile_id = ANY/, () => ({ rows: [{ seller_profile_id: f.seller_profile_id, stage: 'ready_no_auction', decision: 'contacted', conversation_id: 'c1', created_at: hoursAgo(50) }] }));
    route(/FROM cs_conversations c/, () => ({ rows: [{ id: 'c1', ref: 'SABC123', status: 'open', owner: 'sasha', handoff_state: 'none', customer_email: 'pat.seller@gmail.com', last_inbound_at: hoursAgo(5), last_message_at: hoursAgo(5) }] }));
    const h = (await sa.loadHistory([f], CFG, require('../src/db'), NOW)).get(f.seller_profile_id);
    expect(h.replied).toBe(true);
    expect(sa.decide(f, sa.computeStage(f), h, CFG, NOW).guard).toBe('SELLER_REPLIED');
  });
  test('staff taking over the check-in conversation is detected', async () => {
    base();
    route(/FROM seller_activation_touches\s+WHERE seller_profile_id = ANY/, () => ({ rows: [{ seller_profile_id: f.seller_profile_id, stage: 'ready_no_auction', decision: 'contacted', conversation_id: 'c1', created_at: hoursAgo(50) }] }));
    route(/FROM cs_conversations c/, () => ({ rows: [{ id: 'c1', ref: 'SABC123', status: 'waiting_customer', owner: 'staff', handoff_state: 'taken', customer_email: 'pat.seller@gmail.com' }] }));
    expect((await sa.loadHistory([f], CFG, require('../src/db'), NOW)).get(f.seller_profile_id).takeover).toBe(true);
  });
  test('a recent staff email or rep note is recent human contact; an old one is not', async () => {
    base();
    route(/FROM cs_conversations c/, () => ({ rows: [{ id: 'c9', ref: 'SXYZ987', status: 'resolved', owner: 'sasha', handoff_state: 'none', customer_email: 'pat.seller@gmail.com', last_staff_at: hoursAgo(48), last_message_at: hoursAgo(48) }] }));
    expect((await sa.loadHistory([f], CFG, require('../src/db'), NOW)).get(f.seller_profile_id).recent_human).toMatch(/staff email/);
    ROUTES = []; base();
    route(/FROM cs_conversations c/, () => ({ rows: [{ id: 'c9', ref: 'SXYZ987', status: 'resolved', owner: 'sasha', handoff_state: 'none', customer_email: 'pat.seller@gmail.com', last_staff_at: hoursAgo(24 * 30), last_message_at: hoursAgo(24 * 30) }] }));
    expect((await sa.loadHistory([f], CFG, require('../src/db'), NOW)).get(f.seller_profile_id).recent_human).toBeNull();
  });
  test('a suppressed address and a hard bounce are found', async () => {
    base();
    route(/FROM email_suppressions WHERE normalized_email/, () => ({ rows: [{ src: 'global', reason: 'unsubscribe' }] }));
    route(/FROM email_deliverability/, () => ({ rows: [{ normalized_email: 'pat.seller@gmail.com', hard_bounced: true }] }));
    const h = (await sa.loadHistory([f], CFG, require('../src/db'), NOW)).get(f.seller_profile_id);
    expect(h.suppressed).toMatch(/global/);
    expect(h.bounced).toBe(true);
  });
  test('any failed lookup marks the seller lookup_error (fail closed)', async () => {
    route(/FROM seller_activation_touches/, () => { throw new Error('db down'); });
    const h = (await sa.loadHistory([f], CFG, require('../src/db'), NOW)).get(f.seller_profile_id);
    expect(h.lookup_error).toMatch(/db down/);
    expect(sa.decide(f, sa.computeStage(f), h, CFG, NOW).guard).toBe('LOOKUP_FAILED');
  });
  test('the second-touch interval is computed from the ledger (7 days after the first check-in in this stage)', async () => {
    const f2 = seller({ agreement_signed_at: hoursAgo(400), created_at: hoursAgo(500) });
    const at = (days) => { ROUTES = []; base();
      route(/FROM seller_activation_touches\s+WHERE seller_profile_id = ANY/, () => ({ rows: [{ seller_profile_id: f2.seller_profile_id, stage: 'ready_no_auction', decision: 'contacted', conversation_id: null, created_at: hoursAgo(days * 24) }] })); };
    at(6);
    let h = (await sa.loadHistory([f2], CFG, require('../src/db'), NOW)).get(f2.seller_profile_id);
    expect(sa.decide(f2, sa.computeStage(f2), h, CFG, NOW)).toMatchObject({ decision: 'waiting', guard: 'COOLDOWN' });
    at(8);
    h = (await sa.loadHistory([f2], CFG, require('../src/db'), NOW)).get(f2.seller_profile_id);
    expect(sa.decide(f2, sa.computeStage(f2), h, CFG, NOW)).toMatchObject({ decision: 'would_contact', attempt: 2, stage_attempt: 2 });
  });
  test('only LIVE contacted rows count toward caps (shadow decisions never consume a touch)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sellerActivationService.js'), 'utf8');
    expect(src).toMatch(/mode = 'live' AND decision IN \('contacted','send_failed'\)/);
  });
});

// ── send window ───────────────────────────────────────────────────────────────────────────────────────
describe('send window', () => {
  test('seller time zone from a reliable source; multi-zone states fall back to the safe Eastern window', () => {
    expect(sa.timezoneFor(seller({ default_pickup_state: 'NJ' }))).toMatchObject({ tz: 'America/New_York', source: 'pickup_state', start: 10, end: 16 });
    expect(sa.timezoneFor(seller({ default_pickup_state: 'TX' }))).toMatchObject({ source: 'fallback_eastern', start: 11, end: 16 });
    expect(sa.timezoneFor(seller({ default_pickup_state: null }))).toMatchObject({ source: 'fallback_eastern' });
    expect(sa.timezoneFor(seller({ draft_timezone: 'America/Chicago', default_pickup_state: 'TX' }))).toMatchObject({ tz: 'America/Chicago', source: 'auction_timezone' });
  });
  test('weekdays and business hours only', () => {
    const w = { tz: 'America/New_York', start: 10, end: 16 };
    expect(sa.inWindow(new Date('2026-10-07T15:00:00Z'), w)).toBe(true);    // Wed 11:00 ET
    expect(sa.inWindow(new Date('2026-10-07T22:00:00Z'), w)).toBe(false);   // Wed 18:00 ET
    expect(sa.inWindow(new Date('2026-10-10T15:00:00Z'), w)).toBe(false);   // Sat
    expect(sa.nextWindowStart(new Date('2026-10-10T15:00:00Z'), w).toISOString()).toBe('2026-10-12T14:00:00.000Z');   // Mon 10:00 ET
  });
  test('live mode waits outside the window; shadow records the would-send time', () => {
    const sat = new Date('2026-10-10T15:00:00Z');
    expect(run(seller({ agreement_signed_at: null }), hist(), LIVE, sat).d).toMatchObject({ decision: 'waiting', guard: 'OUTSIDE_SEND_WINDOW' });
    expect(run(seller({ agreement_signed_at: null }), hist(), CFG, sat).d).toMatchObject({ decision: 'would_contact', send_at: '2026-10-12T14:00:00.000Z' });
  });
});

// ── messages ──────────────────────────────────────────────────────────────────────────────────────────
describe('Sasha check-in messages (verified facts, no em dashes, not marketing)', () => {
  const cases = [
    seller({ agreement_signed_at: null }),
    seller(),
    seller({ draft_auctions: 1, draft_id: 'a', draft_title: 'Mid—century\nfurniture', draft_lots: 12 }),
    seller({ rejected_auctions: 1, draft_id: 'a', draft_state: 'rejected', draft_title: 'Tools' }),
    seller({ seller_type: 'auction_house', verification_status: 'more_info' }),
  ];
  test.each(cases.map((c, i) => [i, c]))('case %i composes a safe message', (_i, f) => {
    const { s, d } = run(f);
    const m = sa.composeMessage(f, s, d);
    expect(m).toBeTruthy();
    expect(m.text + m.subject).not.toMatch(/[—–]/);
    expect(m.text).toMatch(/^Hi Pat,/);
    expect(m.text).toMatch(/This is Sasha from Advantage\.Bid/);
    expect(m.text).toMatch(/reply to this email/);
    expect(m.text + m.subject).not.toMatch(/\b(AI|artificial intelligence|GPT|OpenAI|Stripe|Railway|unsubscribe|sale|discount|% off)\b/i);
    for (const u of m.text.match(/https?:\/\/\S+/g) || []) expect(u).toMatch(/^https:\/\/bid\.advantage\.bid\/(my-agreements|seller-create|seller-dashboard)\.html$/);
  });
  test('the draft message uses the real lot count and the 30-lot minimum', () => {
    const f = cases[2]; const { s, d } = run(f);
    expect(sa.composeMessage(f, s, d).text).toMatch(/"Mid-century furniture", and it has 12 lots so far\. An auction needs at least 30 lots before it can be submitted, so you have 18 to go\./);
  });
  test('the second check-in in a stage says it is a follow-up', () => {
    const f = seller(); const s = sa.computeStage(f);
    expect(sa.composeMessage(f, s, { stage_attempt: 2 }).text).toMatch(/I wanted to follow up on my note from last week\./);
  });
  test('no message for a stage Sasha does not handle', () => {
    const f = seller({ submitted_auctions: 1 });
    expect(sa.composeMessage(f, sa.computeStage(f), {})).toBeNull();
  });
});

// ── config, shadow mode, live send ────────────────────────────────────────────────────────────────────
const cfgRows = (o) => ({ rows: Object.entries({ enabled: true, mode: 'shadow', ...o }).map(([k, v]) => ({ key: 'seller_activation.' + k, value: v })) });

describe('switches', () => {
  test('anything other than exactly "live" is shadow; a failed read is disabled', async () => {
    route(/seller_activation\.%/, () => cfgRows({ mode: 'LIVE ' }));
    expect((await sa.config()).mode).toBe('shadow');
    ROUTES = []; route(/seller_activation\.%/, () => { throw new Error('x'); });
    expect(await sa.config()).toMatchObject({ enabled: false, mode: 'shadow' });
  });
  test('the migration ships enabled = true, mode = shadow', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '187_seller_activation.sql'), 'utf8');
    expect(sql).toMatch(/'seller_activation\.enabled', 'true'::jsonb/);
    expect(sql).toMatch(/'seller_activation\.mode', '"shadow"'::jsonb/);
    expect(sql).toMatch(/first_touch_hours', '72'/);
    expect(sql).toMatch(/second_touch_days', '7'/);
  });
});

function liveDb(f, { claim = true, owner = 'sasha', sashaOn = true } = {}) {
  route(/pg_try_advisory_lock/, () => ({ rows: [{ ok: true }] }));
  route(/seller_activation\.%/, () => cfgRows({ mode: 'live' }));
  route(/FROM platform_config/, () => ({ rows: [['enabled', sashaOn], ['engine_enabled', true], ['email_inbound_enabled', true], ['email_autoreply_enabled', true]].map(([k, v]) => ({ key: 'sasha.' + k, value: v })) }));
  route(/FROM seller_profiles sp JOIN users u/, () => ({ rows: [f] }));
  route(/count\(\*\)::int n FROM seller_activation_touches/, () => ({ rows: [{ n: 0 }] }));
  route(/INSERT INTO seller_activation_touches[\s\S]*ON CONFLICT DO NOTHING/, (_s, p) => ({ rows: claim || p[2] !== 'contacted' ? [{ id: 't-' + p[2] }] : [] }));
  route(/INSERT INTO cs_conversations/, () => ({ rows: [{ id: 'c1', ref: 'SABC123', customer_email: 'pat.seller@gmail.com', subject: 'x' }] }));
  route(/SELECT owner, status FROM cs_conversations/, () => ({ rows: [{ owner, status: 'open' }] }));
  route(/INSERT INTO cs_messages/, () => ({ rows: [{ id: 'm1' }] }));
}
const ledger = (decision) => calls.filter((c) => /INSERT INTO seller_activation_touches/.test(c.sql) && c.params && c.params[2] === decision);

describe('shadow mode sends nothing', () => {
  test('runPass in shadow records decisions and never calls the email service or creates a conversation', async () => {
    const f = seller({ agreement_signed_at: null });
    liveDb(f);
    ROUTES = ROUTES.filter(([re]) => !/seller_activation\\\.%/.test(re.source));
    ROUTES.unshift([/seller_activation\.%/, () => cfgRows({ mode: 'shadow' })]);
    const emailService = { sendEmail: jest.fn() };
    const r = await sa.runPass({ now: NOW, deps: { emailService } });
    expect(r).toMatchObject({ mode: 'shadow', evaluated: 1, counts: { would_contact: 1 }, sends: [] });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(calls.some((c) => /INSERT INTO cs_conversations|INSERT INTO cs_messages/.test(c.sql))).toBe(false);
    const row = calls.find((c) => /INSERT INTO seller_activation_touches/.test(c.sql));
    expect(row.params.slice(2, 4)).toEqual(['shadow', 'would_contact']);
  });
  test('sendCheckIn refuses outside live mode', async () => {
    route(/seller_activation\.%/, () => cfgRows({ mode: 'shadow' }));
    expect(await sa.sendCheckIn('x', null, { emailService: { sendEmail: jest.fn() } })).toEqual({ sent: false, reason: 'not_live' });
  });
  test('the Director "Re-evaluate" endpoint never sends, even in live mode', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminDirector.js'), 'utf8');
    expect(src).toMatch(/runPass\(\{ allowSend: false \}\)/);
  });
});

describe('live send (re-evaluated immediately before sending)', () => {
  test('sends one Sasha check-in from the Shared Inbox to the account email, threaded with a Ref', async () => {
    const f = seller({ agreement_signed_at: null }); liveDb(f);
    const emailService = { sendEmail: jest.fn(async () => ({ messageId: 'abc@ses', sesMessageId: 'ses1' })) };
    const r = await sa.sendCheckIn(f.seller_profile_id, { stage: 'onboarding_incomplete', last_progress_at: sa.computeStage(f).last_progress_at }, { emailService, now: NOW });
    expect(r).toMatchObject({ sent: true, ref: 'SABC123' });
    const m = emailService.sendEmail.mock.calls[0][0];
    expect(m).toMatchObject({ to: 'pat.seller@gmail.com', fromName: 'Sasha at Advantage.Bid', mailStream: 'support', subject: 'Finishing your Advantage.Bid seller setup [Ref SABC123]' });
    expect(m.headers).toMatchObject({ 'X-Advantage-Sasha': 'SABC123', 'Auto-Submitted': 'auto-generated' });
    expect(m.text).toMatch(/Ref: SABC123$/);
    expect(ledger('contacted')[0].params[14]).toMatch(/^sa:1111.*:onboarding_incomplete:1:1$/);
  });
  test('progress between selection and send cancels the planned check-in', async () => {
    const f = seller({ agreement_signed_at: hoursAgo(80) }); liveDb(f);
    const emailService = { sendEmail: jest.fn() };
    const r = await sa.sendCheckIn(f.seller_profile_id, { stage: 'onboarding_incomplete', last_progress_at: hoursAgo(200) }, { emailService, now: NOW });
    expect(r).toEqual({ sent: false, reason: 'PROGRESSED' });
    expect(ledger('cancelled')[0].params[6]).toBe('PROGRESSED');
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
  test('publishing after selection cancels (activation complete)', async () => {
    const f = seller({ published_auctions: 1, submitted_ever: 1 }); liveDb(f);
    const emailService = { sendEmail: jest.fn() };
    expect((await sa.sendCheckIn(f.seller_profile_id, { stage: 'ready_no_auction', last_progress_at: f.created_at }, { emailService, now: NOW })).sent).toBe(false);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
  test('duplicate prevention: an already-claimed idempotency key sends nothing', async () => {
    const f = seller({ agreement_signed_at: null }); liveDb(f, { claim: false });
    const emailService = { sendEmail: jest.fn() };
    expect(await sa.sendCheckIn(f.seller_profile_id, null, { emailService, now: NOW })).toEqual({ sent: false, reason: 'DUPLICATE' });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
  test('staff taking over between claim and send stops Sasha', async () => {
    const f = seller({ agreement_signed_at: null }); liveDb(f, { owner: 'staff' });
    const emailService = { sendEmail: jest.fn() };
    expect(await sa.sendCheckIn(f.seller_profile_id, null, { emailService, now: NOW })).toEqual({ sent: false, reason: 'HUMAN_TAKEOVER' });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
  test('Sasha or the Shared Inbox off → no send (replies could not be received)', async () => {
    const f = seller({ agreement_signed_at: null }); liveDb(f, { sashaOn: false });
    const emailService = { sendEmail: jest.fn() };
    expect(await sa.sendCheckIn(f.seller_profile_id, null, { emailService, now: NOW })).toEqual({ sent: false, reason: 'SASHA_UNAVAILABLE' });
  });
  test('a failed send is recorded and blocks further automated touches until a person reviews', async () => {
    const f = seller({ agreement_signed_at: null }); liveDb(f);
    const emailService = { sendEmail: jest.fn(async () => { throw new Error('smtp'); }) };
    expect(await sa.sendCheckIn(f.seller_profile_id, null, { emailService, now: NOW })).toEqual({ sent: false, reason: 'SEND_FAILED' });
    expect(calls.some((c) => /SET decision = 'send_failed'/.test(c.sql))).toBe(true);
  });
});

// ── funnel fix, Director, Auction Partner release, scope ─────────────────────────────────────────────
describe('scope and wiring', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  test('a new Professional Seller signup is recorded as seller_registered (funnel visibility); nothing else in the pro path changed', () => {
    const s = read('src/routes/sellers.js');
    expect(s).toMatch(/if \(!existing\) require\('\.\.\/services\/conversionService'\)\.emit\('seller_registered', \{[^}]*subjectType: 'professional_seller_profile'/);
    expect(s).toMatch(/requireVerificationForProfessional\(sellerProfileId, sellerType, req\.user\.id, client\)/);
  });
  test('Director exposes the compact Seller Activation section (read: members.view; writes: Super Admin)', () => {
    const r = read('src/routes/adminDirector.js'); const h = read('public/admin/director.html');
    expect(r).toMatch(/router\.get\('\/seller-activation'/);
    expect(r).toMatch(/router\.post\('\/seller-activation\/evaluate', superOnly/);
    expect(r).toMatch(/router\.post\('\/seller-activation\/:sellerProfileId\/opt-out', superOnly/);
    expect(h).toMatch(/Seller Activation/);
    expect(h).not.toMatch(/\b(AI|artificial intelligence)\b/);
  });
  test('Auction Partner release to Sasha is an explicit, audited admin action', () => {
    expect(read('src/routes/adminFoundingPartners.js')).toMatch(/router\.post\('\/:id\/sasha-assist', idParam, manage/);
    expect(read('public/admin/founding-partners.html')).toMatch(/Allow Sasha check-ins/);
  });
  test('the worker pass is wired and gated', () => {
    const w = read('src/workers/marketingRefreshWorker.js');
    expect(w).toMatch(/async function activationPass/);
    expect(w).toMatch(/setInterval\(activationPass, 30 \* 60_000\)/);
  });
  test('R-1 touches no fee, payout, tax, agreement or pricing code', () => {
    const src = read('src/services/sellerActivationService.js');
    expect(src).not.toMatch(/UPDATE (seller_profiles|auctions|agreements|founding_partners|payments|seller_payouts|platform_config)/);
    expect(src).not.toMatch(/platform_fee_bps|buyer_premium|processing_fee/);
  });
});
