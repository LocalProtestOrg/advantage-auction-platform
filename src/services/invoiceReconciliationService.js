'use strict';

/**
 * invoiceReconciliationService — Phase 2D. Admin-only invoice integrity check +
 * SAFE repair for a closed auction.
 *
 * checkAuction(auctionId)  — READ-ONLY. Returns categorized issues + summary.
 * repairAuction(auctionId) — applies only SAFE fixes:
 *   - issue missing invoices for winners (idempotent; invoice generation only)
 *   - regenerate missing PDFs
 *   - promote an invoice to 'paid' ONLY when a real paid payment row exists
 * It NEVER creates payments and NEVER marks paid without payment evidence.
 * Duplicates are reported but never auto-deleted (manual review).
 */

const db = require('../db');

async function checkAuction(auctionId) {
  const a = (await db.query('SELECT id, title, state FROM auctions WHERE id = $1', [auctionId])).rows[0];
  if (!a) return null;

  const q = (sql) => db.query(sql, [auctionId]).then((r) => r.rows);

  const [
    winningLotsNoInvoice,
    duplicates,
    paidPaymentInvoiceNotPaid,
    paidPaymentNoInvoice,
    missingBuyer,
    missingLot,
    missingNumber,
    pdfMissing,
  ] = await Promise.all([
    q(`SELECT l.id AS lot_id, l.winning_buyer_user_id AS buyer_user_id, l.winning_amount_cents
         FROM lots l
         LEFT JOIN invoices i ON i.lot_id = l.id AND i.buyer_user_id = l.winning_buyer_user_id
        WHERE l.auction_id = $1 AND l.state = 'closed'
          AND l.winning_buyer_user_id IS NOT NULL AND l.winning_amount_cents IS NOT NULL
          AND i.id IS NULL`),
    q(`SELECT lot_id, buyer_user_id, count(*)::int AS n
         FROM invoices WHERE auction_id = $1
        GROUP BY lot_id, buyer_user_id HAVING count(*) > 1`),
    q(`SELECT p.id AS payment_id, i.id AS invoice_id, i.invoice_number, i.status
         FROM payments p
         JOIN invoices i ON i.lot_id = p.lot_id AND i.buyer_user_id = p.buyer_user_id
        WHERE p.auction_id = $1 AND p.status = 'paid' AND i.status <> 'paid'`),
    q(`SELECT p.id AS payment_id, p.lot_id, p.buyer_user_id
         FROM payments p
         LEFT JOIN invoices i ON i.lot_id = p.lot_id AND i.buyer_user_id = p.buyer_user_id
        WHERE p.auction_id = $1 AND p.status = 'paid' AND i.id IS NULL`),
    q(`SELECT i.id, i.invoice_number FROM invoices i
         LEFT JOIN users u ON u.id = i.buyer_user_id
        WHERE i.auction_id = $1 AND (i.buyer_user_id IS NULL OR u.id IS NULL)`),
    q(`SELECT i.id, i.invoice_number FROM invoices i
         LEFT JOIN lots l ON l.id = i.lot_id
        WHERE i.auction_id = $1 AND (i.lot_id IS NULL OR l.id IS NULL)`),
    q(`SELECT id FROM invoices WHERE auction_id = $1 AND (invoice_number IS NULL OR invoice_number = '')`),
    q(`SELECT id, invoice_number FROM invoices WHERE auction_id = $1 AND pdf_generated_at IS NULL`),
  ]);

  const issues = {
    winning_lots_without_invoice: winningLotsNoInvoice,
    duplicate_invoices: duplicates,
    paid_payment_invoice_not_paid: paidPaymentInvoiceNotPaid,
    paid_payment_without_invoice: paidPaymentNoInvoice,
    invoices_missing_buyer: missingBuyer,
    invoices_missing_lot: missingLot,
    invoices_missing_number: missingNumber,
    invoices_pdf_not_generated: pdfMissing,
  };
  const counts = Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, v.length]));
  const clean = Object.values(counts).every((n) => n === 0);

  // Repairable-by-safe-repair categories (duplicates/missing-buyer/missing-lot are
  // data anomalies requiring manual review, not auto-fixed).
  const safelyRepairable =
    counts.winning_lots_without_invoice + counts.paid_payment_invoice_not_paid +
    counts.paid_payment_without_invoice + counts.invoices_pdf_not_generated;

  return {
    auction_id: auctionId,
    auction_title: a.title,
    auction_state: a.state,
    clean,
    counts,
    safely_repairable: safelyRepairable,
    needs_manual_review:
      counts.duplicate_invoices + counts.invoices_missing_buyer +
      counts.invoices_missing_lot + counts.invoices_missing_number,
    issues,
  };
}

async function repairAuction(auctionId) {
  const invoiceService = require('./invoiceService');
  const invoicePdfService = require('./invoicePdfService');
  const before = await checkAuction(auctionId);
  if (!before) return null;

  const done = { issued: 0, promoted: 0, pdfs_regenerated: 0, skipped_manual_review: 0, errors: [] };

  // 1) Issue missing invoices for winners (invoice generation only; no charge, no email here).
  try {
    const res = await invoiceService.issueInvoicesForAuctionWinners(auctionId);
    done.issued = res.createdIds.length;
  } catch (e) { done.errors.push('issue: ' + e.message); }

  // 2) Promote to paid ONLY where a real paid payment exists.
  //    a) invoice exists but not paid → link the paid payment + set 'paid'
  for (const row of before.issues.paid_payment_invoice_not_paid) {
    try {
      await db.query(
        `UPDATE invoices SET status = 'paid', payment_id = $1 WHERE id = $2 AND status <> 'paid'`,
        [row.payment_id, row.invoice_id]
      );
      done.promoted++;
    } catch (e) { done.errors.push('promote(' + row.invoice_id + '): ' + e.message); }
  }
  //    b) paid payment but no invoice → upsert a paid invoice from the real payment row
  for (const row of before.issues.paid_payment_without_invoice) {
    try {
      const pay = (await db.query('SELECT * FROM payments WHERE id = $1', [row.payment_id])).rows[0];
      if (pay && pay.status === 'paid') { await invoiceService.createInvoice(null, pay); done.promoted++; }
    } catch (e) { done.errors.push('promote-create(' + row.payment_id + '): ' + e.message); }
  }

  // 3) Regenerate missing PDFs (re-read after issue/promote so newly-created rows are included).
  const post = await checkAuction(auctionId);
  for (const inv of post.issues.invoices_pdf_not_generated) {
    try { await invoicePdfService.generateAndStoreInvoicePdf(inv.id); done.pdfs_regenerated++; }
    catch (e) { done.errors.push('pdf(' + inv.id + '): ' + e.message); }
  }

  done.skipped_manual_review = before.needs_manual_review;
  const after = await checkAuction(auctionId);
  return { auction_id: auctionId, repaired: done, before: before.counts, after: after.counts, clean_after: after.clean };
}

module.exports = { checkAuction, repairAuction };
