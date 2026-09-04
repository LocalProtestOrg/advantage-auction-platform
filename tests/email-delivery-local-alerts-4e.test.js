'use strict';
// Marketing Agency Phase 4E — first-party email delivery, local event alerts & A7 readiness.
// Everything is built behind the A7 gate. Nothing sends a real subscriber campaign; A7 stays OFF.

const fs = require('fs');
const vm = require('vm');

// QA reads emailService.isConfigured(); mock it so QA is independent of local SMTP env.
jest.mock('../src/services/emailService', () => ({
  sendEmail: async () => ({ messageId: 'x' }),
  isConfigured: () => true,
  marketingConfigurationSet: () => null,
  EMAIL_FROM: 'notifications@advantage.bid',
}));

const classes = require('../src/lib/emailCampaignClasses');
const tmpl = require('../src/services/marketingEmailTemplate');
const token = require('../src/lib/marketingEmailToken');
const qa = require('../src/services/marketingEmailQaService');

// ── 1. Campaign classes: transactional vs marketing rules ────────────────────
describe('emailCampaignClasses', () => {
  test('defines the required classes', () => {
    ['TRANSACTIONAL', 'FOLLOW_SELLER', 'LOCAL_EVENT_ALERT', 'NEWSLETTER', 'PREMIUM_PACKAGE_CAMPAIGN', 'MARKETING_EXPERIMENT']
      .forEach((c) => expect(classes.get(c)).toBeTruthy());
  });
  test('transactional never honors marketing unsubscribe or requires permission', () => {
    const t = classes.get('TRANSACTIONAL');
    expect(t.honorsMarketingUnsub).toBe(false);
    expect(t.permissionRequired).toBe(false);
    expect(t.mailStream).toBe('transactional');
    expect(t.a7Eligible).toBe(false);
  });
  test('every marketing class requires permission, honors marketing unsub, uses marketing stream', () => {
    ['LOCAL_EVENT_ALERT', 'NEWSLETTER', 'PREMIUM_PACKAGE_CAMPAIGN', 'MARKETING_EXPERIMENT'].forEach((k) => {
      const c = classes.get(k);
      expect(c.permissionRequired).toBe(true);
      expect(c.honorsMarketingUnsub).toBe(true);
      expect(c.mailStream).toBe('marketing');
      expect(c.suppressionScope).toBe('marketing');
    });
  });
  test('premium package is not A7-autonomous', () => {
    expect(classes.get('PREMIUM_PACKAGE_CAMPAIGN').a7Eligible).toBe(false);
  });
});

// ── 2. Marketing email token (signed unsubscribe/click) ──────────────────────
describe('marketingEmailToken', () => {
  test('round-trips and is tamper-evident', () => {
    const t = token.sign({ email: 'Foo@Bar.com', campaign: 'local_event_alert', event: 'abc' });
    expect(token.verify(t)).toMatchObject({ email: 'Foo@Bar.com', campaign: 'local_event_alert', event: 'abc' });
    expect(token.verify(t.slice(0, -2) + 'xx')).toBeNull();
    expect(token.verify('garbage')).toBeNull();
  });
});

// ── 3. Local Event Alert template: factual, safe, full-circle ────────────────
describe('marketingEmailTemplate', () => {
  const event = { kind: 'estate_sale', title: 'Maplewood Estate Collection', city: 'Houston', state: 'TX', date_line: 'Sat, Sep 12, 2026', image_url: 'https://x/y.jpg', url: 'https://bid.advantage.bid/event.html?slug=maplewood' };
  test('single alert has facts, CTA, unsubscribe, full-circle, no invented claims', () => {
    const out = tmpl.buildLocalEventAlert(event, { unsubscribeUrl: 'https://bid.advantage.bid/api/public/marketing-email/unsubscribe?token=x' });
    expect(out.subject).toMatch(/estate sale near Houston, TX/i);
    expect(out.html).toContain('Maplewood Estate Collection');
    expect(out.html).toMatch(/View Estate Sale/);
    expect(out.html).toMatch(/unsubscrib/i);
    expect(out.html).toMatch(/Sell with Advantage\.Bid/i);   // full-circle
    expect(out.headers['List-Unsubscribe']).toBeTruthy();
    // No invented distance/value/scarcity.
    expect(out.html).not.toMatch(/miles away|worth \$|only \d+ left|selling fast/i);
  });
  test('digest combines multiple events into one email', () => {
    const out = tmpl.buildLocalEventDigest([event, { ...event, kind: 'auction', title: 'Downtown Auction' }], { locationLabel: 'Houston, TX', unsubscribeUrl: 'https://x/u' });
    expect(out.subject).toMatch(/2 auctions and estate sales near Houston/i);
    expect(out.html).toContain('Downtown Auction');
    expect(out.html).toContain('Maplewood Estate Collection');
  });
  test('CTA vocabulary matches event kind', () => {
    expect(tmpl.kindCta('auction')).toBe('View Auction');
    expect(tmpl.kindCta('estate_sale')).toBe('View Estate Sale');
  });
});

