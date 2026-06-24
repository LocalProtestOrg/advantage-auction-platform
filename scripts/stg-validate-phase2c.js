#!/usr/bin/env node
/*
 * stg-validate-phase2c.js — STAGING-guarded validation of Phase 2C.
 *
 * Builds a real auction (existing seller_profile, 6 lots, 6 winning bids across
 * distinct last names), runs the REAL auctionService.closeAuction, then verifies:
 *   - issued invoices auto-created for every winner (status 'issued', payment_id NULL)
 *   - the post-commit close path created them (issueInvoicesForAuctionWinners reports created=0 after)
 *   - paying 3 winners UPSERTs the existing invoice to 'paid' (same number, payment linked) — no duplicate
 *   - invoice numbers remain stable across the issued→paid transition
 *   - pickup packet includes ALL winners, unpaid-first then paid, alphabetical
 *   - receipt email sends on payment; unpaid invoice email sends
 * Prints admin/buyer JWTs + ids for the live admin-endpoint access-control checks.
 *
 *   railway run --service advantage-staging node scripts/stg-validate-phase2c.js
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';
const AUCTION_ID = '7f000000-0000-4000-8000-0000000000b1';
const ADMIN_ID = '7f000000-0000-4000-8000-0000000000ad';
const IMG = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';
// [last, first, withImage]  — pay the lots at indexes PAY_IDX
const PEOPLE = [
  ['Wallace', 'Will', false],
  ['Adams',   'Amy',  true],
  ['Khan',    'Kira', false],
  ['Diaz',    'Dora', false],
  ['Brooks',  'Ben',  true],
  ['Nguyen',  'Nina', false],
];
const PAY_IDX = [0, 2, 4]; // Wallace, Khan, Brooks → paid; the rest unpaid

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not STAGING (${STG_EP}).`); return 2; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const auctionService = require('../src/services/auctionService');
  const paymentService = require('../src/services/paymentService');
  const invoiceService = require('../src/services/invoiceService');
  const receiptService = require('../src/services/receiptService');
  const pickupPacketService = require('../src/services/pickupPacketService');

  const c = await pool.connect();
  const out = {};
  try {
    const sp = (await c.query(`SELECT id, user_id FROM seller_profiles LIMIT 1`)).rows[0];
    if (!sp) throw new Error('no seller_profile on staging to attach the auction to');

    await c.query(
      `INSERT INTO auctions (id, title, state, seller_id, street_address, city, address_state, zip, pickup_window_start, pickup_window_end)
       VALUES ($1,'Phase 2C Auto-Issued Auction','published',$2,'77 Gavel Rd','Grand Rapids','MI','49503',
               now() + interval '7 days', now() + interval '7 days 5 hours')
       ON CONFLICT (id) DO UPDATE SET state='published', seller_id=$2,
         pickup_window_start=EXCLUDED.pickup_window_start, pickup_window_end=EXCLUDED.pickup_window_end`,
      [AUCTION_ID, sp.id]
    );

    // Clean prior fixture
    await c.query(`DELETE FROM invoices WHERE auction_id=$1`, [AUCTION_ID]);
    await c.query(`DELETE FROM payments WHERE auction_id=$1`, [AUCTION_ID]);
    await c.query(`DELETE FROM bids WHERE auction_id=$1`, [AUCTION_ID]);
    await c.query(`DELETE FROM lot_images WHERE lot_id IN (SELECT id FROM lots WHERE auction_id=$1)`, [AUCTION_ID]);
    await c.query(`DELETE FROM lots WHERE auction_id=$1`, [AUCTION_ID]);

    const lotIds = [];
    for (let i = 0; i < PEOPLE.length; i++) {
      const [last, first, withImg] = PEOPLE[i];
      const n = i + 1;
      const userId = `7f000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
      const lotId = `7f000000-0000-4000-8000-0000000000${String(10 + n).padStart(2, '0')}`;
      lotIds.push(lotId);
      const amount = 2000 + 500 * n;
      await c.query(
        `INSERT INTO users (id, email, role, full_name, phone, password_hash)
         VALUES ($1,$2,'buyer',$3,$4,'x-not-loginable')
         ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name, phone=EXCLUDED.phone`,
        [userId, `advantageauction.bid+p2c${n}@gmail.com`, `${first} ${last}`, n % 2 === 0 ? `616-555-02${String(n).padStart(2, '0')}` : null]
      );
      await c.query(
        `INSERT INTO lots (id, auction_id, title, state, lot_number) VALUES ($1,$2,$3,'open',$4)
         ON CONFLICT (id) DO UPDATE SET state='open', lot_number=$4`,
        [lotId, AUCTION_ID, `${last} Estate Lot ${n}`, n]
      );
      if (withImg) await c.query(`INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ($1,$2,0)`, [lotId, IMG]);
      await c.query(
        `INSERT INTO bids (lot_id, auction_id, bidder_user_id, amount_cents) VALUES ($1,$2,$3,$4)`,
        [lotId, AUCTION_ID, userId, amount]
      );
    }

    // ── REAL close ────────────────────────────────────────────────────────────
    const closeRes = await auctionService.closeAuction(AUCTION_ID, ADMIN_ID);
    out.close = { lots_closed: closeRes.lots_closed, winners: closeRes.results.filter((r) => r.winner_user_id).length };
    await sleep(3000); // let the post-commit async issued-invoice creation + emails run

    // Did close create them? The idempotent helper should now report created=0.
    const repair = await invoiceService.issueInvoicesForAuctionWinners(AUCTION_ID);
    out.close_created_invoices = { newly_created_on_repair: repair.createdIds.length, winners: repair.winnerCount };

    // Snapshot issued invoices + numbers
    const issued = (await c.query(
      `SELECT id, lot_id, invoice_number, status, payment_id FROM invoices WHERE auction_id=$1 ORDER BY invoice_number`, [AUCTION_ID]
    )).rows;
    const numbersBefore = {};
    issued.forEach((r) => { numbersBefore[r.lot_id] = r.invoice_number; });
    out.issued = {
      count: issued.length,
      all_issued_status: issued.every((r) => r.status === 'issued'),
      all_unlinked: issued.every((r) => r.payment_id === null),
    };

    // ── Pay 3 winners (issued → paid UPSERT) ──────────────────────────────────
    let receiptMsgId = null;
    for (const idx of PAY_IDX) {
      const lotId = lotIds[idx];
      const userId = `7f000000-0000-4000-8000-0000000000${String(idx + 1).padStart(2, '0')}`;
      const amount = 2000 + 500 * (idx + 1);
      const pay = (await c.query(
        `INSERT INTO payments (auction_id, lot_id, buyer_user_id, amount_cents, status) VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
        [AUCTION_ID, lotId, userId, amount]
      )).rows[0];
      await paymentService.recordPaymentSuccess(pay.id, 'phase2c-validation');
      if (!receiptMsgId) { const r = await receiptService.sendPaymentReceipt(pay.id); receiptMsgId = r.messageId || r.reason || 'n/a'; }
    }

    // Post-pay snapshot
    const after = (await c.query(
      `SELECT id, lot_id, invoice_number, status, payment_id FROM invoices WHERE auction_id=$1`, [AUCTION_ID]
    )).rows;
    const paidLotIds = PAY_IDX.map((i) => lotIds[i]);
    out.paid_upsert = {
      total_invoices_still: after.length,
      paid_rows_linked: after.filter((r) => paidLotIds.includes(r.lot_id)).every((r) => r.status === 'paid' && r.payment_id),
      numbers_stable: after.filter((r) => paidLotIds.includes(r.lot_id)).every((r) => r.invoice_number === numbersBefore[r.lot_id]),
    };
    const dups = (await c.query(
      `SELECT lot_id, buyer_user_id, count(*) FROM invoices WHERE auction_id=$1 GROUP BY lot_id, buyer_user_id HAVING count(*) > 1`, [AUCTION_ID]
    )).rows;
    out.no_duplicates = dups.length === 0;

    // ── Unpaid invoice email (deterministic capture) ──────────────────────────
    const oneUnpaid = after.find((r) => r.status === 'issued');
    const unpaidEmail = oneUnpaid ? await receiptService.sendUnpaidInvoiceEmail(oneUnpaid.id) : { sent: false, reason: 'none-unpaid' };
    out.emails = { receipt: receiptMsgId, unpaid_invoice: unpaidEmail.messageId || unpaidEmail.reason || 'n/a' };

    // ── Packet inclusion + ordering ───────────────────────────────────────────
    const packet = await pickupPacketService.getPacketData(AUCTION_ID);
    const expectedUnpaid = packet.invoices.filter((i) => !i.isPaid).map((i) => i.last).slice().sort((a, b) => a.localeCompare(b));
    const expectedPaid = packet.invoices.filter((i) => i.isPaid).map((i) => i.last).slice().sort((a, b) => a.localeCompare(b));
    const gotUnpaid = packet.invoices.filter((i) => !i.isPaid).map((i) => i.last);
    const gotPaid = packet.invoices.filter((i) => i.isPaid).map((i) => i.last);
    const buf = await pickupPacketService.buildPacketPdf(packet);
    out.packet = {
      counts: packet.counts,
      includes_all_winners: packet.counts.total === 6,
      unpaid_first: packet.invoices.slice(0, packet.counts.unpaid).every((i) => !i.isPaid),
      unpaid_alphabetical: JSON.stringify(gotUnpaid) === JSON.stringify(expectedUnpaid),
      paid_alphabetical: JSON.stringify(gotPaid) === JSON.stringify(expectedPaid),
      pdf_valid: buf.slice(0, 5).toString() === '%PDF-',
      order: packet.invoices.map((i) => `${i.isPaid ? 'paid' : 'unpaid'}:${i.last}`),
    };

    // ── Live targets ──────────────────────────────────────────────────────────
    let baseUrl = '';
    try { baseUrl = require('../src/lib/publicUrls').publicBaseUrl(); } catch (_e) {}
    await c.query(`INSERT INTO users (id,email,role,full_name,password_hash) VALUES ($1,'p2c.admin@example.com','admin','P2C Admin','x') ON CONFLICT (id) DO UPDATE SET role='admin'`, [ADMIN_ID]);
    out.live = {
      base_url: baseUrl || '(unset)',
      auction_id: AUCTION_ID,
      sample_invoice_id: after[0] ? after[0].id : null,
      admin_jwt: jwt.sign({ id: ADMIN_ID, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
      buyer_jwt: jwt.sign({ id: '7f000000-0000-4000-8000-000000000001', role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
    };

    console.log('\n=== PHASE 2C VALIDATION RESULT ===');
    console.log(JSON.stringify(out, null, 2));
    const pass = out.issued.count === 6 && out.issued.all_issued_status && out.issued.all_unlinked &&
      out.close_created_invoices.newly_created_on_repair === 0 &&
      out.paid_upsert.total_invoices_still === 6 && out.paid_upsert.paid_rows_linked && out.paid_upsert.numbers_stable &&
      out.no_duplicates &&
      out.packet.includes_all_winners && out.packet.unpaid_first && out.packet.unpaid_alphabetical && out.packet.paid_alphabetical && out.packet.pdf_valid;
    console.log('\nRESULT: ' + (pass ? 'PASS' : 'REVIEW'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
