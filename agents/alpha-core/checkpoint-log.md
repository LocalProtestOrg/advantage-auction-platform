# Alpha-Core — Checkpoint Log

Chronological record of completed work cycles. Most recent first.

---

## checkpoint-admin-moderation-v1 (0139717)

**Date:** 2026-05-09

**What was done:**
- Built `public/admin/moderation.html` — full admin moderation dashboard with 6 tabs (Queue, All Videos, Auctions, Sellers, Payouts, Diagnostics)
- Added `GET /api/admin/videos` route (with optional `?status=` filter) to admin.js
- Added `listAllVideos(status, limit)` to walkthroughVideoService.js
- Inline approve/reject workflow; Cloudinary thumbnail derivation; visibility/featured toggles
- JWT admin gate (client-side role check prevents UI flash)
- Published `docs/bd-integration-architecture.md` (planning doc — API contract, security model, caching strategy, widget architecture, SEO strategy)

**Tests:** 63/63 admin-moderation.spec.js PASS; 241+ total passing; 9 pre-existing failures (unchanged)

**Pre-existing failures (unchanged):** admin-idempotency, close-auction-concurrency, audit-log, multi-user bidding, payment-idempotency, production-readiness browser redirect, rehearsal lot inventory, seller-dashboard logout, buyer-flow registration

**What's next:** Bravo-Discovery to build public API layer for BD marketplace integration

---

## checkpoint-phase3-pilot-v1 (9308a29)

**Date:** 2026-05 (pre-Agent-OS)

**What was done:**
- Phase 2: plaintext email fallback, replyTo header, Sentry integration, admin seller/payout endpoints, seller UX improvements, SOP docs, Stripe webhook DB deduplication
- Phase 3: migration 034 applied (stripe_webhook_events table), watchlist 500 fixed (l.status → l.state), registration hardened (token on success, 409 on duplicate, min 8 chars), login redirect fixed to /seller-dashboard.html, Under Review callout with review timeline, SOP corrected for featured lots

**Tests:** 241 passing, 5 pre-existing failures (idempotency/concurrency/audit)

**Pre-launch checklist at this point:** STRIPE live keys, SMTP vars, SENTRY_DSN in Railway; purge test notification rows before first real auction

---

## checkpoint-phase1-hardening-v1 (6b4a9e7)

**Date:** 2026-05 (pre-Agent-OS)

**What was done:**
- Workers:1 for serial test execution
- Admin-refund unique constraint fix
- 1500ms poll wait
- Helmet, rate limiting, mobile viewport
- Workers serial E2E compatibility

**Tests:** 241 passing, 5 pre-existing failures

---

## checkpoint-scheduler-sql-hardening-v1 (548ec6e)

**Date:** 2026-05 (pre-Agent-OS)

**What was done:**
- Fixed column mismatches in all three notification schedulers against live Neon schema
- Live bids: bidder_user_id (not user_id), amount_cents (not amount)
- Live lots: state (not status)
- CLOSE_TO_WINNING: 4 column fixes + removed erroneous *100 multiplier
- FINAL_SECONDS: bidder_user_id AS user_id alias in UNION subquery + state fix
- ENDING_SOON: bidder_user_id AS user_id alias + amount_cents + state fix
- No timing/dedup/business logic changed — only column name corrections

**Tests:** 172/172 Playwright passing; zero scan-failed errors on startup

---

## checkpoint-worker-hardening-v1 (1ff2842)

**Date:** 2026-05 (pre-Agent-OS)

**What was done:**
- server.js: child_process.fork() spawns both workers after server.listen()
- AAP_IS_WORKER=1 guard prevents recursive spawn
- 5s restart loop on worker exit; shuttingDown flag prevents restart after intentional shutdown
- SIGTERM/SIGINT handler kills workers + closes HTTP server + 10s force-exit
- imageProcessingWorker.js: startup recoverStuckJobs() resets processing→pending for jobs >10min old
- notificationWorker.js: SITE_URL uses FRONTEND_URL env var

**Tests:** 172/172 passing (5 pre-existing failures unchanged)

---

