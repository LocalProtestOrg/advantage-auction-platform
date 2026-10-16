'use strict';

/**
 * Taxpayer-ID minimisation (owner decision 2026-10-16; migration 202; roadmap §8.6). Real Postgres (PGlite) with the real
 * seller_identity migrations (055, the identity columns of 107, 202) and the real sellerIdentityService:
 *   • the database refuses any stored EIN;
 *   • identity reads (admin agreements, agreement variables) never include a taxpayer number;
 *   • the audit log records which identity fields changed — never the values.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}
function mockAdapter() {
  const query = async (sql, params) => { const r = await global.__PG.query(sql, params || []); return { rows: r.rows, rowCount: r.rows.length }; };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}
jest.mock('../src/db', () => mockAdapter());
jest.mock('../src/db/index', () => mockAdapter());
const mockAudit = [];
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async (e) => { mockAudit.push(e); }) }));

const mig = (f) => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8');
let svc; let SP;
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(`CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
    CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id), seller_type text);`);
  await global.__PG.exec(mig('055_create_seller_identity.sql'));
  // the seller_identity part of migration 107 (its other statements concern verification tables not used here)
  await global.__PG.exec(`ALTER TABLE seller_identity ADD COLUMN IF NOT EXISTS ein TEXT NULL; ALTER TABLE seller_identity ADD COLUMN IF NOT EXISTS dba_name TEXT NULL;`);
  await global.__PG.exec(mig('202_taxpayer_id_minimization.sql'));
  await global.__PG.exec(mig('202_taxpayer_id_minimization.sql'));   // idempotent
  SP = (await q(`INSERT INTO seller_profiles (seller_type) VALUES ('auction_house') RETURNING id`))[0].id;
  svc = require('../src/services/sellerIdentityService');
}, 60000);
afterAll(async () => { if (global.__PG) await global.__PG.close(); });

test('the database refuses to store an EIN; new rows start with status not_provided', async () => {
  await svc.upsertIdentity(SP, { legal_name: 'Acme Auctions LLC', city: 'Houston', state: 'TX' }, null);
  expect((await q('SELECT ein, taxpayer_id_status FROM seller_identity WHERE seller_profile_id = $1', [SP]))[0]).toEqual({ ein: null, taxpayer_id_status: 'not_provided' });
  await expect(global.__PG.query(`UPDATE seller_identity SET ein = '12-3456789' WHERE seller_profile_id = $1`, [SP])).rejects.toThrow(/seller_identity_no_full_ein|check/i);
  await expect(global.__PG.query(`UPDATE seller_identity SET taxpayer_id_last4 = '12-34' WHERE seller_profile_id = $1`, [SP])).rejects.toThrow(/check/i);
  await expect(global.__PG.query(`UPDATE seller_identity SET taxpayer_id_status = 'maybe' WHERE seller_profile_id = $1`, [SP])).rejects.toThrow(/check/i);
  await q(`UPDATE seller_identity SET taxpayer_id_status = 'verified', taxpayer_id_source = 'stripe_connect', taxpayer_id_last4 = '6789' WHERE seller_profile_id = $1`, [SP]);
});

test('identity reads never include a taxpayer number (field-level allow-list)', async () => {
  const row = await svc.getIdentity(SP);
  expect(row).toMatchObject({ legal_name: 'Acme Auctions LLC', taxpayer_id_status: 'verified' });
  expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['ein']));
  expect(Object.keys(row).filter((k) => /ein|tax_id|tin|last4/i.test(k))).toEqual([]);
});

test('the audit log records which identity fields changed, never their values', async () => {
  mockAudit.length = 0;
  await svc.upsertIdentity(SP, { phone: '713-555-0101', address_line1: '1 Private Way' }, null);
  expect(mockAudit).toHaveLength(1);
  expect(mockAudit[0].metadata).toEqual({ changed_fields: ['address_line1', 'phone'] });
  expect(JSON.stringify(mockAudit)).not.toMatch(/555-0101|Private Way|Acme|6789/);
});

test('no route or service returns a full EIN any more', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  expect(read('src/routes/adminVerification.js')).not.toMatch(/includeEin/);
  expect(read('src/services/verificationService.js')).not.toMatch(/si\.ein\b/);
  expect(read('src/services/sellerIdentityService.js')).not.toMatch(/SELECT \* FROM seller_identity|before, after/);
  expect(read('public/verify-documents.html')).not.toMatch(/id="bz-ein"/);
});

test('documents that would show a full taxpayer number can no longer be requested or uploaded (existing rows still display)', async () => {
  const v = require('../src/services/verificationService');
  expect(v.RETIRED_CATEGORIES).toEqual(['ein_verification', 'tax_document']);
  for (const cat of v.RETIRED_CATEGORIES) {
    await expect(v.createRequest(SP, { categories: [cat] }, null)).rejects.toMatchObject({ code: 'INVALID_CATEGORY' });
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'verificationService.js'), 'utf8');
  expect(src).toMatch(/if \(RETIRED_CATEGORIES\.includes\(category\)\) \{\s*throw new VerificationError\('CATEGORY_RETIRED'/);
  expect(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'verification.html'), 'utf8')).not.toMatch(/var CATS = \[[^\]]*'ein_verification'/);
  expect(fs.existsSync(path.join(__dirname, '..', 'db', 'rollbacks', '202_taxpayer_id_minimization.down.sql'))).toBe(true);
});
