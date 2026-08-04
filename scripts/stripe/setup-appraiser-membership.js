#!/usr/bin/env node
'use strict';

/**
 * Guarded, idempotent Stripe TEST setup for the Appraiser Membership ($19.99/yr).
 *
 * Safe to commit (contains NO credentials — reads STRIPE_SECRET_KEY from env/.env).
 * Safe to re-run: it searches by stable metadata before creating anything, so reruns never
 * create duplicate products or prices. It NEVER archives, replaces, or modifies unrelated
 * Stripe resources.
 *
 * Guarantees:
 *   - Aborts immediately unless the key is sk_test_ (TEST/Sandbox only).
 *   - Product name "Appraiser Membership", metadata product_type=appraiser_membership.
 *   - Price $19.99 USD (unit_amount 1999), recurring interval=year.
 *   - Prints the resulting TEST Product ID + Price ID (never the secret).
 *   - Wire the app with:  STRIPE_APPRAISER_PRICE_ID=<printed price id>
 *
 * Usage:  node scripts/stripe/setup-appraiser-membership.js
 */

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const PRODUCT_META = {
  product_type: 'appraiser_membership',
  membership_type: 'appraiser',
  billing_interval: 'year',
  environment: 'test',
};
const UNIT_AMOUNT = 1999; // $19.99
const CURRENCY = 'usd';
const INTERVAL = 'year';

function fail(msg) { console.error('ABORT: ' + msg); process.exit(1); }

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) fail('STRIPE_SECRET_KEY is not set.');
  if (!key.startsWith('sk_test_')) {
    fail('STRIPE_SECRET_KEY is not a TEST key (must start with sk_test_). Refusing to touch a non-TEST account.');
  }
  const stripe = require('stripe')(key);

  // ── Product: find by stable metadata, else create ─────────────────────────────
  const products = await stripe.products.list({ limit: 100, active: true });
  let product = products.data.find((p) => p.metadata && p.metadata.product_type === 'appraiser_membership') || null;

  if (product) {
    console.log('Reusing existing TEST product: ' + product.id + ' (' + JSON.stringify(product.name) + ')');
  } else {
    product = await stripe.products.create({
      name: 'Appraiser Membership',
      description: 'Annual Advantage.Bid Appraiser professional membership and directory profile.',
      metadata: PRODUCT_META,
    });
    console.log('Created TEST product: ' + product.id);
  }

  // ── Price: find an active $19.99/yr USD price on this product, else create ─────
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find((pr) =>
    pr.active &&
    pr.currency === CURRENCY &&
    pr.unit_amount === UNIT_AMOUNT &&
    pr.recurring && pr.recurring.interval === INTERVAL && pr.recurring.interval_count === 1
  ) || null;

  if (price) {
    console.log('Reusing existing TEST price: ' + price.id);
  } else {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: UNIT_AMOUNT,
      currency: CURRENCY,
      recurring: { interval: INTERVAL, interval_count: 1 },
      metadata: PRODUCT_META,
    });
    console.log('Created TEST price: ' + price.id);
  }

  // ── Verify the resulting price object matches the approved shape ───────────────
  const ok =
    price.active === true &&
    price.currency === CURRENCY &&
    price.unit_amount === UNIT_AMOUNT &&
    price.recurring && price.recurring.interval === INTERVAL &&
    price.product === product.id;

  console.log('\n================ RESULT (TEST/Sandbox) ================');
  console.log('  STRIPE_APPRAISER_PRODUCT_ID = ' + product.id);
  console.log('  STRIPE_APPRAISER_PRICE_ID   = ' + price.id);
  console.log('  amount        = $' + (price.unit_amount / 100).toFixed(2) + ' ' + price.currency.toUpperCase());
  console.log('  interval      = ' + (price.recurring ? price.recurring.interval : '(none)'));
  console.log('  active        = ' + price.active);
  console.log('  attached_to   = ' + price.product + (price.product === product.id ? ' (Appraiser Membership) ✓' : ' ✗'));
  console.log('  verification  = ' + (ok ? 'PASS ✓' : 'FAIL ✗'));
  console.log('=======================================================');
  console.log('\nNext: set STRIPE_APPRAISER_PRICE_ID=' + price.id + ' in the environment (do NOT hardcode / commit).');

  if (!ok) process.exit(2);
}

main().catch((e) => { console.error('Stripe setup error:', e.message); process.exit(1); });
