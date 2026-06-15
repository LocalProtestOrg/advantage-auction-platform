require('dotenv').config();
const Sentry     = require('@sentry/node');
const express    = require('express');
const path       = require('path');
const http       = require('http');
const { fork }   = require('child_process');
const { Server } = require('socket.io');
const helmet     = require('helmet');
const db   = require('./src/db');
const authMiddleware = require('./src/middleware/authMiddleware');
const logger = require('./src/middleware/logger');
const log  = require('./src/lib/logger');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn:         process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
  });
  log.info('startup', 'Sentry initialized');
}

// ── Process-level error handlers — must be first ──────────────────────────────
// Catches unhandled async rejections and synchronous exceptions that escape all
// try/catch blocks. Logs structured context then exits so the process manager
// (or cloud platform) can restart cleanly rather than running in a broken state.
process.on('unhandledRejection', (reason) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  log.error('process', 'Unhandled promise rejection — exiting', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack:  reason instanceof Error ? reason.stack    : undefined,
  });
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  log.error('process', 'Uncaught exception — exiting', {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

// ── Startup: env validation ───────────────────────────────────────────────────
const REQUIRED_ENV  = ['JWT_SECRET', 'DATABASE_URL'];
// Stripe is required in production — the platform cannot accept payments without it.
const STRIPE_ENV    = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'];
const WARN_ONLY_ENV = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

const missingRequired = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingRequired.length) {
  console.error(`[startup] FATAL — missing required env vars: ${missingRequired.join(', ')}`);
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  const missingStripe = STRIPE_ENV.filter(k => !process.env[k]);
  if (missingStripe.length) {
    console.error(`[startup] FATAL — missing Stripe env vars in production: ${missingStripe.join(', ')}`);
    process.exit(1);
  }
} else {
  const missingStripe = STRIPE_ENV.filter(k => !process.env[k]);
  if (missingStripe.length) {
    log.warn('startup', 'Stripe not fully configured — payment features unavailable', { missing: missingStripe });
  }
}

const missingWarn = WARN_ONLY_ENV.filter(k => !process.env[k]);
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
app.set('trust proxy', 1); // Railway sits behind a proxy; req.ip must use X-Forwarded-For
const server = http.createServer(app);

// Allowed origins for CORS + socket.io. FRONTEND_URL may be a comma-separated
// list (e.g. the Railway URL AND https://bid.advantage.bid during cutover).
const { allowedOrigins, isOriginAllowed } = require('./src/lib/publicUrls');
const ALLOWED_ORIGINS = allowedOrigins();
const PRIMARY_ORIGIN  = ALLOWED_ORIGINS[0];

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,   // socket.io accepts an array of allowed origins
    methods: ['GET', 'POST'],
  },
});
// Share the io instance with route handlers (req.app.get('io')).
app.set('io', io);

// ── Socket.IO — auction rooms + per-user rooms (#1 real-time) ──────────────────
const jwt = require('jsonwebtoken');
io.on('connection', (socket) => {
  // Optional auth: a valid token joins the socket to its private user room so it
  // can receive targeted, privacy-safe winning/outbid signals. Anonymous sockets
  // still receive the public lot:update broadcasts.
  try {
    const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
    if (token && process.env.JWT_SECRET) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded && decoded.id) socket.join(`user:${decoded.id}`);
    }
  } catch (_) { /* invalid/expired token → anonymous socket */ }

  socket.on('joinAuction', (auctionId) => {
    if (typeof auctionId === 'string' && auctionId) socket.join(`auction:${auctionId}`);
  });
});

// ── HTTP middleware ───────────────────────────────────────────────────────────

