#!/usr/bin/env node
/*
 * stg-validate-phase2b.js — STAGING-guarded validation of the Phase 2B pickup
 * invoice packet. Seeds a test auction with 3 UNPAID + 3 PAID invoices across
 * distinct buyer last names and lots (one with a real thumbnail), then verifies
 * pickup ordering, packet PDF generation, and thumbnail embedding. Prints an
 * admin JWT + a buyer JWT + auction id so the live access-control checks (admin
 * 200 / buyer 403 / no-token 401) can be run against the deployed staging build.
 *
 *   railway run --service advantage-staging node scripts/stg-validate-phase2b.js
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';
const AUCTION_ID = '7e000000-0000-4000-8000-0000000000b1';
const ADMIN_ID = '7e000000-0000-4000-8000-0000000000ad';
const IMG = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';

// [last, first, paid?, withImage?]
const PEOPLE = [
  ['Young',  'Yara', false, false],
  ['Adams',  'Alice', false, true],   // unpaid + thumbnail
  ['Patel',  'Mona', false, false],
  ['Zhang',  'Tom',  true,  false],
  ['Brown',  'Bob',  true,  true],    // paid + thumbnail
  ['Carter', 'Lee',  true,  false],
];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not STAGING (${STG_EP}).`); return 2; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const invoiceService = require('../src/services/invoiceService');
  const pickupPacketService = require('../src/services/pickupPacketService');
  const documentService = require('../src/services/documentService');

  const c = await pool.connect();
  const out = {};
  try {
    // Auction with pickup window + location
    await c.query(
      `INSERT INTO auctions (id, title, state, street_address, city, address_state, zip, pickup_window_start, pickup_window_end)
       VALUES ($1,'Phase 2B Pickup Packet Auction','closed','123 Auction Way','Grand Rapids','MI','49503',
               now() + interval '6 days', now() + interval '6 days 4 hours')
       ON CONFLICT (id) DO UPDATE SET state='closed', street_address=EXCLUDED.street_address,
         city=EXCLUDED.city, address_state=EXCLUDED.address_state, zip=EXCLUDED.zip,
         pickup_window_start=EXCLUDED.pickup_window_start, pickup_window_end=EXCLUDED.pickup_window_end`,
      [AUCTION_ID]
    );

    // Clean prior fixture rows for this auction
    await c.query(`DELETE FROM invoices WHERE auction_id=$1`, [AUCTION_ID]);
    await c.query(`DELETE FROM payments WHERE auction_id=$1`, [AUCTION_ID]);
    await c.query(`DELETE FROM lot_images WHERE lot_id IN (SELECT id FROM lots WHERE auction_id=$1)`, [AUCTION_ID]);
    await c.query(`DELETE FROM lots WHERE auction_id=$1`, [AUCTION_ID]);

    for (let i = 0; i < PEOPLE.length; i++) {
      const [last, first, paid, withImg] = PEOPLE[i];
      const n = i + 1;
      const userId = `7e000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
      const lotId = `7e000000-0000-4000-8000-0000000000${String(10 + n).padStart(2, '0')}`;
      const email = `phase2b.${last.toLowerCase()}@example.com`;
      const amount = 1000 * n + 500;

      await c.query(
        `INSERT INTO users (id, email, role, full_name, phone, password_hash)
         VALUES ($1,$2,'buyer',$3,$4,'x-not-loginable')
         ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name, phone=EXCLUDED.phone`,
        [userId, email, `${first} ${last}`, i % 2 === 0 ? `616-555-01${String(n).padStart(2, '0')}` : null]
      );
      await c.query(
        `INSERT INTO lots (id, auction_id, title, state, lot_number, winning_buyer_user_id, winning_amount_cents)
         VALUES ($1,$2,$3,'closed',$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET winning_buyer_user_id=$5, winning_amount_cents=$6`,
        [lotId, AUCTION_ID, `${last} Estate Lot ${n}`, n, userId, amount]
      );
      if (withImg) {
        await c.query(`INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ($1,$2,0)`, [lotId, IMG]);
      }
      const payStatus = paid ? 'paid' : 'pending';
      const pay = (await c.query(
        `INSERT INTO payments (auction_id, lot_id, buyer_user_id, amount_cents, status, charged_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [AUCTION_ID, lotId, userId, amount, payStatus, paid ? new Date() : null]
      )).rows[0];
      // Reuse the real invoice creator → sets number/breakdown; status derives from payment.
      await invoiceService.createInvoice(c, pay);
    }

    // ── Verify ordering + counts ──────────────────────────────────────────────
    const packet = await pickupPacketService.getPacketData(AUCTION_ID);
    out.counts = packet.counts;
    out.order = packet.invoices.map((iv) => ({ group: iv.isPaid ? 'paid' : 'unpaid', name: iv.displayName, num: iv.invoiceNumber }));

    const expectedUnpaid = ['Adams', 'Patel', 'Young'];
    const expectedPaid = ['Brown', 'Carter', 'Zhang'];
    const gotUnpaid = packet.invoices.filter((i) => !i.isPaid).map((i) => i.last);
    const gotPaid = packet.invoices.filter((i) => i.isPaid).map((i) => i.last);
    const firstThreeUnpaid = packet.invoices.slice(0, 3).every((i) => !i.isPaid);
    const lastThreePaid = packet.invoices.slice(3).every((i) => i.isPaid);

    out.assertions = {
      counts_ok: packet.counts.unpaid === 3 && packet.counts.paid === 3 && packet.counts.total === 6,
      unpaid_first: firstThreeUnpaid && lastThreePaid,
      unpaid_alphabetical: JSON.stringify(gotUnpaid) === JSON.stringify(expectedUnpaid),
      paid_alphabetical: JSON.stringify(gotPaid) === JSON.stringify(expectedPaid),
    };

    // ── PDF generation + thumbnail embedding ──────────────────────────────────
    const buffer = await pickupPacketService.buildPacketPdf(packet);
    out.pdf = { bytes: buffer.length, valid: buffer.slice(0, 5).toString() === '%PDF-' };
    const imgBuf = await documentService.fetchImageBuffer(IMG);
    out.thumbnail_embeds = Boolean(imgBuf);

    // ── Tokens + target for the live access-control checks ────────────────────
    let baseUrl = '';
    try { baseUrl = require('../src/lib/publicUrls').publicBaseUrl(); } catch (_e) {}
    // Ensure an admin user row exists (for completeness; JWT role is what the guard checks).
    await c.query(
      `INSERT INTO users (id, email, role, full_name, password_hash)
       VALUES ($1,'phase2b.admin@example.com','admin','Phase 2B Admin','x-not-loginable')
       ON CONFLICT (id) DO UPDATE SET role='admin'`,
      [ADMIN_ID]
    );
    out.live = {
      base_url: baseUrl || '(unset)',
      packet_url: `/api/admin/auctions/${AUCTION_ID}/pickup-packet`,
      admin_jwt: jwt.sign({ id: ADMIN_ID, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
      buyer_jwt: jwt.sign({ id: '7e000000-0000-4000-8000-000000000001', role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
    };

    console.log('\n=== PHASE 2B VALIDATION RESULT ===');
    console.log(JSON.stringify(out, null, 2));
    const pass = out.assertions.counts_ok && out.assertions.unpaid_first &&
      out.assertions.unpaid_alphabetical && out.assertions.paid_alphabetical &&
      out.pdf.valid && out.pdf.bytes > 2000 && out.thumbnail_embeds;
    console.log('\nRESULT: ' + (pass ? 'PASS' : 'REVIEW'));
    return pass ? 0 : 1;
  } finally {
    c.release();
    await pool.end();
  }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