// ── 4. A2 email QA ───────────────────────────────────────────────────────────
describe('marketingEmailQaService', () => {
  const event = { title: 'Maplewood Estate', city: 'Houston', state: 'TX', date_line: 'Sep 12', url: 'https://bid.advantage.bid/event.html?slug=x' };
  const goodRendered = { subject: 'Upcoming estate sale near Houston, TX', html: '<meta name="viewport"><a>unsubscribe</a> Sell with Advantage.Bid', text: 'x', headers: { 'List-Unsubscribe': '<x>' } };
  const audienceResult = { ok: true, eligible: 42 };
  test('passes a clean campaign and records full-circle YES', () => {
    const v = qa.qaCampaign({ event, rendered: goodRendered, audienceResult });
    expect(v.pass).toBe(true);
    expect(v.full_circle).toBe('YES');
  });
  test('fails on invented valuation/scarcity', () => {
    const bad = { ...goodRendered, html: goodRendered.html + ' This lot is worth $5,000 and selling fast!' };
    const v = qa.qaCampaign({ event, rendered: bad, audienceResult });
    expect(v.pass).toBe(false);
    expect(v.failed).toContain('no_invented_claims');
  });
  test('fails on banned AI/vendor terms', () => {
    const bad = { ...goodRendered, html: goodRendered.html + ' Powered by OpenAI GPT' };
    expect(qa.qaCampaign({ event, rendered: bad, audienceResult }).failed).toContain('no_banned_terms');
  });
  test('fails when unsubscribe is missing', () => {
    const bad = { subject: 's', html: '<meta name="viewport"> Sell with Advantage.Bid', text: 't', headers: {} };
    expect(qa.qaCampaign({ event, rendered: bad, audienceResult }).failed).toContain('unsubscribe_present');
  });
});

// ── 5. Local event alert service: eligibility + radius (stub runner) ──────────
describe('localEventAlertService', () => {
  const svc = require('../src/services/localEventAlertService');
  function runner(row, opts = {}) {
    return { query: async (sql) => {
      if (/FROM auctions a/.test(sql) || /FROM events e/.test(sql)) return { rows: row ? [row] : [] };
      if (/count\(\*\)::int AS c/.test(sql) && /marketing_contacts mc/.test(sql)) return { rows: [{ c: opts.count != null ? opts.count : 3 }] };
      if (/FROM marketing_contacts\b/.test(sql)) return { rows: [{ c: 3 }] };
      return { rows: [], rowCount: 0 };
    } };
  }
  test('resolveEvent returns null for a non-eligible (stale/closed) event', async () => {
    expect(await svc.resolveEvent('auction', 'missing-id', runner(null))).toBeNull();
  });
  test('resolveEvent builds a factual auction alert object with canonical URL', async () => {
    const row = { id: 'a1', title: 'Fall Auction', city: 'Houston', state: 'TX', zip: '77002', lat: 29.76, lng: -95.36, start_time: '2026-09-12', end_time: '2026-09-13', image_url: 'https://x/y.jpg' };
    const ev = await svc.resolveEvent('auction', 'a1', runner(row));
    expect(ev.kind).toBe('auction');
    expect(ev.url).toMatch(/auction-view\.html\?auctionId=a1/);
    expect(ev.date_line).toBeTruthy();
  });
  test('buildAudience uses a radius strategy from the event coordinates', async () => {
    const row = { id: 'a1', title: 'Fall Auction', city: 'Houston', state: 'TX', lat: 29.76, lng: -95.36, start_time: '2026-09-12' };
    const out = await svc.buildAudience({ kind: 'auction', idOrSlug: 'a1', radiusMiles: 25 }, runner(row, { count: 8 }));
    expect(out.ok).toBe(true);
    expect(out.strategy.kind).toBe('radius');
    expect(out.strategy.radius_miles).toBe(25);
    expect(out.potential).toBe(8);
  });
});

