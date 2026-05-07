'use strict';

const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const imageProcessingService = require('../services/imageProcessingService');

// POST /api/image-processing/jobs
// Creates a new image processing job.
// Body: { originalImageUrl, enhancementType, lotTempId? }
router.post('/jobs', auth, async (req, res, next) => {
  try {
    const { originalImageUrl, enhancementType, lotTempId } = req.body || {};

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
// Returns a single job by ID.
router.get('/jobs/:id', auth, async (req, res, next) => {
  try {
    const job = await imageProcessingService.getJobById(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    return res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
