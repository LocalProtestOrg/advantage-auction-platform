'use strict';

/**
 * Professional Seller bulk import, bulk photos and the inventory workspace (migration 207): adversarial tests.
 *
 * Real Postgres (PGlite) with the real storefront migrations through 207, the real seller routes, seller checkpoint
 * (requireSellerPermission), item service, importer, photo matcher and widget feed. Only the sign-in (a header names the
 * user) and the photo store (an in-memory stand-in for the existing cloud photo storage) are replaced.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-bulk-import'; // test value, never a real secret
process.env.SELLER_STAFF_ENABLED = 'true';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code, constraint: m.constraint })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}
function mockAdapter() {
  const query = async (sql, params) => {
    const r = await global.__PG.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null && !/^\s*select/i.test(sql) ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}
jest.mock('../src/db', () => mockAdapter());
jest.mock('../src/db/index', () => mockAdapter());
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
// The existing photo store, in memory: records every stored original.
global.__STORED = [];
jest.mock('../src/services/cloudinaryService', () => ({
  uploadBuffer: jest.fn(async (buf, opts) => {
    const id = require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16) + '-' + global.__STORED.length;
    global.__STORED.push({ id, bytes: buf.length, folder: opts && opts.folder });
    return { secure_url: `https://res.cloudinary.com/test/image/upload/v1/${opts.folder}/${id}.jpg`, public_id: `${opts.folder}/${id}`, width: 800, height: 600 };
  }),
  destroy: jest.fn(async () => ({ result: 'ok' })),
}));
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: u.id, role: u.role };
  return next();
});

const ROOT = path.join(__dirname, '..');
const mig = (f) => fs.readFileSync(path.join(ROOT, 'db', 'migrations', f), 'utf8');
const BASE = `
CREATE TABLE staff_permission_overrides (user_id uuid, permission text, effect text);
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, full_name text, role text DEFAULT 'buyer', staff_role text, staff_active boolean DEFAULT true,
  stripe_customer_id text, is_active boolean DEFAULT true, created_at timestamptz DEFAULT now());
CREATE TABLE seller_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES users(id), seller_type text, display_name text,
  platform_fee_bps int, metadata jsonb DEFAULT '{}'::jsonb, is_demo boolean DEFAULT false, show_branding_to_buyers boolean DEFAULT true, created_at timestamptz DEFAULT now());
CREATE TABLE auctions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid REFERENCES seller_profiles(id), title text, city text, address_state text,
  street_address text, zip text, state text, end_time timestamptz, is_demo boolean DEFAULT false, buyer_premium_bps int);
CREATE TABLE seller_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, buyer_premium_pct numeric, superseded_at timestamptz);
CREATE TABLE lots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid REFERENCES auctions(id), lot_number int, lot_number_display text, title text,
  description text, category text, condition text, thumbnail_url text, state text, is_withdrawn boolean DEFAULT false, winning_buyer_user_id uuid,
  reserve_cents int, reserve_not_met boolean DEFAULT false, starting_bid_cents int, current_bid_cents int, bid_count int DEFAULT 0, shippable boolean DEFAULT false,
  shipping_cost_cents int, shipping_notes text, pickup_group text);
CREATE TABLE lot_images (lot_id uuid, image_url text, sort_order int DEFAULT 0, created_at timestamptz DEFAULT now());
CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid, auction_id uuid, buyer_user_id uuid, status text, payment_intent_id text, created_at timestamptz DEFAULT now());
CREATE TABLE seller_payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auction_id uuid, settlement_status text, on_hold_reason text, updated_at timestamptz);
CREATE TABLE payment_disputes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stripe_dispute_id text NOT NULL, stripe_charge_id text, payment_intent_id text,
  payment_id uuid, auction_id uuid, buyer_user_id uuid, seller_payout_id uuid, amount_cents int, currency text, reason text, status text NOT NULL,
  livemode boolean NOT NULL DEFAULT false, evidence_due_by timestamptz, payout_hold_applied boolean NOT NULL DEFAULT false, payout_hold_note text,
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, last_event_id text, last_event_type text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX uq_payment_disputes_stripe_dispute ON payment_disputes (stripe_dispute_id);
CREATE TABLE seller_payout_preferences (seller_user_id uuid UNIQUE, stripe_account_id text, connect_transfers_active boolean DEFAULT false, connect_payouts_enabled boolean DEFAULT false);
`;
const MIGRATIONS = ['071_verification_documents.sql', '119_seller_storefronts_marketplace.sql', '121_marketplace_orders.sql', '174_marketplace_checkout_hardening.sql',
  '177_marketplace_item_pickup_location.sql', '178_seller_default_pickup_location.sql', '197_storefront_order_integrity.sql',
  '198_storefront_moderation_reports.sql', '199_seller_staff_accounts.sql', '200_storefront_product_data.sql', '201_storefront_shipping_controls.sql',
  '203_seller_store_policies.sql', '204_inventory_numbers_and_sale_notifications.sql', '205_storefront_item_messaging.sql',
  '206_sold_price_privacy_and_message_moderation.sql', '207_storefront_bulk_import.sql', '209_marketplace_inventory_importer.sql'];

let server, base, items;
const U = {}; const SP = {};
const q = async (sql, p) => (await global.__PG.query(sql, p || [])).rows;
const one = async (sql, p) => (await q(sql, p))[0];

async function call(user, method, url, body) {
  const headers = { 'x-test-user': user };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const raw = await r.text(); let json = null; try { json = JSON.parse(raw); } catch (_) { /* csv */ }
  return { status: r.status, body: json, raw, headers: r.headers };
}
const form = (field, files) => { const fd = new FormData(); for (const [name, buf] of files) fd.append(field, new Blob([buf]), name); return fd; };
const csv = (rows) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(',')).join('\n'));
// columns: the seller's destination for every column (migration 209: Inventory Number … Photo_15, Skip / Ignore).
const preview = (user, buf, name = 'inventory.csv', columns) => {
  const fd = form('file', [[name, buf]]); if (columns) fd.append('columns', JSON.stringify(columns));
  return call(user, 'POST', '/api/seller-storefront/imports/preview', fd);
};
async function importAll(user, batchId) {
  let r;
  for (let i = 0; i < 50; i++) { r = await call(user, 'POST', `/api/seller-storefront/imports/${batchId}/import`); if (r.status !== 200 || r.body.data.done) break; }
  return r;
}

// ── Minimal ZIP / XLSX writers for fixtures (including deliberately malicious archives) ─────────────────────────────
function makeZip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    const method = e.method === undefined ? 8 : e.method;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = e.crc !== undefined ? e.crc : zlib.crc32(data);
    const size = e.size !== undefined ? e.size : data.length;
    const flags = (e.flags || 0) | 0x800;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size >>> 0, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size >>> 0, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function makeXlsx(rows, { sheetXmlPrefix = '' } = {}) {
  const strings = []; const idx = new Map();
  const si = (s) => { if (!idx.has(s)) { idx.set(s, strings.length); strings.push(s); } return idx.get(s); };
  const col = (i) => String.fromCharCode(65 + i);
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((c, ci) => {
    if (c === null || c === undefined || c === '') return '';
    if (typeof c === 'number') return `<c r="${col(ci)}${ri + 1}"><v>${c}</v></c>`;
    if (typeof c === 'object' && c.formula) return `<c r="${col(ci)}${ri + 1}"><f>${xmlEsc(c.formula)}</f><v>${c.value}</v></c>`;
    return `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(String(c))}</v></c>`;
  }).join('') + '</row>').join('');
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join('')}</sst>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0"?>${sheetXmlPrefix}<worksheet><sheetData>${sheetRows}</sheetData></worksheet>` },
  ]);
}
const JPEG = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-test-photo-' + tag), Buffer.alloc(64, 7)]);
const PNG = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-' + tag), Buffer.alloc(64, 3)]);

const HEADER = ['SKU', 'Title', 'Description', 'Category', 'Price', 'Quantity', 'Ships', 'UPC'];

