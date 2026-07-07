const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/authMiddleware');
const invoicePdfService = require('../services/invoicePdfService');

async function fetchInvoicesForBuyer(buyerId) {
  try {
    const { rows } = await db.query(
      `SELECT i.id,
              i.invoice_number,
              i.invoice_date,
              i.amount_cents,
              i.hammer_cents,
              i.buyer_premium_cents,
              i.sales_tax_cents,
              i.shipping_cents,
              i.total_cents,
              i.lot_id,
              i.auction_id,
              i.created_at,
              i.status,
              l.title       AS lot_title,
              l.lot_number  AS lot_number,
              a.title       AS auction_title,
              p.status      AS payment_status,
              p.charged_at  AS payment_date,
              (SELECT image_url FROM lot_images
                WHERE lot_id = l.id
                ORDER BY sort_order ASC LIMIT 1) AS lot_image_url
         FROM invoices i
         LEFT JOIN lots     l ON l.id = i.lot_id
         LEFT JOIN auctions a ON a.id = i.auction_id
         LEFT JOIN payments p ON p.id = i.payment_id
        WHERE i.buyer_user_id = $1
        ORDER BY i.created_at DESC`,
      [buyerId]
    );
    return rows;
  } catch (err) {
    console.error('[invoices] fetchInvoicesForBuyer failed:', { buyerId, error: err.message });
    throw err;
  }
}

// GET /api/invoices/mine — the authenticated buyer's own invoices (self-scoped).
// Declared before /:buyerId so it isn't shadowed by the param route.
router.get('/mine', auth, async (req, res) => {
  try {
    const rows = await fetchInvoicesForBuyer(req.user.id);
    return res.json({ invoices: rows });
  } catch (err) {
    console.error('[invoices] GET /mine error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// GET /api/invoices/:invoiceId/pdf — stream a freshly rendered invoice PDF.
// Ownership: the invoice's buyer, or an admin. Declared before /:buyerId.
router.get('/:invoiceId/pdf', auth, async (req, res) => {
  const { invoiceId } = req.params;
  try {
    const data = await invoicePdfService.getInvoiceData(invoiceId);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    if (req.user.role !== 'admin' && req.user.id !== data.buyerUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const buffer = await invoicePdfService.buildInvoicePdf(data);
    const fileName = `invoice-${data.invoiceNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.end(buffer);
  } catch (err) {
    console.error('[invoices] GET /:invoiceId/pdf error:', err.message);
    return res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
});

// GET /api/invoices/:buyerId — admin or self
router.get('/:buyerId', auth, async (req, res) => {
  const { buyerId } = req.params;

  if (req.user.role !== 'admin' && req.user.id !== buyerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const rows = await fetchInvoicesForBuyer(buyerId);
    return res.json({ invoices: rows });
  } catch (err) {
    console.error('[invoices] GET /:buyerId error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

module.exports = { router, fetchInvoicesForBuyer };
