const express = require('express');
const router = express.Router();
const bidService = require('../services/bidService');
const auth = require('../middleware/authMiddleware');

// POST /api/lots/:lotId/bids
router.post('/:lotId/bids', auth, async (req, res) => {
  try {
    const { lotId } = req.params;
    const { amount, maxBid } = req.body;

    const userId = req.user.id;

    const result = await bidService.createBid(lotId, userId, { amount, maxBid });

    return res.json({
      success: true,
      data: result
    });

  } catch (err) {
    console.error(err);
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
});

// GET /api/lots/:lotId/bids
router.get('/lots/:lotId/bids', auth, async (req, res) => {
  try {
    const bids = await bidService.getBidsByLot(req.params.lotId);
    res.json({ success: true, data: bids });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