beforeAll(async () => {
  global.__PG = startPg();
  await global.__PG.exec(BASE);
  for (const f of MIGRATIONS) await global.__PG.exec(mig(f));
  const mk = async (name, role = 'seller') => { U[name] = await one(`INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3) RETURNING *`, [name + '@test.example', name, role]); };
  for (const n of ['ann', 'bob', 'ivy', 'inv', 'ful']) await mk(n, ['inv', 'ful'].includes(n) ? 'buyer' : 'seller');
  await mk('buyer', 'buyer');
  global.__USERS = U;
  const prof = async (who, type, extra = {}) => (await one(`INSERT INTO seller_profiles (user_id, seller_type, display_name, default_pickup_address_line1, default_pickup_city,
      default_pickup_state, default_pickup_postal_code, default_pickup_country, default_pickup_confirmed_at, storefront_published, storefront_slug)
      VALUES ($1, $2, $3, '1 Main St', 'Houston', 'TX', '77001', 'US', now(), $4, $5) RETURNING id`, [U[who].id, type, who + ' Co', extra.published !== false, who])).id;
  SP.ann = await prof('ann', 'estate_sale_company');
  SP.bob = await prof('bob', 'auction_house');
  SP.ivy = await prof('ivy', 'private');            // an Individual Seller
  for (const [who, role] of [['inv', 'inventory_manager'], ['ful', 'fulfillment']]) {
    // Invited by the owner, then accepted (the order the database requires).
    const m = await one(`INSERT INTO seller_staff_members (seller_id, invited_email, role, invited_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [SP.ann, who + '@test.example', role, U.ann.id]);
    await q(`UPDATE seller_staff_members SET status = 'active', user_id = $2, accepted_at = now() WHERE id = $1`, [m.id, U[who].id]);
  }
  items = require('../src/services/marketplaceItemService');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/seller-storefront', require('../src/routes/sellerStorefront'));
  app.use((e, req, res, _n) => res.status(500).json({ error: e.message }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
}, 60000);
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); if (global.__PG) await global.__PG.close(); });

// ═══ Spreadsheet and archive parsing ═════════════════════════════════════════════════════════════════════════════
describe('spreadsheet parsing (pure)', () => {
  const sheet = require('../src/lib/spreadsheet');
  test('CSV: byte-order mark, quoted commas and line breaks, doubled quotes, CRLF, semicolons', () => {
    const r = sheet.parse(Buffer.from('﻿SKU,Title\r\n"A1","Chair, oak ""Mission""\nstyle"\r\n\r\n'), 'x.csv');
    expect(r).toEqual({ kind: 'csv', rows: [['SKU', 'Title'], ['A1', 'Chair, oak "Mission"\nstyle']] });
    expect(sheet.parse(Buffer.from('SKU;Title;Price\nB2;Lamp;12,50'), 'eu.csv').rows[1]).toEqual(['B2', 'Lamp', '12,50']);
  });
  test('XLSX: shared and inline strings, numbers, a formula imported as its saved value', () => {
    const buf = makeXlsx([['SKU', 'Title', 'Price'], ['X1', 'Desk', 19.99], ['X2', 'Rug', { formula: 'B1*2', value: 40 }]]);
    expect(sheet.parse(buf, 'items.xlsx').rows).toEqual([['SKU', 'Title', 'Price'], ['X1', 'Desk', '19.99'], ['X2', 'Rug', '40']]);
  });
  test('refuses a DTD / entity declaration (no XML entity is ever expanded)', () => {
    const evil = makeXlsx([['a']], { sheetXmlPrefix: '<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>' });
    expect(() => sheet.parse(evil, 'evil.xlsx')).toThrow(expect.objectContaining({ code: 'SHEET_INVALID' }));
  });
  test('refuses old .xls, binary data posing as CSV, and over-limit sheets', () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(40)]);
    expect(() => sheet.parse(ole, 'old.xls')).toThrow(expect.objectContaining({ code: 'SHEET_OLD_EXCEL' }));
    expect(() => sheet.parse(Buffer.from('MZ\u0000\u0000binary'), 'tool.csv')).toThrow(expect.objectContaining({ code: 'SHEET_INVALID' }));
    expect(() => sheet.parse(Buffer.from('a\n' + 'x\n'.repeat(2101)), 'big.csv')).toThrow(expect.objectContaining({ code: 'SHEET_TOO_MANY_ROWS' }));
    expect(() => sheet.parse(Buffer.from(Array(61).fill('c').join(',') + '\n1'), 'wide.csv')).toThrow(expect.objectContaining({ code: 'SHEET_TOO_MANY_COLUMNS' }));
    expect(() => sheet.parse(Buffer.from('a\n"' + 'x'.repeat(10001) + '"'), 'long.csv')).toThrow(expect.objectContaining({ code: 'SHEET_CELL_TOO_LONG' }));
    expect(() => sheet.parse(Buffer.from('a\n"unclosed'), 'q.csv')).toThrow(expect.objectContaining({ code: 'SHEET_INVALID' }));
    expect(() => sheet.parse(Buffer.alloc(6 * 1024 * 1024, 65), 'huge.csv')).toThrow(expect.objectContaining({ code: 'SHEET_TOO_LARGE' }));
  });
  test('CSV output never produces a live formula', () => {
    expect(sheet.toCsv([['=HYPERLINK("http://x")', '+1', '-2', '@SUM(A1)', 'ok']])).toBe('﻿"\'=HYPERLINK(""http://x"")",\'+1,\'-2,\'@SUM(A1),ok\r\n');
  });
});

describe('ZIP safety (pure)', () => {
  const zip = require('../src/lib/zipReader');
  test('a decompression bomb is refused before it is expanded', () => {
    const bomb = makeZip([{ name: 'A1.jpg', data: Buffer.alloc(30 * 1024 * 1024, 0) }]);   // ~30 MB of zeros → ~30 KB
    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(() => zip.listEntries(bomb, { maxRatio: 200 })).toThrow(expect.objectContaining({ code: 'ZIP_UNSUPPORTED' }));
  });
  test('a lying size header cannot make it expand past the declared size', () => {
    const lie = makeZip([{ name: 'A1.jpg', data: Buffer.alloc(200000, 1), size: 1000, crc: 0 }]);
    const [e] = zip.listEntries(lie, { maxRatio: 100000 });
    expect(() => zip.readEntry(lie, e)).toThrow(expect.objectContaining({ code: 'ZIP_INVALID' }));
  });
  test('encrypted entries, unknown compression, ZIP64 and damaged CRCs are refused', () => {
    expect(() => zip.listEntries(makeZip([{ name: 'a.jpg', data: 'x', flags: 1 }]))).toThrow(expect.objectContaining({ code: 'ZIP_UNSUPPORTED' }));
    expect(() => zip.listEntries(makeZip([{ name: 'a.jpg', data: 'x', method: 12 }]))).toThrow(expect.objectContaining({ code: 'ZIP_UNSUPPORTED' }));
    expect(() => zip.listEntries(makeZip([{ name: 'a.jpg', data: 'x', size: 0xffffffff }]))).toThrow(expect.objectContaining({ code: 'ZIP_UNSUPPORTED' }));
    const bad = makeZip([{ name: 'a.jpg', data: 'hello', crc: 1234 }]);
    expect(() => zip.readEntry(bad, zip.listEntries(bad)[0])).toThrow(expect.objectContaining({ code: 'ZIP_INVALID' }));
    expect(() => zip.listEntries(Buffer.from('not a zip at all, definitely not'))).toThrow(expect.objectContaining({ code: 'ZIP_INVALID' }));
  });
});

describe('price and quantity rules (pure)', () => {
  const imp = require('../src/services/storefrontImportService');
  test.each([['125', 12500], ['$1,250.00', 125000], ['19.99', 1999], ['19.990000000000002', 1999], ['USD 7', 700], [' 3.5 ', 350]])('accepts %s', (v, c) => {
    expect(imp.parsePrice(v)).toEqual({ cents: c });
  });
  test.each(['0', '0.00', '-5', '(5)', 'abc', '12-15', '1e5', '12,50', '1.234,50', '5.555', '1000001', 'NaN', 'Infinity'])('refuses %j with a suggestion', (v) => {
    const r = imp.parsePrice(v); expect(r.cents).toBeUndefined(); expect(r.error).toBeTruthy(); expect(r.suggestion).toBeTruthy();
  });
  test('a blank Sale Price is not an error: the item becomes a draft to price later (migration 209)', () => {
    expect(imp.parsePrice('')).toEqual({}); expect(imp.parsePrice('   ')).toEqual({});
  });
  test('quantity: blank is 1; whole numbers 0 to 100,000 are kept; fractions, words and negatives are explained', () => {
    expect(imp.parseQuantity('')).toEqual({ value: 1 }); expect(imp.parseQuantity('1')).toEqual({ value: 1 }); expect(imp.parseQuantity('1.0')).toEqual({ value: 1 });
    expect(imp.parseQuantity('6')).toEqual({ value: 6 }); expect(imp.parseQuantity('0')).toEqual({ value: 0 });
    for (const v of ['1.5', 'one', '-1', '100001']) expect(imp.parseQuantity(v).error).toBeTruthy();
  });
});

// ═══ Import ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('preview and import', () => {
  let existing;
  beforeAll(async () => {
    existing = await items.createDirectListing(U.ann.id, { title: 'Original title', price_cents: 9900, inventory_number: 'KEEP-1', status: 'active' });
  });

  test('every row is checked; problems explained with a fix; nothing is created by a preview', async () => {
    const before = (await one('SELECT count(*)::int n FROM marketplace_items')).n;
    const r = await preview('ann', csv([HEADER,
      ['A1001', 'Oak chair', 'Solid oak', 'Furniture', '$45.00', '1', '', ''],
      ['A1002', 'Brass lamp', '', 'Lighting', '30', '', 'no', ''],
      ['A1003', '', '', '', '20', '', '', ''],                       // missing title
      ['A1004', 'Free thing', '', '', '0', '', '', ''],              // zero price
      ['A1005', 'Bad price', '', '', '12,50', '', '', ''],           // comma cents
      ['A1006', 'Many plates', '', '', '10', '6', '', ''],           // quantity 6 (kept)
      ['A1001', 'Same SKU again', '', '', '10', '', '', ''],         // duplicate in file
      ['KEEP-1', 'Overwrite attempt', '', '', '1', '', '', ''],      // already in inventory → skip
      ['EXAMPLE-1001', 'Victorian walnut side table', '', '', '450', '', '', ''],
      ['A1007', 'Mixer', '', '', '275', '', 'yes', ''],              // "Ships" is not an import field: Skip / Ignore
      ['A1008', 'Barcode item', '', '', '15', '', '', '012345678905'],  // "UPC" is not an import field either
      ['A1009', 'Bad barcode', '', '', '15', '', '', '012345678900'],
      ['', 'No sku item', '', '', '5', '', '', ''],
      ['=CMD()', 'Formula SKU', '', '', '5', '', '', ''],             // stored as plain text, never evaluated
      ['A1010', 'Unpriced vase', '', '', '', '', '', ''],             // no Sale Price: a draft to price later
    ]));
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.columns).toEqual(['inventory_number', 'title', 'description', 'category', 'price', 'quantity', 'skip', 'skip']);
    const byRow = Object.fromEntries(d.rows.map((x) => [x.row, x]));
    expect(byRow[2].action).toBe('create'); expect(byRow[2].values).toEqual(expect.objectContaining({ price_cents: 4500, title: 'Oak chair', inventory_number: 'A1001', category: 'Furniture' }));
    expect(byRow[3].action).toBe('create'); expect(byRow[3].values.category).toBe('Lighting');
    for (const [row, field] of [[4, 'title'], [5, 'price'], [6, 'price'], [8, 'inventory_number'], [10, 'inventory_number']]) {
      expect([row, byRow[row].action, byRow[row].errors.map((e) => e.field)]).toEqual([row, 'error', expect.arrayContaining([field])]);
      expect(byRow[row].errors.every((e) => e.message && e.suggestion)).toBe(true);
    }
    expect(byRow[7]).toEqual(expect.objectContaining({ action: 'create' })); expect(byRow[7].values.quantity).toBe(6);
    expect(byRow[9].action).toBe('skip');
    for (const row of [11, 12, 13, 15]) expect(byRow[row].action).toBe('create');
    expect(byRow[14].action).toBe('create'); expect(byRow[14].warnings[0].field).toBe('inventory_number');
    expect(byRow[15].values.inventory_number).toBe('=CMD()');
    expect(byRow[16].action).toBe('create'); expect(byRow[16].warnings.map((w) => w.code)).toContain('MISSING_PRICE');
    expect(d.summary).toEqual(expect.objectContaining({ total: 15, ready: 9, create: 9, update: 0, skip: 1, errors: 5, missing_price: 1, new_items: 9, existing_items: 1 }));
    expect((await one('SELECT count(*)::int n FROM marketplace_items')).n).toBe(before);

    // Problem list download: one line per problem with the fix, formulas neutralised.
    const p = await call('ann', 'GET', `/api/seller-storefront/imports/${d.batch_id}/problems.csv`);
    expect(p.status).toBe(200);
    expect(p.headers.get('content-type')).toMatch(/text\/csv/);
    expect(p.raw).toMatch(/Item Title is missing/);
    expect(p.raw).toMatch(/No Sale Price/);
    expect(p.raw).not.toMatch(/(^|,)=CMD/m);

    // Import: only the 9 ready rows, as drafts; the existing item is untouched.
    const imp = await importAll('ann', d.batch_id);
    expect(imp.body.data).toEqual(expect.objectContaining({ done: true, created: 9, failed: 0, skipped: 1, status: 'completed_with_errors' }));
    const created = await q('SELECT * FROM marketplace_items WHERE import_batch_id = $1 ORDER BY import_row', [d.batch_id]);
    expect(created.map((x) => x.status)).toEqual(Array(9).fill('draft'));
    // Sale Price only from the spreadsheet; a blank price stays unpriced. Quantity, category and its origin are recorded.
    const vase = created.find((x) => x.inventory_number === 'A1010');
    expect(vase.price_cents).toBeNull();
    expect(created.find((x) => x.inventory_number === 'A1006').quantity).toBe(6);
    expect(created.find((x) => x.inventory_number === 'A1001')).toEqual(expect.objectContaining({ category_key: 'furniture', category: 'Furniture', category_source: 'spreadsheet', category_status: 'assigned' }));
    expect(created.find((x) => x.inventory_number === 'A1008').gtin).toBeNull();   // a skipped column is never stored
    expect(created.every((x) => x.seller_id === SP.ann && x.images.length === 0 && x.thumbnail_url === null)).toBe(true);   // no invented photos
    expect(await one('SELECT title, price_cents, status FROM marketplace_items WHERE id = $1', [existing.id])).toEqual({ title: 'Original title', price_cents: 9900, status: 'active' });
    // Drafts are not public anywhere (storefront page, widget, item page).
    const pub = await items.listPublicForSeller(SP.ann);
    expect(pub.map((x) => x.title)).toEqual(['Original title']);
    expect(await items.getPublicItem(created[0].id)).toBeNull();
  });

  // (The test database gives every caller ONE shared connection, so truly simultaneous requests would interleave inside a
  // single session; an overlapping second worker is therefore simulated deterministically: it has already created some rows.)
  test('repeating the import, or an overlapping second worker, never duplicates an item', async () => {
    const r = await preview('ann', csv([HEADER, ...Array.from({ length: 30 }, (_, i) => ['R-' + i, 'Retry item ' + i, '', '', String(10 + i), '', '', ''])]), 'retry.csv');
    const id = r.body.data.batch_id;
    for (const row of [2, 3, 17]) {   // another worker already created these rows (same batch row, same SKU)
      await items.createDirectListing(U.ann.id, { title: 'Retry item ' + (row - 2), price_cents: (10 + row - 2) * 100, inventory_number: 'R-' + (row - 2), status: 'draft' },
        { importBatchId: id, importRow: row });
    }
    await importAll('ann', id); await importAll('ann', id); await importAll('ann', id);
    expect((await one('SELECT count(*)::int n FROM marketplace_items WHERE import_batch_id = $1', [id])).n).toBe(30);
    expect((await one(`SELECT count(*)::int n FROM marketplace_items WHERE inventory_number LIKE 'R-%'`)).n).toBe(30);
    // Uploading the same file again: every row is now "already in inventory" and nothing is created.
    const again = await preview('ann', csv([HEADER, ...Array.from({ length: 30 }, (_, i) => ['R-' + i, 'Retry item ' + i, '', '', String(10 + i), '', '', ''])]), 'retry.csv');
    expect(again.body.data.summary).toEqual(expect.objectContaining({ ready: 0, skip: 30 }));
    expect(again.body.data.previously_imported).toEqual(expect.objectContaining({ batch_id: id, created_count: 30 }));
    expect((await one('SELECT failed_count, created_count FROM storefront_import_batches WHERE id = $1', [id]))).toEqual({ failed_count: 0, created_count: 30 });
  });

  test('large files import in chunks with progress (250 rows)', async () => {
    const r = await preview('ann', csv([HEADER, ...Array.from({ length: 250 }, (_, i) => ['BIG-' + i, 'Bulk item ' + i, 'desc', 'Misc', '12.50', '1', '', ''])]), 'big.csv');
    const id = r.body.data.batch_id;
    const steps = [];
    for (;;) { const s = await call('ann', 'POST', `/api/seller-storefront/imports/${id}/import`); steps.push([s.body.data.created, s.body.data.remaining]); if (s.body.data.done) break; }
    expect(steps).toEqual([[100, 150], [200, 50], [250, 0]]);
  }, 60000);

  test('a row that fails at import time does not stop the rest, and "retry failed rows" finishes it', async () => {
    const r = await preview('ann', csv([HEADER, ['P-1', 'First', '', '', '10', '', '', ''], ['P-2', 'Second', '', '', '10', '', '', ''], ['P-3', 'Third', '', '', '10', '', '', '']]), 'partial.csv');
    const blocker = await items.createDirectListing(U.ann.id, { title: 'Hand-entered after the preview', price_cents: 500, inventory_number: 'P-2', status: 'draft' });
    const imp = await importAll('ann', r.body.data.batch_id);
    expect(imp.body.data).toEqual(expect.objectContaining({ done: true, created: 2, failed: 1 }));
    expect(imp.body.data.failures[0]).toEqual(expect.objectContaining({ row: 3, code: 'INVENTORY_NUMBER_TAKEN' }));
    expect(await one('SELECT title FROM marketplace_items WHERE id = $1', [blocker.id])).toEqual({ title: 'Hand-entered after the preview' });   // not overwritten
    await q(`UPDATE marketplace_items SET inventory_number = 'P-2-OLD' WHERE id = $1`, [blocker.id]);
    const retry = await call('ann', 'POST', `/api/seller-storefront/imports/${r.body.data.batch_id}/retry`);
    expect(retry.body.data).toEqual(expect.objectContaining({ done: true, created: 3, failed: 0, status: 'completed' }));
  });

  test('Excel workbook imports the same way', async () => {
    const r = await preview('ann', makeXlsx([['Item #', 'Item Name', 'Asking Price', 'Qty'], ['XL-1', 'Mantel clock', 85, 1], ['XL-2', 'Quilt', '120.00', '']]), 'supplier.xlsx');
    expect(r.status).toBe(200);
    expect(r.body.data.file_kind).toBe('xlsx');
    expect(r.body.data.columns).toEqual(['inventory_number', 'title', 'price', 'quantity']);
    expect(r.body.data.summary.ready).toBe(2);
  });

  test('column mapping: the seller can choose columns; bad choices are refused', async () => {
    const buf = csv([['Stock', 'Name', 'Cost', 'Retail'], ['M-1', 'Vase', '5', '25']]);
    const auto = await preview('ann', buf, 'map.csv');
    // "Cost" is never suggested as the Sale Price; with no price column the row is still a draft to price later.
    expect(auto.body.data.columns).toEqual(['inventory_number', 'title', 'skip', 'skip']);   // 'Stock' = stock number
    expect(auto.body.data.missing_required).toEqual([]);
    expect(auto.body.data.summary).toEqual(expect.objectContaining({ ready: 1, missing_price: 1 }));
    const ok = await preview('ann', buf, 'map.csv', ['inventory_number', 'title', 'skip', 'price']);
    expect(ok.body.data.rows[0].values.price_cents).toBe(2500);
    // Skip / Ignore may repeat; every other destination is unique (server-enforced, whatever the page sends).
    expect((await preview('ann', buf, 'map.csv', ['skip', 'title', 'skip', 'skip'])).status).toBe(200);
    expect((await preview('ann', buf, 'map.csv', ['title', 'title', 'skip', 'skip'])).body.code).toBe('MAPPING_DUPLICATE');
    expect((await preview('ann', buf, 'map.csv', ['photo_1', 'title', 'skip', 'photo_1'])).body.code).toBe('MAPPING_DUPLICATE');
    // An auction-price column (cost, reserve, bid, estimate) can never be the Sale Price.
    expect((await preview('ann', buf, 'map.csv', ['skip', 'title', 'price', 'skip'])).body.code).toBe('MAPPING_AUCTION_PRICE');
    for (const bad of [['skip', 'title'], ['skip', 'title', 'owner_id', 'skip'], { title: 1 }, ['x', 'y', 'z', 'w']]) {
      expect((await preview('ann', buf, 'map.csv', bad)).body.code).toBe('MAPPING_INVALID');
    }
  });

  test('file type and size restrictions', async () => {
    expect((await preview('ann', Buffer.alloc(6 * 1024 * 1024, 65), 'big.csv')).status).toBe(413);
    expect((await preview('ann', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(100)]), 'old.xls')).body.code).toBe('SHEET_OLD_EXCEL');
    expect((await preview('ann', Buffer.from('MZ\u0000\u0000'), 'virus.csv')).body.code).toBe('SHEET_INVALID');
    expect((await preview('ann', makeZip([{ name: 'a.txt', data: 'x' }]), 'fake.xlsx')).body.code).toBe('SHEET_INVALID');
    expect((await preview('ann', Buffer.from('SKU,Title,Price\n'), 'empty.csv')).body.code).toBe('SHEET_EMPTY');
    const two = new FormData(); two.append('file', new Blob([csv([HEADER])]), 'a.csv'); two.append('file', new Blob([csv([HEADER])]), 'b.csv');
    expect((await call('ann', 'POST', '/api/seller-storefront/imports/preview', two)).status).toBe(413);
  });
});

describe('isolation and authorization for imports', () => {
  let annBatch;
  beforeAll(async () => { annBatch = (await preview('ann', csv([HEADER, ['ISO-1', 'Isolated', '', '', '10', '', '', '']]), 'iso.csv')).body.data.batch_id; });

  test('another seller cannot see, import, retry, cancel or download a batch', async () => {
    for (const [m, u] of [['GET', ''], ['GET', '/problems.csv'], ['POST', '/import'], ['POST', '/retry'], ['POST', '/cancel']]) {
      expect([m, u, (await call('bob', m, `/api/seller-storefront/imports/${annBatch}${u}`)).status]).toEqual([m, u, 404]);
    }
    expect((await call('bob', 'GET', '/api/seller-storefront/imports')).body.data.some((b) => b.id === annBatch)).toBe(false);
    expect((await one('SELECT count(*)::int n FROM marketplace_items WHERE import_batch_id = $1', [annBatch])).n).toBe(0);
  });
  test('the same SKU in another company is not a duplicate (and is never revealed)', async () => {
    const r = await preview('bob', csv([HEADER, ['A1001', 'Bob chair', '', '', '10', '', '', '']]), 'bob.csv');
    expect(r.body.data.rows[0].action).toBe('create');
    expect(JSON.stringify(r.body.data)).not.toMatch(/Oak chair/);
  });
  test('Individual Sellers, buyers and staff without inventory editing are refused; an Inventory Manager may import', async () => {
    const buf = csv([HEADER, ['S-1', 'Staff item', '', '', '10', '', '', '']]);
    expect((await preview('ivy', buf)).status).toBe(403);
    expect((await preview('buyer', buf)).status).toBe(403);
    expect((await preview('ful', buf)).status).toBe(403);
    expect((await call('ful', 'POST', `/api/seller-storefront/imports/${annBatch}/import`)).status).toBe(403);
    expect((await call('nobody', 'GET', '/api/seller-storefront/imports')).status).toBe(401);
    const ok = await preview('inv', buf, 'staff.csv');
    expect(ok.status).toBe(200);
    const done = await importAll('inv', ok.body.data.batch_id);
    expect(done.body.data.created).toBe(1);
    expect(await one(`SELECT seller_id, status FROM marketplace_items WHERE inventory_number = 'S-1'`)).toEqual({ seller_id: SP.ann, status: 'draft' });
  });
  test('a malformed batch id is a 404, and a cancelled preview cannot be imported', async () => {
    expect((await call('ann', 'POST', '/api/seller-storefront/imports/not-a-uuid/import')).status).toBe(404);
    const r = await preview('ann', csv([HEADER, ['C-1', 'Cancelled', '', '', '10', '', '', '']]), 'cancel.csv');
    expect((await call('ann', 'POST', `/api/seller-storefront/imports/${r.body.data.batch_id}/cancel`)).status).toBe(200);
    expect((await call('ann', 'POST', `/api/seller-storefront/imports/${r.body.data.batch_id}/import`)).body.code).toBe('IMPORT_CANCELLED');
  });
});

// ═══ Photos ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('photos', () => {
  beforeAll(async () => {
    for (const [sku, t] of [['PH-1', 'Photo item one'], ['PH-2', 'Photo item two'], ['PH-AB', 'Photo item AB']]) {
      await items.createDirectListing(U.ann.id, { title: t, price_cents: 1000, inventory_number: sku, status: 'draft' });
    }
  });
  const itemBySku = (sku) => one('SELECT * FROM marketplace_items WHERE inventory_number = $1 AND status IN (\'draft\',\'active\',\'paused\')', [sku]);

  test('matches by SKU and naming convention, in order; only real images; unknown SKUs are not uploaded', async () => {
    const stored = global.__STORED.length;
    const r = await call('ann', 'POST', '/api/seller-storefront/photos', form('photos', [
      ['PH-1_3.jpg', JPEG('1c')], ['PH-1.jpg', JPEG('1a')], ['ph-1-2.JPG', JPEG('1b')], ['PH-2 (2).png', PNG('2b')],
      ['NOPE-9.jpg', JPEG('x')], ['PH-2.jpg', Buffer.from('<svg onload=alert(1)></svg>')], ['PH-AB.gif', Buffer.from('GIF89a-not-really-but-header-ok....')],
    ]));
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect([d.attached, d.unmatched, d.rejected]).toEqual([5, 1, 1]);
    expect(d.results.find((x) => x.file === 'NOPE-9.jpg')).toEqual(expect.objectContaining({ outcome: 'unmatched' }));
    expect(d.results.find((x) => x.file === 'PH-2.jpg')).toEqual(expect.objectContaining({ outcome: 'rejected', code: 'NOT_A_PHOTO' }));
    expect(global.__STORED.length - stored).toBe(5);                     // only matched, real photos were stored
    expect(global.__STORED.slice(stored).every((s) => s.folder === 'storefront-items')).toBe(true);
    const one1 = await itemBySku('PH-1');
    expect(one1.images).toHaveLength(3);
    expect(one1.thumbnail_url).toBe(one1.images[0]);
    const prov = await q('SELECT original_filename FROM storefront_item_photos WHERE item_id = $1 ORDER BY created_at, original_filename', [one1.id]);
    expect(prov.map((p) => p.original_filename)).toEqual(['PH-1.jpg', 'ph-1-2.JPG', 'PH-1_3.jpg']);   // primary = SKU.jpg, then numbered
  });

  test('uploading the same photos again changes nothing', async () => {
    const r = await call('ann', 'POST', '/api/seller-storefront/photos', form('photos', [['PH-1.jpg', JPEG('1a')], ['PH-1_2.jpg', JPEG('1b')]]));
    expect(r.body.data).toEqual(expect.objectContaining({ attached: 0, skipped: 2 }));
    expect((await itemBySku('PH-1')).images).toHaveLength(3);
  });

  test('ZIP: SKU folders and names, system files ignored, non-photos and bombs refused', async () => {
    const z = makeZip([
      { name: 'PH-AB/front.jpg', data: JPEG('ab-front') }, { name: 'PH-AB/back.jpg', data: JPEG('ab-back') },
      { name: '__MACOSX/PH-AB/._front.jpg', data: 'junk' }, { name: '.DS_Store', data: 'junk' },
      { name: 'PH-2.exe', data: 'MZ-not-a-photo' }, { name: '../../etc/PH-2_5.jpg', data: JPEG('2e') },   // a path trick is ignored, never followed
    ]);
    const r = await call('ann', 'POST', '/api/seller-storefront/photos/zip', form('zip', [['photos.zip', z]]));
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual(expect.objectContaining({ attached: 2, rejected: 1 }));
    expect(r.body.data.results.map((x) => x.file)).toEqual(expect.not.arrayContaining(['._front.jpg', '.DS_Store', 'PH-2_5.jpg']));
    expect((await itemBySku('PH-AB')).images).toHaveLength(3);
    const bomb = makeZip([{ name: 'PH-2_9.jpg', data: Buffer.alloc(20 * 1024 * 1024, 0) }]);
    const b = await call('ann', 'POST', '/api/seller-storefront/photos/zip', form('zip', [['bomb.zip', bomb]]));
    expect([b.status, b.body.code]).toEqual([422, 'ZIP_UNSUPPORTED']);
    expect((await call('ann', 'POST', '/api/seller-storefront/photos/zip', form('zip', [['x.zip', Buffer.from('not a zip')]]))).body.code).toBe('ZIP_INVALID');
  });

  test('size and count limits', async () => {
    const big = Buffer.concat([JPEG('big'), Buffer.alloc(10 * 1024 * 1024)]);
    expect((await call('ann', 'POST', '/api/seller-storefront/photos', form('photos', [['PH-2_7.jpg', big]]))).status).toBe(413);
    const eleven = Array.from({ length: 11 }, (_, i) => ['PH-2_' + (10 + i) + '.jpg', JPEG('n' + i)]);
    expect((await call('ann', 'POST', '/api/seller-storefront/photos', form('photos', eleven))).status).toBe(413);
    const it = await itemBySku('PH-2');
    await q(`UPDATE marketplace_items SET images = $2::jsonb WHERE id = $1`, [it.id, JSON.stringify(Array.from({ length: 24 }, (_, i) => `https://res.cloudinary.com/test/image/upload/v1/x/${i}.jpg`))]);
    const full = await call('ann', 'POST', '/api/seller-storefront/photos', form('photos', [['PH-2_30.jpg', JPEG('full')]]));
    expect(full.body.data.results[0]).toEqual(expect.objectContaining({ outcome: 'skipped', code: 'ITEM_FULL' }));
    expect((await itemBySku('PH-2')).images).toHaveLength(24);
  });

  test('photo ownership: another seller can never add to, reorder or see this seller\'s item photos', async () => {
    const it = await itemBySku('PH-1');
    const r = await call('bob', 'POST', '/api/seller-storefront/photos', form('photos', [['PH-1_9.jpg', JPEG('bob')]]));
    expect(r.body.data.results[0]).toEqual(expect.objectContaining({ outcome: 'unmatched' }));
    expect(JSON.stringify(r.body.data)).not.toMatch(/Photo item one/);
    expect((await call('bob', 'POST', `/api/seller-storefront/items/${it.id}/photos`, form('photos', [['x.jpg', JPEG('bob2')]]))).status).toBe(404);
    expect((await call('bob', 'PUT', `/api/seller-storefront/items/${it.id}/photos`, { images: [] })).status).toBe(404);
    expect((await itemBySku('PH-1')).images).toHaveLength(3);
  });

  test('reorder, choose the main photo and remove; no outside photo can be attached this way', async () => {
    const it = await itemBySku('PH-1');
    const [a, b, c] = it.images;
    const r = await call('ann', 'PUT', `/api/seller-storefront/items/${it.id}/photos`, { images: [c, a] });
    expect(r.status).toBe(200);
    const after = await itemBySku('PH-1');
    expect(after.images).toEqual([c, a]); expect(after.thumbnail_url).toBe(c);
    expect((await one('SELECT count(*)::int n FROM storefront_item_photos WHERE item_id = $1 AND url = $2', [it.id, b])).n).toBe(0);
    for (const bad of [[c, 'https://evil.example/x.jpg'], [c, c], ['javascript:alert(1)'], 'nope']) {
      expect((await call('ann', 'PUT', `/api/seller-storefront/items/${it.id}/photos`, { images: bad })).body.code).toBe('PHOTOS_INVALID');
    }
    // A removed photo can be added again later.
    const re = await call('ann', 'POST', `/api/seller-storefront/items/${it.id}/photos`, form('photos', [['again.jpg', JPEG('1b')]]));
    expect(re.body.data.attached).toBe(1);
  });

  test('a sold item keeps its photos', async () => {
    const it = await items.createDirectListing(U.ann.id, { title: 'Sold piece', price_cents: 1000, inventory_number: 'SOLD-1', status: 'active' });
    await items.updateItem(it.id, U.ann.id, { status: 'sold' });
    expect((await call('ann', 'POST', `/api/seller-storefront/items/${it.id}/photos`, form('photos', [['s.jpg', JPEG('sold')]]))).body.code).toBe('ITEM_SOLD');
    expect((await call('ann', 'PUT', `/api/seller-storefront/items/${it.id}/photos`, { images: [] })).body.code).toBe('ITEM_SOLD');
  });
});

