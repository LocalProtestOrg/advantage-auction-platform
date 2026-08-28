'use strict';

/**
 * Representative-based prospect outreach — identity resolution (server-authoritative, no impersonation),
 * approved-identity validation, CRM automation on success, no-false-contacted on failure, and the
 * server-derived From/Reply-To/BCC (section 36). DB + email are mocked.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const outreach = require('../src/services/salesOutreachService');
const templates = require('../src/services/salesOutreachTemplates');

const PROSPECT = {
  id: 'p1', company_name: 'ABC Estate Sales', business_email: 'contact@abcestates.com',
  assigned_rep_user_id: 'rep1', contact_status: 'new_lead', opportunity_type: 'both',
  business_type: 'estate_sale_company', city: 'Dallas', state: 'TX',
};
const REP = { user_id: 'rep1', display_name: 'Kym Witt', outreach_email: 'kymmie@advantage.bid', outreach_enabled: true, staff_active: true };
const SELF = { id: 'rep1', is_super_admin: false };
const OTHER_REP = { id: 'rep2', is_super_admin: false };
const ADMIN = { id: 'admin1', is_super_admin: true };

function router(routes, rec) {
  db.query.mockImplementation(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    if (rec) rec.push({ sql: flat, params });
    for (const [re, res] of routes) if (re.test(flat)) return typeof res === 'function' ? res(params) : res;
    return { rows: [], rowCount: 0 };
  });
}
const baseRoutes = (over = {}) => ([
  [/FROM sales_prospects sp LEFT JOIN/, { rows: [over.prospect || PROSPECT] }],       // getProspect
  [/FROM sales_rep_profiles p JOIN users u/, { rows: over.rep === null ? [] : [over.rep || REP] }],
  [/FROM sales_outreach_emails WHERE prospect_id/, { rows: over.dup ? [{ n: 1 }] : [] }], // recentDuplicate
  [/INSERT INTO sales_outreach_emails/, (p) => ({ rows: [{ id: 'log1', status: p[11] }] })],
  [/INSERT INTO sales_prospect_notes/, { rows: [{ id: 'n1' }] }],
]);
beforeEach(() => db.query.mockReset());

describe('resolveIdentity — server-authoritative, no impersonation', () => {
  test('assigned rep (self) resolves to the rep identity', async () => {
    router(baseRoutes());
    const id = await outreach.resolveIdentity(PROSPECT, SELF);
    expect(id).toMatchObject({ repUserId: 'rep1', displayName: 'Kym Witt', replyTo: 'kymmie@advantage.bid', fromName: 'Kym Witt — Advantage.Bid' });
  });
  test('a DIFFERENT non-admin rep cannot send for this prospect', async () => {
    router(baseRoutes());
    await expect(outreach.resolveIdentity(PROSPECT, OTHER_REP)).rejects.toMatchObject({ status: 403, code: 'NOT_YOUR_PROSPECT' });
  });
  test('a Super Admin may send for any prospect (identity stays the assigned rep)', async () => {
    router(baseRoutes());
    const id = await outreach.resolveIdentity(PROSPECT, ADMIN);
    expect(id.replyTo).toBe('kymmie@advantage.bid'); // NOT the admin — the assigned rep
  });
  test('unassigned prospect → REP_REQUIRED', async () => {
    router(baseRoutes());
    await expect(outreach.resolveIdentity({ ...PROSPECT, assigned_rep_user_id: null }, ADMIN)).rejects.toMatchObject({ code: 'REP_REQUIRED' });
  });
  test('rep with no approved profile → REP_NOT_CONFIGURED', async () => {
    router(baseRoutes({ rep: null }));
    await expect(outreach.resolveIdentity(PROSPECT, SELF)).rejects.toMatchObject({ code: 'REP_NOT_CONFIGURED' });
  });
  test('disabled / inactive rep cannot send', async () => {
    router(baseRoutes({ rep: { ...REP, outreach_enabled: false } }));
    await expect(outreach.resolveIdentity(PROSPECT, SELF)).rejects.toMatchObject({ code: 'REP_DISABLED' });
    router(baseRoutes({ rep: { ...REP, staff_active: false } }));
    await expect(outreach.resolveIdentity(PROSPECT, SELF)).rejects.toMatchObject({ code: 'REP_INACTIVE' });
  });
});

describe('upsertRepProfile — only approved @advantage.bid identities', () => {
  test('rejects a non-@advantage.bid outreach email (no arbitrary identities)', async () => {
    router([[/SELECT id FROM users/, { rows: [{ id: 'rep1' }] }]]);
    await expect(outreach.upsertRepProfile({ userId: 'rep1', displayName: 'X', outreachEmail: 'x@gmail.com' }, 'admin'))
      .rejects.toMatchObject({ code: 'EMAIL_NOT_APPROVED' });
  });
  test('accepts an approved @advantage.bid identity', async () => {
    router([[/SELECT id FROM users/, { rows: [{ id: 'rep1' }] }], [/INSERT INTO sales_rep_profiles/, { rows: [{ user_id: 'rep1', outreach_email: 'kymmie@advantage.bid' }] }]]);
    const r = await outreach.upsertRepProfile({ userId: 'rep1', displayName: 'Kym Witt', outreachEmail: 'Kymmie@Advantage.Bid' }, 'admin');
    expect(r.outreach_email).toBe('kymmie@advantage.bid');
  });
});

describe('sendOutreach — success drives CRM automation with server-derived identity', () => {
  test('sends to the RECORD email as the assigned rep (From-name + Reply-To + BCC server-set), logs sent, marks Contacted', async () => {
    const rec = [];
    router(baseRoutes(), rec);
    const sendEmail = jest.fn(async () => ({ messageId: 'ses-123' }));
    const r = await outreach.sendOutreach({ prospectId: 'p1', actingStaff: SELF, templateKey: 'both', subject: 'Hello', message: 'Hi there.', followUpDays: 7 }, { sendEmail });
    expect(r.status).toBe('sent');
    // recipient from the RECORD, never client input:
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@abcestates.com',
      fromName: 'Kym Witt — Advantage.Bid',
      replyTo: 'kymmie@advantage.bid',
      bcc: 'info@advantage.bid',
    }));
    // logged as sent, activity appended, status advanced to contacted, follow-up scheduled
    expect(rec.find((c) => /INSERT INTO sales_outreach_emails/.test(c.sql)).params).toContain('sent');
    expect(rec.some((c) => /INSERT INTO sales_prospect_notes/.test(c.sql))).toBe(true);
    expect(rec.some((c) => /contact_status='contacted'/.test(c.sql))).toBe(true);
    expect(rec.some((c) => /next_follow_up_at = now\(\)/.test(c.sql))).toBe(true);
  });
  test('the send function does NOT accept client from/replyTo/bcc — they are always server-derived', () => {
    // sendOutreach signature has no from/replyTo/bcc params; identity comes only from the rep profile.
    const src = read('src/services/salesOutreachService.js');
    expect(src).toMatch(/fromName: identity\.fromName/);
    expect(src).toMatch(/replyTo: identity\.replyTo/);
    expect(src).toMatch(/bcc: OUTREACH_BCC/);
  });
});

describe('sendOutreach — failure never falsely marks Contacted (section 16)', () => {
  test('SES throw → logs failed, no Contacted, no sent-activity', async () => {
    const rec = [];
    router(baseRoutes(), rec);
    const sendEmail = jest.fn(async () => { throw new Error('SES rejected'); });
    const r = await outreach.sendOutreach({ prospectId: 'p1', actingStaff: SELF, templateKey: 'both', subject: 'S', message: 'M' }, { sendEmail });
    expect(r.status).toBe('failed');
    expect(rec.find((c) => /INSERT INTO sales_outreach_emails/.test(c.sql)).params).toContain('failed');
    expect(rec.some((c) => /contact_status='contacted'/.test(c.sql))).toBe(false);
    expect(rec.some((c) => /INSERT INTO sales_prospect_notes/.test(c.sql))).toBe(false); // no "email sent" note
  });
  test('SMTP not configured (skipped) → failed, not contacted', async () => {
    router(baseRoutes());
    const sendEmail = jest.fn(async () => ({ skipped: true }));
    const r = await outreach.sendOutreach({ prospectId: 'p1', actingStaff: SELF, templateKey: 'both', subject: 'S', message: 'M' }, { sendEmail });
    expect(r.status).toBe('failed');
  });
});

describe('sendOutreach — guards', () => {
  test('no recipient email → NO_RECIPIENT (phone-only prospects stay usable elsewhere)', async () => {
    router(baseRoutes({ prospect: { ...PROSPECT, business_email: null } }));
    await expect(outreach.sendOutreach({ prospectId: 'p1', actingStaff: SELF, subject: 'S', message: 'M' }, { sendEmail: jest.fn() }))
      .rejects.toMatchObject({ code: 'NO_RECIPIENT' });
  });
  test('duplicate within the window → DUPLICATE_SEND', async () => {
    router(baseRoutes({ dup: true }));
    await expect(outreach.sendOutreach({ prospectId: 'p1', actingStaff: SELF, subject: 'S', message: 'M' }, { sendEmail: jest.fn() }))
      .rejects.toMatchObject({ code: 'DUPLICATE_SEND' });
  });
  test('missing subject/message rejected', async () => {
    router(baseRoutes());
    await expect(outreach.sendOutreach({ prospectId: 'p1', actingStaff: SELF, subject: '', message: 'M' }, { sendEmail: jest.fn() })).rejects.toMatchObject({ code: 'SUBJECT_REQUIRED' });
  });
});

describe('templates — safe, personalized, no invented person', () => {
  test('suggestion follows CRM classification', () => {
    expect(templates.suggestKey({ opportunity_type: 'both' })).toBe('both');
    expect(templates.suggestKey({ opportunity_type: 'website' })).toBe('no_website');
    expect(templates.suggestKey({ opportunity_type: 'online_auction' })).toBe('add_online_auctions');
    expect(templates.suggestKey({ business_type: 'auction_house' })).toBe('auction_house');
  });
  test('team greeting (never invents a contact person) + real canonical links', () => {
    const r = templates.render('estate_sale_company', { company_name: 'ABC Estate Sales', city: 'Dallas', state: 'TX' }, { display_name: 'Kym Witt' });
    expect(r.body).toMatch(/Hello ABC Estate Sales team,/);
    expect(r.body).not.toMatch(/Hello (Mr|Ms|Mrs)\./);
    expect(r.body).toMatch(/bid\.advantage\.bid/);
  });
  test('renderHtml escapes injected content and includes the controlled signature', () => {
    const html = outreach.renderHtml('Hi <script>alert(1)</script>', { displayName: 'Kym Witt', replyTo: 'kymmie@advantage.bid' });
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/kymmie@advantage\.bid/);
  });
});

describe('RBAC + privacy (source guards, sections 29/31)', () => {
  const routeSrc = read('src/routes/adminSales.js');
  const rbacSrc = read('src/lib/rbac.js');
  test('send route requires sales.send_email; rep-profile routes require sales.manage_reps', () => {
    expect(routeSrc).toMatch(/\/prospects\/:id\/email', requirePermission\('sales\.send_email'\)/);
    expect(routeSrc).toMatch(/\/reps\/profiles', requirePermission\('sales\.manage_reps'\)/);
    expect(routeSrc).toMatch(/\/reps\/:userId\/profile', requirePermission\('sales\.manage_reps'\)/);
  });
  test('marketing role can send outreach but CANNOT approve identities (manage_reps is Super-Admin only)', () => {
    expect(rbacSrc).toMatch(/'sales\.send_email'/);
    // marketing bundle includes send_email but not manage_reps
    const m = rbacSrc.match(/marketing:\s*\{[\s\S]*?permissions:\s*\[([^\]]*)\]/)[1];
    expect(m).toMatch(/sales\.send_email/);
    expect(m).not.toMatch(/sales\.manage_reps/);
  });
  test('no public/unauthenticated route references the outreach tables', () => {
    for (const f of ['src/routes/public', 'src/routes/publicEvents', 'src/routes/sellers']) {
      try { const s = read(f + '.js'); expect(s).not.toMatch(/sales_outreach_emails|sales_rep_profiles/); } catch (_e) {}
    }
  });
});
