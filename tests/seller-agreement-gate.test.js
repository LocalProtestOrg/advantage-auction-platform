'use strict';

/**
 * Seller Agreement v1 — dashboard gate + signed-PDF email.
 * Unit tests with a keyword-dispatch mock for db and a mocked email transport.
 */

jest.mock('../src/db/index', () => ({ query: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue({ messageId: 'm1' }) }));

const db = require('../src/db/index');
const { sendEmail } = require('../src/services/emailService');
const svc = require('../src/services/agreementService');

// Dispatch db.query by matching the lowercased SQL against ordered [keyword, rows] routes.
function route(routes) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql).toLowerCase();
    for (const [kw, rows] of routes) {
      if (s.includes(kw)) return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => { db.query.mockReset(); sendEmail.mockClear(); });

describe('dashboardAccess', () => {
  test('admin-waived seller → access (reason waived)', async () => {
    route([['agreement_waived_at', [{ id: 'sp1', agreement_waived_at: '2026-06-17T00:00:00Z' }]]]);
    expect(await svc.dashboardAccess('sp1')).toEqual({ access: true, reason: 'waived', agreement_id: null });
  });

  test('current signed agreement → access (reason signed, returns agreement_id)', async () => {
    route([
      ['agreement_waived_at', [{ id: 'sp1', agreement_waived_at: null }]],
      ["status in ('signed'", [{ id: 'A1' }]],
    ]);
    expect(await svc.dashboardAccess('sp1')).toEqual({ access: true, reason: 'signed', agreement_id: 'A1' });
  });

  test('no signed agreement but has a non-draft auction → access (grandfathered)', async () => {
    route([
      ['agreement_waived_at', [{ id: 'sp1', agreement_waived_at: null }]],
      ["status in ('signed'", []],
      ['from auctions', [{ '?column?': 1 }]],
    ]);
    expect(await svc.dashboardAccess('sp1')).toEqual({ access: true, reason: 'grandfathered', agreement_id: null });
  });

  test('no access, but a pending agreement exists → required + agreement_id', async () => {
    route([
      ['agreement_waived_at', [{ id: 'sp1', agreement_waived_at: null }]],
      ["status in ('signed'", []],
      ['from auctions', []],
      ["status in ('sent'", [{ id: 'P1' }]],
    ]);
    expect(await svc.dashboardAccess('sp1')).toEqual({ access: false, reason: 'agreement_required', agreement_id: 'P1' });
  });

  test('no access and nothing to sign → required + null', async () => {
    route([['agreement_waived_at', [{ id: 'sp1', agreement_waived_at: null }]]]);
    expect(await svc.dashboardAccess('sp1')).toEqual({ access: false, reason: 'agreement_required', agreement_id: null });
  });

  test('unknown seller → seller_not_found, no access', async () => {
    route([]); // seller_profiles query returns []
    expect(await svc.dashboardAccess('nope')).toEqual({ access: false, reason: 'seller_not_found', agreement_id: null });
  });
});

describe('getOnboardingStatus', () => {
  test('non-seller user → not gated (dashboard_access true)', async () => {
    route([]); // seller_profiles WHERE user_id returns []
    const r = await svc.getOnboardingStatus('user-x');
    expect(r.is_seller).toBe(false);
    expect(r.dashboard_access).toBe(true);
    expect(r.required).toBe(false);
  });

  test('seller without signed agreement → required, surfaces pending id', async () => {
    route([
      ['where user_id', [{ id: 'sp1' }]],
      ['agreement_waived_at', [{ id: 'sp1', agreement_waived_at: null }]],
      ["status in ('signed'", []],
      ['from auctions', []],
      ["status in ('sent'", [{ id: 'P9' }]],
    ]);
    const r = await svc.getOnboardingStatus('user-1');
    expect(r).toMatchObject({ is_seller: true, seller_profile_id: 'sp1', dashboard_access: false, required: true, agreement_id: 'P9', reason: 'agreement_required' });
  });
});

describe('emailSignedPdf', () => {
  const buffer = Buffer.from('%PDF-1.4 test');

  test('sends the PDF as an attachment and stamps signed_pdf_emailed_at once', async () => {
    route([
      ['join users', [{ email: 'seller@example.com' }]],
      ['update agreements set signed_pdf_emailed_at', [{ id: 'A1' }]],
    ]);
    await svc.emailSignedPdf({ id: 'A1', seller_profile_id: 'sp1', signed_pdf_emailed_at: null }, buffer);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0];
    expect(arg.to).toBe('seller@example.com');
    expect(Array.isArray(arg.attachments)).toBe(true);
    expect(arg.attachments[0].contentType).toBe('application/pdf');
    expect(Buffer.isBuffer(arg.attachments[0].content)).toBe(true);
    // stamping UPDATE was issued with the idempotency guard
    const stamp = db.query.mock.calls.find(([sql]) => String(sql).toLowerCase().includes('update agreements set signed_pdf_emailed_at'));
    expect(stamp[0].toLowerCase()).toContain('signed_pdf_emailed_at is null');
  });

  test('idempotent: already-emailed agreement does not re-send', async () => {
    route([['join users', [{ email: 'seller@example.com' }]]]);
    await svc.emailSignedPdf({ id: 'A1', seller_profile_id: 'sp1', signed_pdf_emailed_at: '2026-06-17T00:00:00Z' }, buffer);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('best-effort: no buffer → no send, no throw', async () => {
    await expect(svc.emailSignedPdf({ id: 'A1', seller_profile_id: 'sp1', signed_pdf_emailed_at: null }, null)).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
