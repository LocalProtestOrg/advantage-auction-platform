console.log("LOTS ROUTES LOADED");

const express = require('express');
const router = express.Router();
const lotService = require('../services/lotService');
const auth = require('../middleware/authMiddleware');
const authMiddleware = require('../middleware/authMiddleware');
const { createBid } = require('../services/bidService');

router.post('/:lotId/bids', authMiddleware, async (req, res) => {
  try {
    const { lotId } = req.params;
    const { amount, maxBid } = req.body;

    const userId = req.user.id;

    const result = await createBid(lotId, userId, { amount, maxBid });

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

// Create lot
router.post('/auctions/:auctionId/lots', auth, async (req, res) => {
  try {
    const lot = await lotService.createLot(
      req.params.auctionId,
      req.user.id,
      req.body
    );

    res.status(201).json({ success: true, data: lot });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Get lots for auction
router.get('/auctions/:auctionId/lots', auth, async (req, res) => {
  try {
    const lots = await lotService.getLotsByAuction(req.params.auctionId);
    res.json({ success: true, data: lots });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get one lot
router.get('/lots/:id', auth, async (req, res) => {
  const lot = await lotService.getLotById(req.params.id);

  if (!lot) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  res.json({ success: true, data: lot });
});

// Update
router.put('/lots/:id', auth, async (req, res) => {
  try {
    const lot = await lotService.updateLot(
      req.params.id,
      req.user.id,
      req.body
    );

    res.json({ success: true, data: lot });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Delete
router.delete('/lots/:id', auth, async (req, res) => {
  try {
    await lotService.deleteLot(req.params.id, req.user.id);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
