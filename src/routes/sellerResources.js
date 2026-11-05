'use strict';

/**
 * Seller How To Center downloads (Professional Sellers and administrators only). Access is enforced BEFORE this router
 * by src/middleware/sellerResourceGate.js (mounted ahead of every route and static file); this router only builds the
 * file. GET /api/seller-resources/lot-labels.pdf?from&to&seller&auction&web=0|1&plain=0|1&mode=calibrate
 * Made from the query; nothing is stored. Moved from /api/public/printables (owner decision 2026-11-05).
 */
const express = require('express');
const { normalLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.get('/lot-labels.pdf', normalLimiter, (req, res, next) => {
  try {
    const q = {};
    for (const k of ['from', 'to', 'seller', 'auction', 'web', 'plain', 'mode']) if (typeof req.query[k] === 'string') q[k] = req.query[k];
    const L = require('../../public/js/lot-label-layout');
    const o = L.normalize(q);
    const name = q.mode === 'calibrate' ? 'advantage-bid-label-calibration.pdf' : `advantage-bid-lot-labels-${o.from}-${o.to}.pdf`;
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
    require('../services/lotLabelPdfService').render(q, res);
  } catch (e) { next(e); }
});

module.exports = router;
