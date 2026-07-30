'use strict';

// Commit 10 — Admin Review Queue service. Hermetic: db, writer, auditLog are mocked.
// Proves the governance guarantees at the service layer: transactional row-locking,
// approval reuses writer.publishImported, rejection → 'rejected' (never deleted), every
// decision is audited with the acting admin, and non-pending items are skipped safely.

jest.mock('../../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => ({ id: 'AUD1' })) }));
jest.mock('../../src/services/eventImport/writer', () => ({ publishImported: jest.fn(async () => true) }));

const db = require('../../src/db');
const { writeAuditLog } = require('../../src/lib/auditLog');
const writer = require('../../src/services/eventImport/writer');
const rq = require('../../src/services/eventImport/reviewQueue');

const EV = '11111111-2222-3333-4444-555555555555';

function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return (responder && responder(sql, params)) || { rows: [] };
    },
    find(re) { return this.calls.find((c) => re.test(c.sql)); },
  };
}

beforeEach(() => { db.query.mockReset(); writeAuditLog.mockClear(); writer.publishImported.mockClear(); });

// ── buildPendingWhere — filter/search SQL ────────────────────────────────────
describe('buildPendingWhere', () => {
  test('base predicate = imported drafts only', () => {
    const { sql, params } = rq.buildPendingWhere({}, 0);
    expect(sql).toBe("e.source = 'imported' AND e.status = 'draft'");
    expect(params).toEqual([]);
  });
  test('sourceId (uuid), market, and q compose parameterized clauses', () => {
    const { sql, params } = rq.buildPendingWhere({ sourceId: EV, market: 'houston', q: 'estate' }, 0);
    expect(sql).toMatch(/event_sources es WHERE es\.event_id = e\.id AND es\.source_id = \$1/);
    expect(sql).toMatch(/e\.market_slug = \$2/);
    expect(sql).toMatch(/e\.title ILIKE \$3 OR e\.city ILIKE \$3 OR e\.state ILIKE \$3 OR e\.organizer_name ILIKE \$3/);
    expect(params).toEqual([EV, 'houston', '%estate%']);
  });
  test('a non-uuid sourceId is ignored (no injection surface)', () => {
    const { sql, params } = rq.buildPendingWhere({ sourceId: "x'; DROP TABLE events; --" }, 0);
    expect(sql).toBe("e.source = 'imported' AND e.status = 'draft'");
    expect(params).toEqual([]);
  });
});

// ── list — pagination + metadata mapping ─────────────────────────────────────
describe('list', () => {
  test('returns paginated items with review metadata', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ n: 3 }] }) // count
      .mockResolvedValueOnce({ rows: [{
        id: EV, slug: 'houston-sale', title: 'Houston Estate Sale', city: 'Houston', state: 'TX',
        market_slug: 'houston', market_resolved_via: 'radius', organizer_name: 'ACME Estate Co',
        start_at: '2026-09-01T14:00:00Z', end_at: '2026-09-02T20:00:00Z', created_at: 'c', updated_at: 'u',
        image_count: 4, company_match_status: 'possible',
        source_id: 'S', source_url: 'https://host/x', first_imported_at: 't', sync_status: 'active',
        source_key: 'aac-csv', source_name: 'AAC CSV', source_kind: 'csv', media_policy: 'link_only', auto_publish: false,
        run_id: 'R1', outcome: 'created', match_via: null, reason: null,
      }] });
    const out = await rq.list({ page: 1, limit: 25, market: 'houston' });
    expect(out.total).toBe(3);
    expect(out.page).toBe(1);
    expect(out.pages).toBe(1);
    const it = out.items[0];
    expect(it.organizer).toBe('ACME Estate Co');
    expect(it.company_match_status).toBe('possible');
    expect(it.source_platform).toBe('AAC CSV');
    expect(it.media_policy).toBe('link_only');
    expect(it.auto_publish_eligible).toBe(false);
    expect(it.import).toMatchObject({ run_id: 'R1', outcome: 'created' });
  });

  test('empty queue → zero items, pages >= 1', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ n: 0 }] }).mockResolvedValueOnce({ rows: [] });
    const out = await rq.list({});
    expect(out.total).toBe(0);
    expect(out.items).toEqual([]);
    expect(out.pages).toBe(1);
  });
});

