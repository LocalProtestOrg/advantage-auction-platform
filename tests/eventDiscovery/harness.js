'use strict';

/**
 * Real-Postgres harness for event discovery (PGlite in a worker thread). Applies the REAL migrations that
 * define the event, import, organization and authorization tables (076 … 168) and 208, on a minimal base of
 * the unrelated tables they reference. `adapter()` mimics src/db (query/connect) for jest.mock.
 *
 * fakeWeb(routes) is a tiny in-memory website: a fetch implementation for netGuard.safeFetch plus a lookup
 * that resolves every host to a public address (or a private one, for SSRF tests). It records every request
 * with its headers, so tests can prove robots.txt came first and the identity was always the honest one.
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..', '..');

const BASE = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, role text DEFAULT 'buyer', full_name text, created_at timestamptz DEFAULT now());
CREATE TABLE platform_config (key text PRIMARY KEY, value jsonb, category text, description text, updated_at timestamptz DEFAULT now());
CREATE TABLE organization_config (organization_id uuid, key text, value jsonb);
CREATE TABLE auctions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid, title text, organization_id uuid);
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, seller_type text, capabilities jsonb, organization_id uuid);
CREATE TABLE lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid);
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE analytics_events (id bigserial PRIMARY KEY, event_name text, event_type text, ip_hash text, auction_id uuid, seller_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE marketing_agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_key text UNIQUE NOT NULL, code text, display_name text NOT NULL, tier text,
  capabilities jsonb DEFAULT '[]', can_publish boolean, can_spend boolean, can_review boolean, is_active boolean DEFAULT true, created_at timestamptz DEFAULT now());
`;

const MIGRATIONS = ['013_create_audit_log.sql', '076_organizations_and_events.sql', '077_tenant_foundation.sql', '079_activation_foundation.sql',
  '080_directory_mirror_fields.sql', '081_crm_foundation.sql', '091_marketplace_company_seller_link.sql', '092_directory_sync_status.sql',
  '097_import_sources.sql', '098_import_runs.sql', '099_event_sources.sql', '100_event_import_fields.sql', '101_market_resolution.sql',
  '102_event_internal_coordinates.sql', '104_organization_profile_fields.sql', '114_event_image_provenance.sql',
  '153_event_partner_authorization_foundation.sql', '167_event_import_resilience.sql', '168_member_neutral_import.sql', '208_event_discovery.sql'];

function startPg() {
  const worker = new Worker(path.join(ROOT, 'tests', 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}

async function setupSchema(pg) {
  await pg.exec(BASE);
  for (const f of MIGRATIONS) await pg.exec(fs.readFileSync(path.join(ROOT, 'db', 'migrations', f), 'utf8'));
}

/** A src/db-shaped adapter over the global PGlite (set global.__PG first). */
function adapter() {
  const query = async (sql, params) => {
    const r = await global.__PG.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null && !/^\s*(select|with)/i.test(sql) ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}

/**
 * An in-memory website. routes: { 'https://host/path': { status, headers, body } | (url) => response }.
 * Unlisted URLs answer 404. opts.privateHosts resolve to 10.0.0.5.
 */
function fakeWeb(routes, opts = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: Object.assign({}, (init && init.headers) || {}) });
    let r = routes[url];
    if (typeof r === 'function') r = r(url);
    if (!r) r = { status: 404, body: 'not found', headers: { 'content-type': 'text/html' } };
    const body = r.body == null ? '' : String(r.body);
    return { status: r.status || 200, headers: Object.assign({ 'content-type': 'text/html' }, r.headers || {}), body: null, text: async () => body };
  };
  const lookup = async (host) => [{ address: (opts.privateHosts || []).includes(host) ? '10.0.0.5' : '93.184.216.34', family: 4 }];
  return { fetchImpl, lookup, requests, deps: { fetchImpl, lookup, limits: { minIntervalMs: 0 }, sleep: async () => {} } };
}

module.exports = { BASE, MIGRATIONS, startPg, setupSchema, adapter, fakeWeb, ROOT };
