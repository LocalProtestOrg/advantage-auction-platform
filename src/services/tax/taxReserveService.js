'use strict';

/**
 * taxReserveService - sales tax that Advantage.Bid collected and must remit is not spendable (owner 2026-11-16).
 *
 *   outstanding liability = platform tax collected - tax remitted                      (from the ledger, all states)
 *   held outside          = money an administrator recorded as moved to the dedicated tax bank account, not yet remitted
 *   required on hand      = max(0, outstanding liability - held outside)
 *
 * The payout guard: a seller transfer is refused when the payment account's AVAILABLE balance (pending settlements are
 * not counted; refunds and chargebacks have already reduced it) would fall below "required on hand" after the transfer.
 * It fails closed: if the balance cannot be read while tax is owed, the transfer waits. With nothing owed it makes no
 * outside call at all. An administrator cannot override it; the remedies are real ones (wait for settlement, record the
 * money already moved to the tax account, or record the remittance).
 */

const db = require('../../db');

async function position(runner = db) {
  let r;
  try {
    r = (await runner.query(
      `SELECT COALESCE(SUM(tax_collected_cents) FILTER (WHERE remitter = 'platform'), 0)::bigint AS collected,
              COALESCE(SUM(tax_remitted_cents), 0)::bigint AS remitted,
              COALESCE(SUM(tax_reserved_cents), 0)::bigint AS moved
         FROM tax_ledger_entries`)).rows[0];
  } catch (e) { if (e && e.code === '42P01') return { collected: 0, remitted: 0, outstanding: 0, heldOutside: 0, requiredOnHand: 0 }; throw e; }
  const collected = Number(r.collected) || 0; const remitted = Number(r.remitted) || 0; const moved = Number(r.moved) || 0;
  const outstanding = Math.max(0, collected - remitted);
  // Money in the tax account pays remittances, so what is still held there is what was moved less what was remitted.
  const heldOutside = Math.max(0, Math.min(outstanding, moved - remitted));
  return { collected, remitted, outstanding, heldOutside, requiredOnHand: Math.max(0, outstanding - heldOutside) };
}

async function guardEnabled(runner = db) {
  try {
    const r = (await runner.query(`SELECT value FROM platform_config WHERE key = 'tax.reserve_guard'`)).rows[0];
    return !(r && r.value === false);
  } catch (_e) { return true; }
}

class TaxReserveError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'TaxReserveError'; this.code = code; this.status = 409; this.detail = detail || null; }
}
const money = (c) => '$' + (Math.round(Number(c) || 0) / 100).toFixed(2);

/**
 * Throws TaxReserveError when a transfer of transferCents would spend money held for sales tax. `stripe` is the client
 * the caller is about to create the transfer with. The ledger is brought up to date first, so tax collected minutes ago
 * is protected.
 */
async function assertTransferLeavesReserve({ transferCents, stripe }, runner = db) {
  // Before migration 231 is applied there is no ledger and nothing to protect. to_regclass never raises, so this probe
  // is safe inside the caller's open transaction.
  const installed = (await runner.query(`SELECT to_regclass('public.tax_ledger_entries') IS NOT NULL AND to_regclass('public.platform_config') IS NOT NULL AS ok`)).rows[0];
  if (!installed || installed.ok !== true) return { checked: false, reason: 'not_installed' };
  if (!(await guardEnabled(runner))) return { checked: false, reason: 'guard_off' };
  try { await require('./taxLedgerService').sync(); } catch (e) { console.error('[tax-reserve] ledger sync before payout failed:', e.message); }
  const pos = await position(runner);
  if (pos.requiredOnHand <= 0) return { checked: true, requiredOnHand: 0 };
  let available;
  try {
    const bal = await stripe.balance.retrieve();
    available = (bal.available || []).filter((b) => b.currency === 'usd').reduce((s, b) => s + (Number(b.amount) || 0), 0);
  } catch (e) {
    throw new TaxReserveError('TAX_RESERVE_UNVERIFIED',
      'The payment account balance could not be checked, so this payout is waiting: sales tax is owed and must stay covered. Try again in a few minutes.');
  }
  const after = available - Math.max(0, Math.round(Number(transferCents) || 0));
  if (after < pos.requiredOnHand) {
    throw new TaxReserveError('TAX_RESERVE_SHORTFALL',
      `This payout would spend money held for sales tax. Available balance ${money(available)}; this payout ${money(transferCents)}; sales tax that must stay covered ${money(pos.requiredOnHand)}. `
      + 'Wait for pending card payments to settle, or record sales tax already moved to the tax account or already remitted (Admin > Sales Tax).',
      { available, transferCents, requiredOnHand: pos.requiredOnHand });
  }
  return { checked: true, requiredOnHand: pos.requiredOnHand, available };
}

module.exports = { position, guardEnabled, assertTransferLeavesReserve, TaxReserveError };
