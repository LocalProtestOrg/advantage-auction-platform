'use strict';

const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const role    = require('../middleware/roleMiddleware');
const db      = require('../db');
const imageProcessingService = require('../services/imageProcessingService');

/**
 * A processing job's lotTempId links its result to a lot's public image (lots.js reads the newest job for a lot) or to
 * an auction (the dashboard sends the auction id). Only that lot's / auction's own seller, or an admin, may create or
 * read jobs for it; a job linked to nothing has no public effect (security audit 2026-10-15: any user could replace
 * another seller's public lot photo and run processing on the platform's account).
 */
async function ownsTarget(user, targetId) {
  if (!targetId) return true;
  if (user.role === 'admin') return true;
  const { rows } = await db.query(
    `SELECT 1 FROM seller_profiles sp JOIN auctions a ON a.seller_id = sp.id
       LEFT JOIN lots l ON l.auction_id = a.id
      WHERE sp.user_id = $1 AND (a.id::text = $2 OR l.id::text = $2) LIMIT 1`,
    [user.id, String(targetId)]
  );
  return rows.length > 0;
}

// POST /api/image-processing/jobs
// Creates a new image processing job.
// Body: { originalImageUrl, enhancementType, lotTempId? }
router.post('/jobs', auth, role(['seller', 'admin']), async (req, res, next) => {
  try {
    const { originalImageUrl, enhancementType, lotTempId } = req.body || {};
    if (!(await ownsTarget(req.user, lotTempId))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const job = await imageProcessingService.createProcessingJob({
      lotTempId,
      originalImageUrl,
      enhancementType,
    });

    return res.status(201).json({ success: true, data: job });
  } catch (err) {
    if (
      err.message === 'originalImageUrl is required' ||
      err.message === 'enhancementType is required' ||
      err.message.startsWith('Invalid enhancementType')
    ) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// GET /api/image-processing/jobs/:id
// Returns a single job by ID (only to the owner of the lot/auction it is linked to, or an admin).
router.get('/jobs/:id', auth, role(['seller', 'admin']), async (req, res, next) => {
  try {
    const job = await imageProcessingService.getJobById(req.params.id);
    if (!job || !(await ownsTarget(req.user, job.lot_temp_id))) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    return res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
