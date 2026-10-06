'use strict';

/**
 * Auction Partner Program: invitation-only agreement + acceptance path.
 *
 * Invariants: only an invited (staff-reserved) prospect can reach the Program terms; the first professional seller to
 * accept is bound and everyone else is refused (fail closed); accepting or signing never applies a fee; the addendum
 * never stands in for the Seller Agreement (auto-send, dashboard gate, template fallback); a signed-but-not-activated
 * partner cannot be published at the wrong terms; customer surfaces never say "Founding".
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mockDb = { s: null, q: [] };
function mockReset() {
  mockDb.q = [];
  mockDb.s = {
    fps: new Map([
      ['fp-1', { id: 'fp-1', status: 'prospect', seller_profile_id: null, display_name: 'Gulf Coast Estate Sales', market: 'houston', fee_applied_at: null, fee_restored_at: null, intro_end_date: null }],
      ['fp-2', { id: 'fp-2', status: 'prospect', seller_profile_id: null, display_name: 'Harbor Estates', market: 'ny_tristate', fee_applied_at: null, fee_restored_at: null, intro_end_date: null }],
      ['fp-ended', { id: 'fp-ended', status: 'ended', seller_profile_id: null, display_name: 'Old Co', market: 'houston' }],
    ]),
    sellers: new Map([
      ['u-pro', { id: 'sp-pro', seller_type: 'estate_sale_company', display_name: 'Gulf Coast Estate Sales', full_name: 'Pat Owner', email: 'pat@example.test', platform_fee_bps: 400 }],
      ['u-pro2', { id: 'sp-pro2', seller_type: 'estate_sale_company', display_name: 'Someone Else', full_name: 'Sam Other', email: 'sam@example.test', platform_fee_bps: 400 }],
      ['u-ind', { id: 'sp-ind', seller_type: 'private', display_name: 'Indy', full_name: 'Indy', email: 'i@example.test', platform_fee_bps: 400 }],
    ]),
    agreements: [], revoked: [], template: null, versions: [],
  };
}
async function mockHandle(sql, p = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim(); const st = mockDb.s; mockDb.q.push(s);
  const rows = (r) => ({ rows: r, rowCount: r.length });
  if (/^SELECT id, status, seller_profile_id, display_name, market FROM founding_partners WHERE id = \$1/.test(s)) { const f = st.fps.get(p[0]); return rows(f ? [Object.assign({}, f)] : []); }
  if (/^SELECT id, status, seller_profile_id, display_name FROM founding_partners WHERE id = \$1/.test(s)) { const f = st.fps.get(p[0]); return rows(f ? [Object.assign({}, f)] : []); }
  if (/event_type = 'founding_partner\.invites_revoked'/.test(s) && /^SELECT 1 FROM audit_log/.test(s)) {
    return rows(st.revoked.filter((r) => r.id === p[0] && r.at >= p[1]).map(() => ({ x: 1 })));
  }
  if (/^INSERT INTO audit_log \(event_type, entity_type, entity_id, actor_id, metadata\) VALUES \('founding_partner\.invites_revoked'/.test(s)) {
    st.revoked.push({ id: p[0], at: Math.floor(Date.now() / 1000) }); return rows([]);
  }
  if (/^SELECT sp\.id, sp\.seller_type, sp\.display_name, u\.full_name, u\.email FROM seller_profiles sp JOIN users u/.test(s)) { const x = st.sellers.get(p[0]); return rows(x ? [x] : []); }
  if (/^SELECT id FROM founding_partners WHERE seller_profile_id = \$1 AND status <> 'ended' AND id <> \$2/.test(s)) {
    return rows([...st.fps.values()].filter((f) => f.seller_profile_id === p[0] && f.status !== 'ended' && f.id !== p[1]));
  }
  if (/^UPDATE founding_partners SET seller_profile_id = \$2, updated_at = now\(\) WHERE id = \$1 AND seller_profile_id IS NULL AND status = 'prospect'/.test(s)) {
    const f = st.fps.get(p[0]); if (!f || f.seller_profile_id || f.status !== 'prospect') return rows([]); f.seller_profile_id = p[1]; return rows([{ id: f.id }]);
  }
  if (/FROM agreements a JOIN agreement_template_versions v ON v\.id = a\.template_version_id WHERE a\.seller_profile_id = \$1 AND v\.template_id = \$2 AND a\.status = ANY\(\$3\)/.test(s)) {
    return rows(st.agreements.filter((a) => a.seller_profile_id === p[0] && a.template === 'addendum' && p[2].includes(a.status)).slice(-1));
  }
  if (/FROM agreements a JOIN agreement_template_versions v ON v\.id = a\.template_version_id WHERE a\.seller_profile_id = \$1 AND v\.template_id <> \$2/.test(s)) {
    return rows(st.agreements.filter((a) => a.seller_profile_id === p[0] && a.template === 'base').slice(-1));
  }
  if (/FROM agreements a JOIN agreement_template_versions v ON v\.id = a\.template_version_id WHERE a\.seller_profile_id = \$1 AND v\.template_id = \$2 AND a\.status IN \('signed','countersigned'\)/.test(s)) {
    return rows(st.agreements.filter((a) => a.seller_profile_id === p[0] && a.template === 'addendum' && a.status === 'signed'));
  }
  if (/^SELECT status, fee_applied_at FROM founding_partners WHERE seller_profile_id = \$1/.test(s)) { return rows([...st.fps.values()].filter((f) => f.seller_profile_id === p[0] && f.status !== 'ended')); }
  if (/^SELECT id, status, fee_applied_at, fee_restored_at, intro_end_date FROM founding_partners WHERE seller_profile_id = \$1/.test(s)) {
    return rows([...st.fps.values()].filter((f) => f.seller_profile_id === p[0] && f.status !== 'ended'));
  }
  if (/FROM verification_requests/.test(s)) return rows([]);
  // template provisioning
  if (/^SELECT id, current_version_id FROM agreement_templates WHERE id = \$1/.test(s)) return rows(st.template ? [st.template] : []);
  if (/^INSERT INTO agreement_templates \(id, agreement_type, name, description, is_active, created_by\)/.test(s)) {
    st.template = { id: p[0], current_version_id: null, agreement_type: 'custom', is_active: false, name: p[1] }; return rows([]);
  }
  if (/^SELECT id, version_int, body_markdown FROM agreement_template_versions WHERE id = \$1/.test(s)) return rows(st.versions.filter((v) => v.id === p[0]));
  if (/^SELECT template_id FROM agreement_template_versions WHERE id = \$1/.test(s)) {
    return rows(p[0] === 'ver-addendum' ? [{ template_id: 'a9000000-0000-4000-8000-0000000000a1' }] : [{ template_id: 'base-template' }]);
  }
  if (/^SELECT id, display_name FROM founding_partners WHERE seller_profile_id = \$1/.test(s)) return rows([...st.fps.values()].filter((f) => f.seller_profile_id === p[0]));
  return rows([]);
}
jest.mock('../src/db', () => ({ query: (s, p) => mockHandle(s, p), connect: async () => ({ query: (s, p) => mockHandle(s, p), release() {} }), pool: {} }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));

process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential';
const ap = require('../src/services/auctionPartnerAgreementService');
const agreementService = require('../src/services/agreementService');
const templateService = require('../src/services/agreementTemplateService');
const { writeAuditLog } = require('../src/lib/auditLog');

function invite(fpId, { daysAgo = 0, days = 30 } = {}) {
  const now = Math.floor(Date.now() / 1000) - daysAgo * 86400;
  return ap.signToken({ v: 1, f: fpId, i: now, e: now + days * 86400, n: 'abc123' });
}
function stubAgreements() {
  jest.spyOn(templateService, 'publishVersion').mockImplementation(async (id, v) => {
    const ver = { id: 'ver-' + (mockDb.s.versions.length + 1), version_int: mockDb.s.versions.length + 1, body_markdown: v.body_markdown };
    mockDb.s.versions.push(ver); mockDb.s.template.current_version_id = ver.id; return ver;
  });
  jest.spyOn(agreementService, 'autoSendAgreement').mockImplementation(async (spId) => {
    if (!mockDb.s.agreements.some((a) => a.seller_profile_id === spId && a.template === 'base')) mockDb.s.agreements.push({ id: 'base-' + spId, seller_profile_id: spId, template: 'base', status: 'sent' });
    return { status: 'sent' };
  });
  jest.spyOn(agreementService, 'sendAgreement').mockImplementation(async (args) => {
    const a = { id: 'add-' + args.sellerProfileId + '-' + (mockDb.s.agreements.length + 1), seller_profile_id: args.sellerProfileId, template: 'addendum', status: 'sent',
      template_version_id: mockDb.s.template.current_version_id, _args: args };
    mockDb.s.agreements.push(a); return { agreement: a, rawToken: 'x' };
  });
  jest.spyOn(agreementService, 'resolveBaseTemplateId').mockResolvedValue(null);
}

beforeEach(() => { mockReset(); jest.restoreAllMocks(); writeAuditLog.mockClear(); stubAgreements(); });

describe('invitations', () => {
  test('a token is bound to its record, signed and expiring; tampering or expiry is refused', () => {
    const t = invite('fp-1');
    expect(ap.readToken(t)).toMatchObject({ f: 'fp-1' });
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, f: 'fp-2', i: 1, e: 9999999999, n: 'x' })).toString('base64url') + '.' + sig;
    expect(ap.readToken(forged)).toBeNull();
    expect(ap.readToken(body + '.AAAA')).toBeNull();
    expect(ap.readToken(invite('fp-1', { daysAgo: 40, days: 30 }))).toBeNull();
    expect(ap.readToken('')).toBeNull();
  });
  test('only a reserved PROSPECT can be invited (issuance is audited, nothing is sent)', async () => {
    const r = await ap.issueInvite('fp-1', { actorId: 'admin-1' });
    expect(r.url).toMatch(/^https:\/\/bid\.advantage\.bid\/auction-partner\.html\?invite=/);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'founding_partner.invite_issued', entity_id: 'fp-1' }));
    await expect(ap.issueInvite('fp-ended', { actorId: 'admin-1' })).rejects.toMatchObject({ code: 'NOT_A_PROSPECT' });
    await expect(ap.issueInvite('fp-1', {})).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
  });
  test('an ended (inactive) record, an expired link, or a revoked link is refused with one generic message', async () => {
    await expect(ap.resolveInvite(invite('fp-ended'))).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    await expect(ap.resolveInvite(invite('fp-1', { daysAgo: 31 }))).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    const t = invite('fp-1', { daysAgo: 1 });
    await ap.revokeInvites('fp-1', { actorId: 'admin-1' });
    await expect(ap.resolveInvite(t)).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    expect(mockDb.q.some((q) => /^INSERT INTO audit_log .*invites_revoked/.test(q))).toBe(true);   // written directly, not best-effort
  });
  test('the public invitation view names the Program and company, shows the exact addendum text, and never says "Founding"', async () => {
    const v = await ap.publicView(invite('fp-1'));
    expect(v.program).toBe('Advantage.Bid Auction Partner Program');
    expect(v.company).toBe('Gulf Coast Estate Sales');
    expect(v.addendum.version).toBe(1);
    expect(v.addendum.body).toMatch(/0% Advantage\.Bid auction platform\/software fee/);
    expect(v.addendum.body).toMatch(/\[Auction Partner legal name\]/);
    expect(JSON.stringify(v)).not.toMatch(/founding/i);
    expect(mockDb.s.template).toMatchObject({ agreement_type: 'custom', is_active: false });   // never auto-selected for ordinary sellers
  });
  test('the template publishes a new immutable version only when the source text changes (idempotent otherwise)', async () => {
    await ap.ensureTemplate(); await ap.ensureTemplate();
    expect(templateService.publishVersion).toHaveBeenCalledTimes(1);
    mockDb.s.versions[0].body_markdown = 'older text';
    await ap.ensureTemplate();
    expect(templateService.publishVersion).toHaveBeenCalledTimes(2);
  });
});

describe('acceptance', () => {
  test('unauthenticated entry is refused (sign in first)', async () => {
    await expect(ap.accept(invite('fp-1'), {})).rejects.toMatchObject({ status: 401, code: 'LOGIN_REQUIRED' });
  });
  test('a seller without a valid invitation gets nothing (no public self-enrollment)', async () => {
    await expect(ap.accept('not-a-token', { userId: 'u-pro' })).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    await expect(ap.accept(invite('fp-ended'), { userId: 'u-pro' })).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    expect(mockDb.s.agreements.length).toBe(0);
  });
  test('a non-professional account must complete the professional application first', async () => {
    await expect(ap.accept(invite('fp-1'), { userId: 'u-ind' })).rejects.toMatchObject({ code: 'PROFESSIONAL_PROFILE_REQUIRED' });
    expect(mockDb.s.fps.get('fp-1').seller_profile_id).toBeNull();
  });
  test('the invited prospect: binds the record, issues the Seller Agreement and the addendum (pinned version, no email), never changes a fee', async () => {
    const r = await ap.accept(invite('fp-1'), { userId: 'u-pro' });
    expect(mockDb.s.fps.get('fp-1').seller_profile_id).toBe('sp-pro');
    expect(r.seller_agreement.agreement_id).toBe('base-sp-pro');
    expect(r.addendum).toMatchObject({ status: 'sent', signed: false });
    const call = agreementService.sendAgreement.mock.calls[0][0];
    expect(call).toMatchObject({ templateId: ap.TEMPLATE_ID, sendEmail: false, sellerProfileId: 'sp-pro' });
    expect(call.overrides).toMatchObject({ legal_name: 'Gulf Coast Estate Sales', signatory_name: 'Pat Owner' });
    expect(r.program_active).toBe(false);
    expect(mockDb.q.some((q) => /seller_profiles SET|platform_fee_bps =|fee_applied_at = now/.test(q))).toBe(false);   // no fee touched
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'founding_partner.invite_accepted' }));
  });
  test('repeat acceptance is idempotent: no second addendum, no second claim', async () => {
    await ap.accept(invite('fp-1'), { userId: 'u-pro' });
    writeAuditLog.mockClear();
    const again = await ap.accept(invite('fp-1'), { userId: 'u-pro' });
    expect(agreementService.sendAgreement).toHaveBeenCalledTimes(1);
    expect(mockDb.s.agreements.filter((a) => a.template === 'addendum').length).toBe(1);
    expect(writeAuditLog).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: 'founding_partner.invite_accepted' }));
    expect(again.addendum.agreement_id).toBeTruthy();
  });
  test('a forwarded invitation cannot be used by another account; one seller cannot hold two invitations', async () => {
    await ap.accept(invite('fp-1'), { userId: 'u-pro' });
    await expect(ap.accept(invite('fp-1'), { userId: 'u-pro2' })).rejects.toMatchObject({ code: 'INVITE_ALREADY_CLAIMED' });
    await expect(ap.accept(invite('fp-2'), { userId: 'u-pro' })).rejects.toMatchObject({ code: 'SELLER_ALREADY_IN_PROGRAM' });
  });
  test('signing the addendum records the program audit and alerts the Owner; it does not activate anything', async () => {
    const oa = require('../src/services/ownerAlertService');
    const notify = jest.spyOn(oa, 'notifyAdminActionRequired').mockResolvedValue({ skipped: true });
    mockDb.s.fps.get('fp-1').seller_profile_id = 'sp-pro';
    const agreement = { id: 'add-1', seller_profile_id: 'sp-pro', seller_user_id: 'u-pro', template_version_id: 'ver-addendum' };
    expect(await ap.isAddendum(agreement)).toBe(true);
    expect(await ap.isAddendum({ id: 'b', template_version_id: 'ver-base' })).toBe(false);
    await ap.onAddendumSigned(agreement);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'founding_partner.addendum_signed', entity_id: 'fp-1' }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'auction_partner_signed', entityId: 'add-1' }));
    expect(mockDb.s.fps.get('fp-1').status).toBe('prospect');
  });
});

describe('fees stay safe', () => {
  test('publish is refused while a signed partner is not yet activated, and after the Term with the 0% fee still applied', async () => {
    mockDb.s.fps.get('fp-1').seller_profile_id = 'sp-pro';
    mockDb.s.agreements.push({ id: 'add-x', seller_profile_id: 'sp-pro', template: 'addendum', status: 'signed', signed_at: new Date() });
    expect(await ap.publishGuard('sp-pro')).toMatchObject({ code: 'AUCTION_PARTNER_ACTIVATION_PENDING' });
    Object.assign(mockDb.s.fps.get('fp-1'), { status: 'active', fee_applied_at: new Date(), intro_end_date: '2027-10-04' });
    expect(await ap.publishGuard('sp-pro')).toBeNull();
    mockDb.s.fps.get('fp-1').intro_end_date = '2020-01-01';
    expect(await ap.publishGuard('sp-pro')).toMatchObject({ code: 'AUCTION_PARTNER_TERM_ENDED' });
    mockDb.s.fps.get('fp-1').fee_restored_at = new Date();                 // return fee restored → ordinary terms, publish allowed
    expect(await ap.publishGuard('sp-pro')).toBeNull();
    expect(await ap.publishGuard('sp-ordinary')).toBeNull();               // an ordinary seller is never affected
  });
  test('the Term is one year from the signature (last day = the day before the anniversary)', () => {
    expect(ap.termFor('2026-10-06T14:00:00Z')).toEqual({ start_date: '2026-10-06', intro_end_date: '2027-10-05' });
    expect(ap.termFor('2028-02-29T10:00:00Z')).toEqual({ start_date: '2028-02-29', intro_end_date: '2029-02-28' });
  });
  test('the publish path consults the guard before freezing pricing; activation requires the signed addendum', () => {
    const svc = read('src/services/auctionService.js');
    expect(svc.indexOf('publishGuard(current.rows[0].seller_id, client)')).toBeGreaterThan(-1);
    expect(svc.indexOf('publishGuard(current.rows[0].seller_id, client)')).toBeLessThan(svc.indexOf('PRICING SNAPSHOT'));
    expect(read('src/services/acquisition/foundingPartnerService.js')).toMatch(/ADDENDUM_NOT_SIGNED/);
  });
});

describe('existing onboarding and economics are unaffected', () => {
  test('the addendum never stands in for the Seller Agreement (auto-send, dashboard gate, template fallback)', () => {
    const svc = read('src/services/agreementService.js');
    expect(svc).toMatch(/is_active = true AND current_version_id IS NOT NULL AND id <> \$1/);           // fallback skips it (it is also inactive)
    expect((svc.match(/v\.template_id <> \$2/g) || []).length).toBe(3);                                 // signed gate, pending gate, auto-send
    expect(agreementService.ADDENDUM_TEMPLATE_ID).toBe(ap.TEMPLATE_ID);
  });
  test('sendAgreement still emails the signing link by default (ordinary sellers unchanged)', () => {
    expect(read('src/services/agreementService.js')).toMatch(/sendEmail: emailTheLink = true/);
  });
  test('customer surfaces say "Auction Partner Program", never "Founding", and name no payment vendor', () => {
    const page = read('public/auction-partner.html');
    const body = ap.loadBody();
    for (const t of [page, body, read('src/routes/auctionPartner.js')]) expect(t).not.toMatch(/founding/i);
    expect(page).toMatch(/Advantage\.Bid Auction Partner Program/);
    expect(body).toMatch(/^# Advantage\.Bid Auction Partner Program Addendum/);
    for (const t of [page, body]) expect(t).not.toMatch(/stripe|\bAI\b/i);
  });
  test('the addendum states the Owner\'s terms and avoids the forbidden promises', () => {
    const b = ap.loadBody();
    expect(b).toMatch(/ends one year later/);
    expect(b).toMatch(/does not renew automatically/);
    expect(b).toMatch(/0% Advantage\.Bid auction platform\/software fee/);
    expect(b).toMatch(/actually assesses on the buyer payments/);                                   // actual cost (unchanged)
    expect(b).toMatch(/does not mark up these charges/);
    expect(b).toMatch(/Professional Storefront fixed-price sales are not included/);
    expect(b).toMatch(/starting bids, reserves, custom bid increments, and your buyer's premium/);
    expect(b).toMatch(/Advantage\.Bid processes eligible seller payouts every Thursday\. Auction sales become eligible for the first Thursday after pickup or fulfillment is completed and the transaction is otherwise eligible for payout\./);
    expect(b).toMatch(/Advantage\.Bid attribution remains on every display\./);
    expect(b).not.toMatch(/white-label/i);
    expect(b).toMatch(/an auction that you publish through Advantage\.Bid during the Term while you are eligible for the Program/);
    expect(b).not.toMatch(/Advantage\.Bid (publishes|published|continues to review and publish)/);
    expect(b).toMatch(/based on the amount processed for the buyer's payment, which may include the hammer price, buyer's premium, and applicable sales tax/);
    expect(b).toMatch(/The 0% platform fee applies only to Qualifying Auctions published during the Term\./);
    expect(b).not.toMatch(/not permanent/);
    expect(b).toMatch(/Advantage Auction Company, LLC d\/b\/a Advantage\.Bid/);
    expect(b).toMatch(/does not set a minimum number of auctions/);
    expect(b).not.toMatch(/2\.9|3%|free of charge|completely free|guarantee(s|d)? (bidders|prices|sell-through)|automatically renew(s)? each|white-label service is included/i);
    expect(b).not.toMatch(/—/);                                                                   // em-dash-free (content SOP)
  });
  test('the email PDF exists and is built from the same source text', () => {
    const pdf = fs.readFileSync(path.join(ROOT, 'docs', 'legal', 'auction-partner-program-addendum.pdf'));
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(read('scripts/build-auction-partner-addendum-pdf.js')).toMatch(/ap\.loadBody\(\)/);
  });
});
