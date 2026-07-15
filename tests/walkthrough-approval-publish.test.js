'use strict';

/**
 * #3 — Walkthrough approval workflow (approved business rule).
 *
 * Queue approval must complete publication:
 *   Seller Upload → Queued → Admin Approves → Automatically Published
 *   → Appears Under All Videos → Visible On Public Auction
 *
 * There must NOT be two separate manual moderation actions for the normal
 * approval workflow. The separate visibility action is preserved so an admin
 * can hide/re-show an already-approved video.
 *
 * Mocked-db unit tests — no network, no live server.
 */

jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));

const db = require('../src/db');
const svc = require('../src/services/walkthroughVideoService');

beforeEach(() => { jest.clearAllMocks(); });

// Pull the SQL text + params out of the single db.query call under test.
function lastCall() {
  const [sql, params] = db.query.mock.calls[0];
  return { sql: String(sql).replace(/\s+/g, ' '), params };
}

describe('#3 — Queue approval auto-publishes', () => {
  test('approveVideo publishes in ONE action (no second manual step)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'v1', review_status: 'approved', visible_public: true }],
    });

    const row = await svc.approveVideo('v1', 'admin-1');

    const { sql, params } = lastCall();
    // The single approval write must set BOTH review state and publication.
    expect(sql).toMatch(/review_status = 'approved'/);
    expect(sql).toMatch(/visible_public = true/);
    expect(params).toEqual(['v1', 'admin-1']);

    // The row handed back to the caller is already publicly visible.
    expect(row).toMatchObject({ review_status: 'approved', visible_public: true });
  });

  test('approval records the admin + clears any prior rejection reason', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });

    await svc.approveVideo('v1', 'admin-1');

    const { sql } = lastCall();
    expect(sql).toMatch(/approved_by = \$2/);
    expect(sql).toMatch(/approved_at = NOW\(\)/);
    // A previously-rejected video that is later approved must not keep its reason.
    expect(sql).toMatch(/rejection_reason = NULL/);
  });

  test('an approved video satisfies the public-visibility query contract', async () => {
    // getPublicVideos requires BOTH flags; approveVideo must satisfy both by itself,
    // otherwise approval alone would not surface the walkthrough publicly.
    db.query.mockResolvedValueOnce({ rows: [] });
    await svc.getPublicVideos();

    const { sql } = lastCall();
    expect(sql).toMatch(/visible_public = true/);
    expect(sql).toMatch(/review_status = 'approved'/);
  });

  test('approveVideo returns null when the video does not exist', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(svc.approveVideo('missing', 'admin-1')).resolves.toBeNull();
  });
});

describe('#3 — the separate visibility action is preserved', () => {
  test('setPublicVisibility(false) can hide an already-approved video', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'v1', review_status: 'approved', visible_public: false }],
    });

    const row = await svc.setPublicVisibility('v1', false);

    const { sql, params } = lastCall();
    expect(sql).toMatch(/visible_public = \$2/);
    // Hiding remains scoped to approved videos only.
    expect(sql).toMatch(/review_status = 'approved'/);
    expect(params).toEqual(['v1', false]);
    expect(row).toMatchObject({ visible_public: false });
  });

  test('setPublicVisibility(true) can re-show a hidden approved video', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'v1', review_status: 'approved', visible_public: true }],
    });

    const row = await svc.setPublicVisibility('v1', true);

    expect(lastCall().params).toEqual(['v1', true]);
    expect(row).toMatchObject({ visible_public: true });
  });

  test('setPublicVisibility cannot publish a video that was never approved', async () => {
    // The WHERE clause gates on review_status='approved', so an unapproved id
    // matches no row — moderation cannot be bypassed via the visibility action.
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(svc.setPublicVisibility('pending-video', true)).resolves.toBeNull();
    expect(lastCall().sql).toMatch(/WHERE id = \$1 AND review_status = 'approved'/);
  });
});

describe('#3 — rejection still unpublishes', () => {
  test('rejectVideo clears visible_public and featured_for_marketing', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'v1', review_status: 'rejected', visible_public: false }],
    });

    await svc.rejectVideo('v1', 'admin-1', 'Poor audio');

    const { sql, params } = lastCall();
    expect(sql).toMatch(/review_status = 'rejected'/);
    expect(sql).toMatch(/visible_public = false/);
    expect(sql).toMatch(/featured_for_marketing = false/);
    expect(sql).toMatch(/approved_at = NULL/);
    expect(params).toEqual(['v1', 'Poor audio', 'admin-1']);
  });

  test('a newly uploaded video starts queued and unpublished', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'v1', review_status: 'pending_review', visible_public: false }],
    });

    await svc.createVideo('a1', { videoUrl: 'https://example.test/v.mp4' });

    const { sql } = lastCall();
    expect(sql).toMatch(/'pending_review', false, false/);
  });
});
