'use strict';

/**
 * taxPolicy - the ONE place that decides how sales tax is handled for a sale, for every channel (auctions, marketplace
 * sales, embedded storefront sales). Owner authorization 2026-11-16; migration 231.
 *
 * The decision rests on an administrator-entered rule per state (marketplace_tax_jurisdictions), never on an assumption:
 *   'platform'       Advantage.Bid collects at checkout and remits. The calculation must really be collecting there.
 *   'seller_direct'  Advantage.Bid does not collect; the seller is responsible outside the platform.
 *   'seller'         RETIRED for new transactions (collected under Advantage.Bid's registration and paid to the seller:
 *                    a double-remittance risk). Historical orders keep it; a new sale treats it as "no rule".
 *   no rule          never permission to collect nothing. Storefront orders are refused (marketplaceOrderService).
 *                    Auctions: 'enforce' holds the payment for an administrator; 'report' (the setting until the owner
 *                    turns enforcement on) lets the payment proceed exactly as before and raises an alert.
 *
 * A $0 calculation is classified, never assumed: an approved buyer exemption, a non-taxable item, or "not collecting"
 * (no registration in the calculation provider). Nothing here decides who is legally responsible; it only applies the
 * configuration an administrator recorded from professional advice.
 */

const db = require('../../db');

const NEW_RULE_REMITTERS = Object.freeze(['platform', 'seller_direct']);
const HOLD_MESSAGE = 'Payment for this purchase is on hold while Advantage.Bid completes a required setup step. Nothing has been charged. We will let you know as soon as you can pay.';

class TaxHoldError extends Error {
  constructor(code, detail = {}) {
    super(HOLD_MESSAGE);
    this.name = 'TaxHoldError';
    this.code = code;              // TAX_CONFIGURATION_REQUIRED | TAX_NOT_COLLECTING | TAX_CONFIGURATION_CONFLICT
    this.status = 409;
    this.taxHold = true;
    this.detail = detail;          // internal only (state, auction): never sent to the buyer
  }
}

async function ruleFor(state, runner = db) {
  const st = String(state || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(st)) return null;
  try {
    return (await runner.query(
      `SELECT state, remitter, legal_basis, effective_from FROM marketplace_tax_jurisdictions WHERE state = $1 AND effective_from <= CURRENT_DATE`, [st])).rows[0] || null;
  } catch (e) { if (e && e.code === '42P01') return null; throw e; }
}

async function activeRegistration(state, runner = db) {
  const st = String(state || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(st)) return null;
  try {
    return (await runner.query(
      `SELECT id, state, status, effective_from, effective_to, filing_frequency, processor_registered FROM tax_registrations
        WHERE state = $1 AND status = 'active' AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
          AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`, [st])).rows[0] || null;
  } catch (e) { if (e && e.code === '42P01') return null; throw e; }
}

// 'enforce' or 'report'. Anything unreadable is 'report': a broken setting must never start blocking payments.
let modeCache = { at: 0, value: 'report' };
async function auctionEnforcement(runner = db) {
  if (runner === db && Date.now() - modeCache.at < 15000) return modeCache.value;
  let value = 'report';
  try {
    const r = (await runner.query(`SELECT value FROM platform_config WHERE key = 'tax.auction_enforcement'`)).rows[0];
    if (r && r.value === 'enforce') value = 'enforce';
  } catch (_e) { /* report */ }
  if (runner === db) modeCache = { at: Date.now(), value };
  return value;
}
function clearCache() { modeCache = { at: 0, value: 'report' }; }

async function activeException(auctionId, state, runner = db) {
  if (!auctionId || !state) return null;
  try {
    return (await runner.query(
      `SELECT id, decision, reason FROM tax_payment_exceptions WHERE auction_id = $1 AND state = $2 AND revoked_at IS NULL`,
      [auctionId, String(state).toUpperCase()])).rows[0] || null;
  } catch (e) { if (e && e.code === '42P01') return null; throw e; }
}

