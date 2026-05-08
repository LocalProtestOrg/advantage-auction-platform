require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const db   = require('./src/db');
const authMiddleware = require('./src/middleware/authMiddleware');
const logger = require('./src/middleware/logger');
const log  = require('./src/lib/logger');

// ── Startup: env validation ───────────────────────────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL'];
const WARN_ENV     = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'];

const missingRequired = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingRequired.length) {
  console.error(`[startup] FATAL — missing required env vars: ${missingRequired.join(', ')}`);
  process.exit(1);
}
const missingWarn = WARN_ENV.filter(k => !process.env[k]);
if (missingWarn.length) {
  log.warn('startup', 'missing optional env vars — some features may be unavailable', { missing: missingWarn });
}

const stripeMode = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'TEST'
  : process.env.STRIPE_SECRET_KEY ? 'LIVE' : 'NOT_SET';
log.info('startup', 'Advantage Auction Platform', {
  env:    process.env.NODE_ENV || 'development',
  db:     process.env.DATABASE_URL?.includes('neon') ? 'NEON' : 'LOCAL',
  stripe: stripeMode,
});

const app = express();
const server = http.createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST'],
  },
});

// ── Socket.IO — auction rooms ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('joinAuction', (auctionId) => {
    socket.join(`auction:${auctionId}`);
  });
});

// ── HTTP middleware ───────────────────────────────────────────────────────────

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.options('/{*path}', (req, res) => {
  res.sendStatus(200);
});

// Static frontend — must be before routes and 404 handler
app.use(express.static(path.join(__dirname, 'public')));

// Logging — logs method, path, status, duration on response finish
app.use(logger);

// JSON body parsing — skip the Stripe webhook path so it receives the raw buffer
// required for signature verification.
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhook') return next();
  express.json()(req, res, next);
});

// ── Route imports ─────────────────────────────────────────────────────────────
const authRoutes = require(path.join(__dirname, 'src/routes/auth'));
const auctionRoutes = require(path.join(__dirname, 'src/routes/auctions'));
const paymentRoutes = require(path.join(__dirname, 'src/routes/payments'));
const adminRoutes = require(path.join(__dirname, 'src/routes/admin'));
const lotRoutes = require('./src/routes/lots');
const bidsRoutes = require('./src/routes/bids');
const marketingRoutes = require('./src/routes/marketing');
const payoutPreferencesRoutes = require('./src/routes/payoutPreferences');
const aiRoutes = require('./src/routes/ai');
const sellersRoutes = require('./src/routes/sellers');
const watchlistRoutes = require('./src/routes/watchlist');
const { router: invoicesRoutes, fetchInvoicesForBuyer } = require('./src/routes/invoices');
const marketingReportsRoutes    = require('./src/routes/marketingReports');
const imageProcessingRoutes     = require('./src/routes/imageProcessing');
const uploadsRoutes             = require('./src/routes/uploads');

// ── Database-backed routes (frontend API shape) ───────────────────────────────

// DEV-only: reset a test auction's state between E2E test runs
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/test/reset-auction', async (req, res) => {
    const { auction_id } = req.body || {};
    if (!auction_id) return res.status(400).json({ error: 'auction_id required' });
    try {
      await db.query('DELETE FROM app_bids WHERE auction_id = $1', [auction_id]);
      await db.query(
        'UPDATE app_auctions SET current_price = 100.00, current_winner_id = NULL WHERE id = $1',
        [auction_id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}


// ── Production route mounts ───────────────────────────────────────────────────
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
app.use('/api/invoices', invoicesRoutes);
app.use('/api/seller/marketing-report', marketingReportsRoutes);
app.use('/api/image-processing', imageProcessingRoutes);
app.use('/api/uploads', uploadsRoutes);

// Root
app.get('/', (req, res) => res.send('API Running'));

// ✅ Force serve payment page (MUST be before 404)
app.get('/payment.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

// GET /api/me/invoices — buyer dashboard
app.get('/api/me/invoices', authMiddleware, async (req, res) => {
  try {
    const rows = await fetchInvoicesForBuyer(req.user.id);
    return res.json({ invoices: rows });
  } catch (err) {
    console.error('[invoices] GET /api/me/invoices error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  let dbReachable = false;
  try { await db.query('SELECT 1'); dbReachable = true; } catch { /* db down */ }

  const healthy = dbReachable;
  const stripeMode = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test'
    : process.env.STRIPE_SECRET_KEY ? 'live' : 'not_set';

  return res.status(healthy ? 200 : 503).json({
    status:            healthy ? 'ok' : 'degraded',
    env:               process.env.NODE_ENV || 'development',
    uptime_seconds:    Math.floor(process.uptime()),
    started_at:        log.startedAt,
    db_reachable:      dbReachable,
    stripe_configured: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY),
    stripe_mode:       stripeMode,
    email_configured:  !!(process.env.SMTP_HOST && process.env.SMTP_USER),
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
    return res.status(err.status || 500).json({ error: err.message, stack: err.stack });
  }
  console.error(err.message);
  return res.status(err.status || 500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  log.info('startup', `server listening on port ${PORT}`);
});
