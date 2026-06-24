#!/usr/bin/env node
/*
 * stg-validate-phase2d.js — STAGING-guarded validation of Phase 2D
 * (reconciliation + repair + email visibility + buyer/admin checks).
 *
 * Builds a real closed auction (5 winners), pays 2, then exercises:
 *   - reconciliation READ-ONLY check
 *   - REPAIR scenario A: delete an invoice → check flags it → repair re-issues it
 *   - REPAIR scenario B: a REAL paid payment exists but invoice still 'issued' →
 *     check flags it → repair promotes to paid (no fake payment), number stable
 *   - buyer invoice history (issued + paid, numbers, status)
 *   - pickup packet still correct
 * Prints admin/buyer JWTs + ids for live access-control + buyer-download checks.
 *
 *   railway run --service advantage-staging node scripts/stg-validate-phase2d.js
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';
const AUCTION_ID = '7d000000-0000-4000-8000-0000000000b1';
const ADMIN_ID = '7d000000-0000-4000-8000-0000000000ad';
const IMG = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';
const PEOPLE = [ // [last, first, withImage]
  ['Olsen', 'Olivia', true],
  ['Reed', 'Ray', false],
  ['Cole', 'Cara', true],
  ['Vance', 'Vic', false],
  ['Diaz', 'Dana', false],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not STAGING (${STG_EP}).`); return 2; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const auctionService = require('../src/services/auctionService');
  const paymentService = require('../src/services/paymentService');
  const recon = require('../src/services/invoiceReconciliationService');
  const pickupPacketService = require('../src/services/pickupPacketService');
  const { fetchInvoicesForBuyer } = require('../src/routes/invoices');

  const c = await pool.connect();
  const out = { scenarios: {} };
  try {
    const sp = (await c.query(`SELECT id FROM seller_profiles LIMIT 1`)).rows[0];
    if (!sp) throw new Error('no seller_profile on staging');

    await c.query(
      `INSERT INTO auctions (id, title, state, seller_id, street_address, city, address_state, zip, pickup_window_start, pickup_window_end)
       VALUES ($1,'Phase 2D Readiness Auction','published',$2,'88 Hammer Ct','Grand Rapids','MI','49503', now()+interval '8 days', now()+interval '8 days 4 hours')
       ON CONFLICT (id) DO UPDATE SET state='published', seller_id=$2`,
      [AUCTION_ID, sp.id]
    );
    await c.query(`DELETE FROM invoices WHERE auction_id=$1`, [AUCTION_ID]);
    await c.query(`DELETE FROM payments WHERE auction_id=$1`, [AUCTION_ID]);
    await c.query(`DELETE FROM bids WHERE auction_id=$1`, [AUCTION_ID]);
    await c.query(`DELETE FROM lot_images WHERE lot_id IN (SELECT id FROM lots WHERE auction_id=$1)`, [AUCTION_ID]);
    await c.query(`DELETE FROM lots WHERE auction_id=$1`, [AUCTION_ID]);

    const lots = [];
    for (let i = 0; i < PEOPLE.length; i++) {
      const [last, first, withImg] = PEOPLE[i];
      const n = i + 1;
      const userId = `7d000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
      const lotId = `7d000000-0000-4000-8000-0000000000${String(10 + n).padStart(2, '0')}`;
      const amount = 3000 + 500 * n;
      lots.push({ lotId, userId, amount, last });
      await c.query(`INSERT INTO users (id,email,role,full_name,phone,password_hash) VALUES ($1,$2,'buyer',$3,$4,'x')
        ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name`,
        [userId, `advantageauction.bid+p2d${n}@gmail.com`, `${first} ${last}`, `616-555-03${String(n).padStart(2, '0')}`]);
      await c.query(`INSERT INTO lots (id,auction_id,title,state,lot_number) VALUES ($1,$2,$3,'open',$4)
        ON CONFLICT (id) DO UPDATE SET state='open'`, [lotId, AUCTION_ID, `${last} Lot ${n}`, n]);
      if (withImg) await c.query(`INSERT INTO lot_images (lot_id,image_url,sort_order) VALUES ($1,$2,0)`, [lotId, IMG]);
      await c.query(`INSERT INTO bids (lot_id,auction_id,bidder_user_id,amount_cents) VALUES ($1,$2,$3,$4)`, [lotId, AUCTION_ID, userId, amount]);
    }

    // Real close → 5 issued invoices (post-commit async)
    const closeRes = await auctionService.closeAuction(AUCTION_ID, ADMIN_ID);
    out.close = { winners: closeRes.results.filter((r) => r.winner_user_id).length };
    await sleep(3500);

    // Snapshot numbers after close
    const afterClose = (await c.query(`SELECT lot_id, invoice_number, status FROM invoices WHERE auction_id=$1`, [AUCTION_ID])).rows;
    const numByLot = {}; afterClose.forEach((r) => { numByLot[r.lot_id] = r.invoice_number; });
    out.after_close = { issued_count: afterClose.length };

    // Pay 2 winners normally (lots[3], lots[4]) → paid upsert
    for (const idx of [3, 4]) {
      const l = lots[idx];
      const pay = (await c.query(`INSERT INTO payments (auction_id,lot_id,buyer_user_id,amount_cents,status) VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
        [AUCTION_ID, l.lotId, l.userId, l.amount])).rows[0];
      await paymentService.recordPaymentSuccess(pay.id, 'phase2d');
    }

    // ── Scenario A: delete an invoice → check flags → repair re-issues ─────────
    const delLot = lots[0]; // Olsen, unpaid
    await c.query(`DELETE FROM invoices WHERE lot_id=$1`, [delLot.lotId]);
    const checkA1 = await recon.checkAuction(AUCTION_ID);
    const repairA = await recon.repairAuction(AUCTION_ID);
    const checkA2 = await recon.checkAuction(AUCTION_ID);
    out.scenarios.A_missing_invoice = {
      flagged_missing: checkA1.counts.winning_lots_without_invoice,
      repaired_issued: repairA.repaired.issued,
      missing_after: checkA2.counts.winning_lots_without_invoice,
      reissued_exists: (await c.query(`SELECT 1 FROM invoices WHERE lot_id=$1`, [delLot.lotId])).rowCount === 1,
    };

    // ── Scenario B: real paid payment exists, invoice still 'issued' → promote ──
    const promoLot = lots[1]; // Reed, unpaid
    const numBefore = (await c.query(`SELECT invoice_number FROM invoices WHERE lot_id=$1`, [promoLot.lotId])).rows[0].invoice_number;
    await c.query(`INSERT INTO payments (auction_id,lot_id,buyer_user_id,amount_cents,status,charged_at) VALUES ($1,$2,$3,$4,'paid',now())`,
      [AUCTION_ID, promoLot.lotId, promoLot.userId, promoLot.amount]);
    const checkB1 = await recon.checkAuction(AUCTION_ID);
    const repairB = await recon.repairAuction(AUCTION_ID);
    const promoted = (await c.query(`SELECT status, payment_id, invoice_number FROM invoices WHERE lot_id=$1`, [promoLot.lotId])).rows[0];
    out.scenarios.B_paid_promotion = {
      flagged_paid_not_marked: checkB1.counts.paid_payment_invoice_not_paid,
      repaired_promoted: repairB.repaired.promoted,
      now_paid: promoted.status === 'paid' && !!promoted.payment_id,
      number_stable: promoted.invoice_number === numBefore,
    };

    // ── Final reconciliation should be clean ──────────────────────────────────
    const finalCheck = await recon.checkAuction(AUCTION_ID);
    out.final_reconciliation = { clean: finalCheck.clean, counts: finalCheck.counts };

    // ── Buyer invoice history (issued + paid) ─────────────────────────────────
    const unpaidBuyer = lots[2].userId; // Cole, still unpaid
    const paidBuyer = lots[3].userId;   // Vance, paid normally
    const unpaidHist = await fetchInvoicesForBuyer(unpaidBuyer);
    const paidHist = await fetchInvoicesForBuyer(paidBuyer);
    out.buyer_history = {
      unpaid_buyer_shows_issued: unpaidHist.some((i) => i.status === 'issued' && i.invoice_number),
      paid_buyer_shows_paid: paidHist.some((i) => (i.status === 'paid' || i.payment_status === 'paid') && i.invoice_number),
      numbers_present: unpaidHist.every((i) => i.invoice_number) && paidHist.every((i) => i.invoice_number),
    };

    // ── Pickup packet final check ─────────────────────────────────────────────
    const packet = await pickupPacketService.getPacketData(AUCTION_ID);
    const gotUnpaid = packet.invoices.filter((i) => !i.isPaid).map((i) => i.last);
    const gotPaid = packet.invoices.filter((i) => i.isPaid).map((i) => i.last);
    const buf = await pickupPacketService.buildPacketPdf(packet);
    out.packet = {
      counts: packet.counts,
      unpaid_first: packet.invoices.slice(0, packet.counts.unpaid).every((i) => !i.isPaid),
      unpaid_alpha: JSON.stringify(gotUnpaid) === JSON.stringify(gotUnpaid.slice().sort((a, b) => a.localeCompare(b))),
      paid_alpha: JSON.stringify(gotPaid) === JSON.stringify(gotPaid.slice().sort((a, b) => a.localeCompare(b))),
      pdf_valid: buf.slice(0, 5).toString() === '%PDF-',
    };

    // ── Live targets ──────────────────────────────────────────────────────────
    let baseUrl = ''; try { baseUrl = require('../src/lib/publicUrls').publicBaseUrl(); } catch (_e) {}
    await c.query(`INSERT INTO users (id,email,role,full_name,password_hash) VALUES ($1,'p2d.admin@example.com','admin','P2D Admin','x') ON CONFLICT (id) DO UPDATE SET role='admin'`, [ADMIN_ID]);
    const buyerInv = (await c.query(`SELECT id FROM invoices WHERE buyer_user_id=$1 LIMIT 1`, [unpaidBuyer])).rows[0];
    const otherInv = (await c.query(`SELECT id FROM invoices WHERE buyer_user_id=$1 LIMIT 1`, [paidBuyer])).rows[0];
    out.live = {
      base_url: baseUrl || '(unset)', auction_id: AUCTION_ID,
      buyer_owned_invoice_id: buyerInv ? buyerInv.id : null,
      other_buyer_invoice_id: otherInv ? otherInv.id : null,
      admin_jwt: jwt.sign({ id: ADMIN_ID, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
      buyer_jwt: jwt.sign({ id: unpaidBuyer, role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
    };

    console.log('\n=== PHASE 2D VALIDATION RESULT ===');
    console.log(JSON.stringify(out, null, 2));
    const A = out.scenarios.A_missing_invoice, B = out.scenarios.B_paid_promotion;
    const pass =
      out.after_close.issued_count === 5 &&
      A.flagged_missing >= 1 && A.repaired_issued >= 1 && A.missing_after === 0 && A.reissued_exists &&
      B.flagged_paid_not_marked >= 1 && B.repaired_promoted >= 1 && B.now_paid && B.number_stable &&
      out.final_reconciliation.clean &&
      out.buyer_history.unpaid_buyer_shows_issued && out.buyer_history.paid_buyer_shows_paid && out.buyer_history.numbers_present &&
      out.packet.unpaid_first && out.packet.unpaid_alpha && out.packet.paid_alpha && out.packet.pdf_valid;
    console.log('\nRESULT: ' + (pass ? 'PASS' : 'REVIEW'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
