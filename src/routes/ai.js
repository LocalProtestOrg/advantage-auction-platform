const express = require('express');
const router = express.Router();
const { generateDescriptionFromImage } = require('../services/aiDescriptionService');

// POST /api/ai/generate-description
router.post('/generate-description', async (req, res, next) => {
  const { imageUrl } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ success: false, message: 'imageUrl is required' });
  }
  try {
    const result = await generateDescriptionFromImage(imageUrl);
    return res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
