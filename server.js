require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// JSON body parsing — skip the Stripe webhook path so it receives the raw buffer
// required for signature verification.
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhook') return next();
  express.json()(req, res, next);
});

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Mount routes
const authRoutes = require(path.join(__dirname, 'src/routes/auth'));
const auctionRoutes = require(path.join(__dirname, 'src/routes/auctions'));
const paymentRoutes = require(path.join(__dirname, 'src/routes/payments'));
const adminRoutes = require(path.join(__dirname, 'src/routes/admin'));


const lotRoutes = require('./src/routes/lots');
const bidsRoutes = require('./src/routes/bids');
const marketingRoutes = require('./src/routes/marketing');
const payoutPreferencesRoutes = require('./src/routes/payoutPreferences');
const aiRoutes = require('./src/routes/ai');
const sellersRoutes   = require('./src/routes/sellers');
const watchlistRoutes = require('./src/routes/watchlist');

app.use('/api/auth', authRoutes);
app.use('/api/auctions', auctionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/lots', lotRoutes);
app.use('/api', bidsRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/payout-preferences', payoutPreferencesRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/sellers', sellersRoutes);
app.use('/api/watchlist', watchlistRoutes);

// Root route
app.get('/', (req, res) => {
  res.send('API Running');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
    return res.status(err.status || 500).json({
      error: err.message,
      stack: err.stack
    });
  }

  console.error(err.message);

  return res.status(err.status || 500).json({
    error: 'Internal server error'
  });
});

const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});