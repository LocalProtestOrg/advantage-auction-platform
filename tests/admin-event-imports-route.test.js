'use strict';

// Commit 10 — Admin Review Queue route governance. The repo has no supertest harness, so
// these assert the non-negotiable governance wiring at the source level: admin-only auth,
// every mutation wrapped in a transaction, audit never bypassed, the expectedCount guard,
// bulk id caps, and that the router mounts + loads cleanly.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; // authMiddleware requires it at load

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const route = read('src', 'routes', 'adminEventImports.js');
const server = read('server.js');

describe('authorization + mount', () => {
  test('router requires auth AND the admin role on every route', () => {
    expect(route).toMatch(/router\.use\(authMiddleware, roleMiddleware\(\['admin'\]\)\)/);
  });
  test('module loads without error (require smoke test)', () => {
    expect(() => require('../src/routes/adminEventImports')).not.toThrow();
  });
  test('mounted at /api/admin/event-imports, before the /api/admin catch-all', () => {
    expect(server).toMatch(/app\.use\('\/api\/admin\/event-imports', adminEventImportsRoutes\)/);
    const mountIdx = server.indexOf("app.use('/api/admin/event-imports'");
    const catchAllIdx = server.indexOf("app.use('/api/admin', adminRoutes)");
    expect(mountIdx).toBeGreaterThan(-1);
    expect(catchAllIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeLessThan(catchAllIdx);
  });
});

describe('transactional + audited mutations (governance not weakened)', () => {
  test('approve/reject/bulk/approve-all all run inside withTransaction', () => {
    // Count the withTransaction wrappers — 5 mutation routes must each use one.
    const wraps = (route.match(/withTransaction\(/g) || []).length;
    expect(wraps).toBeGreaterThanOrEqual(5);
  });
  test('approval reuses writer.publishImported via the service (no direct status flip in the route)', () => {
    expect(route).toMatch(/reviewQueue\.approveOne\(client/);
    expect(route).not.toMatch(/UPDATE events SET status/); // the route never mutates events directly
  });
  test('acting admin is the audit actor (req.user.id threaded into every mutation)', () => {
    expect(route).toMatch(/approveOne\(client, req\.params\.id, req\.user\.id/);
    expect(route).toMatch(/rejectOne\(client, req\.params\.id, req\.user\.id/);
    expect(route).toMatch(/approveOne\(client, id, req\.user\.id/); // bulk + approve-all
  });
  test('no native/external record is created or deleted from the route (all writes go via the audited service)', () => {
    // The route issues NO direct INSERT/DELETE SQL — approvals/rejections flow through the
    // service (writer.publishImported / status flip), which is where auditing lives.
    expect(route).not.toMatch(/INSERT INTO/i);
    expect(route).not.toMatch(/DELETE FROM/i);
  });
});

describe('approve-all expectedCount safety guard', () => {
  test('rejects a missing/negative expectedCount with 400', () => {
    expect(route).toMatch(/EXPECTED_COUNT_REQUIRED/);
    expect(route).toMatch(/expectedCount < 0/);
  });
  test('publishes nothing and 409s on a count mismatch (locked snapshot)', () => {
    expect(route).toMatch(/lockPendingIds\(client, filters\)/);
    expect(route).toMatch(/ids\.length !== expectedCount.*throw new reviewQueue\.CountMismatchError/s);
    expect(route).toMatch(/CountMismatchError[\s\S]*status\(409\)/);
  });
});

describe('bulk input safety', () => {
  test('bulk endpoints reject an empty id list (400) and cap the batch', () => {
    expect(route).toMatch(/NO_IDS/);
    expect(route).toMatch(/out\.length >= 500/); // hard per-call cap
    expect(route).toMatch(/reviewQueue\.isUuid\(v\)/); // only well-formed uuids
  });
});

describe('endpoint surface', () => {
  test('exposes browse/detail/approve/reject/bulk/approve-all/sources', () => {
    expect(route).toMatch(/router\.get\('\/queue'/);
    expect(route).toMatch(/router\.get\('\/queue\/:id'/);
    expect(route).toMatch(/router\.post\('\/queue\/:id\/approve'/);
    expect(route).toMatch(/router\.post\('\/queue\/:id\/reject'/);
    expect(route).toMatch(/router\.post\('\/bulk-approve'/);
    expect(route).toMatch(/router\.post\('\/bulk-reject'/);
    expect(route).toMatch(/router\.post\('\/approve-all'/);
    expect(route).toMatch(/router\.get\('\/sources'/);
  });
});
