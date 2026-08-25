'use strict';

/**
 * followerCampaignService — authorization, eligibility, publish-trigger safety, dedup, and the
 * member-privacy guarantees (§19). DB is mocked; we assert the SQL gates + control flow.
 */
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => ({ id: 'a1' })) }));

const db = require('../src/db');
const { writeAuditLog } = require('../src/lib/auditLog');
const svc = require('../src/services/followerCampaignService');

const PRO = { id: 'seller-pro', seller_type: 'estate_sale_company', follower_email_enabled: true, is_demo: false };
const INDIV = { id: 'seller-ind', seller_type: 'private', follower_email_enabled: true, is_demo: false };
const BUSINESS = { id: 'seller-biz', seller_type: 'business', follower_email_enabled: true, is_demo: false };
const REVOKED = { id: 'seller-rev', seller_type: 'auction_house', follower_email_enabled: false, is_demo: false };
const DEMO = { id: 'seller-demo', seller_type: 'auction_house', follower_email_enabled: true, is_demo: true };

// Route queries to canned results by regex (first match wins). Records every call for SQL assertions.
function routeDb(routes) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    for (const [re, res] of routes) if (re.test(flat)) return typeof res === 'function' ? res(params) : res;
    return { rows: [], rowCount: 0 };
  });
  return { calls, find: (re) => calls.find((c) => re.test(c.sql)) };
}
beforeEach(() => { db.query.mockReset(); writeAuditLog.mockClear(); });

describe('sellerCanEmailFollowers — the professional/privilege/demo gate (§16)', () => {
  test('strict professional types are allowed', () => {
    expect(svc.sellerCanEmailFollowers(PRO)).toBe(true);
    expect(svc.sellerCanEmailFollowers({ ...PRO, seller_type: 'auction_house' })).toBe(true);
    expect(svc.sellerCanEmailFollowers({ ...PRO, seller_type: 'professional_liquidator' })).toBe(true);
  });
  test('individual / private / business / other sellers are excluded', () => {
    expect(svc.sellerCanEmailFollowers(INDIV)).toBe(false);
    expect(svc.sellerCanEmailFollowers(BUSINESS)).toBe(false);
    expect(svc.sellerCanEmailFollowers({ ...PRO, seller_type: 'other' })).toBe(false);
    expect(svc.sellerCanEmailFollowers(null)).toBe(false);
  });
  test('a revoked privilege disables it even for a professional', () => {
    expect(svc.sellerCanEmailFollowers(REVOKED)).toBe(false);
  });
  test('demo accounts are excluded', () => {
    expect(svc.sellerCanEmailFollowers(DEMO)).toBe(false);
  });
});

describe('resolveSellerForEvent — via the org owner user (only reliable path)', () => {
  test('resolves through organization_members owner → seller_profiles', async () => {
    const r = routeDb([[/FROM organization_members m JOIN seller_profiles/, { rows: [PRO] }]]);
    const seller = await svc.resolveSellerForEvent({ organization_id: 'org1' });
    expect(seller).toEqual(PRO);
    expect(r.find(/organization_members/).sql).toMatch(/role = 'owner' AND m\.status = 'active'/);
  });
  test('null when the event has no organization', async () => {
    routeDb([]);
    expect(await svc.resolveSellerForEvent({ organization_id: null })).toBeNull();
  });
});

describe('estimateAudience — eligibility SQL honors every recipient gate', () => {
  test('counts only followers who are email-on, marketing-on, active, and not suppressed', async () => {
    const r = routeDb([[/count\(\*\)::int n FROM seller_followers/, { rows: [{ n: 1284 }] }]]);
    const n = await svc.estimateAudience('seller-pro');
    expect(n).toBe(1284);
    const sql = r.find(/seller_followers/).sql;
    expect(sql).toMatch(/email_enabled, true\) = true/);
    expect(sql).toMatch(/follower_emails_enabled, true\) = true/);
    expect(sql).toMatch(/is_active, true\) = true/);
    expect(sql).toMatch(/email_suppressions/);
  });
});

