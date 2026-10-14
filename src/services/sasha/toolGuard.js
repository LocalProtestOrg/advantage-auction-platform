'use strict';

/**
 * Sasha tool permission guard (owner directive 2026-10-14): Sasha is a receptionist, never an administrator.
 *
 * Every Sasha tool runs inside guard.run(toolName, fn). While it runs, this module enforces server-side, independently
 * of anything the model is told:
 *   1. Database writes: each tool may write ONLY the customer-service tables listed for it in TOOL_WRITES (its own logs,
 *      verification, callbacks / messages, one-time payment links). Any other INSERT / UPDATE / DELETE, and any DDL
 *      (CREATE / ALTER / DROP / TRUNCATE / GRANT / REVOKE / COPY), is refused before it reaches the database. So no tool,
 *      directly or through a service it calls, can change terms, policies, agreements, fees, auction rules, lots, bids,
 *      invoices, payment amounts, orders, refunds, payouts, accounts or permissions.
 *   2. Payment processor: any request to Stripe's API from inside a tool is refused (Sasha never charges, refunds,
 *      changes prices or reads/edits Stripe configuration).
 * Reads are unrestricted here; each tool already scopes reads to the verified customer.
 *
 * Approved customer-service communications (verification codes, permitted texts, payment-link delivery, seller pickup
 * requests, callbacks) and their logs keep working: their tables are on the allowlist below.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Customer-service tables each tool may write. Everything else is read-only to Sasha.
const AUDIT = ['cs_phone_audit'];
const CONVERSATION = ['cs_conversations', 'cs_messages', 'cs_handoffs'];   // Shared Inbox: messages, notes, callback requests
// Consent protection: if the carrier reports a number has opted out while a text is being sent, the opt-out is recorded.
const SMS_LOG = ['sms_suppressions'];
const TOOL_WRITES = {
  // knowledge + account reads: audit rows only (phone disclosure audit)
  search_help_center: [], get_platform_rules: [], get_auction_or_lot: [],
  get_my_account: AUDIT, get_my_bids: AUDIT, get_my_invoices: AUDIT, get_my_pickup_details: AUDIT, get_my_orders: AUDIT,
  get_my_auctions: AUDIT, get_my_settlements: AUDIT, get_my_seller_terms: AUDIT, get_my_storefront_orders: AUDIT,
  get_my_seller_onboarding: AUDIT, get_my_business_verification: AUDIT, get_my_agreements: AUDIT,
  get_my_auction_registration: AUDIT, get_my_pickup_slots: AUDIT, get_my_order_detail: AUDIT, find_auction: [],
  // approved receptionist actions
  start_account_verification: [...AUDIT, 'cs_phone_verifications', 'cs_calls', ...SMS_LOG],
  request_callback: [...AUDIT, ...CONVERSATION],
  request_human: CONVERSATION,
  send_text: [...AUDIT, ...SMS_LOG],
  send_payment_link: [...AUDIT, 'payment_links', ...SMS_LOG],   // a one-time link to an EXISTING invoice; never the invoice itself
  contact_seller_about_pickup: [...AUDIT, ...CONVERSATION],
};

// Write statements anywhere in the SQL (including inside a CTE). "FOR UPDATE" locks and "ON CONFLICT DO UPDATE" are not
// separate targets (the INSERT target is checked).
const DML = /(?<![\w])(INSERT\s+INTO|(?<!(?:FOR|DO|KEY)\s+)UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*(?:\."?[a-z_][a-z0-9_]*)?)"?/gi;
const DDL = /(?:^|;|\()\s*(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|COMMENT\s+ON|VACUUM|REINDEX|CLUSTER|SET\s+ROLE|SET\s+SESSION\s+AUTHORIZATION)\b/i;
const STRIPE_HOST = /(^|\.)stripe\.com$/i;

class SashaToolPermissionError extends Error {
  constructor(message) { super(message); this.name = 'SashaToolPermissionError'; this.code = 'SASHA_TOOL_FORBIDDEN'; }
}

function current() { return als.getStore() || null; }

/** Tables a SQL statement writes (lower case, schema stripped), and whether it is DDL. */
function writesOf(sql) {
  const text = String(sql || '').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  const tables = [];
  let m; DML.lastIndex = 0;
  while ((m = DML.exec(text))) {
    const t = m[2].toLowerCase().split('.').pop();
    if (t !== 'set') tables.push(t);
  }
  return { tables, ddl: DDL.test(text) };
}

