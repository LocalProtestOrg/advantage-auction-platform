const express = require('express');
const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  // TODO: implement authentication
  res.status(501).json({ message: 'Not implemented' });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