describe('upsertScheduledCampaign — authorization + state guards', () => {
  test('FORBIDDEN for a non-professional seller (buyer/individual cannot send)', async () => {
    routeDb([[/FROM organization_members/, { rows: [INDIV] }]]);
    await expect(svc.upsertScheduledCampaign({ event: { id: 'e1', organization_id: 'o1', status: 'draft' }, userId: 'u1', enabled: true }))
      .rejects.toMatchObject({ status: 403, code: 'FOLLOWER_EMAIL_FORBIDDEN' });
  });
  test('rejects opt-in on an already-published event', async () => {
    routeDb([[/FROM organization_members/, { rows: [PRO] }]]);
    await expect(svc.upsertScheduledCampaign({ event: { id: 'e1', organization_id: 'o1', status: 'published' }, userId: 'u1', enabled: true }))
      .rejects.toMatchObject({ status: 409, code: 'ALREADY_PUBLISHED' });
  });
  test('opt-in creates/updates a scheduled campaign (message length-capped)', async () => {
    const r = routeDb([
      [/FROM organization_members/, { rows: [PRO] }],
      [/count\(\*\)::int n FROM seller_followers/, { rows: [{ n: 10 }] }],
      [/INSERT INTO follower_campaigns/, (p) => ({ rows: [{ id: 'camp1', custom_message: p[3], status: 'scheduled' }] })],
    ]);
    const camp = await svc.upsertScheduledCampaign({ event: { id: 'e1', organization_id: 'o1', status: 'draft' }, userId: 'u1', enabled: true, customMessage: 'x'.repeat(900) });
    expect(camp.id).toBe('camp1');
    const ins = r.find(/INSERT INTO follower_campaigns/);
    expect(ins.params[3].length).toBe(svc.MAX_MESSAGE_LEN); // capped
    expect(ins.sql).toMatch(/ON CONFLICT \(event_id, trigger_type\)/);
  });
  test('opt-out cancels any scheduled campaign (returns null)', async () => {
    const r = routeDb([[/FROM organization_members/, { rows: [PRO] }]]);
    const out = await svc.upsertScheduledCampaign({ event: { id: 'e1', organization_id: 'o1', status: 'draft' }, userId: 'u1', enabled: false });
    expect(out).toBeNull();
    expect(r.find(/UPDATE follower_campaigns SET status='canceled'/)).toBeTruthy();
  });
});