function deny(store, why) {
  const e = new SashaToolPermissionError(`Sasha tool "${store.tool}" is not permitted to ${why}`);
  console.error('[sasha-guard] refused:', e.message);
  if (store.onDenied) try { store.onDenied(e); } catch (_e) { /* never mask the refusal */ }
  throw e;
}

/** Throws if the statement is not allowed in the current tool context. No-op outside a Sasha tool. */
function checkSql(sql) {
  const store = current(); if (!store) return;
  const { tables, ddl } = writesOf(sql);
  if (ddl) deny(store, 'change the database structure or permissions');
  const allowed = new Set(TOOL_WRITES[store.tool] || []);
  for (const t of tables) {
    if (record) record({ tool: store.tool, table: t, allowed: allowed.has(t) });
    if (!allowed.has(t)) deny(store, `write to "${t}"`);
  }
}

function checkHost(host) {
  const store = current(); if (!store) return;
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (STRIPE_HOST.test(h)) deny(store, 'contact the payment processor');
}

// Optional recorder (tests / audits only): SASHA_TOOL_GUARD_RECORD=<file> appends one JSON line per write seen.
let record = null;
if (process.env.SASHA_TOOL_GUARD_RECORD) {
  const fs = require('fs'); const file = process.env.SASHA_TOOL_GUARD_RECORD;
  record = (x) => { try { fs.appendFileSync(file, JSON.stringify(x) + '\n'); } catch (_e) { /* audit aid only */ } };
}

/**
 * Wrap a query function so every statement passes checkSql. ALL arguments are passed through unchanged: pg's own Pool
 * calls client.query(text, values, callback) on pooled clients, so dropping the callback hangs that query forever and
 * leaks the client (production incident 2026-10-14: follow-up phone turns never completed). A refusal is delivered the
 * way the caller asked for results: through the callback when one is given, otherwise as a rejected promise.
 */
function guardQuery(fn) {
  return function guardedQuery(...args) {
    const first = args[0];
    try { checkSql(first && typeof first === 'object' && first.text ? first.text : first); } catch (e) {
      const cb = args.find((a) => typeof a === 'function') || (first && typeof first === 'object' && typeof first.callback === 'function' ? first.callback : null);
      if (cb) { process.nextTick(() => cb(e)); return undefined; }
      return Promise.reject(e);
    }
    return fn.apply(this, args);
  };
}

/** Wrap a db module object ({ query, connect }) once so every statement passes checkSql. Idempotent. */
function installDb(db) {
  if (!db || db.__sashaGuarded) return db;
  if (typeof db.query === 'function') db.query = guardQuery(db.query);
  const c = db.connect;
  if (typeof c === 'function') {
    db.connect = async function guardedConnect(...a) {
      const client = await c.apply(this, a);
      if (client && !client.__sashaGuarded && typeof client.query === 'function') {
        client.query = guardQuery(client.query);
        client.__sashaGuarded = true;
      }
      return client;
    };
  }
  Object.defineProperty(db, '__sashaGuarded', { value: true });
  return db;
}

/** Refuse payment-processor requests made from inside a Sasha tool (Node http/https and fetch). Installed once. */
let netInstalled = false;
function installNet() {
  if (netInstalled) return; netInstalled = true;
  for (const mod of ['http', 'https']) {
    const m = require(mod);
    for (const fn of ['request', 'get']) {
      const orig = m[fn];
      m[fn] = function (...args) {
        if (current()) {
          const a = args[0];
          checkHost(typeof a === 'string' ? new URL(a).host : a instanceof URL ? a.host : (a && (a.hostname || a.host)));
        }
        return orig.apply(this, args);
      };
    }
  }
  if (typeof globalThis.fetch === 'function') {
    const of = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      if (current()) { try { checkHost(new URL(typeof input === 'string' ? input : (input && (input.url || input.href))).host); } catch (e) { if (e instanceof SashaToolPermissionError) return Promise.reject(e); } }
      return of.call(this, input, init);
    };
  }
}

/** Run one Sasha tool under the guard. */
function run(tool, fn, { onDenied } = {}) {
  return als.run({ tool: String(tool || ''), onDenied }, fn);
}

module.exports = { run, installDb, installNet, checkSql, checkHost, writesOf, TOOL_WRITES, SashaToolPermissionError, _current: current };