// ── 6. Send service: gated live send + safe test send ────────────────────────
describe('marketingSendService', () => {
  function load({ a7 = false } = {}) {
    jest.resetModules();
    const sent = [];
    jest.doMock('../src/services/emailService', () => ({
      sendEmail: async (m) => { sent.push(m); return { messageId: 'mid-' + sent.length }; },
      isConfigured: () => true, marketingConfigurationSet: () => null, EMAIL_FROM: 'notifications@advantage.bid',
    }));
    jest.doMock('../src/services/marketingConfigService', () => ({ a7SendEnabled: async () => a7, getInt: async (_k, fb) => fb, raw: async (_k, fb) => fb }));
    const audits = [];
    jest.doMock('../src/db', () => ({ query: async (sql, p) => { audits.push({ sql, p }); return { rows: [], rowCount: 0 }; }, connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }));
    const svc = require('../src/services/marketingSendService');
    return { svc, sent, audits };
  }
  afterEach(() => { jest.dontMock('../src/services/emailService'); jest.dontMock('../src/services/marketingConfigService'); jest.dontMock('../src/db'); });

  test('testSend sends only to explicit internal addresses, marked [TEST], via marketing stream', async () => {
    const { svc, sent, audits } = load();
    const r = await svc.testSend({ rendered: { subject: 'Hi', html: '<p>x</p>', text: 'x' }, toAddresses: ['me@advantage.bid'], sentBy: 'u1' });
    expect(r.ok).toBe(true); expect(r.test).toBe(true); expect(r.sent).toBe(1);
    expect(sent[0].subject).toMatch(/^\[TEST\] /);
    expect(sent[0].mailStream).toBe('marketing');
    expect(audits.some((a) => /INSERT INTO marketing_test_sends/.test(a.sql))).toBe(true);
  });
  test('testSend rejects empty / non-email / oversized recipient lists', async () => {
    const { svc } = load();
    expect((await svc.testSend({ rendered: { subject: 's', html: 'h' }, toAddresses: [] })).reason).toBe('no_test_addresses');
    expect((await svc.testSend({ rendered: { subject: 's', html: 'h' }, toAddresses: ['nope'] })).reason).toBe('invalid_test_address');
    expect((await svc.testSend({ rendered: { subject: 's', html: 'h' }, toAddresses: Array(11).fill('a@b.com') })).reason).toBe('too_many_test_addresses');
  });
  test('sendCampaignLive REFUSES while A7 is disabled (no bypass)', async () => {
    const { svc, sent } = load({ a7: false });
    await expect(svc.sendCampaignLive({ campaignId: 'c1', rendered: { subject: 's', html: 'h' } })).rejects.toMatchObject({ code: 'A7_DISABLED' });
    expect(sent.length).toBe(0);
  });
});

// ── 7. A7 readiness gate (READY != ENABLED) ──────────────────────────────────
describe('a7ReadinessService', () => {
  function load({ feedbackSecret = false } = {}) {
    jest.resetModules();
    if (feedbackSecret) process.env.SES_FEEDBACK_WEBHOOK_SECRET = 'x'; else delete process.env.SES_FEEDBACK_WEBHOOK_SECRET;
    jest.doMock('../src/services/emailService', () => ({ isConfigured: () => true, marketingConfigurationSet: () => null, EMAIL_FROM: 'notifications@advantage.bid' }));
    jest.doMock('../src/services/marketingConfigService', () => ({ a7SendEnabled: async () => false }));
    jest.doMock('../src/db', () => ({ query: async () => ({ rows: [], rowCount: 0 }) }));
    return require('../src/services/a7ReadinessService');
  }
  afterEach(() => { jest.dontMock('../src/services/emailService'); jest.dontMock('../src/services/marketingConfigService'); jest.dontMock('../src/db'); delete process.env.SES_FEEDBACK_WEBHOOK_SECRET; });

  test('reports NOT_READY when the SES feedback loop is not configured (honest)', async () => {
    const svc = load({ feedbackSecret: false });
    const r = await svc.evaluate({ query: async () => ({ rows: [], rowCount: 0 }) });
    expect(r.overall).toBe('NOT_READY');
    expect(r.blocking).toEqual(expect.arrayContaining(['bounce_feedback', 'complaint_feedback']));
    expect(r.enabled).toBe(false);          // READY != ENABLED; enabled stays false regardless
  });
  test('feedback checks flip to configured when the webhook secret + table exist', async () => {
    const svc = load({ feedbackSecret: true });
    const runner = { query: async (sql) => (/information_schema.tables/.test(sql) ? { rowCount: 1, rows: [{}] } : { rowCount: 1, rows: [{}] }) };
    const r = await svc.evaluate(runner);
    expect(r.checks.bounce_feedback.status).toBe('PASS');
  });
});

