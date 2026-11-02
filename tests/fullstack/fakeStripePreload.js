'use strict';

// Test-only preload for the isolated full-stack environment (node --require): the payment processor's library is
// replaced by an in-memory stand-in, so checkout can be exercised end to end over HTTP without any network access or
// keys. Cards always succeed unless the payment method id contains "decline" (a card error) or "prepaid" (refused by the
// app before any charge). Refunds are recorded. Nothing leaves the machine.
const Module = require('module');

const intents = new Map(); const refunds = []; let n = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
function cardError() { const e = new Error('Your card was declined.'); e.type = 'StripeCardError'; e.code = 'card_declined'; return e; }
const fake = () => ({
  paymentIntents: {
    async create(p) {
      const id = 'pi_fake_' + (++n);
      intents.set(id, { id, object: 'payment_intent', client_secret: id + '_secret', status: 'requires_payment_method', amount: p.amount,
        currency: p.currency, metadata: p.metadata || {}, amount_received: 0 });
      return clone(intents.get(id));
    },
    async retrieve(id) { const pi = intents.get(id); if (!pi) throw new Error('No such payment_intent: ' + id); return clone(pi); },
    async confirm(id, params = {}) {
      const pi = intents.get(id);
      if (String(params.payment_method || '').includes('decline')) { pi.status = 'requires_payment_method'; throw cardError(); }
      Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, latest_charge: 'ch_fake_' + id });
      return clone(pi);
    },
    async cancel(id) { const pi = intents.get(id); if (pi.status !== 'succeeded') pi.status = 'canceled'; return clone(pi); },
  },
  paymentMethods: {
    async retrieve(id) {
      return { id, type: 'card', customer: null, card: { brand: 'visa', last4: '4242', funding: String(id).includes('prepaid') ? 'prepaid' : 'credit' } };
    },
  },
  refunds: { async create(p, o) { refunds.push({ ...p, key: o && o.idempotencyKey }); return { id: 're_fake_' + refunds.length }; } },
  tax: { calculations: { async create() { throw new Error('tax not configured in the isolated environment'); } } },
});
fake._intents = intents; fake._refunds = refunds;

const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'stripe') return fake;
  return realLoad.apply(this, arguments);
};
