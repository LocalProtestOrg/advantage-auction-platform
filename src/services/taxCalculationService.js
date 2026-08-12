'use strict';

/**
 * taxCalculationService — Stripe Tax (Calculation API) integration for auction buyer payments.
 *
 * Owner-approved Version 1.0 policy:
 *   • Jurisdiction  = BUYER address (customer_details.address), NOT the auction pickup address.
 *   • Taxable base  = hammer + buyer premium (the caller passes this as taxableBaseCents).
 *   • Seller payout = tax EXCLUDED (this module never touches settlement; the settlement engine
 *                     computes the seller's net from the billing model, independent of the charge).
 *
 * Architecture: auction payments are raw PaymentIntents, so `automatic_tax` is NOT applicable —
 * the correct method is the Tax Calculation API: create a calculation, add its tax to the
 * PaymentIntent amount, then record a Tax Transaction on success (and a reversal on refund).
 *
 * SAFETY: the entire pipeline is gated by the STRIPE_TAX_ENABLED env flag (default OFF). With the
 * flag off, computeTax() returns zero tax and makes NO Stripe call — behavior is byte-for-byte the
 * pre-tax flow. The flag stays OFF in production until the Owner enables Stripe Tax + registrations.
 *
 * Stripe is AUTHORITATIVE for the tax amount when enabled — we never estimate tax locally. The one
 * local short-circuit is an APPROVED buyer exemption → $0 (never a silent exemption; see
 * taxExemptionService: only an admin approval sets it).
 */

const taxExemptionService = require('./taxExemptionService');

const STRIPE_API_VERSION = '2026-03-25.dahlia'; // matches paymentService/cardService pin
// General tangible goods tax code by default; overridable per Owner Stripe config without code change.
const DEFAULT_TAX_CODE = process.env.STRIPE_TAX_PRODUCT_CODE || 'txcd_99999999';
const DEFAULT_COUNTRY  = process.env.STRIPE_TAX_DEFAULT_COUNTRY || 'US';

function getStripe() {
  const Stripe = require('stripe');
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

/** Runtime kill switch. Tax is inactive unless STRIPE_TAX_ENABLED === 'true'. */
function taxEnabled() {
  return String(process.env.STRIPE_TAX_ENABLED || '').toLowerCase() === 'true';
}

class TaxCalculationError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'TaxCalculationError';
    this.code = code;      // BUYER_TAX_ADDRESS_REQUIRED | TAX_CALCULATION_FAILED
    this.status = status;  // route maps this to the HTTP status
  }
}

/** Minimum viable address for a Stripe Tax jurisdiction determination. */
function addressComplete(a) {
  return !!(a && a.line1 && a.city && a.state && a.postal_code && (a.country || DEFAULT_COUNTRY));
}

/**
 * Compute sales tax for a taxable base using the buyer's address.
 * Returns { enabled, taxCents, calculationId, exempt }.
 *  - flag OFF                          → { enabled:false, taxCents:0, calculationId:null, exempt:false }  (NO Stripe call)
 *  - approved applicable exemption     → { enabled:true,  taxCents:0, calculationId:null, exempt:true  }  (NO Stripe call)
 *  - missing address (flag ON)         → throws TaxCalculationError('BUYER_TAX_ADDRESS_REQUIRED')
 *  - Stripe failure (flag ON)          → throws TaxCalculationError('TAX_CALCULATION_FAILED')  (caller must FAIL the payment)
 *  - otherwise                         → { enabled:true,  taxCents:<stripe>, calculationId:<id>, exempt:false }
 */
async function computeTax({ buyerUserId, taxableBaseCents, address, currency = 'usd', reference }) {
  if (!taxEnabled()) return { enabled: false, taxCents: 0, calculationId: null, exempt: false };

  const base = Math.max(0, Math.round(Number(taxableBaseCents) || 0));

  // Approved, applicable exemption → $0 tax. Only an admin approval produces this (users.tax_exempt
  // mirror + buyer_tax_exemptions.status='approved'); pending/rejected are NEVER treated as exempt.
  const exemption = await taxExemptionService.effectiveExemptionForSale(buyerUserId, {
    state: address && address.state ? address.state : null,
    date: new Date(),
  });
  if (exemption) return { enabled: true, taxCents: 0, calculationId: null, exempt: true };

  // Non-exempt: a jurisdiction address is required BEFORE we can calculate/charge.
  if (!addressComplete(address)) {
    throw new TaxCalculationError('BUYER_TAX_ADDRESS_REQUIRED',
      'A billing address is required to calculate sales tax before payment.', 422);
  }

  let calc;
  try {
    const stripe = getStripe();
    calc = await stripe.tax.calculations.create({
      currency,
      line_items: [{
        amount: base,                 // hammer + buyer premium (tax-exclusive base)
        reference: reference || 'auction-sale',
        tax_behavior: 'exclusive',
        tax_code: DEFAULT_TAX_CODE,
      }],
      customer_details: {
        address: {
          line1: address.line1,
          line2: address.line2 || undefined,
          city: address.city,
          state: address.state,
          postal_code: address.postal_code,
          country: address.country || DEFAULT_COUNTRY,
        },
        address_source: 'billing',
      },
    }, { timeout: 15000 });
  } catch (e) {
    // Never assume $0 on failure — the caller MUST block the payment (fail-safe).
    console.error('[tax] calculation failed:', e && e.message ? e.message : e);
    throw new TaxCalculationError('TAX_CALCULATION_FAILED',
      'Sales tax could not be calculated right now. Please try again in a moment.', 502);
  }

  const taxCents = Math.max(0, Math.round(Number(calc.tax_amount_exclusive) || 0));
  return { enabled: true, taxCents, calculationId: calc.id, exempt: false };
}

/**
 * Record the authoritative Stripe Tax Transaction from a prior calculation, on payment success.
 * Idempotent via a stable idempotency key; returns the transaction id (or null when inapplicable).
 * No-op when the flag is off or there is no calculation id (exempt / $0 / pre-tax payment).
 */
async function recordTransaction({ calculationId, reference }) {
  if (!taxEnabled() || !calculationId) return null;
  const stripe = getStripe();
  const tx = await stripe.tax.transactions.createFromCalculation(
    { calculation: calculationId, reference },
    { idempotencyKey: 'taxtx:' + reference }
  );
  return tx.id;
}

/**
 * Reverse a recorded Tax Transaction in full, on a full refund. Idempotent via a stable key.
 * No-op when the flag is off or there is no original transaction id. Partial reversals are out of
 * V1.0 scope (matches the refund architecture: full refund → full reversal).
 */
async function reverseFullTransaction({ originalTransactionId, reference }) {
  if (!taxEnabled() || !originalTransactionId) return null;
  const stripe = getStripe();
  const rev = await stripe.tax.transactions.createReversal(
    { mode: 'full', original_transaction: originalTransactionId, reference },
    { idempotencyKey: 'taxrev:' + reference }
  );
  return rev.id;
}

module.exports = {
  TaxCalculationError,
  DEFAULT_TAX_CODE,
  taxEnabled,
  addressComplete,
  computeTax,
  recordTransaction,
  reverseFullTransaction,
};
