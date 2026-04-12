const express = require('express');
const router = express.Router();

const auctionService = require('../services/auctionService');
const authMiddleware = require('../middleware/authMiddleware');

// Helper to check if a string is a valid UUID
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// CREATE AUCTION
router.post('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      sellerProfileId,
      title,
      description,
      status,
      startTime,
      endTime
    } = req.body;

    if (!sellerProfileId || !title) {
      return res.status(400).json({
        success: false,
        message: 'sellerProfileId and title are required'
      });
    }

    const auction = await auctionService.createAuction({
      sellerProfileId,
      createdByUserId: userId,
      title,
      description,
      status,
      startTime,
      endTime
    });

    return res.status(201).json({
      success: true,
      data: auction
    });
  } catch (error) {
    console.error('Create Auction Error:', error);
    return res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to create auction',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// GET ALL AUCTIONS FOR SELLER (GET /my)
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const auctions = await auctionService.getSellerAuctions(userId);
    return res.json({
      success: true,
      data: auctions
    });
  } catch (error) {
    console.error('Get Seller Auctions Error:', error);
    return res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to fetch auctions',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// GET SINGLE AUCTION (GET /:id)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!isUuid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid auction ID'
      });
    }

    const auction = await auctionService.getAuctionById(id, userId);

    if (!auction) {
      return res.status(404).json({
        success: false,
        message: 'Auction not found'
      });
    }

    return res.json({
      success: true,
      data: auction
    });
// ...existing code...

// UPDATE AUCTION (PUT /:id)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const updates = req.body;

    if (!isUuid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid auction ID'
      });
    }

    const updated = await auctionService.updateAuction(id, userId, updates);
    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Auction not found or not owned by user'
      });
    }
    return res.json({
      success: true,
      data: updated
    });
  } catch (error) {
    console.error('Update Auction Error:', error);
    return res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to update auction',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// DELETE AUCTION (DELETE /:id)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!isUuid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid auction ID'
      });
    }

    const deleted = await auctionService.deleteAuction(id, userId);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Auction not found or not owned by user'
      });
    }
    return res.json({
      success: true,
      data: deleted
    });
  } catch (error) {
    console.error('Delete Auction Error:', error);
    return res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to delete auction',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});
  } catch (error) {
    console.error('Get Auction Error:', error);
    return res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to fetch auction',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// PATCH AUCTION
router.patch('/:auctionId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { auctionId } = req.params;

    if (!isUuid(auctionId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid auction ID'
      });
    }

    const updates = req.body;
    const updatedAuction = await auctionService.updateAuction(auctionId, userId, updates);

    if (!updatedAuction) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided or auction not found'
      });
    }

    return res.json({
      success: true,
      data: updatedAuction
    });
  } catch (error) {
    console.error('Update Auction Error:', error);
    return res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to update auction',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

module.exports = router;
console.log('🔥 AUCTIONS ROUTE FILE LOADED');






function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}


// ==================== CREATE AUCTION ====================
router.post('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      sellerProfileId,
      title,
      description,
      status,
      startTime,
      endTime,
    } = req.body;

    if (!sellerProfileId || !title) {
      return res.status(400).json({
        success: false,
        message: 'sellerProfileId and title are required',
      });
    }

    const auction = await auctionService.createAuction({
      sellerProfileId,
      createdByUserId: userId,
      title,
      description,
      status,
      startTime,
      endTime,
    });

    return res.status(201).json({
      success: true,
      data: auction,
    });

  } catch (error) {
    console.error('Create Auction Error:', error);

    return res.status(500).json({
      success: false,
      message: error.message,
      stack: error.stack,
    });
  }
});


// ==================== GET SELLER AUCTIONS ====================
router.get('/seller', authMiddleware, async (req, res) => {
  try {
    console.log('🔥 SELLER ROUTE HIT');
    console.log('🔥 req.user:', req.user);

    const userId = req.user.id;
    const auctions = await auctionService.getSellerAuctions(userId);

    return res.json({
      success: true,
      data: auctions,
    });

  } catch (error) {
    console.error('Get Seller Auctions Error:', error);

    return res.status(500).json({
      success: false,
      message: error.message,
      stack: error.stack,
    });
  }
});


// ==================== GET SINGLE AUCTION ====================
router.get('/:auctionId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { auctionId } = req.params;

    console.log('🔥 SINGLE AUCTION ROUTE HIT');
    console.log('🔥 auctionId param:', auctionId);

    if (!isUuid(auctionId)) {
      return res.status(404).json({
        success: false,
        message: 'Auction not found',
      });
    }

    if (typeof auctionService.getAuctionById !== 'function') {
      return res.status(500).json({
        success: false,
        message: 'auctionService.getAuctionById is not a function',
      });
    }

    const auction = await auctionService.getAuctionById(auctionId, userId);

    if (!auction) {
      return res.status(404).json({
        success: false,
        message: 'Auction not found',
      });
    }

    return res.json({
      success: true,
      data: auction,
    });

  } catch (error) {
    console.error('Get Auction Error:', error);

    return res.status(500).json({
      success: false,
      message: error.message,
      stack: error.stack,
    });
  }
});


// ==================== UPDATE AUCTION ====================
router.patch('/:auctionId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { auctionId } = req.params;

    if (!isUuid(auctionId)) {
      return res.status(404).json({
        success: false,
        message: 'Auction not found',
      });
    }

    const updates = req.body;

    const updatedAuction = await auctionService.updateAuction(
      auctionId,
      userId,
      updates
    );

    if (!updatedAuction) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided or auction not found',
      });
    }

    return res.json({
      success: true,
      data: updatedAuction,
    });

  } catch (error) {
    console.error('Update Auction Error:', error);

    return res.status(500).json({
      success: false,
      message: error.message,
      stack: error.stack,
    });
  }
});

module.exports = router;