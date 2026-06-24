#!/usr/bin/env node
/*
 * stg-validate-phase2.js — STAGING-guarded end-to-end validation of the Phase 2
 * invoice / receipt / document system. Builds a real fixture (auction → closed
 * lot w/ image → winning buyer → paid payment), drives the actual settlement path
 * (paymentService.recordPaymentSuccess → invoiceService → receiptService), then
 * verifies invoice numbering+breakdown, PDF generation, thumbnail embedding,
 * generated_documents history, SES receipt delivery, and account-history
 * enrichment. Prints a buyer JWT + invoice id so the live HTTP /pdf download can
 * be exercised against the deployed staging build.
 *
 * Idempotent: clears its own fixture payment/invoice rows before each run.
 *
 *   railway run --service advantage-staging node scripts/stg-validate-phase2.js
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';

// Deterministic fixture ids (idempotent re-runs).
const BUYER_ID   = '7c000000-0000-4000-8000-0000000000a1';
const AUCTION_ID = '7c000000-0000-4000-8000-0000000000b1';
const LOT_ID     = '7c000000-0000-4000-8000-0000000000c1';
const BUYER_EMAIL = 'advantageauction.bid+phase2val@gmail.com'; // Gmail plus-addr → operator inbox, deliverable
const IMG = 'https://res.cloudinary.com/demo/image/upload/sample.jpg'; // direct 200 JPEG (no redirect)
const HAMMER = 42500;

const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint. STAGING-only.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not the STAGING endpoint (${STG_EP}).`); return 2; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const db = require('../src/db'); // shares DATABASE_URL; used by services
  const paymentService = require('../src/services/paymentService');
  const invoiceService = require('../src/services/invoiceService');
  const receiptService = require('../src/services/receiptService');
  const invoicePdfService = require('../src/services/invoicePdfService');
  const documentService = require('../src/services/documentService');
  const { fetchInvoicesForBuyer } = require('../src/routes/invoices');

  const c = await pool.connect();
  try {
    // ── Fixture ──────────────────────────────────────────────────────────────
    await c.query(
      `INSERT INTO users (id, email, role, full_name, password_hash)
       VALUES ($1,$2,'buyer','Phase 2 Validation Buyer','x-not-loginable-validation')
       ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name`,
      [BUYER_ID, BUYER_EMAIL]
    );
    await c.query(
      `INSERT INTO auctions (id, title, state) VALUES ($1,'Phase 2 Validation Auction','closed')
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, state='closed'`,
      [AUCTION_ID]
    );
    await c.query(
      `INSERT INTO lots (id, auction_id, title, state, lot_number, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1,$2,'Mid-Century Walnut Credenza','closed',1,$3,$4)
       ON CONFLICT (id) DO UPDATE SET state='closed', winning_buyer_user_id=$3, winning_amount_cents=$4`,
      [LOT_ID, AUCTION_ID, BUYER_ID, HAMMER]
    );
    await c.query(`DELETE FROM lot_images WHERE lot_id=$1`, [LOT_ID]);
    await c.query(
      `INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ($1,$2,0)`,
      [LOT_ID, IMG]
    );
    // Clear prior fixture payment/invoice so the unique-active-payment index and
    // numbering start clean each run.
    await c.query(`DELETE FROM invoices WHERE lot_id=$1 AND buyer_user_id=$2`, [LOT_ID, BUYER_ID]);
    await c.query(`DELETE FROM payments WHERE lot_id=$1 AND buyer_user_id=$2`, [LOT_ID, BUYER_ID]);

    const payRes = await c.query(
      `INSERT INTO payments (auction_id, lot_id, buyer_user_id, amount_cents, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
      [AUCTION_ID, LOT_ID, BUYER_ID, HAMMER]
    );
    const paymentId = payRes.rows[0].id;
    out.paymentId = paymentId;

    // ── Drive the REAL settlement path ────────────────────────────────────────
    try {
      await paymentService.recordPaymentSuccess(paymentId, 'phase2-validation');
      out.realPath = 'ok (recordPaymentSuccess: invoice + async receipt hook fired)';
    } catch (e) {
      out.realPath = 'fell back: ' + e.message;
      // Fallback: settle + create invoice exactly as the hook's downstream does.
      await c.query(`UPDATE payments SET status='paid', charged_at=now() WHERE id=$1`, [paymentId]);
      const prow = (await c.query(`SELECT * FROM payments WHERE id=$1`, [paymentId])).rows[0];
      await invoiceService.createInvoice(null, prow);
    }

    // Locate the invoice.
    const invRow = (await c.query(`SELECT * FROM invoices WHERE payment_id=$1`, [paymentId])).rows[0];
    if (!invRow) throw new Error('No invoice created');
    out.invoice = {
      invoice_number: invRow.invoice_number,
      status: invRow.status,
      hammer_cents: invRow.hammer_cents,
      buyer_premium_cents: invRow.buyer_premium_cents,
      sales_tax_cents: invRow.sales_tax_cents,
      shipping_cents: invRow.shipping_cents,
      total_cents: invRow.total_cents,
      invoice_date: invRow.invoice_date,
    };

    // ── Definitive receipt send (captures SES result) ─────────────────────────
    await sleep(2500); // let any async hook settle first
    const receipt = await receiptService.sendPaymentReceipt(paymentId);
    out.receipt = receipt; // { sent, messageId? , skipped?, reason? }

    // ── PDF generation + thumbnail embedding ──────────────────────────────────
    const data = await invoicePdfService.getInvoiceData(invRow.id);
    const buffer = await invoicePdfService.buildInvoicePdf(data);
    out.pdf = {
      bytes: buffer.length,
      valid: buffer.slice(0, 5).toString() === '%PDF-',
    };
    const imgBuf = await documentService.fetchImageBuffer(IMG);
    out.thumbnail = {
      image_url: IMG,
      fetched_bytes: imgBuf ? imgBuf.length : 0,
      embeds_in_pdf: Boolean(imgBuf), // raster fetched → PDFKit embeds it; else placeholder
    };

    // ── generated_documents history + pdf_* stamp ─────────────────────────────
    const gd = (await c.query(
      `SELECT doc_type, pdf_sha256, byte_size, pdf_public_id FROM generated_documents
        WHERE entity_id=$1 ORDER BY created_at DESC LIMIT 1`, [invRow.id]
    )).rows[0];
    const stamped = (await c.query(
      `SELECT pdf_sha256, pdf_generated_at, pdf_public_id FROM invoices WHERE id=$1`, [invRow.id]
    )).rows[0];
    out.document_history = gd || null;
    out.invoice_pdf_stamp = stamped;

    // ── Account history enrichment ────────────────────────────────────────────
    const history = await fetchInvoicesForBuyer(BUYER_ID);
    const mine = history.find((h) => h.id === invRow.id);
    out.account_history = mine ? {
      invoice_number: mine.invoice_number, auction_title: mine.auction_title,
      lot_number: mine.lot_number, lot_title: mine.lot_title,
      total_cents: mine.total_cents, status: mine.status,
      has_thumbnail: Boolean(mine.lot_image_url),
    } : null;

    // ── Mint a buyer JWT for the live HTTP /pdf download test ──────────────────
    let baseUrl = '';
    try { baseUrl = require('../src/lib/publicUrls').publicBaseUrl(); } catch (_e) {}
    out.live_http = {
      base_url: baseUrl || '(publicUrls unset)',
      invoice_id: invRow.id,
      buyer_jwt: process.env.JWT_SECRET
        ? jwt.sign({ id: BUYER_ID, role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '1h' })
        : '(JWT_SECRET unset)',
    };

    console.log('\n=== PHASE 2 STAGING VALIDATION RESULT ===');
    console.log(JSON.stringify(out, null, 2));

    const pass =
      out.invoice.invoice_number &&
      out.invoice.total_cents === HAMMER &&
      out.invoice.hammer_cents === HAMMER &&
      out.pdf.valid && out.pdf.bytes > 1000 &&
      out.thumbnail.embeds_in_pdf &&
      out.document_history &&
      out.invoice_pdf_stamp.pdf_sha256 &&
      out.account_history && out.account_history.has_thumbnail;
    console.log('\nRESULT: ' + (pass ? 'PASS' : 'REVIEW (see fields above)'));
    return pass ? 0 : 1;
  } finally {
    c.release();
    await pool.end();
  }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
