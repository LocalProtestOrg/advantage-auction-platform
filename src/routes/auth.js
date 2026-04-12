const express = require('express');
const router = express.Router();
const authService = require('../services/authService');

router.post('/login', async (req, res, next) => {
  try {
    const result = await authService.authenticate(req.body);

    return res.status(200).json({
      success: true,
      token: result.token,
      user: result.user
    });
  } catch (err) {
    if (err.message === 'Invalid credentials') {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    if (err.message === 'User account is inactive') {
      return res.status(403).json({
        success: false,
        error: 'User account is inactive'
      });
    }

    next(err);
  }
});

module.exports = router;