// ── 8. Marketing unsubscribe writes marketing suppression (source-assertion) ─
describe('publicMarketingEmail route', () => {
  const SRC = fs.readFileSync('src/routes/publicMarketingEmail.js', 'utf8');
  test('unsubscribe writes email_suppressions (marketing scope) + records withdrawal; click is open-redirect-safe', () => {
    expect(SRC).toMatch(/INSERT INTO email_suppressions/);
    expect(SRC).toMatch(/'marketing'/);
    expect(SRC).toMatch(/grantPermission[\s\S]{0,60}withdrawn/);
    expect(SRC).toMatch(/List-Unsubscribe-Post|One-Click|\/unsubscribe/);
    expect(SRC).toMatch(/ALLOWED_HOSTS/);            // click redirect is host-restricted
  });
});

// ── 9. emailService transactional isolation (source-assertion) ───────────────
describe('emailService marketing stream', () => {
  const SRC = fs.readFileSync('src/services/emailService.js', 'utf8');
  test('marketing has a SEPARATE transporter pool and optional config-set header', () => {
    expect(SRC).toMatch(/getMarketingTransporter/);
    expect(SRC).toMatch(/SES_MARKETING_CONFIGURATION_SET/);
    expect(SRC).toMatch(/X-SES-CONFIGURATION-SET/);
    expect(SRC).toMatch(/mailStream/);
    // Default transactional path unchanged: getTransporter still builds a 5-connection pool.
    expect(SRC).toMatch(/buildTransport\(5\)/);
    expect(SRC).toMatch(/buildTransport\(2\)/);   // marketing capped smaller
  });
});

// ── 10. Migration 133 (additive; A7 untouched) + admin route safety ──────────
describe('migration 133 + admin route', () => {
  const SQL = fs.readFileSync('db/migrations/133_email_delivery_local_alerts_4e.sql', 'utf8');
  const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const ROUTE = fs.readFileSync('src/routes/adminMarketingCampaigns.js', 'utf8');
  const PAGE = fs.readFileSync('public/admin/marketing-campaigns.html', 'utf8');
  test('additive; frequency + test-send + email-events; never flips A7 on', () => {
    expect(code).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(code).toMatch(/marketing\.email\.max_per_day/);
    expect(code).toMatch(/marketing_test_sends/);
    expect(code).toMatch(/marketing_email_events/);
    expect(code).not.toMatch(/a7_send_enabled['"]?,\s*'true'/);
  });
  test('admin route: RBAC, super-admin test send, readiness; no production audience send', () => {
    expect(ROUTE).toMatch(/requirePermission\('members\.view'\)/);
    expect(ROUTE).toMatch(/isSuperAdmin/);
    expect(ROUTE).toMatch(/readiness/);
    const rc = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(rc).not.toMatch(/sendCampaignLive/);   // admin never triggers the live audience send
  });
  test('admin page: no mass-send button; readiness clarifies READY != ENABLED; parses', () => {
    expect(PAGE).not.toMatch(/Send to all|Send campaign|Blast/i);
    expect(PAGE).toMatch(/READY and ENABLED are separate/i);
    expect(PAGE).not.toMatch(/\bAI\b/);
    const scripts = [...PAGE.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    scripts.forEach((s) => expect(() => new vm.Script(s)).not.toThrow());
  });
});

// ── 11. A7 stays OFF + premium promise (no 10k / no 60-40) ───────────────────
describe('A7 gate + premium promise', () => {
  test('no source flips a7_send_enabled to true', () => {
    for (const f of ['db/migrations/133_email_delivery_local_alerts_4e.sql', 'src/services/marketingSendService.js', 'src/routes/adminMarketingCampaigns.js']) {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/a7_send_enabled['"]?\s*[,=:]\s*['"]?true/);
    }
  });
  test('premium class promises eligible subscribers, never a count or 60/40', () => {
    const c = classes.get('PREMIUM_PACKAGE_CAMPAIGN');
    expect(c.note).toMatch(/eligible subscribers/i);
    expect(c.note).not.toMatch(/10,?000|60\/40|60-40/);
  });
});
