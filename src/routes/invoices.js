const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/authMiddleware');

async function fetchInvoicesForBuyer(buyerId) {
  try {
    const { rows } = await db.query(
      `SELECT i.id,
              i.amount_cents,
              i.lot_id,
              i.created_at,
              i.status,
              l.title AS lot_title,
              (SELECT image_url FROM lot_images
                WHERE lot_id = l.id
                ORDER BY sort_order ASC LIMIT 1) AS lot_image_url
         FROM invoices i
         LEFT JOIN lots l ON l.id = i.lot_id
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
