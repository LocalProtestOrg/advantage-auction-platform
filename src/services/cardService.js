// #20 STEP 4 Card-on-file (Stripe TEST). SetupIntent-based save + verify; no
// charge is ever made here (payment capture stays in paymentService).
const db = require('../db');
const Stripe = require('stripe');
const { writeAuditLog } = require('../lib/auditLog');

const STRIPE_API_VERSION = '2026-03-25.dahlia'; // matches paymentService pin

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

// Create (or reuse) the buyer's Stripe Customer and persist the id.
async function ensureStripeCustomer(userId) {
  const u = (await db.query('SELECT email, stripe_customer_id FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) throw new Error('User not found');
  const stripe = getStripe();
  if (u.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(u.stripe_customer_id);
      if (existing && !existing.deleted) return u.stripe_customer_id;
    } catch (e) { /* stale id — recreate below */ }
  }
  const customer = await stripe.customers.create({ email: u.email || undefined, metadata: { user_id: userId } });
  await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customer.id, userId]);
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
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });
  const ins = await db.query(
    `INSERT INTO card_verifications (user_id, stripe_payment_method_id, status, attempted_at, amount_cents, currency)
     VALUES ($1, $2, 'verified', now(), 0, 'usd') RETURNING id`,
    [userId, pm.id]
  );
  writeAuditLog({
    event_type:  'card.on_file_saved',
    entity_type: 'card_verification',
    entity_id:   ins.rows[0].id,
    actor_id:    userId,
    metadata:    { brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4, payment_method_id: pm.id },
  }).catch(() => {});
  return { saved: true, brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4, payment_method_id: pm.id };
}

// Launch definition of card-on-file: customer exists AND a verified PM marker
// exists. Local check (no Stripe call) so the bid path stays fast.
async function hasCardOnFile(userId) {
  if (!userId) return false;
  const { rows } = await db.query(
    `SELECT (u.stripe_customer_id IS NOT NULL)
            AND EXISTS (SELECT 1 FROM card_verifications cv WHERE cv.user_id = u.id AND cv.status = 'verified') AS ok
       FROM users u WHERE u.id = $1`,
    [userId]
  );
  return rows[0] ? rows[0].ok === true : false;
}

module.exports = { ensureStripeCustomer, createSetupIntent, recordCardOnFile, hasCardOnFile };
