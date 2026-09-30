'use strict';

/**
 * /api/admin/event-partners route order (defect 30 Sep 2026): GET /:id was registered before the static
 * GET lists, so /cohorts, /escalations, /requests, /suppressions (and /templates) were captured by /:id and
 * failed in Postgres with 22P02 (invalid uuid) → 500. Each static path must reach its own handler, and a
 * non-uuid /:id must 404 without touching the database.
 */

const http = require('http');
const express = require('express');

jest.mock('../../src/db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })) }));
jest.mock('../../src/middleware/authMiddleware', () => (req, _res, next) => { req.user = { id: 'u1', role: 'admin' }; next(); });
jest.mock('../../src/middleware/requirePermission', () => {
  const f = () => (_req, _res, next) => next();
  f.loadStaffContext = async () => ({ is_super_admin: true });
  return f;
});
jest.mock('../../src/services/eventPartners/authorizationService', () => ({ list: jest.fn(async () => []), auditHistory: jest.fn(async () => []), STATES: [] }));
jest.mock('../../src/services/eventPartners/partnerSourceService', () => ({ inspect: jest.fn(async () => ({ kind: 'detail' })) }));
jest.mock('../../src/services/eventPartners/performanceStatsService', () => ({ evaluateForAuthorization: jest.fn(async () => ({})), threshold: jest.fn(async () => 100) }));
jest.mock('../../src/services/eventPartners/escalationService', () => ({ list: jest.fn(async () => [{ kind: 'escalations' }]), counts: jest.fn(async () => ({})) }));
jest.mock('../../src/services/eventPartners/cohortService', () => ({ listCohorts: jest.fn(async () => [{ kind: 'cohorts' }]), listTemplates: jest.fn(async () => [{ kind: 'templates' }]) }));
jest.mock('../../src/services/eventPartners/selfServiceService', () => ({ listRequests: jest.fn(async () => [{ kind: 'requests' }]), PATHS: [] }));
jest.mock('../../src/services/eventPartners/partnerSuppressionService', () => ({ list: jest.fn(async () => [{ kind: 'suppressions' }]), isSuppressed: jest.fn(async () => false) }));
jest.mock('../../src/services/configService', () => ({ get: jest.fn(async () => false) }));

const partnerSource = require('../../src/services/eventPartners/partnerSourceService');
const db = require('../../src/db');
const router = require('../../src/routes/adminEventPartners');

let server;
beforeAll((done) => {
  const app = express();
  app.use('/api/admin/event-partners', router);
  server = http.createServer(app).listen(0, done);
});
afterAll((done) => { server.close(done); });
beforeEach(() => { jest.clearAllMocks(); });

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/admin/event-partners' + path }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || 'null') }));
    }).on('error', reject);
  });
}

describe('event-partner admin static routes are not captured by /:id', () => {
  test.each(['cohorts', 'escalations', 'requests', 'suppressions', 'templates'])('GET /%s reaches its own handler', async (name) => {
    const r = await get('/' + name);
    expect(r.status).toBe(200);
    expect(r.body.data[0].kind).toBe(name);
    expect(partnerSource.inspect).not.toHaveBeenCalled();
  });

  test('a non-uuid id is a 404 and never reaches the database', async () => {
    const r = await get('/not-a-uuid');
    expect(r.status).toBe(404);
    expect(partnerSource.inspect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a uuid id still returns the partner detail', async () => {
    const r = await get('/11111111-1111-4111-8111-111111111111');
    expect(r.status).toBe(200);
    expect(r.body.data.kind).toBe('detail');
    expect(partnerSource.inspect).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  });

  test('GET /:id is registered after every static single-segment GET', () => {
    const gets = router.stack.filter((l) => l.route && l.route.methods.get).map((l) => l.route.path);
    const idAt = gets.indexOf('/:id');
    for (const p of ['/escalations', '/templates', '/cohorts', '/requests', '/suppressions']) expect(gets.indexOf(p)).toBeLessThan(idAt);
  });
});
