'use strict';

/**
 * Storefront sales tax safeguard (owner 2026-11-09): no storefront order proceeds without the CPA-approved tax configuration
 * an administrator recorded for the sale's state (marketplace_tax_jurisdictions; migration 227 adds "not collected at
 * checkout"). The order-flow cases run on a real database in storefront-commerce-policies.test.js; this file covers how a
 * calculation is read, every branch of the rule check, migration 227 and its production runner.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const mig = (f) => fs.readFileSync(path.join(ROOT, 'db', 'migrations', f), 'utf8');

describe('reading whether the processor is collecting tax for the address', () => {
  const { isCollecting } = jest.requireActual('../src/services/taxCalculationService');
  test.each([
    ['tax calculated', { tax_breakdown: [] }, 825, true],
    ['$0, taxable but zero rate (collecting)', { tax_breakdown: [{ taxability_reason: 'zero_rated' }] }, 0, true],
    ['$0, product exempt (collecting)', { tax_breakdown: [{ taxability_reason: 'product_exempt' }] }, 0, true],
    ['$0, no registration for the state', { tax_breakdown: [{ taxability_reason: 'not_collecting' }] }, 0, false],
    ['$0, location not supported', { tax_breakdown: [{ taxability_reason: 'not_supported' }] }, 0, false],
    ['$0, no breakdown at all (fails closed)', {}, 0, false],
    ['$0, breakdown without a reason (fails closed)', { tax_breakdown: [{}] }, 0, false],
  ])('%s', (label, calc, cents, want) => { expect(isCollecting(calc, cents)).toBe(want); });
});

describe('the rule check (no decision about who is legally responsible; it enforces the recorded configuration)', () => {
  jest.mock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
  const { taxConfiguration } = require('../src/services/marketplaceOrderService');
  const T = (o) => ({ enabled: true, exempt: false, taxCents: 0, collecting: false, ...o });
  const refused = (fn, code) => { try { fn(); } catch (e) { expect(e).toMatchObject({ status: 409, code }); return; } throw new Error('not refused'); };
  test('no rule: refused, whatever the calculation says', () => {
    for (const tax of [T({ taxCents: 825, collecting: true }), T({}), { enabled: false, taxCents: 0 }]) refused(() => taxConfiguration(null, 'TX', tax), 'TAX_CONFIGURATION_REQUIRED');
  });
  test.each(['platform', 'seller'])('rule "%s" (collected at checkout)', (remitter) => {
    expect(taxConfiguration({ remitter }, 'tx', T({ taxCents: 825, collecting: true }))).toEqual({ remitter, jurisdiction: 'TX' });
    expect(taxConfiguration({ remitter }, 'TX', T({ collecting: true }))).toEqual({ remitter: 'none', jurisdiction: 'TX' });   // not taxable
    expect(taxConfiguration({ remitter }, 'TX', T({ exempt: true }))).toEqual({ remitter: 'none', jurisdiction: 'TX' });       // approved exemption
    refused(() => taxConfiguration({ remitter }, 'TX', T({})), 'TAX_NOT_COLLECTING');                                         // not registered
    refused(() => taxConfiguration({ remitter }, 'TX', { enabled: false, taxCents: 0 }), 'TAX_NOT_COLLECTING');               // calculation off
    refused(() => taxConfiguration({ remitter }, 'TX', T({ collecting: undefined })), 'TAX_NOT_COLLECTING');                  // unknown: fail closed
  });
  test('rule "seller_direct" (not collected at checkout)', () => {
    expect(taxConfiguration({ remitter: 'seller_direct' }, 'TX', { enabled: false, taxCents: 0 })).toEqual({ remitter: 'none', jurisdiction: 'TX' });
    expect(taxConfiguration({ remitter: 'seller_direct' }, 'TX', T({}))).toEqual({ remitter: 'none', jurisdiction: 'TX' });
    refused(() => taxConfiguration({ remitter: 'seller_direct' }, 'TX', T({ taxCents: 825, collecting: true })), 'TAX_CONFIGURATION_CONFLICT');
  });
  test('an unknown rule value is refused', () => { refused(() => taxConfiguration({ remitter: 'buyer' }, 'TX', T({ taxCents: 825, collecting: true })), 'TAX_CONFIGURATION_REQUIRED'); });
  test('the old check that let a $0 order through without a rule is gone', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
    expect(src).not.toMatch(/async function taxResponsibility|taxResponsibility\(/);
    const create = src.slice(src.indexOf('async function createOrder'), src.indexOf('async function reuseOrRetireHold'));
    expect(create.indexOf('await assertTaxRule(saleState)')).toBeGreaterThan(0);
    expect(create.indexOf('await assertTaxRule(saleState)')).toBeLessThan(create.indexOf('reuseOrRetireHold('));   // before any unit is held
    expect(create).toMatch(/taxConfiguration\(await taxRuleFor\(saleState\), saleState, tax\)/);                    // re-read after the calculation
  });
});

describe('migration 227 and its production runner', () => {
  function startPg() {
    const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
    worker.unref();
    const pending = new Map(); let n = 0;
    worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
    const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
    return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
  }
  test('adds "seller_direct" and changes no existing rule', async () => {
    const pg = startPg();
    try {
      // the table as migration 214 created it (with its original check), holding rules written before 227
      await pg.exec(`CREATE TABLE marketplace_tax_jurisdictions (state CHAR(2) PRIMARY KEY, remitter TEXT NOT NULL CHECK (remitter IN ('platform', 'seller')),
        legal_basis TEXT NOT NULL, effective_from DATE NOT NULL DEFAULT CURRENT_DATE, notes TEXT, updated_by UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
        INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis) VALUES ('NY', 'platform', 'advice'), ('CA', 'seller', 'advice');`);
      await expect(pg.query(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis) VALUES ('TX', 'seller_direct', 'advice')`)).rejects.toThrow();
      await pg.exec(mig('227_storefront_tax_rule_seller_direct.sql'));
      await pg.exec(mig('227_storefront_tax_rule_seller_direct.sql'));   // safe to run twice
      await pg.query(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis) VALUES ('TX', 'seller_direct', 'advice')`);
      await expect(pg.query(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis) VALUES ('OK', 'none', 'advice')`)).rejects.toThrow(/remitter_check/);
      const rows = (await pg.query('SELECT state, remitter FROM marketplace_tax_jurisdictions ORDER BY state')).rows;
      expect(rows).toEqual([{ state: 'CA', remitter: 'seller' }, { state: 'NY', remitter: 'platform' }, { state: 'TX', remitter: 'seller_direct' }]);
    } finally { await pg.close(); }
  }, 30000);
  test('the runner is production-only, read-only with --check, and verifies nothing else changed', () => {
    const s = fs.readFileSync(path.join(ROOT, 'scripts', 'prod-migrate-227.js'), 'utf8');
    expect(s).toMatch(/REFUSE: PRODUCTION endpoint only/);
    expect(s).toMatch(/const ok = pre\.migration_214_applied && pre\.rules_table_present && !pre\.already_recorded && pre\.invalid_rules === 0;/);
    expect(s).toMatch(/if \(CHECK\) \{[^}]*return ok \? 0 : 1; \}/);
    expect(s).toMatch(/rules_unchanged/);
    expect(mig('227_storefront_tax_rule_seller_direct.sql')).not.toMatch(/INSERT|UPDATE marketplace_tax_jurisdictions SET|DELETE/i);
  });
});