/** What a calculation result means. tax = taxCalculationService.computeTax's result. */
function classify(tax) {
  if (!tax || !tax.enabled) return 'tax_off';
  if ((Number(tax.taxCents) || 0) > 0) return 'taxed';
  if (tax.exempt === true) return 'exempt';
  if (tax.collecting === true) return 'not_taxable';
  return 'not_collecting';
}

/**
 * The auction decision. Pure. Returns
 *   { action: 'charge', taxCents, remitter, basis, keepCalculation }   or   { action: 'hold', code }.
 * remitter: 'platform' | 'seller_direct' | 'none' | 'unconfigured' | 'exception' | null (tax switched off entirely).
 */
function decideAuction({ rule, tax, mode = 'report', exception = null }) {
  const kind = classify(tax);
  const cents = Math.max(0, Number(tax && tax.taxCents) || 0);
  if (kind === 'tax_off') return { action: 'charge', taxCents: 0, remitter: null, basis: 'tax_off', keepCalculation: false };
  const usable = rule && NEW_RULE_REMITTERS.includes(rule.remitter) ? rule : null;
  if (!usable) {
    if (exception) return { action: 'charge', taxCents: cents, remitter: cents > 0 ? 'platform' : 'exception', basis: cents > 0 ? 'taxed' : 'exception', keepCalculation: cents > 0 };
    if (mode === 'enforce') return { action: 'hold', code: 'TAX_CONFIGURATION_REQUIRED' };
    // Report mode: exactly the behaviour before the safeguard, but recorded for what it is.
    return { action: 'charge', taxCents: cents, remitter: cents > 0 ? 'platform' : 'unconfigured',
      basis: kind === 'taxed' ? 'taxed' : (kind === 'not_collecting' ? 'unconfigured' : kind), keepCalculation: true };
  }
  if (usable.remitter === 'seller_direct') {
    // A registration was added without updating the rule: never charge tax the rule says is not collected, never drop it silently.
    if (cents > 0) return { action: 'hold', code: 'TAX_CONFIGURATION_CONFLICT' };
    return { action: 'charge', taxCents: 0, remitter: 'seller_direct', basis: 'seller_direct', keepCalculation: false };
  }
  // 'platform'
  if (kind === 'taxed') return { action: 'charge', taxCents: cents, remitter: 'platform', basis: 'taxed', keepCalculation: true };
  if (kind === 'exempt') return { action: 'charge', taxCents: 0, remitter: 'none', basis: 'exempt', keepCalculation: false };
  if (kind === 'not_taxable') return { action: 'charge', taxCents: 0, remitter: 'none', basis: 'not_taxable', keepCalculation: true };
  if (exception) return { action: 'charge', taxCents: 0, remitter: 'exception', basis: 'exception', keepCalculation: false };
  return { action: 'hold', code: 'TAX_NOT_COLLECTING' };
}

/**
 * May an auction with this pickup state be published? Returns { allowed, code, state, mode }.
 * 'report' never refuses (it reports); 'enforce' refuses a state with no usable rule. An unknown state is left to the
 * existing pickup-location checks.
 */
async function auctionPublicationCheck(state, runner = db) {
  const st = String(state || '').toUpperCase();
  const mode = await auctionEnforcement(runner);
  if (!/^[A-Z]{2}$/.test(st)) return { allowed: true, code: 'STATE_UNKNOWN', state: null, mode };
  const rule = await ruleFor(st, runner);
  const usable = !!(rule && NEW_RULE_REMITTERS.includes(rule.remitter));
  if (usable) return { allowed: true, code: 'RULE_PRESENT', state: st, mode, remitter: rule.remitter };
  return { allowed: mode !== 'enforce', code: 'TAX_CONFIGURATION_REQUIRED', state: st, mode };
}

const PUBLICATION_MESSAGE = 'This auction cannot be published yet: sales in its pickup state are waiting on a setup step by Advantage.Bid. Your work is saved. Please contact Advantage.Bid and we will complete it.';

module.exports = { NEW_RULE_REMITTERS, HOLD_MESSAGE, PUBLICATION_MESSAGE, TaxHoldError, ruleFor, activeRegistration, auctionEnforcement,
  activeException, classify, decideAuction, auctionPublicationCheck, clearCache };
