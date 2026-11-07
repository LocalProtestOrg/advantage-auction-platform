// #21 Terms & Conditions routes.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const termsService = require('../services/termsService');

// GET /api/terms/current — public. Returns the current buyer terms version.
router.get('/current', async (req, res) => {
  try {
    const current = await termsService.getCurrentTerms();
    if (!current) return res.status(404).json({ success: false, message: 'No current terms configured' });
    return res.json({ success: true, data: current });
  } catch (err) {
    console.error('[terms] current failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load terms' });
  }
});

// GET /api/terms/me/acceptance — auth. Whether the user has accepted current terms.
router.get('/me/acceptance', auth, async (req, res) => {
  try {
    const [accepted, current] = await Promise.all([
      termsService.hasAcceptedCurrentTerms(req.user.id),
      termsService.getCurrentTerms(),
    ]);
    return res.json({
      success: true,
      data: { accepted_current: accepted, current_version_int: current ? current.version_int : null },
    });
  } catch (err) {
    console.error('[terms] acceptance status failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to check acceptance' });
  }
});

// POST /api/terms/accept — auth. Accept the current terms (idempotent). The page sends the version it displayed
// (version_int); if the current version changed since, nothing is recorded and 409 TERMS_CHANGED asks for a fresh review.
router.post('/accept', auth, async (req, res) => {
  try {
    const { ip, userAgent } = termsService.requestEvidence(req);
    const body = req.body || {};
    const result = await termsService.acceptCurrentTerms(req.user.id, { ip, userAgent, expectedVersionInt: body.version_int, source: 'terms_page' });
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.code === 'NO_CURRENT_TERMS') {
      return res.status(409).json({ success: false, message: 'No current terms configured' });
    }
    if (err.code === 'TERMS_CHANGED') return res.status(409).json({ success: false, code: err.code, message: err.message });
    console.error('[terms] accept failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to record acceptance' });
  }
});

module.exports = router;
