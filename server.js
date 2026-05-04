require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./src/db');
const authMiddleware = require('./src/middleware/authMiddleware');

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
  console.log(`[ws] connected: ${socket.id}`);

  socket.on('joinAuction', (auctionId) => {
    socket.join(`auction:${auctionId}`);
    console.log(`[ws] ${socket.id} joined auction:${auctionId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[ws] disconnected: ${socket.id}`);
  });
});

// ── HTTP middleware ───────────────────────────────────────────────────────────

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_URL);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.options('/{*path}', (req, res) => {
  res.sendStatus(200);
});

// Logging
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

// GET /api/auctions/:id — shape expected by frontend
// UUID-format IDs are served from app_auctions; anything else falls through to auctionRoutes
app.get('/api/auctions/:id', async (req, res, next) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(req.params.id)) {
    return next();
  }
  try {
    const { rows } = await db.query(
      'SELECT id, title, current_price, end_time, current_winner_id FROM app_auctions WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Auction not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/bids?lot_id=<auction_uuid>
app.get('/api/bids', async (req, res) => {
  const { lot_id } = req.query;
  if (!lot_id) return res.json([]);
  try {
    const { rows } = await db.query(
      `SELECT id, auction_id AS lot_id, user_id,
              amount_cents, (amount_cents::numeric / 100) AS amount, created_at
       FROM app_bids WHERE auction_id = $1 ORDER BY created_at DESC`,
      [lot_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bids — place a bid (requires auth); emits real-time update
app.post('/api/bids', authMiddleware, async (req, res) => {
  const { lot_id, amount_cents } = req.body || {};
  if (!lot_id || !amount_cents) {
    return res.status(400).json({ error: 'lot_id and amount_cents required' });
  }
  try {
    const { rows } = await db.query(
      'INSERT INTO app_bids (auction_id, user_id, amount_cents) VALUES ($1, $2, $3) RETURNING *',
      [lot_id, req.user.id, amount_cents]
    );
    const bid = rows[0];

    await db.query(
      'UPDATE app_auctions SET current_price = $1, current_winner_id = $2 WHERE id = $3',
      [amount_cents / 100, req.user.id, lot_id]
    );

    const current_price = amount_cents / 100;
    const current_winner_id = req.user.id;

    const bidPayload = {
      id: bid.id,
      lot_id: bid.auction_id,
      user_id: bid.user_id,
      amount_cents: bid.amount_cents,
      amount: current_price,
      created_at: bid.created_at,
    };

    io.to(`auction:${lot_id}`).emit('bidUpdate', {
      auction_id: lot_id,
      current_price,
      current_winner_id,
      bid: bidPayload,
    });

    res.json({ success: true, bid: bidPayload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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

// Root
app.get('/', (req, res) => res.send('API Running'));

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
  console.log(`Server running on port ${PORT}`);
});
