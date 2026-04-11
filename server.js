require('dotenv').config();
const express = require('express');
const app = express();
const path = require('path');

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// JSON body parsing
app.use(express.json());

// Mount routes
const authRoutes = require(path.join(__dirname, 'src/routes/auth'));
const auctionRoutes = require(path.join(__dirname, 'src/routes/auctions'));
const paymentRoutes = require(path.join(__dirname, 'src/routes/payments'));
const adminRoutes = require(path.join(__dirname, 'src/routes/admin'));

app.use('/api/auth', authRoutes);
app.use('/api/auctions', auctionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);

// Root route
app.get('/', (req, res) => {
  res.send('API Running');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler (hardened)
app.use((err, req, res, next) => {
  console.error('ERROR:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });

  res.status(err.status || 500).json({
    error: 'Request failed',
    message: err.message || 'Internal server error'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
