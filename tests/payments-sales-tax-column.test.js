'use strict';

/**
 * Regression (2026-09-27): the Stripe Tax pipeline writes payments.sales_tax_cents, but no migration ever created it
 * (109 assumed 072 had; 072 only altered `invoices`). With tax enabled every taxed auction charge failed with 42703.
 * Guard: every column the tax pipeline writes on `payments` is created by some migration.
 */
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'db', 'migrations');
const all = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(MIG, f), 'utf8')).join('\n');
// Every column added to `payments` by an ALTER TABLE payments ... block or created in CREATE TABLE payments.
const created = new Set();
for (const m of all.matchAll(/ALTER TABLE (?:IF EXISTS )?payments\b([\s\S]*?);/gi)) {
  for (const c of m[1].matchAll(/ADD COLUMN (?:IF NOT EXISTS )?(\w+)/gi)) created.add(c[1]);
}
for (const m of all.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?payments\s*\(([\s\S]*?)\n\);/gi)) {
  for (const line of m[1].split('\n')) { const w = line.trim().match(/^(\w+)\s/); if (w) created.add(w[1]); }
}

test('migration 175 adds payments.sales_tax_cents as NOT NULL DEFAULT 0', () => {
  const sql = fs.readFileSync(path.join(MIG, '175_payments_sales_tax_cents.sql'), 'utf8');
  expect(sql).toMatch(/ALTER TABLE payments ADD COLUMN IF NOT EXISTS sales_tax_cents INTEGER NOT NULL DEFAULT 0;/);
});

test('every payments column the tax pipeline writes is created by a migration', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'paymentService.js'), 'utf8');
  const block = src.slice(src.indexOf('async _applyTaxToPayment'), src.indexOf('async _finalizeTaxTransaction'));
  const cols = [...block.matchAll(/UPDATE payments\s+SET([\s\S]*?)WHERE/g)]
    .flatMap((m) => [...m[1].matchAll(/(\w+)\s*=/g)].map((c) => c[1]));
  expect(cols).toEqual(expect.arrayContaining(['sales_tax_cents', 'taxable_base_cents', 'stripe_tax_calculation_id']));
  for (const c of cols) expect({ column: c, created: created.has(c) }).toEqual({ column: c, created: true });
});
