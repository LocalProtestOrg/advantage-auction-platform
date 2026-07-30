'use strict';

// Corrective fix (Population Phase 1): a best-effort transactional audit must never poison the
// caller's transaction. Discovered when an approve-queue run reported success but published 0 events:
// a failed audit INSERT inside the tx aborted it, turning the COMMIT into a silent ROLLBACK. The fix
// isolates the audit write in a SAVEPOINT.

jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const { writeAuditLog } = require('../src/lib/auditLog');

const BASE = { event_type: 'event.published', entity_type: 'event', entity_id: '11111111-2222-3333-4444-555555555555', actor_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

function client(insertBehavior) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (/^INSERT INTO audit_log/.test(sql.trim())) return insertBehavior(params);
      return { rows: [] }; // SAVEPOINT / RELEASE / ROLLBACK
    },
  };
}

beforeEach(() => db.query.mockReset());

describe('writeAuditLog SAVEPOINT isolation (transactional, best-effort)', () => {
  test('a failing audit INSERT rolls back to the savepoint and returns null (never throws)', async () => {
    const c = client(() => { throw new Error('invalid input syntax for type uuid'); });
    const out = await writeAuditLog({ ...BASE, client: c });
    expect(out).toBeNull(); // best-effort: swallowed
    expect(c.calls[0]).toMatch(/^SAVEPOINT audit_write/);
    expect(c.calls.some((q) => /^INSERT INTO audit_log/.test(q))).toBe(true);
    expect(c.calls[c.calls.length - 1]).toMatch(/^ROLLBACK TO SAVEPOINT audit_write/);
    // crucially: NO bare failure left the transaction in an aborted state (savepoint absorbed it)
  });

  test('a successful audit INSERT releases the savepoint and returns the row', async () => {
    const c = client(() => ({ rows: [{ id: 'AUD1', created_at: 't' }] }));
    const out = await writeAuditLog({ ...BASE, client: c });
    expect(out).toEqual({ id: 'AUD1', created_at: 't' });
    expect(c.calls).toEqual([
      'SAVEPOINT audit_write',
      'INSERT INTO audit_log (event_type, entity_type, entity_id, auction_id, lot_id, payment_id, actor_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id, created_at',
      'RELEASE SAVEPOINT audit_write',
    ]);
  });

  test('without a client (pool path) it does NOT wrap in a savepoint', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'AUD2' }] });
    const out = await writeAuditLog({ ...BASE });
    expect(out).toEqual({ id: 'AUD2' });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toMatch(/^\s*INSERT INTO audit_log/);
  });

  test('missing required fields still short-circuits (no query)', async () => {
    const c = client(() => ({ rows: [] }));
    const out = await writeAuditLog({ event_type: null, entity_type: 'event', entity_id: 'x', client: c });
    expect(out).toBeNull();
    expect(c.calls.length).toBe(0);
  });
});
