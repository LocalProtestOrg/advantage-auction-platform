// #20 STEP 4 Card-on-file. SetupIntent-based save (the bank checks the card); no
// charge is ever made here (payment capture stays in paymentService).
const db = require('../db');
const Stripe = require('stripe');
const { writeAuditLog } = require('../lib/auditLog');
const { isLiveMode } = require('../lib/stripeMode');

const STRIPE_API_VERSION = '2026-03-25.dahlia'; // matches paymentService pin

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

// Debit and credit cards only (Owner decision 3). Only an explicit 'prepaid' funding type is refused.
const PREPAID_MESSAGE = "Prepaid cards aren't accepted. Please use a debit or credit card.";
function isPrepaid(pm) {
  return !!(pm && pm.card && String(pm.card.funding || '').toLowerCase() === 'prepaid');
}

// Create (or reuse) the buyer's Stripe Customer and persist the id + the mode it belongs to.
// A stored customer from the OTHER mode (e.g. a TEST customer after the switch to LIVE keys) is never
// used: a fresh customer is created and the old id is kept in superseded_stripe_customer_id for history.
async function ensureStripeCustomer(userId) {
  const u = (await db.query('SELECT email, stripe_customer_id, stripe_customer_livemode FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) throw new Error('User not found');
  const live = isLiveMode();
  const stripe = getStripe();
  const sameMode = (u.stripe_customer_livemode === true) === live;
  if (u.stripe_customer_id && sameMode) {
    try {
      const existing = await stripe.customers.retrieve(u.stripe_customer_id);
      if (existing && !existing.deleted) {
        if (u.stripe_customer_livemode == null) {
          await db.query('UPDATE users SET stripe_customer_livemode = $1 WHERE id = $2 AND stripe_customer_livemode IS NULL', [live, userId]);
        }
        return u.stripe_customer_id;
      }
    } catch (e) { /* stale id — recreate below */ }
  }
  const customer = await stripe.customers.create({ email: u.email || undefined, metadata: { user_id: userId } });
  await db.query(
    `UPDATE users
        SET superseded_stripe_customer_id = CASE WHEN stripe_customer_id IS NOT NULL AND stripe_customer_id <> $1
                                                 THEN stripe_customer_id ELSE superseded_stripe_customer_id END,
            stripe_customer_id = $1,
            stripe_customer_livemode = $2
      WHERE id = $3`,
    [customer.id, live, userId]);
  return customer.id;
}

// Create a SetupIntent so the client can save a card (off-session, for later
// settlement). Returns the client secret + publishable key for Stripe Elements.
async function createSetupIntent(userId) {
  const customerId = await ensureStripeCustomer(userId);
  const stripe = getStripe();
  const si = await stripe.setupIntents.create({
    customer: customerId,
    usage: 'off_session',
    payment_method_types: ['card'],
  });
  return { client_secret: si.client_secret, customer_id: customerId, publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || '' };
}

// After the client confirms the SetupIntent (PM attached), make it the customer's
// default and write a 'verified' card_verifications row (the local card-on-file
// marker). No charge. Throws NO_PM if no card is attached.
async function recordCardOnFile(userId) {
  const customerId = await ensureStripeCustomer(userId);
  const stripe = getStripe();
  const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  if (!pms.data.length) { const e = new Error('No payment method found. Please add a card.'); e.code = 'NO_PM'; throw e; }
  const pm = pms.data[0]; // most recent
  // Card policy (Owner decision 3, 2026-09-27): debit and credit cards only. The card network reports the
  // funding type; only an explicit 'prepaid' is refused. 'unknown' is allowed so a legitimate card is never
  // rejected on an uncertain classification. A refused card is detached, so it is never kept or charged.
  if (isPrepaid(pm)) {
    await stripe.paymentMethods.detach(pm.id).catch(() => {});
    writeAuditLog({
      event_type: 'card.prepaid_rejected', entity_type: 'user', entity_id: userId, actor_id: userId,
      metadata: { brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4, funding: 'prepaid' },
    }).catch(() => {});
    const e = new Error(PREPAID_MESSAGE); e.code = 'PREPAID_NOT_ACCEPTED'; throw e;
  }
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });
  const ins = await db.query(
    `INSERT INTO card_verifications (user_id, stripe_payment_method_id, status, attempted_at, amount_cents, currency, livemode)
     VALUES ($1, $2, 'verified', now(), 0, 'usd', $3) RETURNING id`,
    [userId, pm.id, isLiveMode()]
  );
  writeAuditLog({
    event_type:  'card.on_file_saved',
    entity_type: 'card_verification',
    entity_id:   ins.rows[0].id,
    actor_id:    userId,
    metadata:    { brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4, funding: (pm.card && pm.card.funding) || 'unknown', payment_method_id: pm.id },
  }).catch(() => {});
  return { saved: true, brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4, payment_method_id: pm.id };
}

// Launch definition of card-on-file: a customer from the CURRENT mode exists AND a verified card marker
// from the CURRENT mode exists. Local check (no Stripe call) so the bid path stays fast. After the switch to
// LIVE keys, TEST-mode customers/cards no longer count, so every buyer is asked to add a card again.
async function hasCardOnFile(userId) {
  if (!userId) return false;
  const { rows } = await db.query(
    `SELECT (u.stripe_customer_id IS NOT NULL AND COALESCE(u.stripe_customer_livemode, false) = $2)
            AND EXISTS (SELECT 1 FROM card_verifications cv
                         WHERE cv.user_id = u.id AND cv.status = 'verified' AND cv.livemode = $2) AS ok
       FROM users u WHERE u.id = $1`,
    [userId, isLiveMode()]
  );
  return rows[0] ? rows[0].ok === true : false;
}

// Buyer billing summary: SAFE, non-sensitive card metadata only (brand, last4,
// exp_month, exp_year) read live from Stripe — never a PAN/CVC, never stored.
// Returns { has_card:false } when no current-mode customer/PM, so the billing page can render
// a clean "no card on file" state.
async function getCardSummary(userId) {
  if (!userId) return { has_card: false };
  const u = (await db.query('SELECT stripe_customer_id, stripe_customer_livemode FROM users WHERE id = $1', [userId])).rows[0];
  if (!u || !u.stripe_customer_id) return { has_card: false };
  if ((u.stripe_customer_livemode === true) !== isLiveMode()) return { has_card: false };
  try {
    const stripe = getStripe();
    const cust = await stripe.customers.retrieve(u.stripe_customer_id);
    const defaultPm = cust && cust.invoice_settings && cust.invoice_settings.default_payment_method;
    const pms = await stripe.paymentMethods.list({ customer: u.stripe_customer_id, type: 'card' });
    if (!pms.data.length) return { has_card: false };
    const pm = pms.data.find(p => p.id === defaultPm) || pms.data[0];
    const c = pm.card || {};
    return { has_card: true, brand: c.brand || null, last4: c.last4 || null, exp_month: c.exp_month || null, exp_year: c.exp_year || null };
  } catch (e) {
    console.error('[cardService] getCardSummary failed:', e.message);
    return { has_card: false, error: 'unavailable' };
  }
}

module.exports = { ensureStripeCustomer, createSetupIntent, recordCardOnFile, hasCardOnFile, getCardSummary, isPrepaid, PREPAID_MESSAGE };
