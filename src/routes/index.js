// Route index skeleton
// Intentionally minimal: wire routes here in real app bootstrap.

const express = require('express');
const router = express.Router();

// Mount route modules (implementations are skeletons)
router.use('/auth', require('./auth'));
router.use('/auctions', require('./auctions'));
router.use('/payments', require('./payments'));
router.use('/admin', require('./admin'));

module.exports = router;
