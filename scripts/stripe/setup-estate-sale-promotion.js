#!/usr/bin/env node
'use strict';

/**
 * Guarded, idempotent Stripe TEST setup for the Estate Sale Promotion ($39 one-time).
 * Safe to commit (no credentials). Safe to re-run (searches by stable metadata first).
 * Aborts unless the key is sk_test_. Never prints the secret.
 *
 *   node scripts/stripe/setup-estate-sale-promotion.js   →   prints STRIPE_ESTATE_SALE_PRICE_ID
 */
try { require('dotenv').config(); } catch (_) {}
const META = { product_type: 'estate_sale_promotion', billing: 'one_time', environment: 'test' };
const UNIT_AMOUNT = 3900; // $39.00
function fail(m) { console.error('ABORT: ' + m); process.exit(1); }

(async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) fail('STRIPE_SECRET_KEY not set.');
  if (!key.startsWith('sk_test_')) fail('Not a TEST key (sk_test_ required). Refusing to touch a non-TEST account.');
  const stripe = require('stripe')(key);

  const products = await stripe.products.list({ limit: 100, active: true });
  let product = products.data.find((p) => p.metadata && p.metadata.product_type === 'estate_sale_promotion') || null;
  if (product) console.log('Reusing product: ' + product.id);
  else { product = await stripe.products.create({ name: 'Estate Sale Promotion', description: 'One-time promotion for a single estate sale on Advantage.Bid.', metadata: META }); console.log('Created product: ' + product.id); }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find((pr) => pr.active && pr.currency === 'usd' && pr.unit_amount === UNIT_AMOUNT && !pr.recurring) || null;
  if (price) console.log('Reusing price: ' + price.id);
  else { price = await stripe.prices.create({ product: product.id, unit_amount: UNIT_AMOUNT, currency: 'usd', metadata: META }); console.log('Created price: ' + price.id); }

  const ok = price.active === true && price.currency === 'usd' && price.unit_amount === UNIT_AMOUNT && !price.recurring && price.product === product.id;
  console.log('\n================ RESULT (TEST/Sandbox) ================');
  console.log('  STRIPE_ESTATE_SALE_PRODUCT_ID = ' + product.id);
  console.log('  STRIPE_ESTATE_SALE_PRICE_ID   = ' + price.id);
  console.log('  amount   = $' + (price.unit_amount / 100).toFixed(2) + ' ' + price.currency.toUpperCase() + ' (one-time)');
  console.log('  recurring= ' + (price.recurring ? 'YES (bad)' : 'no ✓'));
  console.log('  verify   = ' + (ok ? 'PASS ✓' : 'FAIL ✗'));
  console.log('======================================================');
  console.log('\nSet STRIPE_ESTATE_SALE_PRICE_ID=' + price.id + ' in the environment (do NOT hardcode / commit).');
  if (!ok) process.exit(2);
})().catch((e) => { console.error('Stripe setup error:', e.message); process.exit(1); });
