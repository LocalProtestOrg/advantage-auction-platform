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
    seller({ verification_flag: true, verification_status: 'more_info' }),   // Individual track; Professional messages are covered below
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

// ── Super Admin settings (audited, validated, LIVE needs typed confirmation) ──────────────────────────
describe('settings edit path', () => {
  const writes = () => calls.filter((c) => /INSERT INTO platform_config/.test(c.sql)).map((c) => [c.params[0], JSON.parse(c.params[1])]);
  const audits = () => calls.filter((c) => /INSERT INTO audit_log/.test(c.sql));
  beforeEach(() => { route(/seller_activation\.%/, () => cfgRows({ mode: 'shadow' })); });
  test('saves validated values and audits the change', async () => {
    await sa.setConfig({ enabled: true, first_touch_hours: 96, second_touch_days: 10, max_per_stage: 1, max_per_seller: 2, daily_cap: 4, recent_human_days: 21 }, { actorId: 'u1' });
    expect(writes()).toEqual(expect.arrayContaining([['seller_activation.enabled', true], ['seller_activation.first_touch_hours', 96], ['seller_activation.second_touch_days', 10],
      ['seller_activation.max_per_stage', 1], ['seller_activation.max_per_seller', 2], ['seller_activation.daily_cap', 4], ['seller_activation.recent_human_days', 21]]));
    expect(audits()).toHaveLength(1);
    expect(audits()[0].params[0]).toBe('seller_activation.config_changed');
  });
  test('switching to live without typing LIVE is refused and writes nothing', async () => {
    await expect(sa.setConfig({ mode: 'live' }, { actorId: 'u1' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Type LIVE/) });
    await expect(sa.setConfig({ mode: 'live' }, { actorId: 'u1', confirm: 'live' })).rejects.toMatchObject({ status: 400 });
    expect(writes()).toEqual([]);
  });
  test('typing LIVE switches to live; returning to shadow needs no confirmation', async () => {
    await sa.setConfig({ mode: 'live' }, { actorId: 'u1', confirm: 'LIVE' });
    await sa.setConfig({ mode: 'shadow' }, { actorId: 'u1' });
    expect(writes()).toEqual([['seller_activation.mode', 'live'], ['seller_activation.mode', 'shadow']]);
  });
  test.each([
    [{ first_touch_hours: 12 }], [{ second_touch_days: 1 }], [{ max_per_stage: 3 }], [{ max_per_seller: 4 }], [{ daily_cap: -1 }], [{ recent_human_days: 0 }],
    [{ daily_cap: 2.5 }], [{ mode: 'turbo' }], [{ enabled: 'yes' }], [{ surprise: 1 }], [{}],
  ])('rejects invalid input %j', async (patch) => {
    await expect(sa.setConfig(patch, { actorId: 'u1' })).rejects.toMatchObject({ status: 400 });
    expect(writes()).toEqual([]);
  });
  test('Director wiring: Super Admin endpoint, Save posts to it, reloads the saved config, shadow says Sasha sends nothing', () => {
    const r = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminDirector.js'), 'utf8');
    const h = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'director.html'), 'utf8');
    expect(r).toMatch(/router\.post\('\/seller-activation\/config', superOnly/);
    expect(h).toMatch(/fetch\('\/api\/admin\/director\/seller-activation\/config'/);
    expect(h).toMatch(/await loadActivation\(\);\s+\/\/ reload the authoritative saved configuration/);
    expect(h).toMatch(/Shadow: Sasha sends nothing/);
    expect(h).toMatch(/Type LIVE to confirm/);
    for (const id of ['sa-enabled', 'sa-mode-sel', 'sa-first', 'sa-second', 'sa-stage', 'sa-seller', 'sa-daily', 'sa-human']) expect(h).toContain('id="' + id + '"');
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

// ── Professional track (owner approval 2026-11-06) ───────────────────────────────────────────────────
describe('Professional Seller track', () => {
  const pro = (o = {}) => seller({ seller_type: 'estate_sale_company', full_name: 'Pat Seller', verification_flag: true, verification_approved: true,
    active_items: 0, draft_items: 0, open_imports: 0, storefront_terms_signed: true, storefront_published: true, storefront_slug: 'pat', ...o });
  const stageOf = (f) => sa.computeStage(f);

  test('stages come from recorded facts, in the owner order: agreement, verification, first listing, drafts, published', () => {
    expect(stageOf(pro({ agreement_signed_at: null }))).toMatchObject({ track: 'professional', stage: 'onboarding_incomplete', ledger_stage: 'pro_agreement', blocker: 'agreement_unsigned', next_owner: 'seller' });
    expect(stageOf(pro({ verification_approved: false, verification_status: 'open' }))).toMatchObject({ ledger_stage: 'pro_verification', blocker: 'verification_documents_needed', next_owner: 'seller' });
    expect(stageOf(pro({ verification_approved: false, verification_status: null }))).toMatchObject({ ledger_stage: 'pro_verification', blocker: 'verification_documents_needed' });
    expect(stageOf(pro({ verification_approved: false, verification_status: 'more_info' }))).toMatchObject({ ledger_stage: 'pro_verification', blocker: 'verification_more_info_requested' });
    expect(stageOf(pro())).toMatchObject({ stage: 'ready_no_auction', ledger_stage: 'pro_first_listing', blocker: 'no_listing_created', message_category: 'ready_no_auction' });
    expect(stageOf(pro({ draft_auctions: 1, draft_id: 'a1', draft_lots: 5 }))).toMatchObject({ stage: 'draft_started', ledger_stage: 'pro_auction_draft', blocker: 'draft_incomplete', message_category: 'draft_stalled' });
    expect(stageOf(pro({ rejected_auctions: 1, draft_id: 'a1', draft_state: 'rejected' }))).toMatchObject({ ledger_stage: 'pro_auction_draft', blocker: 'auction_returned_for_changes' });
    expect(stageOf(pro({ open_imports: 1 }))).toMatchObject({ stage: 'draft_started', ledger_stage: 'pro_storefront_setup', blocker: 'import_not_finished' });
    expect(stageOf(pro({ draft_items: 4 }))).toMatchObject({ ledger_stage: 'pro_storefront_setup', blocker: 'storefront_items_unpublished' });
    expect(stageOf(pro({ active_items: 1, draft_items: 3 }))).toMatchObject({ stage: 'activated', ledger_stage: 'activated' });
    expect(stageOf(pro({ published_auctions: 1 }))).toMatchObject({ stage: 'activated' });
    expect(stageOf(pro({ submitted_auctions: 1, submitted_ever: 1 }))).toMatchObject({ stage: 'submitted_waiting', next_owner: 'advantage' });
  });
  test('a first published listing (auction or storefront item) ends outreach', () => {
    expect(run(pro({ active_items: 1 })).d).toMatchObject({ decision: 'complete', guard: 'ACTIVATED' });
  });
  test('verification follows the one publication gate: a pro without the gate flag or an open request is not asked to verify', () => {
    const grandfathered = pro({ verification_flag: false, verification_approved: false, verification_status: null });
    expect(stageOf(grandfathered).ledger_stage).toBe('pro_first_listing');
    expect(run(pro({ verification_approved: false, verification_status: 'submitted' })).d).toMatchObject({ decision: 'staff_attention', guard: 'ADVANTAGE_OWNS_NEXT_ACTION' });
  });
  test('the canonical isProfessional decides the track (retail_gallery_studio included); individual types stay on the individual track', () => {
    expect(stageOf(pro({ seller_type: 'retail_gallery_studio' })).track).toBe('professional');
    for (const t of ['private', 'business', 'other', null]) expect(stageOf(seller({ seller_type: t })).track).toBeUndefined();
  });
  test('the Individual track is unchanged (same stage objects as before; no Professional fields)', () => {
    expect(stageOf(seller())).toEqual({ stage: 'ready_no_auction', blocker: 'no_auction_created', next_owner: 'seller', message_category: 'ready_no_auction', last_progress_at: hoursAgo(100) });
    expect(stageOf(seller({ agreement_signed_at: null }))).toEqual({ stage: 'onboarding_incomplete', blocker: 'agreement_unsigned', next_owner: 'seller', message_category: 'onboarding_incomplete', last_progress_at: hoursAgo(200) });
    const f = seller({ draft_auctions: 1, draft_id: 'a', draft_title: 'Tools', draft_lots: 3 });
    const { s, d } = run(f);
    expect(sa.composeMessage(f, s, d).text).toMatch(/seller-dashboard\.html/);
    expect(JSON.stringify(sa.composeMessage(f, s, d))).not.toMatch(/app\.html|seller-inventory|seller-how-to/);
  });

  test('at most 2 check-ins per Professional stage; check-ins sent under the coarse stage count too', () => {
    const f = pro({ agreement_signed_at: null });
    expect(run(f, hist({ touches_total: 2, touches_by_stage: { pro_agreement: 2 }, last_touch_at: hoursAgo(900) })).d.guard).toBe('STAGE_CAP');
    expect(run(f, hist({ touches_total: 2, touches_by_stage: { onboarding_incomplete: 2 }, last_touch_at: hoursAgo(900) })).d.guard).toBe('STAGE_CAP');
    expect(run(f, hist({ touches_total: 2, touches_by_stage: { onboarding_incomplete: 1, pro_agreement: 1 }, last_touch_at: hoursAgo(900) })).d.guard).toBe('STAGE_CAP');
    expect(run(pro(), hist({ touches_total: 3, touches_by_stage: { pro_agreement: 2, pro_verification: 1 }, last_touch_at: hoursAgo(900) })).d.guard).toBe('SELLER_CAP');
    const one = run(f, hist({ touches_total: 1, touches_by_stage: { pro_agreement: 1 }, last_touch_at: hoursAgo(8 * 24), last_touch_by_stage: { pro_agreement: hoursAgo(8 * 24) } })).d;
    expect(one).toMatchObject({ decision: 'would_contact', stage_attempt: 2, attempt: 2 });
  });
  test('the second check-in in a Professional stage waits 7 days after the first (also when the first was under the coarse stage)', () => {
    const f = pro({ agreement_signed_at: null });
    const h = hist({ touches_total: 1, touches_by_stage: { onboarding_incomplete: 1 }, last_touch_at: hoursAgo(5 * 24), last_touch_by_stage: { onboarding_incomplete: hoursAgo(5 * 24) } });
    expect(run(f, h).d).toMatchObject({ decision: 'waiting', guard: 'COOLDOWN' });
  });

  test('no R-1 message within 72 hours of the Professional welcome email, at any stage', () => {
    for (const o of [{ agreement_signed_at: null }, {}, { draft_items: 2 }]) {
      expect(run(pro({ ...o, welcome_at: hoursAgo(10) })).d).toMatchObject({ decision: 'waiting', guard: 'WELCOME_EMAIL_RECENT' });
      expect(run(pro({ ...o, welcome_at: hoursAgo(73) })).d.decision).toBe('would_contact');
    }
  });
  test('no agreement reminder within 72 hours of the agreement auto-send email; other stages are not held by it', () => {
    expect(run(pro({ agreement_signed_at: null, agreement_sent_at: hoursAgo(20) })).d).toMatchObject({ decision: 'waiting', guard: 'AGREEMENT_EMAIL_RECENT' });
    expect(run(pro({ agreement_signed_at: null, agreement_sent_at: hoursAgo(80) })).d.decision).toBe('would_contact');
    expect(run(pro({ agreement_sent_at: hoursAgo(20) })).d.decision).toBe('would_contact');
  });
  test('every existing guard still applies to Professional Sellers', () => {
    const f = pro({ agreement_signed_at: null });
    for (const [h, guard] of [[{ opted_out: true }, 'ACTIVATION_OPT_OUT'], [{ suppressed: 'global' }, 'SUPPRESSION_LIST'], [{ replied: true }, 'SELLER_REPLIED'],
      [{ open_conversation: 'Ref S1, open' }, 'OPEN_CONVERSATION'], [{ recent_human: 'rep email 2026-10-01' }, 'RECENT_HUMAN_CONTACT'],
      [{ staff_owner: 'assigned sales rep' }, 'STAFF_RELATIONSHIP_OWNER'], [{ other_programme: 'x' }, 'OTHER_PROGRAMME_CONTACT']]) {
      expect(run(f, hist(h)).d.guard).toBe(guard);
    }
    expect(run(f, hist({ sent_today: 6 }), LIVE).d.guard).toBe('DAILY_CAP');
  });
  test('Auction Partners held by their relationship owner are never messaged, at any Professional stage', () => {
    const ap = hist({ auction_partner: { id: 'fp1', name: 'Ashbury', released: false, owner_user_id: 'ty' } });
    for (const o of [{ agreement_signed_at: null }, { verification_approved: false, verification_status: 'open' }, {}, { draft_items: 2 }, { draft_id: 'a', draft_auctions: 1 }]) {
      expect(run(pro(o), ap).d).toMatchObject({ decision: 'staff_attention', guard: 'AUCTION_PARTNER_RELATIONSHIP_OWNER' });
    }
  });
  test('a failed Professional fact lookup blocks contact (fail closed); individuals are not queried for it', async () => {
    route(/FROM marketplace_items m/, () => { throw new Error('relation missing'); });
    const facts = [pro({ agreement_signed_at: null }), seller({ seller_profile_id: '33333333-3333-4333-8333-333333333333' })];
    await sa.attachProfessionalFacts(facts, require('../src/db'));
    expect(facts[0].pro_facts_error).toMatch(/relation missing/);
    expect(facts[1].pro_facts_error).toBeUndefined();
    route(/count\(\*\)::int n FROM seller_activation_touches/, () => ({ rows: [{ n: 0 }] }));
    const h = (await sa.loadHistory([facts[0]], CFG, require('../src/db'), NOW)).get(facts[0].seller_profile_id);
    expect(sa.decide(facts[0], sa.computeStage(facts[0]), h, CFG, NOW).guard).toBe('LOOKUP_FAILED');
    calls.length = 0;
    await sa.attachProfessionalFacts([seller()], require('../src/db'));
    expect(calls).toHaveLength(0);
  });
  test('the Professional facts come from the recorded tables (items, imports, storefront terms, agreement email, welcome email)', async () => {
    route(/FROM marketplace_items m/, () => ({ rows: [{ seller_profile_id: pro().seller_profile_id, active_items: 0, draft_items: 3, open_imports: 1, welcome_at: hoursAgo(5),
      agreement_sent_at: hoursAgo(4), storefront_terms_signed: false, storefront_published: false, storefront_slug: null }] }));
    const [f] = await sa.attachProfessionalFacts([pro()], require('../src/db'));
    expect(f).toMatchObject({ draft_items: 3, open_imports: 1, welcome_at: hoursAgo(5), agreement_sent_at: hoursAgo(4), storefront_terms_signed: false });
    const sql = calls.find((c) => /FROM marketplace_items m/.test(c.sql)).sql;
    for (const re of [/seller_welcome_emails/, /status IN \('sent','viewed'\)/, /storefront_import_batches/, /storefront_fee_schedule IS NOT NULL/, /NOT COALESCE\(m\.is_demo, false\)/]) expect(sql).toMatch(re);
  });

  // ── messages ──
  const proCases = [
    ['agreement', pro({ agreement_signed_at: null })],
    ['verification', pro({ verification_approved: false, verification_status: 'open' })],
    ['verification, more info', pro({ verification_approved: false, verification_status: 'more_info' })],
    ['first listing', pro()],
    ['auction draft', pro({ draft_auctions: 1, draft_id: 'a', draft_title: 'Estate—contents', draft_lots: 12 })],
    ['auction returned', pro({ rejected_auctions: 1, draft_id: 'a', draft_state: 'rejected', draft_title: 'Tools' })],
    ['import not finished', pro({ open_imports: 1 })],
    ['storefront drafts, terms and page pending', pro({ draft_items: 4, storefront_terms_signed: false, storefront_published: false })],
  ];
  const PAGE_FILES = { '/sign-agreement.html': 'sign-agreement.html', '/verify-documents.html': 'verify-documents.html', '/app.html': 'app.html', '/seller-create.html': 'seller-create.html',
    '/seller-inventory.html': 'seller-inventory.html', '/seller-storefront.html': 'seller-storefront.html', '/seller-how-to': 'seller-how-to.html' };
  test.each(proCases)('%s: short, accurate, Sasha, real authenticated links, no unavailable features or promises', (_n, f) => {
    const { s, d } = run(f);
    const m = sa.composeMessage(f, s, d);
    expect(m).toBeTruthy();
    const all = m.subject + '\n' + m.text;
    expect(all).not.toMatch(/[—–]/);
    expect(m.text).toMatch(/^Hi Pat,\n\nThis is Sasha from Advantage\.Bid\./);
    expect(m.text).toMatch(/reply to this email/);
    expect(m.text).toMatch(/If you would rather I not check in again, reply and let me know\./);
    expect(all).not.toMatch(/\b(AI|A\.I\.|artificial intelligence|machine learning|GPT|OpenAI|LLM|Stripe|Railway|Cloudinary|Neon|Postmark|unsubscribe|sale|discount|% off)\b/i);
    expect(all).not.toMatch(/checkout|check out|buy now|purchas|payout|get paid|paid|ship/i);
    expect(all).not.toMatch(/will be approved|guarantee|approval is|you are approved/i);
    expect(m.text.split(/\s+/).length).toBeLessThan(140);
    const urls = m.text.match(/https?:\/\/\S+/g) || [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      const p = u.replace('https://bid.advantage.bid', '').replace(/\?.*$/, '');
      expect(u).toMatch(/^https:\/\/bid\.advantage\.bid\//);
      expect(Object.values(sa.PRO_PATHS).map((x) => x.replace(/\?.*$/, ''))).toContain(p);
      expect(fs.existsSync(path.join(__dirname, '..', 'public', PAGE_FILES[p]))).toBe(true);
    }
  });
  test('each Professional stage gets its own subject and destination', () => {
    const msg = (f) => { const { s, d } = run(f); return sa.composeMessage(f, s, d); };
    expect(msg(proCases[0][1])).toMatchObject({ subject: 'Your Advantage.Bid Professional Seller agreement' });
    expect(msg(proCases[0][1]).text).toContain('https://bid.advantage.bid/sign-agreement.html?onboarding=1');
    expect(msg(proCases[1][1]).text).toContain('https://bid.advantage.bid/verify-documents.html');
    expect(msg(proCases[2][1]).text).toMatch(/our team asked for a little more information/);
    expect(msg(proCases[3][1]).text).toMatch(/seller-create\.html[\s\S]*seller-inventory\.html[\s\S]*seller-how-to/);
    expect(msg(proCases[4][1]).text).toMatch(/"Estate-contents", and it has 12 lots so far\. An auction needs at least 30 lots before it can go live, so you have 18 to go\./);
    expect(msg(proCases[6][1]).text).toMatch(/inventory import that has not been finished/);
    const sf = msg(proCases[7][1]).text;
    expect(sf).toMatch(/You have 4 storefront items saved as drafts/);
    expect(sf).not.toMatch(/storefront terms|agreement|sign/i);   // never a reminder about a newly published agreement version (owner 2026-11-07)
    expect(sf).toMatch(/seller-storefront\.html\?tab=store/);
    expect(sf).toMatch(/Online buying for storefront items is not open yet, so published items can be viewed but not bought online for now\./);
    expect(msg(pro({ draft_items: 1 })).text).not.toMatch(/storefront terms|seller-storefront/);
    expect(msg(pro({ draft_items: 1, checkout_enabled: true })).text).not.toMatch(/Online buying/);
  });

  // ── storefront-only Professional Sellers (owner 2026-11-07) ──
  test('storefront milestones are distinct and never merged', () => {
    const sp = (o) => sa.storefrontProgress(pro({ storefront_published: false, storefront_slug: null, ...o }));
    expect(sp({})).toMatchObject({ stage: 'registration_completed', registration_completed: true, storefront_configured: false, inventory_drafted: false });
    expect(sp({ storefront_published: true, storefront_slug: 'pat' })).toMatchObject({ stage: 'storefront_configured', storefront_configured: true });
    expect(sp({ draft_items: 2 })).toMatchObject({ stage: 'inventory_drafted', inventory_published: false });
    expect(sp({ active_items: 2 })).toMatchObject({ stage: 'inventory_published', inventory_published: true, checkout_enabled: false });
    expect(sp({ active_items: 2, checkout_enabled: true })).toMatchObject({ stage: 'checkout_enabled' });
    expect(sp({ checkout_enabled: true })).toMatchObject({ stage: 'registration_completed', checkout_enabled: true });   // the switch alone is not a seller stage
    expect(sp({ active_items: 1, paid_orders: 1 })).toMatchObject({ stage: 'first_sale', first_sale: true });
  });
  test('live public storefront inventory alone completes listing activation; the basis is recorded', () => {
    expect(stageOf(pro({ active_items: 1 }))).toMatchObject({ stage: 'activated', activation_basis: 'storefront_inventory' });
    expect(stageOf(pro({ paid_orders: 1 }))).toMatchObject({ stage: 'activated', activation_basis: 'storefront_sale' });
    expect(stageOf(pro({ published_auctions: 1, active_items: 1 }))).toMatchObject({ activation_basis: 'auction' });
    expect(stageOf(pro({ sold_items: 2 })).stage).not.toBe('activated');   // a sold-marked item is not live inventory or a paid sale
    const d = run(pro({ active_items: 1 })).d;
    expect(d).toMatchObject({ decision: 'complete', guard: 'ACTIVATED' });
    expect(d.reason).toMatch(/Storefront inventory is live and public\. Storefront stage: inventory_published; online checkout not enabled\./);
    expect(sa.composeMessage(pro({ active_items: 1 }), stageOf(pro({ active_items: 1 })), d)).toBeNull();   // no message, so never "ready to accept purchases"
  });
  test('live inventory uses the one public-visibility rule; paid storefront orders mark the first sale', async () => {
    route(/FROM marketplace_items m/, () => ({ rows: [] }));
    await sa.attachProfessionalFacts([pro()], require('../src/db'));
    const sql = calls.find((c) => /FROM marketplace_items m/.test(c.sql)).sql;
    expect(sql).toContain(require('../src/lib/marketplaceVisibility').activeMarketplaceItemSql('m'));
    expect(sql).toMatch(/FROM marketplace_orders o WHERE o\.seller_id = sp\.id AND o\.payment_status = 'paid'/);
  });
  test('checkout is read from the existing switches only (general switch, or this seller in the pilot); R-1 never changes it', () => {
    const id = pro().seller_profile_id;
    expect(sa.checkoutEnabledFor(id, {})).toBe(false);
    expect(sa.checkoutEnabledFor(id, { MARKETPLACE_CHECKOUT_ENABLED: 'true' })).toBe(true);
    expect(sa.checkoutEnabledFor(id, { MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS: id, MARKETPLACE_CHECKOUT_PILOT_USER_IDS: '' })).toBe(true);
    expect(sa.checkoutEnabledFor(id, { MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS: '99999999-9999-4999-8999-999999999999' })).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sellerActivationService.js'), 'utf8');
    expect(src).not.toMatch(/MARKETPLACE_CHECKOUT_ENABLED\s*=|process\.env\.MARKETPLACE_CHECKOUT[A-Z_]*\s*=/);
  });
  test('snapshot and ledger record the storefront stage; a storefront milestone change writes a ledger row', async () => {
    const f = pro({ active_items: 1 }); const s = stageOf(f); const d = sa.decide(f, s, hist(), CFG, NOW);
    route(/FROM seller_activation_state WHERE seller_profile_id/, () => ({ rows: [{ stage: 'activated', blocker: null, decision: 'complete', guard: 'ACTIVATED', storefront_stage: 'inventory_drafted' }] }));
    await sa.recordEvaluation(f, s, hist(), d, CFG, require('../src/db'));
    const touch = calls.find((c) => /INSERT INTO seller_activation_touches/.test(c.sql));
    expect(touch.params[8]).toMatch(/^Storefront stage: inventory_drafted -> inventory_published\./);
    const state = calls.find((c) => /INSERT INTO seller_activation_state/.test(c.sql));
    expect(JSON.parse(state.params[11])).toMatchObject({ activation_basis: 'storefront_inventory', storefront_stage: 'inventory_published',
      storefront_progress: { registration_completed: true, inventory_published: true, checkout_enabled: false, first_sale: false } });
    calls.length = 0; ROUTES = [];
    route(/FROM seller_activation_state WHERE seller_profile_id/, () => ({ rows: [{ stage: 'activated', blocker: null, decision: 'complete', guard: 'ACTIVATED', storefront_stage: 'inventory_published' }] }));
    await sa.recordEvaluation(f, s, hist(), d, CFG, require('../src/db'));
    expect(calls.some((c) => /INSERT INTO seller_activation_touches/.test(c.sql))).toBe(false);   // no repeat rows
  });
  test('no R-1 message reminds a seller about a newly published agreement version or announces updated buyer terms', () => {
    const texts = [];
    for (const o of [{ agreement_signed_at: null }, { verification_approved: false, verification_status: 'open' }, {}, { draft_id: 'a', draft_auctions: 1 },
      { open_imports: 1, storefront_terms_signed: false }, { draft_items: 2, storefront_terms_signed: false, storefront_published: false }]) {
      const f = pro(o); const s = stageOf(f); const m = sa.composeMessage(f, s, sa.decide(f, s, hist(), CFG, NOW));
      if (m) texts.push(m.subject + '\n' + m.text);
    }
    for (const sv of [seller({ agreement_signed_at: null }), seller()]) { const s = stageOf(sv); texts.push(JSON.stringify(sa.composeMessage(sv, s, sa.decide(sv, s, hist(), CFG, NOW)))); }
    for (const t of texts) expect(t).not.toMatch(/new version|updated (seller )?agreement|current storefront terms|updated terms|buyer terms|terms of service/i);
  });
  test('no message for a Professional stage Sasha does not handle', () => {
    for (const f of [pro({ submitted_auctions: 1 }), pro({ active_items: 1 }), pro({ verification_approved: false, verification_status: 'submitted' })]) {
      expect(sa.composeMessage(f, sa.computeStage(f), {})).toBeNull();
    }
  });
  test('live send uses the Professional stage in the ledger and the idempotency key', async () => {
    const f = pro({ agreement_signed_at: null }); liveDb(f);
    const emailService = { sendEmail: jest.fn(async () => ({ messageId: 'abc@ses' })) };
    const r = await sa.sendCheckIn(f.seller_profile_id, { stage: 'onboarding_incomplete', last_progress_at: sa.computeStage(f).last_progress_at }, { emailService, now: NOW });
    expect(r).toMatchObject({ sent: true });
    expect(emailService.sendEmail.mock.calls[0][0].subject).toBe('Your Advantage.Bid Professional Seller agreement [Ref SABC123]');
    expect(ledger('contacted')[0].params[3]).toBe('pro_agreement');
    expect(ledger('contacted')[0].params[14]).toMatch(/:pro_agreement:1:1$/);
  });
  test('the state table keeps the coarse stage (its CHECK constraint); the ledger records the Professional stage', async () => {
    const f = pro({ agreement_signed_at: null }); const s = sa.computeStage(f); const d = sa.decide(f, s, hist(), CFG, NOW);
    await sa.recordEvaluation(f, s, hist(), d, CFG, require('../src/db'));
    const touch = calls.find((c) => /INSERT INTO seller_activation_touches/.test(c.sql));
    const state = calls.find((c) => /INSERT INTO seller_activation_state/.test(c.sql));
    expect(touch.params[4]).toBe('pro_agreement');
    expect(state.params[2]).toBe('onboarding_incomplete');
    expect(JSON.parse(state.params[11])).toMatchObject({ track: 'professional', pro_stage: 'pro_agreement', registration_complete: true });
  });
  test('the coordination rules are documented in the service header', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sellerActivationService.js'), 'utf8');
    expect(src).toMatch(/R-1 is the ONLY automated source of activation and onboarding check-ins to registered sellers/);
    expect(src).toMatch(/WELCOME_EMAIL_RECENT/);
    expect(src).toMatch(/AGREEMENT_EMAIL_RECENT/);
  });
});