## checkpoint-demo-integration-v1 (1aa8628)

**Date:** 2026-05 (pre-Agent-OS)

**What was done:**
- server.js: GET / serves demo.html
- public/demo.html: canonical title, noindex meta, favicon, Calendly → mailto
- public/favicon.svg: new branded favicon (blue bg, white A)

**Tests:** 172/189 chromium (5 pre-existing failures in concurrency/idempotency)

---

## checkpoint-pilot-demo-v1 (2a4a5a2)

**Date:** 2026-05 (pre-Agent-OS)

**What was done:**
- public/demo.html: polished demo access page
- scripts/seed-demo-data.js: idempotent seed — 3 closed auctions (jewelry, furniture, electronics), 9 lots with Unsplash images, 2 paid invoices + 1 pending
- src/routes/invoices.js: invoice query pulls real image from lot_images
- src/routes/auth.js: structured error logging; JWT default expiry 1h → 24h
- src/routes/admin.js: GET /api/admin/diagnostics/notifications added
- docs/pilot-runbook.md: go-live topology, pre-deploy checklist, admin procedures, seller onboarding
- Demo accounts: demo-buyer@advantage.bid / DemoExplore2025! | demo-seller@advantage.bid / same

**Tests:** 171/171 passing (prior 160 + deployment 11)

---

## checkpoint-operational-infrastructure-v1 (4a32180)

**Date:** 2026-05 (pre-Agent-OS)

**What was done:**
- src/lib/logger.js: centralized structured logger (info/warn/error/debug)
- middleware/logger.js: skip static asset logging; level-coded output
- db/index.js: removed per-connection noise
- server.js: startup env validation, startup banner, structured logging
- GET /api/health: public endpoint with status/uptime/db_reachable/stripe_mode
- GET /api/admin/diagnostics/auctions + /payments added

**Tests:** 160/160 passing

---

## checkpoint-production-readiness-v1 (8e16016)

**Date:** 2026-05 (pre-Agent-OS)

**What was done:**
- authMiddleware: expired/invalid token → 401 (was 403)
- payments.js: structured success/failure logs
- bids.js: createBid failure log
- auctions.js: structured error logs
- invoices.js: removed 3 debug console.log statements
- 401 → logout behavior in dashboard.html, seller-dashboard.html, lot.html, invoice.html

**Tests:** 147/147 passing

---

## checkpoint-mobile-responsiveness-v1 (c7838a1)

**Tests:** 134/134 passing (prior 125 + mobile 9)

---

## checkpoint-buyer-operations-v1 (a88e946)

**What was done:**
- lot.html winner panel: Pay Now for winner only (JWT decode vs winning_buyer_user_id)
- GET /api/payments/config endpoint returning STRIPE_PUBLISHABLE_KEY
- e2e/buyer-flow.spec.js: 31 tests

**Tests:** 125/125 passing

---

## checkpoint-seller-dashboard-v1 (4a7c382)

**What was done:**
- public/seller-dashboard.html + e2e/seller-dashboard.spec.js
- Dashboard: auction cards, lazy lot panels, inline add/edit/remove lot forms, state badges

**Tests:** 94/94 passing

---

## checkpoint-self-serve-seller-flow-v1 (01f9734)

**What was done:**
- Fixed self-serve seller auction creation flow end-to-end
- Fixed auctionService.js, lotService.js, auctions.js route, seller-create.html, server.js
- Removed legacy app.get stubs that referenced non-existent app_auctions/app_bids tables

**Tests:** 69/69 passing

---

## checkpoint-multi-user-rehearsal-v1 (dda25a5)

**What was done:**
- 40/40 rehearsal.spec.js passing (full 7-phase live auction event)
- Competitive bidding, proxy resolution, anti-snipe, withdraw, close, payment gating, browser sync

**Tests:** 40/40 passing

---

## checkpoint-buyer-flow-hardening-v1 (df2f847)

**What was done:**
- Fixed status→state throughout buyer routes, bidService, auction-view.html, lot.html
- Anti-snipe timing corrected to 2 minutes

**Tests:** Initial baseline established