describe('activateOnPublish — fires ONLY on genuine publication, best-effort, deduped', () => {
  const EVENT = { id: 'e1', organization_id: 'o1', status: 'published', title: 'Sale', slug: 'sale', start_at: '2026-09-13T16:00:00Z', timezone: 'America/Chicago', city: 'Houston', state: 'TX', sale_type: 'estate_sale' };

  test('does NOT fire for a non-published event (draft/submitted/rejected)', async () => {
    routeDb([]);
    for (const status of ['draft', 'submitted', 'rejected', 'archived']) {
      const r = await svc.activateOnPublish({ ...EVENT, status });
      expect(r).toEqual({ activated: false, reason: 'not_published' });
    }
    expect(db.query).not.toHaveBeenCalled();
  });
  test('no-op when there is no scheduled campaign (seller did not opt in)', async () => {
    routeDb([[/SELECT \* FROM follower_campaigns/, { rows: [] }]]);
    expect(await svc.activateOnPublish(EVENT)).toEqual({ activated: false, reason: 'no_scheduled_campaign' });
  });
  test('cancels + does not send if the seller is no longer eligible at publish time', async () => {
    const r = routeDb([
      [/SELECT \* FROM follower_campaigns/, { rows: [{ id: 'camp1', seller_id: 'seller-rev', created_by: 'u1' }] }],
      [/FROM seller_profiles WHERE id/, { rows: [REVOKED] }],
    ]);
    expect(await svc.activateOnPublish(EVENT)).toEqual({ activated: false, reason: 'seller_ineligible' });
    expect(r.find(/UPDATE follower_campaigns SET status='canceled'/)).toBeTruthy();
    expect(r.find(/INSERT INTO notifications_queue/)).toBeFalsy(); // never fanned out
  });
  test('fans out FOLLOWER_EVENT to eligible followers with per-campaign dedup, then marks queued + audits', async () => {
    const r = routeDb([
      [/SELECT \* FROM follower_campaigns/, { rows: [{ id: 'camp1', seller_id: 'seller-pro', created_by: 'u1', custom_message: 'hi' }] }],
      [/FROM seller_profiles WHERE id/, { rows: [PRO] }],
      [/FROM event_images/, { rows: [{ url: 'https://res.cloudinary.com/x.jpg' }] }],
      [/FROM organizations WHERE id/, { rows: [{ name: 'Lewis & Maese' }] }],
      [/INSERT INTO notifications_queue/, { rowCount: 42 }],
      [/UPDATE follower_campaigns SET status='queued'/, { rows: [] }],
    ]);
    const out = await svc.activateOnPublish(EVENT);
    expect(out).toEqual({ activated: true, targeted: 42 });
    const ins = r.find(/INSERT INTO notifications_queue/);
    expect(ins.sql).toMatch(/'FOLLOWER_EVENT'/);
    expect(ins.sql).toMatch(/email_enabled, true\) = true/);
    expect(ins.sql).toMatch(/follower_emails_enabled, true\) = true/);
    expect(ins.sql).toMatch(/email_suppressions/);
    expect(ins.sql).toMatch(/NOT EXISTS/);                       // dedup guard
    // payload snapshot carries the campaign id + seller id + event URL back to Advantage.Bid
    const payload = JSON.parse(ins.params[1]);
    expect(payload.campaign_id).toBe('camp1');
    expect(payload.company_name).toBe('Lewis & Maese');
    expect(payload.event_url).toMatch(/bid\.advantage\.bid\/event\.html\?slug=sale/);
    expect(r.find(/UPDATE follower_campaigns SET status='queued'/).params).toEqual(['camp1', 42]);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'follower_campaign.queued' }));
  });
  test('email failure NEVER throws (publication is never blocked)', async () => {
    db.query.mockImplementation(async () => { throw new Error('db exploded'); });
    const out = await svc.activateOnPublish(EVENT);
    expect(out.activated).toBe(false);
    expect(out.reason).toBe('error');
  });
});

describe('member privacy — no recipient identities/emails are ever exposed', () => {
  test('serializeCampaign returns only aggregate counts (no emails, no user ids)', () => {
    const v = svc.serializeCampaign(
      { id: 'c1', event_id: 'e1', status: 'queued', trigger_type: 'event_published', custom_message: 'hi',
        audience_estimate: 100, targeted_count: 98, created_at: 't', queued_at: 't', updated_at: 't' },
      { delivered: 90, failed: 2, pending: 6, skipped: 0 });
    const keys = Object.keys(v).join(',');
    expect(keys).not.toMatch(/email|recipient|user|phone/i);
    expect(v).toMatchObject({ delivered_count: 90, failed_count: 2, targeted_count: 98 });
  });
  test('campaignStats aggregates queue rows by status (counts only)', async () => {
    routeDb([[/FROM notifications_queue WHERE type='FOLLOWER_EVENT'/, { rows: [{ total: 10, delivered: 8, failed: 1, pending: 1, skipped: 0 }] }]]);
    const s = await svc.campaignStats('camp1');
    expect(s).toEqual({ total: 10, delivered: 8, failed: 1, pending: 1, skipped: 0 });
  });
});

describe('buildQueueEmail — signs a per-recipient unsubscribe token', () => {
  test('produces a branded email addressed to the recipient with an unsubscribe URL', () => {
    const msg = svc.buildQueueEmail(
      { seller_id: 's1', company_name: 'C', event_title: 'T', event_url: 'https://bid.advantage.bid/event.html?slug=t' },
      'user-1', 'buyer@example.com');
    expect(msg.to).toBe('buyer@example.com');
    expect(msg.headers['List-Unsubscribe']).toMatch(/follower-emails\/unsubscribe\?token=/);
  });
});