// ═══ Inventory workspace and bulk actions ═════════════════════════════════════════════════════════════════════════
describe('inventory workspace', () => {
  let drafts;
  beforeAll(async () => {
    drafts = [];
    for (let i = 0; i < 3; i++) drafts.push(await items.createDirectListing(U.ann.id, { title: 'Bulk ' + i, price_cents: 2000 + i, inventory_number: 'BLK-' + i, status: 'draft' }));
  });
  const bulk = (user, action, ids, value) => call(user, 'POST', '/api/seller-storefront/items/bulk', { action, ids, value });
  const feedTitles = async () => (await require('../src/services/storefrontWidgetService').publicFeed(SP.ann)).items.map((x) => x.title);

  test('bulk publish makes items visible on Advantage.Bid and the website widget together; pause hides them from both', async () => {
    const ids = drafts.map((d) => d.id);
    const r = await bulk('ann', 'publish', ids);
    expect(r.body.data).toEqual(expect.objectContaining({ done: 3, refused: 0 }));
    expect(await feedTitles()).toEqual(expect.arrayContaining(['Bulk 0', 'Bulk 1', 'Bulk 2']));
    const list = (await call('ann', 'GET', '/api/seller-storefront/items')).body;
    expect(list.storefront_open).toBe(true);
    const b0 = list.data.find((m) => m.id === ids[0]);
    expect(b0).toEqual(expect.objectContaining({ photo_count: 0, visibility: { advantage_bid: true, widget: true } }));

    const p = await bulk('ann', 'pause', ids.slice(0, 2));
    expect(p.body.data.done).toBe(2);
    expect(await feedTitles()).not.toEqual(expect.arrayContaining(['Bulk 0']));
    expect(await items.getPublicItem(ids[0])).toBeNull();
    const paused = (await call('ann', 'GET', '/api/seller-storefront/items')).body.data.find((m) => m.id === ids[0]);
    expect(paused).toEqual(expect.objectContaining({ status: 'paused', visibility: { advantage_bid: false, widget: false } }));
    // A paused item keeps its SKU reserved.
    await expect(items.createDirectListing(U.ann.id, { title: 'Clash', price_cents: 100, inventory_number: 'BLK-0', status: 'draft' })).rejects.toMatchObject({ code: 'INVENTORY_NUMBER_TAKEN' });
    expect((await bulk('ann', 'publish', [ids[0]])).body.data.done).toBe(1);
    expect(await feedTitles()).toEqual(expect.arrayContaining(['Bulk 0']));
  });

  test('a storefront that is not published: items show on Advantage.Bid but not on the widget', async () => {
    await q('UPDATE seller_profiles SET storefront_published = false WHERE id = $1', [SP.ann]);
    const list = (await call('ann', 'GET', '/api/seller-storefront/items')).body;
    expect(list.storefront_open).toBe(false);
    expect(list.data.find((m) => m.id === drafts[2].id).visibility).toEqual({ advantage_bid: true, widget: false });
    await q('UPDATE seller_profiles SET storefront_published = true WHERE id = $1', [SP.ann]);
  });

  test('another seller cannot publish, pause or remove these items (reported as not found; nothing changes)', async () => {
    const ids = drafts.map((d) => d.id);
    for (const action of ['publish', 'pause', 'remove', 'unpublish']) {
      const r = await bulk('bob', action, ids);
      expect(r.body.data).toEqual(expect.objectContaining({ done: 0, refused: 3 }));
      expect(r.body.data.results.every((x) => x.code === 'NOT_FOUND')).toBe(true);
    }
    expect((await call('bob', 'POST', '/api/seller-storefront/items/bulk', { action: 'set_category', ids, value: 'coins_currency' })).body.data.done).toBe(0);
    expect((await call('bob', 'POST', '/api/seller-storefront/items/bulk', { action: 'set_price', ids, value: 100 })).body.data.done).toBe(0);
    expect((await q('SELECT category_key, category_source FROM marketplace_items WHERE id = ANY($1::uuid[])', [ids])).every((x) => x.category_key !== 'coins_currency' && x.category_source !== 'seller')).toBe(true);
  });

  test('unauthorized publishing: staff without editing, Individual Sellers, taken-down and sold items', async () => {
    expect((await bulk('ful', 'publish', [drafts[0].id])).status).toBe(403);
    expect((await bulk('ivy', 'publish', [drafts[0].id])).body.data.results[0].code).toBe('NOT_PROFESSIONAL');
    const down = await items.createDirectListing(U.ann.id, { title: 'Taken down', price_cents: 100, inventory_number: 'TD-1', status: 'active' });
    await q(`UPDATE marketplace_items SET status = 'removed', moderation_status = 'taken_down' WHERE id = $1`, [down.id]);
    expect((await bulk('ann', 'publish', [down.id])).body.data.results[0].code).toBe('TAKEN_DOWN');
    const sold = await one(`SELECT id FROM marketplace_items WHERE inventory_number = 'SOLD-1'`);
    for (const a of ['publish', 'pause', 'unpublish']) expect((await bulk('ann', a, [sold.id])).body.data.results[0].code).toBe('ITEM_SOLD');
    expect(await one('SELECT status FROM marketplace_items WHERE id = $1', [sold.id])).toEqual({ status: 'sold' });
  });

  test('publishing needs a pickup location; bad requests are refused', async () => {
    const noLoc = await q(`UPDATE seller_profiles SET default_pickup_confirmed_at = NULL WHERE id = $1 RETURNING id`, [SP.ann]);
    void noLoc;
    const d = await items.createDirectListing(U.ann.id, { title: 'Needs location', price_cents: 100, status: 'draft' });
    expect((await bulk('ann', 'publish', [d.id])).body.data.results[0].code).toBe('STOREFRONT_LOCATION_REQUIRED');
    await q(`UPDATE seller_profiles SET default_pickup_confirmed_at = now() WHERE id = $1`, [SP.ann]);
    expect((await bulk('ann', 'explode', [d.id])).body.code).toBe('ACTION_INVALID');
    expect((await bulk('ann', 'publish', [])).body.code).toBe('IDS_INVALID');
    expect((await bulk('ann', 'publish', Array.from({ length: 501 }, () => crypto.randomUUID()))).body.code).toBe('IDS_INVALID');
    expect((await bulk('ann', 'set_category', [d.id], 'x'.repeat(101))).body.code).toBe('CATEGORY_INVALID');
    // Categories come from the one taxonomy; a seller's bulk choice is recorded as theirs.
    expect((await bulk('ann', 'set_category', [d.id], 'Clocks')).body.code).toBe('CATEGORY_INVALID');
    const cat = await bulk('ann', 'set_category', [d.id], 'collectibles');
    expect(cat.body.data.done).toBe(1);
    expect(await one('SELECT category, category_key, category_source FROM marketplace_items WHERE id = $1', [d.id])).toEqual({ category: 'Collectibles', category_key: 'collectibles', category_source: 'seller' });
    // Bulk Sale Price and quantity.
    expect((await bulk('ann', 'set_price', [d.id], 0)).body.code).toBe('PRICE_INVALID');
    expect((await bulk('ann', 'set_price', [d.id], 4250)).body.data.done).toBe(1);
    expect((await bulk('ann', 'set_quantity', [d.id], 3)).body.data.done).toBe(1);
    expect(await one('SELECT price_cents, quantity FROM marketplace_items WHERE id = $1', [d.id])).toEqual({ price_cents: 4250, quantity: 3 });
  });
});

