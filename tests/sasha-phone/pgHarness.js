'use strict';

/**
 * Real-Postgres test harness for Phone Sasha (PGlite: Postgres compiled to WASM, in memory, no server).
 * Creates the Sasha tables exactly as migration 180 defines them, applies migration 188 unchanged, and adds the minimal
 * platform tables the phone tools read. `dbAdapter` mimics src/db (query/connect) for jest.mock.
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..', '..');

const BASE = `
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, full_name text, role text DEFAULT 'buyer', phone text,
  is_active boolean DEFAULT true, is_demo boolean DEFAULT false, staff_role text, contact_email text, created_at timestamptz DEFAULT now());
CREATE TABLE platform_config (key text PRIMARY KEY, value jsonb, category text, description text, updated_at timestamptz DEFAULT now());
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, seller_type text, display_name text, storefront_published boolean,
  platform_fee_bps int, metadata jsonb DEFAULT '{}'::jsonb, organization_id uuid, created_at timestamptz DEFAULT now(), is_demo boolean DEFAULT false,
  agreement_waived_at timestamptz, verification_required_before_publication boolean DEFAULT false, default_pickup_state text, storefront_slug text);
CREATE TABLE auctions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid, title text, city text, address_state text, street_address text, zip text,
  state text, start_time timestamptz, end_time timestamptz, pickup_window_start timestamptz, pickup_window_end timestamptz, timezone text DEFAULT 'America/New_York',
  is_archived boolean DEFAULT false, is_demo boolean DEFAULT false, marketplace_status text DEFAULT 'syndicated', shipping_available boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), submitted_at timestamptz, published_at timestamptz, buyer_premium_bps int);
CREATE TABLE lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid, lot_number int, lot_number_display text, title text, state text,
  current_bid_cents int, starting_bid_cents int, bid_count int DEFAULT 0, closes_at timestamptz, shippable boolean DEFAULT false, bid_increment_cents int,
  is_withdrawn boolean DEFAULT false, winning_buyer_user_id uuid, current_winner_user_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE buyer_auction_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text, buyer_user_id uuid, auction_id uuid, status text,
  hammer_cents int, buyer_premium_cents int, sales_tax_cents int, shipping_cents int, total_cents int, paid_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE bids (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid, bidder_user_id uuid, amount_cents int, created_at timestamptz DEFAULT now());
CREATE TABLE card_verifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text, livemode boolean, attempted_at timestamptz);
CREATE TABLE verification_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, status text, message text, reviewed_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE verification_request_categories (request_id uuid, category text);
CREATE TABLE seller_identity (seller_profile_id uuid, legal_name text, dba_name text, ein text, address_line1 text, address_line2 text, city text, state text, postal_code text, country text);
CREATE TABLE agreement_templates (id uuid PRIMARY KEY, name text, agreement_type text);
CREATE TABLE agreement_template_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), template_id uuid, version_int int);
CREATE TABLE agreements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, seller_user_id uuid, template_version_id uuid, status text,
  signed_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE marketing_contacts (normalized_email text, is_internal boolean);
CREATE TABLE founding_partners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, status text, intro_platform_fee_bps int,
  fee_applied_at timestamptz, fee_restored_at timestamptz);
CREATE TABLE seller_activation_touches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, mode text, decision text, stage text,
  conversation_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE professional_pricing_agreements (seller_profile_id uuid, status text, platform_fee_bps int, processing_fee_bps int, effective_date date, version int);
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text, entity_type text, entity_id uuid, actor_id uuid, metadata jsonb, created_at timestamptz DEFAULT now());
`;

function sashaTables() {
  const sql = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '180_sasha_customer_service.sql'), 'utf8');
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS cs_conversations');
  const end = sql.indexOf('-- ── Inbound mail');
  return sql.slice(start, end) + `\nALTER TABLE cs_messages ADD COLUMN IF NOT EXISTS content_fingerprint text;\n`;
}

/** A PGlite instance in a worker thread, with the same exec/query surface as PGlite. */
function startPg() {
  const worker = new Worker(path.join(__dirname, 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}

async function createDb() {
  const pg = startPg();
  await pg.exec(BASE);
  await pg.exec(sashaTables());
  await pg.exec(fs.readFileSync(path.join(ROOT, 'db', 'migrations', '188_sasha_phone_foundation.sql'), 'utf8'));
  await pg.exec(`INSERT INTO platform_config (key, value, category) VALUES ('sasha.enabled','true','sasha'),('sasha.engine_enabled','true','sasha'),('sasha.daily_budget_usd','25','sasha')`);
  return pg;
}

/** src/db stand-in. Transactions are no-ops (PGlite is a single connection; tests run statements serially). */
function dbAdapter(getPg) {
  const run = async (sql, params) => {
    const r = await getPg().query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null && !/^\s*select/i.test(sql) ? r.affectedRows : r.rows.length };
  };
  const query = (sql, params) => (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql) ? Promise.resolve({ rows: [], rowCount: 0 }) : run(sql, params));
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}

module.exports = { createDb, dbAdapter };