// Security headers — helmet adds X-Frame-Options, X-Content-Type-Options,
// Strict-Transport-Security, Referrer-Policy, etc. CSP is disabled because the
// HTML pages use inline <script> blocks; it can be enabled with nonces later.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS
// Public discovery endpoints and widget assets are designed for cross-origin consumption by BD.
app.use((req, res, next) => {
  const isPublicDiscovery = req.path.startsWith('/api/public/')
    || req.path.startsWith('/widgets/')
    || req.path === '/marketplace.css'
    || req.path === '/marketplace-components.js';
  const reqOrigin = req.headers.origin;
  if (isPublicDiscovery) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (reqOrigin && isOriginAllowed(reqOrigin)) {
    // Echo the matching allowed origin (supports the multi-origin cutover window).
    res.header('Access-Control-Allow-Origin', reqOrigin);
    res.header('Vary', 'Origin');
  } else {
    res.header('Access-Control-Allow-Origin', PRIMARY_ORIGIN);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (isPublicDiscovery) {
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  }
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
const termsRoutes = require('./src/routes/terms');
// bidsRoutes intentionally removed 2026-05-28: its POST mounted at the
// unreachable path /api/:lotId/bids (missing /lots/ prefix) and its GET
// was shadowed by an identical handler in lots.js. src/routes/bids.js
// remains as orphaned source for a future housekeeping pass.
const marketingRoutes = require('./src/routes/marketing');
const payoutPreferencesRoutes = require('./src/routes/payoutPreferences');
const aiRoutes = require('./src/routes/ai');
const sellersRoutes = require('./src/routes/sellers');
const watchlistRoutes = require('./src/routes/watchlist');
const { router: invoicesRoutes, fetchInvoicesForBuyer } = require('./src/routes/invoices');
const marketingReportsRoutes    = require('./src/routes/marketingReports');
const imageProcessingRoutes     = require('./src/routes/imageProcessing');
const uploadsRoutes             = require('./src/routes/uploads');
const publicRoutes              = require('./src/routes/public');
const analyticsRoutes           = require('./src/routes/analytics');
const adminAgreementsRoutes     = require('./src/routes/adminAgreements');
const adminBuyersRoutes         = require('./src/routes/adminBuyers');
const adminUsersRoutes          = require('./src/routes/adminUsers');
const agreementsRoutes          = require('./src/routes/agreements');

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
app.use('/api/admin/agreements', adminAgreementsRoutes);
app.use('/api/admin/buyers', adminBuyersRoutes);
app.use('/api/admin/users', adminUsersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/agreements', agreementsRoutes);
app.use('/api/lots', lotRoutes);
app.use('/api/terms', termsRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/payout-preferences', payoutPreferencesRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/sellers', sellersRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/seller/marketing-report', marketingReportsRoutes);
app.use('/api/image-processing', imageProcessingRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/analytics', analyticsRoutes);

// Root — serve demo page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

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
// Each reconciliation query is wrapped in its own try/catch so a DB hiccup
// on any single query never breaks the health endpoint. The reconciliation
// fields are informational only — they DO NOT affect the response status code.
async function _safeQueryScalar(sql, fallback = null) {
  try {
    const { rows } = await db.query(sql);
    return rows[0] ? Object.values(rows[0])[0] : fallback;
  } catch {
    return fallback;
  }
}

app.get('/api/health', async (req, res) => {
  let dbReachable = false;
  try { await db.query('SELECT 1'); dbReachable = true; } catch { /* db down */ }

  const healthy = dbReachable;
  const stripeMode = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test'
    : process.env.STRIPE_SECRET_KEY ? 'live' : 'not_set';

  // Reconciliation surface (R-2). Read-only; nulls on query failure.
  // Only attempted when the DB is reachable; otherwise reported as null.
  let reconciliation = {
    last_webhook_received_at:       null,
    last_webhook_processed_at:      null,
    webhook_failed_count_1h:        null,
    payments_orphaned_intent_count: null,
  };
  if (dbReachable) {
    const [lastRecv, lastProc, failed1h, orphans] = await Promise.all([
      _safeQueryScalar(`SELECT MAX(received_at) FROM stripe_webhook_events`),
      _safeQueryScalar(`SELECT MAX(processed_at) FROM stripe_webhook_events WHERE status = 'processed'`),
      _safeQueryScalar(`SELECT COUNT(*)::int FROM stripe_webhook_events WHERE status = 'failed' AND received_at > now() - interval '1 hour'`, null),
      _safeQueryScalar(`SELECT COUNT(*)::int FROM payments WHERE payment_intent_id IS NULL AND status = 'pending' AND created_at < now() - interval '5 minutes'`, null),
    ]);
    reconciliation = {
      last_webhook_received_at:       lastRecv,
      last_webhook_processed_at:      lastProc,
      webhook_failed_count_1h:        failed1h,
      payments_orphaned_intent_count: orphans,
    };
  }

  return res.status(healthy ? 200 : 503).json({
    status:            healthy ? 'ok' : 'degraded',
    env:               process.env.NODE_ENV || 'development',
    uptime_seconds:    Math.floor(process.uptime()),
    started_at:        log.startedAt,
    db_reachable:      dbReachable,
    stripe_configured: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY),
    stripe_mode:       stripeMode,
    email_configured:  !!(process.env.SMTP_HOST && process.env.SMTP_USER),
    reconciliation,
  });
});

// Sentry error handler — must be before the 404 and generic error handlers
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

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

// ── Worker processes ──────────────────────────────────────────────────────────
// Workers are forked as child processes so their event loops are isolated from
// the HTTP server. AAP_IS_WORKER=1 is set in the child env to prevent any
// accidental recursive spawn if this file is ever loaded in a worker context.

const activeWorkers = new Map();  // workerPath → ChildProcess
let   shuttingDown  = false;

function spawnWorker(workerPath) {
  if (shuttingDown) return;
  const label = path.relative(__dirname, workerPath);
  const child = fork(workerPath, [], {
    env: { ...process.env, AAP_IS_WORKER: '1' },
  });
  activeWorkers.set(workerPath, child);
  child.on('exit', (code, signal) => {
    activeWorkers.delete(workerPath);
    if (shuttingDown) return;
    log.warn('worker', `${label} exited (code=${code} signal=${signal}), restarting in 5s`);
    setTimeout(() => spawnWorker(workerPath), 5_000);
  });
  child.on('error', (err) => {
    log.error('worker', `${label} error`, { error: err.message });
  });
  log.info('worker', `spawned ${label} pid=${child.pid}`);
}

function shutdown(signal) {
  shuttingDown = true;
  log.info('startup', `${signal} — shutting down workers and server`);
  for (const child of activeWorkers.values()) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  log.info('startup', `server listening on port ${PORT}`);
  // Only spawn workers from the primary process — not from forked worker children.
  if (!process.env.AAP_IS_WORKER) {
    spawnWorker(path.join(__dirname, 'src/workers/notificationWorker.js'));
    spawnWorker(path.join(__dirname, 'src/workers/imageProcessingWorker.js'));
    // #1 real-time: bridge Postgres NOTIFY (from web + worker processes) to
    // socket.io. Polling on the clients remains the permanent fallback.
    require('./src/lib/realtime').startListener(io)
      .catch(e => log.error('realtime', 'listener start failed', { error: e.message }));
  }
});