describe('migration 207', () => {
  test('is idempotent and keeps existing items, statuses and inventory numbers', async () => {
    const before = await q('SELECT id, status, inventory_number, images FROM marketplace_items ORDER BY id');
    await global.__PG.exec(mig('207_storefront_bulk_import.sql'));
    expect(await q('SELECT id, status, inventory_number, images FROM marketplace_items ORDER BY id')).toEqual(before);
    await expect(q(`UPDATE marketplace_items SET status = 'bogus' WHERE id = $1`, [before[0].id])).rejects.toThrow();
  });
});

describe('independent security review regressions', () => {
  test('a hostile photo file name cannot stall the server (bounded, linear matching)', async () => {
    const { matchFile } = require('../src/services/storefrontPhotoService');
    const skus = new Map([['ph-1', {}]]);
    const t = Date.now();
    for (const n of ['a' + ' '.repeat(4000) + 'x.jpg', 'a' + ' '.repeat(65000) + '(1).jpg', 'PH-1' + ' '.repeat(60) + '_2.jpg', '('.repeat(5000) + '1).jpg']) matchFile(n, skus);
    expect(Date.now() - t).toBeLessThan(200);
    const z = makeZip([{ name: 'a' + ' '.repeat(20000) + 'x.jpg', data: JPEG('long') }, { name: 'PH-1_8.jpg', data: JPEG('ok8') }]);
    const t2 = Date.now();
    const r = await call('ann', 'POST', '/api/seller-storefront/photos/zip', form('zip', [['names.zip', z]]));
    expect(Date.now() - t2).toBeLessThan(5000);
    expect(r.body.data).toEqual(expect.objectContaining({ attached: 1, unmatched: 1 }));
  });

  test('a tiny workbook with a huge number of empty text entries is read quickly or refused', () => {
    const sheet = require('../src/lib/spreadsheet');
    const evil = makeZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="a" sheetId="1"/></sheets></workbook>' },
      { name: 'xl/sharedStrings.xml', data: '<sst>' + '<si/>'.repeat(200000) + '</sst>', method: 0 },   // stored: reaches the parser
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>' },
    ]);
    const t = Date.now();
    expect(() => sheet.parse(evil, 'evil.xlsx')).toThrow(expect.objectContaining({ code: 'SHEET_INVALID' }));
    expect(Date.now() - t).toBeLessThan(1000);
    const unterminated = makeZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="a" sheetId="1"/></sheets></workbook>' },
      { name: 'xl/sharedStrings.xml', data: '<sst>' + '<si>'.repeat(200000), method: 0 },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>T</t></is></c></row><row r="2"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>' },
    ]);
    const t2 = Date.now();
    sheet.parse(unterminated, 'u.xlsx');
    expect(Date.now() - t2).toBeLessThan(1000);
  });

  test('photos of a sold-then-removed item, or of a taken-down item, cannot be changed', async () => {
    const sold = await one(`SELECT id, images FROM marketplace_items WHERE inventory_number = 'SOLD-1'`);
    await items.updateItem(sold.id, U.ann.id, { status: 'removed' });
    // a paid order makes the sale permanent even after the item is hidden
    const orderless = await items.createDirectListing(U.ann.id, { title: 'Removed after takedown', price_cents: 100, inventory_number: 'TD-2', status: 'draft' });
    await call('ann', 'POST', `/api/seller-storefront/items/${orderless.id}/photos`, form('photos', [['td.jpg', JPEG('td2')]]));
    await q(`UPDATE marketplace_items SET status = 'removed', moderation_status = 'taken_down' WHERE id = $1`, [orderless.id]);
    const before = await one('SELECT images FROM marketplace_items WHERE id = $1', [orderless.id]);
    expect((await call('ann', 'PUT', `/api/seller-storefront/items/${orderless.id}/photos`, { images: [] })).body.code).toBe('TAKEN_DOWN');
    expect((await call('ann', 'POST', `/api/seller-storefront/items/${orderless.id}/photos`, form('photos', [['td3.jpg', JPEG('td3')]]))).status).toBe(409);
    expect(await one('SELECT images FROM marketplace_items WHERE id = $1', [orderless.id])).toEqual(before);
    expect((await one('SELECT count(*)::int n FROM storefront_item_photos WHERE item_id = $1', [orderless.id])).n).toBe(1);
  });

  test('a started import cannot be cancelled or replaced by a new preview of the same file', async () => {
    const buf = csv([HEADER, ['ST-1', 'Started', '', '', '10', '', '', ''], ['', 'No sku started', '', '', '11', '', '', '']]);
    const r = await preview('ann', buf, 'started.csv');
    const id = r.body.data.batch_id;
    await call('ann', 'POST', `/api/seller-storefront/imports/${id}/import`);
    expect((await call('ann', 'POST', `/api/seller-storefront/imports/${id}/cancel`)).body.code).toBe('ALREADY_IMPORTED');
    await preview('ann', buf, 'started.csv');                         // the same file again
    expect(await one('SELECT status FROM storefront_import_batches WHERE id = $1', [id])).toEqual({ status: 'completed' });
    expect((await one('SELECT count(*)::int n FROM marketplace_items WHERE import_batch_id = $1', [id])).n).toBe(2);
    // The batch summary does not send every row back.
    const g = await call('ann', 'GET', `/api/seller-storefront/imports/${id}`);
    expect(g.body.data.rows).toBeUndefined();
    expect(g.body.data.created).toBe(2);
  });

  test('columns outside the ten fields (e.g. over-long pickup details) are skipped, never stored or echoed', async () => {
    const r = await preview('ann', csv([['SKU', 'Title', 'Price', 'Pickup address', 'Pickup city', 'Pickup state', 'Pickup ZIP'],
      ['PU-1', 'Pickup test', '10', 'x'.repeat(5000), 'Houston', 'TX', '77002']]), 'pickup.csv');
    expect(r.body.data.columns.slice(3)).toEqual(['skip', 'skip', 'skip', 'skip']);
    expect(r.body.data.rows[0].action).toBe('create');
    expect(JSON.stringify(r.body.data).length).toBeLessThan(5000);
  });
});

