const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const db = require('../db');

// GET /api/sellers/me
// Returns the seller profile for the authenticated user.
router.get('/me', auth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, user_id FROM seller_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: 'Seller profile not found' });
    }
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
