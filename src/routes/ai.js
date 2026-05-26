const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const { generateDescriptionFromImage, AIUnavailableError } = require('../services/aiDescriptionService');

// POST /api/ai/generate-description
router.post('/generate-description', auth, role(['seller', 'admin']), async (req, res, next) => {
  const { imageUrl } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ success: false, message: 'imageUrl is required' });
  }
  try {
    const result = await generateDescriptionFromImage(imageUrl);
    return res.json({ success: true, data: result });
  } catch (err) {
    // Surface "AI provider unavailable" conditions as a truthful 503 so the
    // frontend's error UI can display the real reason. Previously, any
    // failure (missing API key, provider error, parse error) silently
    // substituted a random pre-canned sample, which on 2026-05-26 caused
    // an operator to think the AI had hallucinated when in fact no AI ran.
    if (err instanceof AIUnavailableError) {
      return res.status(503).json({ success: false, message: 'AI description service unavailable: ' + err.message });
    }
    next(err);
  }
});

module.exports = router;
