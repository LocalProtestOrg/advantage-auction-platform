'use strict';

/**
 * Unified ADMIN ACTION REQUIRED SMS layer.
 * Behavior tests for the reusable notifyAdminActionRequired() (multi-recipient, per-recipient idempotency,
 * failure isolation, direct URL, account email), plus source-level assertions that each family is wired to
 * its AUTHORITATIVE transition and that routine/informational events are deliberately NOT wired.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const mockCreate = jest.fn(async (params) => ({ sid: 'SM_' + String(params.to).slice(-4), status: 'accepted' }));
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: mockCreate } })));
const store = { log: new Map() };
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');
function route(sql, params) {
  const s = String(sql);
  if (/INSERT INTO owner_alert_log/.test(s)) {
    const dedup = params[4];
    if (store.log.has(dedup)) return { rows: [] };
    const id = 'row-' + (store.log.size + 1); store.log.set(dedup, { id, status: 'pending' }); return { rows: [{ id }] };
  }
  if (/SELECT id, status FROM owner_alert_log WHERE dedup_key/.test(s)) { const r = store.log.get(params[0]); return { rows: r ? [{ id: r.id, status: r.status }] : [] }; }
  if (/UPDATE owner_alert_log SET status='sent'/.test(s)) { setStatus(params[0], 'sent'); return { rows: [] }; }
  if (/UPDATE owner_alert_log SET status='failed'/.test(s)) { setStatus(params[0], 'failed'); return { rows: [] }; }
  if (/UPDATE owner_alert_log SET status='pending'/.test(s)) { setStatus(params[0], 'pending'); return { rows: [] }; }
  return { rows: [] };
}
function setStatus(id, status) { for (const r of store.log.values()) if (r.id === id) r.status = status; }

const A = '+15551110001', B = '+15551110002';
let svc;
beforeEach(() => {
  store.log.clear();
  mockCreate.mockClear();
  mockCreate.mockImplementation(async (params) => ({ sid: 'SM_' + String(params.to).slice(-4), status: 'accepted' }));
  db.query.mockReset(); db.query.mockImplementation(async (sql, params) => route(sql, params));
  process.env.TWILIO_ACCOUNT_SID = 'ACx'; process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGx';
  delete process.env.TWILIO_FROM_NUMBER;
  process.env.OWNER_ALERT_PHONE_E164S = `${A},${B}`; process.env.OWNER_ALERT_PHONE_E164 = A;
  svc = require('../src/services/ownerAlertService');
});

describe('notifyAdminActionRequired (reusable)', () => {
  const base = { actionType: 'professional_seller_verification_pending', entityType: 'verification_request', entityId: 'req-1',
    headline: 'Seller verification pending approval', context: 'A professional seller submitted verification documents.',
    email: 'seller@example.com', adminPath: '/admin/verification.html', actionLabel: 'Review' };
  test('delivers to BOTH recipients with a concise actionable message + direct URL', async () => {
    const r = await svc.notifyAdminActionRequired(base);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const body = mockCreate.mock.calls[0][0].body;
    expect(body).toContain('Advantage.Bid: Seller verification pending approval');
    expect(body).toContain('Account: seller@example.com');
    expect(body).toContain('https://bid.advantage.bid/admin/verification.html');
    expect(r).toMatchObject({ attempted: 2, sent: 2, failed: 0 });
  });
  test('per-recipient idempotency: a duplicate transition does not re-text either recipient', async () => {
    await svc.notifyAdminActionRequired(base);
    mockCreate.mockClear();
    const r = await svc.notifyAdminActionRequired(base);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skipped: true, reason: 'already_sent' });
  });
  test('a genuinely NEW requirement later (distinct entityId) re-alerts', async () => {
    await svc.notifyAdminActionRequired(base);
    mockCreate.mockClear();
    await svc.notifyAdminActionRequired({ ...base, entityId: 'req-1:cycle2' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
  test('one recipient failing never suppresses the other', async () => {
    mockCreate.mockImplementation(async (p) => { if (p.to === B) throw new Error('down'); return { sid: 'ok', status: 'accepted' }; });
    const r = await svc.notifyAdminActionRequired({ ...base, entityId: 'req-x' });
    expect(r).toMatchObject({ attempted: 2, sent: 1, failed: 1 });
  });
  test('missing actionType/entityId is a safe no-op (never throws)', async () => {
    await expect(svc.notifyAdminActionRequired({ actionType: 'x' })).resolves.toMatchObject({ skipped: true });
  });
  test('a direct admin URL with an id param is built when provided', async () => {
    await svc.notifyAdminActionRequired({ ...base, entityId: 'req-2', adminPath: '/admin/settlement-review.html', adminId: 'auc-9', adminParam: 'auction' });
    expect(mockCreate.mock.calls[0][0].body).toContain('/admin/settlement-review.html?auction=auc-9');
  });
  test('result never leaks a full phone number', async () => {
    const r = await svc.notifyAdminActionRequired({ ...base, entityId: 'req-3' });
    expect(JSON.stringify(r)).not.toContain(A);
    expect(JSON.stringify(r)).not.toContain(B);
  });
});

describe('wiring — each family fires on its AUTHORITATIVE transition', () => {
  test('verification: fired on the guarded open/more_info → submitted transition, cycle-aware entity', () => {
    const s = read('src', 'services', 'verificationService.js');
    expect(s).toMatch(/status='submitted'[\s\S]*RETURNING id, updated_at/);
    expect(s).toMatch(/PROFESSIONAL_SELLER_VERIFICATION_PENDING/);
    expect(s).toMatch(/entityId: `\$\{requestId\}:\$\{new Date\(trans\.updated_at\)/);
    expect(s).toMatch(/if \(trans\)/); // only on the real transition
  });
  test('business listing: idempotent via org id + submitted_at cycle token', () => {
    expect(read('src', 'routes', 'orgEvents.js')).toMatch(/organizationId: out\.organization_id, submittedAt: out\.submitted_at/);
    expect(read('src', 'services', 'ownerAlertService.js')).toMatch(/BUSINESS_LISTING_SUBMITTED, entityType: 'organization', entityId: `\$\{organizationId\}:\$\{cycle\}`/);
  });
  test('payout: fired only when a payout row is newly created (result.rows[0]) → pending review', () => {
    const s = read('src', 'services', 'payoutService.js');
    expect(s).toMatch(/if \(result\.rows\[0\]\)/);
    expect(s).toMatch(/PAYOUT_RELEASE_PENDING/);
    expect(s).toMatch(/adminParam: 'auction'/);
  });
  test('settlement exception: fired on transfer.reversed authoritative update (RETURNING row)', () => {
    const s = read('src', 'services', 'settlementEngine.js');
    expect(s).toMatch(/payout_status='reversed'[\s\S]*RETURNING id, auction_id/);
    expect(s).toMatch(/SETTLEMENT_EXCEPTION/);
    expect(s).toMatch(/entityId: `\$\{row\.id\}:reversed`/);
  });
  test('compliance: deliberately NOT wired to SMS (non-blocking decision-support; isolation preserved)', () => {
    const s = read('src', 'services', 'complianceService.js');
    expect(s).not.toMatch(/ownerAlert|notifyOwner|notifyAdminActionRequired|sendSMS/); // isolation boundary kept
    expect(s).toMatch(/ADMIN_MAY_REVIEW/); // documented classification
    // COMPLIANCE_ESCALATION stays a reserved ALERT_TYPE for a future explicit escalation state.
    expect(read('src', 'services', 'ownerAlertService.js')).toMatch(/COMPLIANCE_ESCALATION/);
  });
});

describe('anti-noise — routine/informational events are NOT wired to admin-action SMS', () => {
  test('ordinary successful buyer payment does not trigger an admin-action SMS', () => {
    const pay = read('src', 'services', 'paymentService.js');
    expect(pay).not.toMatch(/notifyAdminActionRequired|PAYOUT_RELEASE_PENDING|SETTLEMENT_EXCEPTION/);
  });
  test('event import + walkthrough video moderation are NOT wired to owner SMS (high-frequency/dashboard)', () => {
    expect(read('src', 'routes', 'adminEventImports.js')).not.toMatch(/ownerAlertService|notifyAdminActionRequired/);
    // video moderation lives in admin.js; ensure no admin-action SMS was added there for it
    expect(read('src', 'services', 'ownerAlertService.js')).not.toMatch(/walkthrough|video_pending/i);
  });
  test('exactly the intended admin-action families exist as ALERT_TYPES', () => {
    const s = read('src', 'services', 'ownerAlertService.js');
    ['PROFESSIONAL_SELLER_VERIFICATION_PENDING', 'PAYOUT_RELEASE_PENDING', 'SETTLEMENT_EXCEPTION', 'COMPLIANCE_ESCALATION'].forEach((t) => expect(s).toMatch(t));
  });
});