describe('sold items are never offered again (owner decision 2026-10-28)', () => {
  const moderation = () => require('../src/services/marketplaceModerationService');
  const bulk = (user, action, ids) => call(user, 'POST', '/api/seller-storefront/items/bulk', { action, ids });
  let admin;
  beforeAll(async () => { admin = await one(`INSERT INTO users (email, role) VALUES ('mod@test.example', 'admin') RETURNING id`); });
  async function paidOrder(item) {
    const o = await one(`INSERT INTO marketplace_orders (marketplace_item_id, seller_id, buyer_user_id, item_price_cents, total_charge_cents, fulfillment_method,
        item_snapshot, seller_snapshot) VALUES ($1, $2, $3, $4, $4, 'pickup', $5::jsonb, $6::jsonb) RETURNING id`,
      [item.id, item.seller_id, U.buyer.id, item.price_cents, JSON.stringify({ item_id: item.id }), JSON.stringify({ seller_profile_id: item.seller_id })]);
    await q(`UPDATE marketplace_orders SET payment_status = 'paid', paid_at = now() WHERE id = $1`, [o.id]);
    await q(`UPDATE marketplace_items SET status = 'sold' WHERE id = $1`, [item.id]);
    return o.id;
  }

  test('marked sold → removed → publish / pause / draft / relist / bulk are all refused; the database refuses it too', async () => {
    const it = await items.createDirectListing(U.ann.id, { title: 'Marked sold', price_cents: 900, inventory_number: 'MS-1', status: 'active' });
    await items.updateItem(it.id, U.ann.id, { status: 'sold' });
    expect((await one('SELECT sold_at FROM marketplace_items WHERE id = $1', [it.id])).sold_at).not.toBeNull();
    await items.updateItem(it.id, U.ann.id, { status: 'removed' });
    for (const status of ['active', 'paused', 'draft']) {
      expect((await call('ann', 'PATCH', `/api/seller-storefront/items/${it.id}`, { status })).body.code).toBe('ITEM_SOLD');
    }
    for (const a of ['publish', 'pause', 'unpublish']) expect((await bulk('ann', a, [it.id])).body.data.results[0].code).toBe('ITEM_SOLD');
    await expect(require('../src/services/marketplaceOrderService').relistItem(it.id, U.ann.id)).rejects.toMatchObject({ code: 'ITEM_SOLD' });
    await expect(q(`UPDATE marketplace_items SET status = 'active' WHERE id = $1`, [it.id])).rejects.toThrow(/cannot be offered again/);
    expect(await one('SELECT status FROM marketplace_items WHERE id = $1', [it.id])).toEqual({ status: 'removed' });
    expect(await items.getPublicItem(it.id)).toBeNull();
  });

  test('a mistaken sold mark is corrected only by an administrator, with a reason, in the permanent history', async () => {
    const it = await items.createDirectListing(U.ann.id, { title: 'Sold by mistake', price_cents: 900, inventory_number: 'MS-2', status: 'active' });
    await items.updateItem(it.id, U.ann.id, { status: 'sold' });
    await expect(moderation().correctSold(it.id, admin.id, { reason: '' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(moderation().correctSold(it.id, null, { reason: 'Seller clicked sold by mistake' })).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    const fixed = await moderation().correctSold(it.id, admin.id, { reason: 'Seller clicked sold by mistake' });
    expect(fixed).toEqual(expect.objectContaining({ status: 'draft', sold_at: null }));
    expect(await one(`SELECT action, actor_user_id, reason, prior_status FROM marketplace_item_moderation_events WHERE item_id = $1`, [it.id]))
      .toEqual({ action: 'sold_corrected', actor_user_id: admin.id, reason: 'Seller clicked sold by mistake', prior_status: 'sold' });
    // The seller now decides to publish it again, deliberately.
    expect((await bulk('ann', 'publish', [it.id])).body.data.done).toBe(1);
    await expect(moderation().correctSold(it.id, admin.id, { reason: 'Not sold any more' })).rejects.toMatchObject({ code: 'NOT_SOLD' });
  });

  test('an item sold through Advantage.Bid (paid order) can never be republished or "corrected"; its records stay intact', async () => {
    const it = await items.createDirectListing(U.ann.id, { title: 'Really sold', price_cents: 4200, inventory_number: 'PO-1', status: 'active' });
    const orderId = await paidOrder(it);
    await items.updateItem(it.id, U.ann.id, { status: 'removed' });
    expect((await bulk('ann', 'publish', [it.id])).body.data.results[0].code).toBe('ITEM_SOLD');
    await expect(moderation().correctSold(it.id, admin.id, { reason: 'Trying to undo a real sale' })).rejects.toMatchObject({ code: 'HAS_ORDER' });
    await expect(q(`UPDATE marketplace_items SET sold_at = NULL, status = 'draft' WHERE id = $1`, [it.id])).rejects.toThrow(/paid order/);
    expect(await one('SELECT payment_status, total_charge_cents FROM marketplace_orders WHERE id = $1', [orderId])).toEqual({ payment_status: 'paid', total_charge_cents: 4200 });
  });

  test('a takedown and restore never brings a sold item back on sale', async () => {
    const it = await items.createDirectListing(U.ann.id, { title: 'Sold then reported', price_cents: 900, inventory_number: 'MS-3', status: 'active' });
    await items.updateItem(it.id, U.ann.id, { status: 'sold' });
    await moderation().takedown(it.id, admin.id, { reason: 'Reported listing check' });
    const back = await moderation().restore(it.id, admin.id, { reason: 'Report was unfounded' });
    expect(back.status).toBe('sold');
  });

  test('a full refund undoes the sale, so the item may be relisted (database rule)', async () => {
    const it = await items.createDirectListing(U.ann.id, { title: 'Refunded sale', price_cents: 1500, inventory_number: 'RF-1', status: 'active' });
    const orderId = await paidOrder(it);
    await expect(q(`UPDATE marketplace_items SET sold_at = NULL, status = 'removed' WHERE id = $1`, [it.id])).rejects.toThrow(/paid order/);
    await q(`UPDATE marketplace_orders SET payment_status = 'refunded', refund_status = 'refunded', refunded_amount_cents = 1500, refunded_at = now() WHERE id = $1`, [orderId]);
    await q(`UPDATE marketplace_items SET sold_at = NULL, status = 'removed' WHERE id = $1`, [it.id]);   // what the refund path does
    const relisted = await require('../src/services/marketplaceOrderService').relistItem(it.id, U.ann.id);
    expect(relisted.status).toBe('active');
  });
});

// ═══ Simple marketplace importer (migration 209, owner requirements 2026-10-30) ══════════════════════════════════
describe('simple marketplace importer: the real AuctionFlex export (142 items, 17 columns)', () => {
  const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'auctionflex-unsold-inventory.csv'));
  const photosSvc = () => require('../src/services/storefrontImportPhotoService');
  let batch, firstPreview;

  test('the columns map themselves; auction prices are never a Sale Price; nothing needs renaming', async () => {
    const r = await preview('bob', FIXTURE, 'Unsold items by inv.csv');
    expect(r.status).toBe(200);
    firstPreview = r.body.data; batch = firstPreview.batch_id;
    expect(firstPreview.headers).toHaveLength(17);
    expect(firstPreview.source_label).toBe('AuctionFlex export');
    const map = Object.fromEntries(firstPreview.headers.map((h, i) => [h, firstPreview.columns[i]]));
    expect(map).toEqual(expect.objectContaining({ itemnum: 'inventory_number', lead: 'title', shortdesc: 'description', quantity: 'quantity',
      lotnum: 'skip', bidamount: 'skip', bidreserve: 'skip', bidcardnum: 'skip', soldstatus: 'skip' }));
    expect(firstPreview.columns.filter((c) => c === 'price')).toHaveLength(0);
    expect(firstPreview.lot_column).toBe(0);                                         // lotnum: the original auction lot number
    expect(firstPreview.summary).toEqual(expect.objectContaining({ total: 142, create: 142, errors: 0, missing_price: 142 }));
    // Ten primary fields, Photo_1..Photo_15, and Skip / Ignore (the only repeatable choice).
    const dest = firstPreview.destinations;
    expect(dest.filter((d) => !d.photo && !d.repeatable).map((d) => d.label)).toEqual(['Inventory Number', 'Item Title', 'Description', 'Sale Price', 'Quantity',
      'Category', 'Condition', 'Dimensions', 'Material', 'Color']);
    expect(dest.filter((d) => d.photo).map((d) => d.label)).toEqual(Array.from({ length: 15 }, (_, i) => `Photo_${i + 1}`));
    expect(dest.filter((d) => d.repeatable).map((d) => d.label)).toEqual(['Skip / Ignore']);
    expect(dest.map((d) => d.label).join(' ')).not.toMatch(/reserve|estimate|starting bid|bid/i);
  });

  test('photos match by the original auction lot number, numbered photos keep their order, unmatched files are reported and not stored', async () => {
    const r = await preview('bob', FIXTURE, 'Unsold items by inv.csv', firstPreview.columns.map(String));
    // Match photos by the lot number column (an internal reference; lotnum stays Skip / Ignore as a field).
    const pm = await call('bob', 'PUT', `/api/seller-storefront/imports/${r.body.data.batch_id}/options`, { photo_match: { reference: 'lot_number' } });
    expect(pm.status).toBe(409);                                                       // a different column needs the original cells
    const fd = new FormData(); fd.append('file', new Blob([FIXTURE]), 'Unsold items by inv.csv');
    fd.append('columns', JSON.stringify(firstPreview.columns)); fd.append('photo_match', JSON.stringify({ reference: 'lot_number' }));
    const r2 = await call('bob', 'POST', '/api/seller-storefront/imports/preview', fd);
    expect(r2.body.data.photo_match).toEqual({ reference: 'lot_number', column: 0 });
    batch = r2.body.data.batch_id;
    const up = await call('bob', 'POST', `/api/seller-storefront/imports/${batch}/photos`, form('photos', [['6.jpg', JPEG('lot6-a')], ['6_2.jpg', JPEG('lot6-b')], ['10 (2).png', PNG('lot10')],
      ['999999.jpg', JPEG('nobody')], ['notes.txt', Buffer.from('not a photo at all, just some text for the test')], ['6.jpg', JPEG('lot6-a')]]));
    expect(up.status).toBe(200);
    const by = Object.fromEntries(up.body.data.results.map((x, i) => [i, x]));
    expect([by[0].outcome, by[1].outcome, by[2].outcome]).toEqual(['matched', 'matched', 'matched']);
    expect(by[3]).toEqual(expect.objectContaining({ outcome: 'unmatched', code: 'NO_MATCHING_ROW' }));
    expect(by[4].outcome).toBe('unmatched');                                          // a .txt named like nothing is never stored
    expect(by[5]).toEqual(expect.objectContaining({ outcome: 'duplicate' }));
    const list = (await call('bob', 'GET', `/api/seller-storefront/imports/${batch}/photos`)).body.data;
    const row2 = list.rows.find((x) => x.row === 2);                                   // lot 6 = spreadsheet row 2
    expect(row2.photos.map((p) => p.file)).toEqual(['6.jpg', '6_2.jpg']);
    expect((await one('SELECT count(*)::int n FROM storefront_import_photos WHERE batch_id = $1', [batch])).n).toBe(3);
  });

  test('the review shows the totals; importing creates 142 drafts with their photos, categories assigned automatically', async () => {
    const rev = (await call('bob', 'GET', `/api/seller-storefront/imports/${batch}/review`)).body.data;
    expect(rev.summary).toEqual(expect.objectContaining({ total: 142, new_items: 142, existing_items: 0, missing_price: 142, photos_matched: 3, errors: 0 }));
    expect(rev.summary.photos_unmatched).toBeGreaterThanOrEqual(1);
    const done = await importAll('bob', batch);
    expect(done.body.data).toEqual(expect.objectContaining({ done: true, created: 142, failed: 0, photos_attached: 3 }));
    const made = await q('SELECT * FROM marketplace_items WHERE import_batch_id = $1 ORDER BY import_row', [batch]);
    expect(made).toHaveLength(142);
    expect(made.every((m) => m.status === 'draft' && m.price_cents === null && m.seller_id === SP.bob)).toBe(true);   // no auction price carried
    expect(made[0]).toEqual(expect.objectContaining({ inventory_number: '126721', title: 'KARL SPRINGER STYLE HORN INLAID LAMP', source_lot_number: '6', quantity: 1,
      category_key: 'lighting', category_source: 'automatic' }));
    expect(made[0].images).toHaveLength(2);
    expect(made[0].thumbnail_url).toBe(made[0].images[0]);                             // the primary photo
    const assigned = made.filter((m) => m.category_status === 'assigned').length;
    expect(assigned / made.length).toBeGreaterThan(0.8);                              // the rest stay pending, never guessed
    expect(made.filter((m) => m.category_status === 'pending').every((m) => m.category_key === null)).toBe(true);
    expect(made.every((m) => m.category_source !== 'seller')).toBe(true);
    // The seller's approved columns are saved for the next export from the same software.
    const again = await preview('bob', FIXTURE, 'Unsold items by inv.csv');
    expect(again.body.data.mapping_source).toBe('saved');
    expect(again.body.data.photo_match).toEqual({ reference: 'lot_number', column: 0 });
    expect(again.body.data.summary).toEqual(expect.objectContaining({ create: 0, skip: 142 }));   // already in inventory: never duplicated
    // Drafts are not public anywhere.
    expect((await items.listPublicForSeller(SP.bob)).filter((x) => x.title === 'KARL SPRINGER STYLE HORN INLAID LAMP')).toHaveLength(0);
  });

  test('an imported draft cannot be published until it has a Sale Price', async () => {
    const it = await one(`SELECT id FROM marketplace_items WHERE inventory_number = '126721' AND seller_id = $1`, [SP.bob]);
    const r = await call('bob', 'POST', '/api/seller-storefront/items/bulk', { action: 'publish', ids: [it.id] });
    expect(r.body.data.results[0].code).toBe('PRICE_REQUIRED');
    await expect(q(`UPDATE marketplace_items SET status = 'active' WHERE id = $1`, [it.id])).rejects.toThrow(/priced_when_visible/);   // the database agrees
    await call('bob', 'POST', '/api/seller-storefront/items/bulk', { action: 'set_price', ids: [it.id], value: 45000 });
    expect((await call('bob', 'POST', '/api/seller-storefront/items/bulk', { action: 'publish', ids: [it.id] })).body.data.done).toBe(1);
  });
});

describe('simple marketplace importer: photo columns, links, matching choices and corrections', () => {
  const photosSvc = () => require('../src/services/storefrontImportPhotoService');
  const SHEET = [['Item Number', 'Name', 'Price', 'Photo 1', 'Photo 2', 'Image URL', 'Vendor Ref'],
    ['PC-1', 'Walnut bench', '120', 'bench-front.jpg', 'bench-back.jpg', 'https://img.example.com/bench-detail.jpg', 'V-9'],
    ['PC-2', 'Brass sconce pair', '80', '', '', 'http://127.0.0.1/admin/secret.jpg', 'V-9'],
    ['PC-3', 'Blue vase', '35', 'shared.jpg', '', '', 'V-3'],
    ['PC-4', 'Green vase', '35', 'shared.jpg', '', '', 'V-4']];
  let batch;

  test('Photo_1..Photo_15 headings and image-link columns are recognised; file names and links are counted', async () => {
    const r = await preview('ann', csv(SHEET), 'photos.csv');
    expect(r.body.data.columns).toEqual(['inventory_number', 'title', 'price', 'photo_1', 'photo_2', 'photo_3', 'skip']);
    expect(r.body.data.photo_references).toEqual({ file_names: 4, links: 2, rows: 4 });
    batch = r.body.data.batch_id;
  });

  test('named files go to their row and position; a name used by two rows is ambiguous until the seller chooses', async () => {
    const up = await call('ann', 'POST', `/api/seller-storefront/imports/${batch}/photos`, form('photos', [['bench-back.jpg', JPEG('bb')], ['bench-front.jpg', JPEG('bf')], ['shared.jpg', JPEG('sh')]]));
    const res = up.body.data.results;
    expect(res.map((x) => x.outcome)).toEqual(['matched', 'matched', 'ambiguous']);
    expect(res[2].rows).toEqual([4, 5]);
    // The seller assigns the ambiguous file to row 5.
    const fd = form('photos', [['shared.jpg', JPEG('sh')]]); fd.append('assign', JSON.stringify({ 'shared.jpg': 5 }));
    const fix = await call('ann', 'POST', `/api/seller-storefront/imports/${batch}/photos`, fd);
    expect(fix.body.data.results[0]).toEqual(expect.objectContaining({ outcome: 'matched', row: 5 }));
    const list = (await call('ann', 'GET', `/api/seller-storefront/imports/${batch}/photos`)).body.data;
    expect(list.rows.find((x) => x.row === 2).photos.map((p) => p.file)).toEqual(['bench-front.jpg', 'bench-back.jpg']);   // Photo_1 then Photo_2
    expect(list.rows.find((x) => x.row === 4).missing).toEqual([{ type: 'file', value: 'shared.jpg', problem: null }]);
  });

  test('photo links are fetched only from permitted public addresses, as images, and stored unchanged', async () => {
    const seen = [];
    const fetcher = async (url) => {
      seen.push(url);
      // The real fetcher is netGuard.safeFetch; it refuses private addresses before connecting (checked below).
      const guard = await require('../src/services/eventImport/netGuard').checkUrl(url, { lookup: async () => [{ address: url.includes('127.0.0.1') ? '127.0.0.1' : '93.184.216.34' }] });
      if (!guard.ok) return { ok: false, reason: guard.reason };
      return { ok: true, status: 200, body: JPEG('link:' + url) };
    };
    const out = await photosSvc().fetchLinks(U.ann.id, batch, { fetcher });
    expect(out).toEqual(expect.objectContaining({ fetched: 1, failed: 1, done: true }));
    expect(out.results.find((x) => x.outcome === 'failed')).toEqual(expect.objectContaining({ code: 'LINK_NOT_PERMITTED', row: 3 }));
    // The real network guard: private and non-web addresses are refused, and only same-site redirects are followed.
    const ng = require('../src/services/eventImport/netGuard');
    for (const bad of ['http://127.0.0.1/x.jpg', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'http://user:pw@example.com/a.jpg', 'http://example.com:8080/a.jpg']) {
      expect((await ng.checkUrl(bad, { lookup: async () => [{ address: '127.0.0.1' }] })).ok).toBe(false);
    }
    // A link that returns something other than an image is refused.
    const notImage = await photosSvc().fetchLinks(U.ann.id, batch, { fetcher: async () => ({ ok: true, status: 200, body: Buffer.from('<html>not a photo</html>'.repeat(4)) }) });
    expect(notImage.fetched).toBe(0);
  });

  test('the seller reorders photos, chooses the primary, moves a photo to another item, or removes it', async () => {
    let list = (await call('ann', 'GET', `/api/seller-storefront/imports/${batch}/photos`)).body.data;
    const bench = list.rows.find((x) => x.row === 2);
    expect(bench.photos).toHaveLength(3);
    const last = bench.photos[2];
    expect((await call('ann', 'PATCH', `/api/seller-storefront/imports/${batch}/photos/${last.id}`, { position: 0 })).status).toBe(200);   // make it the primary
    list = (await call('ann', 'GET', `/api/seller-storefront/imports/${batch}/photos`)).body.data;
    expect(list.rows.find((x) => x.row === 2).photos[0].id).toBe(last.id);
    const back = list.rows.find((x) => x.row === 2).photos.find((p) => p.file === 'bench-back.jpg');
    expect((await call('ann', 'PATCH', `/api/seller-storefront/imports/${batch}/photos/${back.id}`, { row: 3 })).status).toBe(200);   // move to the sconce
    expect((await call('ann', 'PATCH', `/api/seller-storefront/imports/${batch}/photos/${back.id}`, { row: 999 })).body.code).toBe('ROW_INVALID');
    const vase = (await call('ann', 'GET', `/api/seller-storefront/imports/${batch}/photos`)).body.data.rows.find((x) => x.row === 5).photos[0];
    expect((await call('ann', 'DELETE', `/api/seller-storefront/imports/${batch}/photos/${vase.id}`)).status).toBe(200);
    // Import: each draft gets its photos in the chosen order.
    await importAll('ann', batch);
    const benchItem = await one(`SELECT images, thumbnail_url FROM marketplace_items WHERE inventory_number = 'PC-1' AND seller_id = $1`, [SP.ann]);
    expect(benchItem.images).toHaveLength(2);
    expect(benchItem.thumbnail_url).toBe(last.url);
    const sconce = await one(`SELECT images FROM marketplace_items WHERE inventory_number = 'PC-2' AND seller_id = $1`, [SP.ann]);
    expect(sconce.images).toHaveLength(1);
    const blueVase = await one(`SELECT images FROM marketplace_items WHERE inventory_number = 'PC-4' AND seller_id = $1`, [SP.ann]);
    expect(blueVase.images).toHaveLength(0);
    // Retrying the finished import never adds a photo twice.
    await call('ann', 'POST', `/api/seller-storefront/imports/${batch}/import`);
    expect((await one(`SELECT images FROM marketplace_items WHERE inventory_number = 'PC-1' AND seller_id = $1`, [SP.ann])).images).toHaveLength(2);
  });

  test('photos can also be matched by another column (here, a vendor reference shared by two rows is ambiguous)', async () => {
    const fd = new FormData(); fd.append('file', new Blob([csv(SHEET.map((r, i) => (i === 0 ? r : [r[0] + '-B', ...r.slice(1)])))]), 'photos-b.csv');
    fd.append('photo_match', JSON.stringify({ reference: 'column', column: 6 }));
    const r = await call('ann', 'POST', '/api/seller-storefront/imports/preview', fd);
    const b = r.body.data.batch_id;
    const up = await call('ann', 'POST', `/api/seller-storefront/imports/${b}/photos`, form('photos', [['V-3.jpg', JPEG('v3')], ['V-9_2.jpg', JPEG('v9')]]));
    expect(up.body.data.results.map((x) => x.outcome)).toEqual(['matched', 'ambiguous']);
  });
});

describe('simple marketplace importer: categories, duplicates and isolation', () => {
  test('a spreadsheet category maps to the taxonomy; a seller choice is never overwritten by later imports or the background pass', async () => {
    const r = await preview('ann', csv([['Inventory Number', 'Item Title', 'Category', 'Sale Price'], ['CAT-1', 'Oak hall table', 'Furniture', '50'], ['CAT-2', 'Unlabelled thing', '', '20']]), 'cats.csv');
    await importAll('ann', r.body.data.batch_id);
    const t = await one(`SELECT id, category_key, category_source FROM marketplace_items WHERE inventory_number = 'CAT-1' AND seller_id = $1`, [SP.ann]);
    expect(t).toEqual(expect.objectContaining({ category_key: 'furniture', category_source: 'spreadsheet' }));
    const pending = await one(`SELECT id, category_status, category_key FROM marketplace_items WHERE inventory_number = 'CAT-2' AND seller_id = $1`, [SP.ann]);
    expect(pending).toEqual(expect.objectContaining({ category_status: 'pending', category_key: null }));
    // The seller changes the category in the editor.
    await call('ann', 'PATCH', `/api/seller-storefront/items/${t.id}`, { category_key: 'antiques' });
    await call('ann', 'PATCH', `/api/seller-storefront/items/${pending.id}`, { category_key: 'home_decor' });
    // A re-import that updates drafts does not touch a seller-chosen category.
    const fd = new FormData(); fd.append('file', new Blob([csv([['Inventory Number', 'Item Title', 'Category', 'Sale Price'], ['CAT-1', 'Oak hall table (updated)', 'Furniture', '55']])]), 'cats2.csv');
    fd.append('duplicate_mode', 'update_drafts');
    const r2 = await call('ann', 'POST', '/api/seller-storefront/imports/preview', fd);
    expect(r2.body.data.summary).toEqual(expect.objectContaining({ update: 1, create: 0, existing_items: 1 }));
    await importAll('ann', r2.body.data.batch_id);
    expect(await one(`SELECT title, price_cents, category_key, category_source FROM marketplace_items WHERE id = $1`, [t.id]))
      .toEqual({ title: 'Oak hall table (updated)', price_cents: 5500, category_key: 'antiques', category_source: 'seller' });
    // The background pass never changes a seller's choice, and assigns pending items only with confidence.
    const cats = require('../src/services/storefrontCategoryService');
    await q(`UPDATE marketplace_items SET category_status = 'pending' WHERE id = $1`, [pending.id]);   // even if it were pending again
    const out = await cats.refinePending(SP.ann, { classifyText: async () => ({ key: 'tools', confidence: 0.99 }) });
    expect(out.examined).toBeGreaterThan(0);          // other pending items may be assigned; the seller choice is not
    expect(await one(`SELECT category_key FROM marketplace_items WHERE id = $1`, [pending.id])).toEqual({ category_key: 'home_decor' });
  });

  test('update-drafts mode never changes a published item; skip mode changes nothing', async () => {
    const live = await items.createDirectListing(U.ann.id, { title: 'Live chair', price_cents: 1000, inventory_number: 'LIVE-1', status: 'active' });
    const fd = new FormData(); fd.append('file', new Blob([csv([['SKU', 'Title', 'Price'], ['LIVE-1', 'Hijack title', '1']])]), 'live.csv'); fd.append('duplicate_mode', 'update_drafts');
    const r = await call('ann', 'POST', '/api/seller-storefront/imports/preview', fd);
    expect(r.body.data.rows[0].action).toBe('skip');
    expect(await one('SELECT title, price_cents FROM marketplace_items WHERE id = $1', [live.id])).toEqual({ title: 'Live chair', price_cents: 1000 });
  });

  test('another seller cannot see, add photos to, rearrange or import someone else\'s import', async () => {
    const r = await preview('ann', csv([['SKU', 'Title'], ['ISO-P', 'Private item']]), 'iso-p.csv');
    const id = r.body.data.batch_id;
    await call('ann', 'POST', `/api/seller-storefront/imports/${id}/photos`, form('photos', [['ISO-P.jpg', JPEG('iso')]]));
    const photo = (await call('ann', 'GET', `/api/seller-storefront/imports/${id}/photos`)).body.data.rows[0].photos[0];
    for (const [m, u, b] of [['GET', `/imports/${id}/photos`], ['GET', `/imports/${id}/review`], ['POST', `/imports/${id}/import`], ['PUT', `/imports/${id}/options`, { duplicate_mode: 'update_drafts' }],
      ['PATCH', `/imports/${id}/photos/${photo.id}`, { position: 0 }], ['DELETE', `/imports/${id}/photos/${photo.id}`]]) {
      expect((await call('bob', m, '/api/seller-storefront' + u, b)).status).toBe(404);
    }
    const up = await call('bob', 'POST', `/api/seller-storefront/imports/${id}/photos`, form('photos', [['ISO-P.jpg', JPEG('evil')]]));
    expect(up.status).toBe(404);
    expect((await one('SELECT count(*)::int n FROM storefront_import_photos WHERE batch_id = $1', [id])).n).toBe(1);
    // An Individual Seller cannot use the importer at all.
    expect((await preview('ivy', csv([['SKU', 'Title'], ['X', 'Y']]), 'x.csv')).status).toBe(403);
  });

  test('the readiness list tells the seller what is left before buyers can purchase', async () => {
    const r = await call('ann', 'GET', '/api/seller-storefront/readiness');
    expect(r.status).toBe(200);
    const keys = r.body.data.company.map((s) => s.key);
    expect(keys).toEqual(['agreement', 'verification', 'pickup_location', 'storefront', 'payouts', 'checkout']);
    expect(r.body.data.company.find((s) => s.key === 'checkout').done).toBe(false);   // online checkout stays off
    expect(r.body.data.purchasable).toBe(false);
    expect(r.body.data.items.map((n) => n.key)).toEqual(expect.arrayContaining(['missing_price']));
    expect(JSON.stringify(r.body.data)).not.toMatch(/stripe|MARKETPLACE_CHECKOUT|ENABLED/i);
  });
});