// ── approveOne — reuses publishImported, audits, row-locks ────────────────────
describe('approveOne', () => {
  test('pending draft → publishes + audits approval with the acting admin', async () => {
    const c = fakeClient((sql) => (/FOR UPDATE/.test(sql) ? { rows: [{ id: EV, status: 'draft' }] } : { rows: [] }));
    const r = await rq.approveOne(c, EV, 'admin-9', 'looks good');
    expect(r).toEqual({ id: EV, ok: true, status: 'published' });
    expect(c.find(/SELECT id, status FROM events WHERE id = \$1 AND source = 'imported' FOR UPDATE/)).toBeTruthy();
    expect(writer.publishImported).toHaveBeenCalledWith(c, EV, { actorId: 'admin-9' });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({
      event_type: 'event.import.approved', entity_type: 'event', entity_id: EV, actor_id: 'admin-9',
    });
    expect(writeAuditLog.mock.calls[0][0].client).toBe(c); // transactional audit
  });

  test('missing event → not_found, no publish, no audit', async () => {
    const c = fakeClient(() => ({ rows: [] }));
    const r = await rq.approveOne(c, EV, 'admin-9');
    expect(r).toEqual({ id: EV, ok: false, reason: 'not_found' });
    expect(writer.publishImported).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test('already published → not_pending, no publish, no audit', async () => {
    const c = fakeClient(() => ({ rows: [{ id: EV, status: 'published' }] }));
    const r = await rq.approveOne(c, EV, 'admin-9');
    expect(r).toMatchObject({ ok: false, reason: 'not_pending', status: 'published' });
    expect(writer.publishImported).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

// ── rejectOne — draft → 'rejected', audited, never deleted ────────────────────
describe('rejectOne', () => {
  test('pending draft → rejected + audit with reason (no DELETE)', async () => {
    const c = fakeClient((sql) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: EV, status: 'draft' }] };
      if (/UPDATE events SET status = 'rejected'/.test(sql)) return { rows: [{ id: EV }] };
      return { rows: [] };
    });
    const r = await rq.rejectOne(c, EV, 'admin-9', 'off-catalog');
    expect(r).toEqual({ id: EV, ok: true, status: 'rejected' });
    // never issues a DELETE — provenance + audit are preserved
    expect(c.calls.some((x) => /DELETE/i.test(x.sql))).toBe(false);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({
      event_type: 'event.import.rejected', entity_id: EV, actor_id: 'admin-9',
    });
    expect(writeAuditLog.mock.calls[0][0].metadata).toMatchObject({ reason: 'off-catalog' });
  });

  test('non-pending → skipped, no update, no audit', async () => {
    const c = fakeClient(() => ({ rows: [{ id: EV, status: 'rejected' }] }));
    const r = await rq.rejectOne(c, EV, 'admin-9', 'x');
    expect(r).toMatchObject({ ok: false, reason: 'not_pending' });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

// ── lockPendingIds — FOR UPDATE snapshot for approve-all ──────────────────────
describe('lockPendingIds', () => {
  test('locks the filtered pending set and returns ids', async () => {
    const c = fakeClient(() => ({ rows: [{ id: 'a' }, { id: 'b' }] }));
    const ids = await rq.lockPendingIds(c, { market: 'houston' });
    expect(ids).toEqual(['a', 'b']);
    const q = c.find(/FROM events e WHERE/);
    expect(q.sql).toMatch(/FOR UPDATE/);
    expect(q.sql).toMatch(/e\.market_slug = \$1/);
    expect(q.params).toEqual(['houston']);
  });
});

// ── CountMismatchError — the approve-all safety guard ─────────────────────────
describe('CountMismatchError', () => {
  test('carries a stable code + the expected/actual counts', () => {
    const e = new rq.CountMismatchError(5, 7);
    expect(e.code).toBe('APPROVE_ALL_COUNT_MISMATCH');
    expect(e.expected).toBe(5);
    expect(e.actual).toBe(7);
  });
});

// ── detail — null for non-imported, escapes company-match input ───────────────
describe('detail', () => {
  test('non-uuid → null without querying', async () => {
    expect(await rq.detail('nope')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
  test('unknown/non-imported id → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await rq.detail(EV)).toBeNull();
  });
});
