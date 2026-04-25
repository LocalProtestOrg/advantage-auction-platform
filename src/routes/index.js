// Route index with global middleware integration
const express = require('express');
const router = express.Router();

// Middleware
const logger = require('../middleware/logger');
const errorHandler = require('../middleware/errorHandler');
const { strictLimiter, normalLimiter } = require('../middleware/rateLimit');

router.use(logger);

// Normal traffic limiter
router.use(normalLimiter);

// Critical routes stricter limiter
router.use('/payments', strictLimiter);
router.use('/auctions/:auctionId/bid', strictLimiter);

// Mount route modules
router.use('/auth', require('./auth'));
router.use('/auctions', require('./auctions'));
router.use('/payments', require('./payments'));
router.use('/admin', require('./admin'));
router.use('/marketing', require('./marketing'));

// Centralized error handler (should be last)
router.use(errorHandler);

module.exports = router;
