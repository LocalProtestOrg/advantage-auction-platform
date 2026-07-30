'use strict';

// Commit 15 — manual-run, worker-status, and run-history routes on /api/admin/event-imports.
// Source-level governance + a require smoke test (no supertest in the repo).

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; // authMiddleware requires it at load

const fs = require('fs');
const path = require('path');
const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminEventImports.js'), 'utf8');

describe('module + authorization', () => {
  test('loads cleanly (require smoke) and still admin-guards every route', () => {
    expect(() => require('../src/routes/adminEventImports')).not.toThrow();
    expect(route).toMatch(/router\.use\(authMiddleware, roleMiddleware\(\['admin'\]\)\)/);
  });
  test('exposes the new operational endpoints', () => {
    expect(route).toMatch(/router\.get\('\/status'/);
    expect(route).toMatch(/router\.get\('\/runs'/);
    expect(route).toMatch(/router\.get\('\/runs\/:id'/);
    expect(route).toMatch(/router\.post\('\/run'/);
  });
});

describe('POST /run — reuses the Commit 14 worker (draft-only) + audited', () => {
  const run = route.slice(route.indexOf("router.post('/run'"), route.indexOf('// Roll a list of per-id'));
  test('delegates to worker.runNow / runAllNow (never calls the engine or a publish path directly)', () => {
    expect(run).toMatch(/worker\.runAllNow\(\{ apply, trigger: 'manual' \}\)/);
    expect(run).toMatch(/worker\.runNow\(\{ sourceKey: String\(sourceKey\), apply, trigger: 'manual' \}\)/);
    expect(run).not.toMatch(/publishImported|runImport\(/);
  });
  test('apply defaults FALSE (dry run) — writes nothing unless explicitly applied', () => {
    expect(run).toMatch(/const apply = !!body\.apply/);
  });
  test('requires a sourceKey or all=true', () => {
    expect(run).toMatch(/SOURCE_REQUIRED/);
  });
  test('audits the manual trigger with the acting admin (never bypasses audit)', () => {
    expect(run).toMatch(/writeAuditLog\(\{/);
    expect(run).toMatch(/event_type: apply \? 'event_import_manual_run' : 'event_import_dry_run'/);
    expect(run).toMatch(/actor_id: req\.user\.id/);
  });
  test('a run failure is reported as 400, not a 500 crash', () => {
    expect(run).toMatch(/RUN_FAILED/);
  });
});

describe('GET /runs — history mapping + safe filters', () => {
  test('maps ledger columns to operator counts (imported/updated/skipped/dupes/errors)', () => {
    expect(route).toMatch(/imported: r\.created/);
    expect(route).toMatch(/updated: r\.updated/);
    expect(route).toMatch(/skipped: \(r\.skipped_quality \|\| 0\) \+ \(r\.skipped_ambiguous \|\| 0\)/);
    expect(route).toMatch(/duplicates: r\.skipped_duplicate/);
    expect(route).toMatch(/errors: r\.failed/);
  });
  test('filters are whitelisted / uuid-validated (no injection surface)', () => {
    const runs = route.slice(route.indexOf("router.get('/runs'"), route.indexOf("router.get('/runs/:id'"));
    expect(runs).toMatch(/reviewQueue\.isUuid\(req\.query\.sourceId\)/);
    expect(runs).toMatch(/\['running', 'completed', 'partial', 'failed'\]\.includes\(req\.query\.status\)/);
    expect(runs).toMatch(/\['scheduled', 'manual', 'backfill'\]\.includes\(req\.query\.trigger\)/);
  });
  test('run detail returns the per-record trail (dead-letter items)', () => {
    const detail = route.slice(route.indexOf("router.get('/runs/:id'"), route.indexOf("router.post('/run'"));
    expect(detail).toMatch(/FROM import_run_items WHERE run_id = \$1/);
    expect(detail).toMatch(/outcome, match_via, market_via, reason, error/);
  });
});

describe('GET /status — scheduler + worker state, no secrets', () => {
  const st = route.slice(route.indexOf("router.get('/status'"), route.indexOf("router.get('/runs'"));
  test('reports scheduler enabled + schedule from the worker cfg', () => {
    expect(st).toMatch(/worker\.cfg\(\)/);
    expect(st).toMatch(/enabled: c\.enabled/);
    expect(st).toMatch(/schedule_label/);
  });
  test('derives live worker state from the shared DB (running now + last run)', () => {
    expect(st).toMatch(/status = 'running'/);
    expect(st).toMatch(/running_now: !!running/);
    expect(st).toMatch(/last_run: last \? mapRun\(last\) : null/);
  });
  test('exposes no secrets (no env dumps / connection strings / tokens)', () => {
    expect(st).not.toMatch(/DATABASE_URL|process\.env\.[A-Z]|JWT|SECRET|API_KEY/);
  });
});
