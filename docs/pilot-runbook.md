# Pilot Runbook — Advantage Auction Platform

*Last updated: 2026-05-08 | Pilot phase*

---

## Deployment Topology

```
Internet
    │
    ▼
[Reverse Proxy — Nginx or Caddy]
    │  TLS termination, static caching, rate limiting
    │  Forwards /api/* and WebSocket to Node
    │
    ▼
[Node.js Process — server.js on port 3000]
    │  Serves public/ as static files
    │  Handles /api/* routes
    │  Socket.IO for real-time bid push
    │
    ├──► [Neon PostgreSQL — DATABASE_URL]
    │       All operational data: users, auctions, lots, bids, payments
    │
    ├──► [Stripe — STRIPE_SECRET_KEY]
    │       Payment intent creation, webhook delivery
    │
    └──► [SMTP (optional at pilot) — SMTP_HOST]
             Seller final report email, operational close email
```

**Notes:**
- Frontend is served as static files from `public/` by the same Node process. No separate frontend host required.
- No background worker processes. All operations are request-scoped.
- WebSocket connections upgrade from HTTP on the same port.

---

## Pre-Deploy Checklist

Complete every item before starting the server in production.

### Environment Variables
- [ ] `JWT_SECRET` — minimum 32 random characters; **do not reuse dev value**
- [ ] `DATABASE_URL` — Neon connection string with `?sslmode=require`
- [ ] `STRIPE_SECRET_KEY` — `sk_test_*` for pilot; `sk_live_*` only after explicit approval
- [ ] `STRIPE_PUBLISHABLE_KEY` — matching `pk_test_*` or `pk_live_*`
- [ ] `STRIPE_WEBHOOK_SECRET` — from Stripe dashboard for the deployed URL
- [ ] `NODE_ENV=production` — suppresses stack traces in error responses
- [ ] `FRONTEND_URL` — production domain (e.g. `https://auction.advantageauction.bid`)
- [ ] `PORT` — optional; defaults to 3000

### SMTP (required for seller final reports)
- [ ] `SMTP_HOST` — e.g. smtp.gmail.com or your mail provider
- [ ] `SMTP_PORT` — typically 587
- [ ] `SMTP_USER` — SMTP account
- [ ] `SMTP_PASS` — SMTP password or app password
- [ ] `EMAIL_FROM` — e.g. `noreply@advantageauction.bid`
- Note: If SMTP is not configured, buyer notifications log to console (mock mode).
  Operational close email and final report email will **throw** — do not trigger these
  endpoints until SMTP is configured.

### Process Manager
- [ ] PM2 or systemd configured to restart on crash
- [ ] `server.on('error')` exits with code 1 on port conflict — process manager will restart

### Stripe Webhook
- [ ] Webhook URL registered in Stripe dashboard: `https://yourdomain.com/api/payments/webhook`
- [ ] `STRIPE_WEBHOOK_SECRET` matches the registered webhook

### Database
- [ ] Run `GET /api/health` after startup; verify `db_reachable: true`
- [ ] Run `GET /api/admin/diagnostics/auctions` with admin token; verify `200 OK`

---

## Step-by-Step Go-Live Procedure

### 1. Provision server
- Node.js >= 18.x, npm >= 9.x
- Install dependencies: `npm install --omit=dev`
- Copy `.env` with all required vars (see above)

### 2. Database readiness
- Verify Neon connection: `psql "$DATABASE_URL" -c "SELECT 1"`
- Confirm all schema migrations applied (check migrations directory if applicable)
- Verify test user exists (admin account for Advantage staff)

### 3. Start the server
```
NODE_ENV=production node server.js
```
Or with PM2:
```
pm2 start server.js --name advantage-auction --env production
pm2 save
```

### 4. Verify startup
Check console for startup banner:
```
[<timestamp>] INFO  [startup] Advantage Auction Platform {"env":"production","db":"NEON","stripe":"TEST"}
[<timestamp>] INFO  [startup] server listening on port 3000
```
If you see `[startup] FATAL — missing required env vars`, check your `.env`.

### 5. Smoke tests (manual)
```
curl https://yourdomain.com/api/health
# Expected: {"status":"ok","db_reachable":true,...}

curl -H "Authorization: Bearer <admin_token>" https://yourdomain.com/api/admin/diagnostics/auctions
# Expected: {"success":true,"data":{...}}
```

### 6. Configure reverse proxy
- Point proxy to `localhost:3000`
- Enable WebSocket upgrade forwarding (`Upgrade`, `Connection` headers)
- Set `X-Forwarded-For` if behind nginx for accurate IP logging

---

## Monitoring Workflow

### Daily during pilot
1. Check `GET /api/health` — verify `status: "ok"` and `db_reachable: true`
2. Check `GET /api/admin/diagnostics/auctions` — review open lot counts and auction states
3. Check `GET /api/admin/diagnostics/payments` — look for unexpected `failed` payment accumulation
4. Check `GET /api/admin/diagnostics/notifications` — review `failed` notification counts; queue depth should be near 0 between auctions

### During a live auction event
- Monitor server logs for `[ERROR]` lines (payment failures, auth anomalies)
- Watch `open_lots` count via diagnostics; should decrease as lots close
- After close: check `payments.by_status` for `pending` → `paid` transitions

### Signs of trouble
| Signal | Likely cause | Action |
|---|---|---|
| `db_reachable: false` | Neon connection lost | Check DATABASE_URL; Neon status page |
| `stripe_configured: false` | Missing Stripe env var | Check `.env`, restart |
| Large `failed` payment count | Stripe webhook not firing | Verify webhook URL in Stripe dashboard |
| Large `failed` notification count | SMTP misconfigured | Check SMTP vars; buyer notifications still work (mock) |

---

## Admin Operational Procedures

### Publishing an auction
1. Seller creates and submits auction via seller create flow
2. Admin reviews lots and selects featured lots if needed
3. Admin calls `PATCH /api/admin/auctions/:id/publish` with admin token
4. Auction state transitions: `submitted → published`
5. Verify via diagnostics: `auction_states` should show count increase in `published`

### Closing an auction
1. After auction window has passed, admin calls `POST /api/admin/auctions/:id/close`
2. Auction and all lots transition to closed state
3. Winners are set; invoices become available to buyers
4. Optional: send operational close email via `POST /api/admin/auctions/:id/send-final-report`
   (requires SMTP configured; attaches PDF report)

### Manually recording a payment
If a buyer pays outside Stripe (cash, check — not recommended for pilot):
```
POST /api/admin/payments/:paymentId/record-success
Authorization: Bearer <admin_token>
Content-Type: application/json

{ "payment_provider_id": "manual-check-<date>" }
```

### Troubleshooting a failed payment
1. Buyer reports payment failure
2. Check `GET /api/admin/diagnostics/payments` for recent failures
3. Find payment record ID in DB: `SELECT id, status, amount_cents FROM payments WHERE lot_id = '<lot_id>'`
4. If charge was collected by Stripe but record shows `pending`: use `record-success` endpoint
5. If charge was not collected: buyer must retry via `/payment.html`

---

## Seller Onboarding (Pilot)

### Pre-auction preparation
1. Create seller account: `POST /api/auth/register` (or admin creates via DB)
2. Admin promotes to seller role: `UPDATE users SET role = 'seller' WHERE email = '<email>'`
3. Seller creates `seller_profile` if required by schema (check if auto-created on role assignment)
4. Seller logs in, navigates to `/seller-create.html`
5. Seller fills in auction details: title, description, dates, pickup window
6. Seller adds lots: title, description, starting bid, category, images
7. Seller submits auction — locks seller editing
8. Admin reviews and publishes

### Seller checklist (give to seller before event)
- [ ] Account created and login confirmed
- [ ] Test login before auction day
- [ ] All lots entered with descriptions, photos, and starting bids
- [ ] Auction submitted (locked)
- [ ] Pickup window confirmed (must be ≥ 36 hours after auction end)
- [ ] Understand: after admin publishes, buyers can view and bid
- [ ] Understand: auction close and payment collection are automated; pickup details go to buyers after payment

---

## Backup + Recovery Verification

### Neon backup assumptions
- Neon free tier: automatic daily backups, 7-day history
- Neon Pro tier: point-in-time recovery

### Pre-pilot verification (do once before go-live)
1. Log in to Neon console → branch → "Restore" tab
2. Confirm a backup snapshot exists from the last 24 hours
3. Test restore to a dev branch: `SELECT COUNT(*) FROM users` should return expected count
4. Record: last verified restore on _______ by _______

### Recovery priorities if DB is lost
1. **Users** — cannot be recovered except from backups; all passwords are bcrypt hashes
2. **Auctions + lots** — auction data; recoverable from Neon backup
3. **Bids** — bid history; recoverable from Neon backup
4. **Payments** — Stripe is authoritative for payment intent status; payments table can be reconciled from Stripe dashboard
5. **Invoices** — derived from payments + lots; can be regenerated if base data is intact

### If JWT_SECRET is rotated
- All active sessions immediately invalidated
- Users must log in again
- No data loss
- Update `.env`, restart server

### If Stripe keys are changed
- In-flight payment intents created with old key become unreachable
- New payments work with new key
- Resolve stranded intents via Stripe dashboard manually

---

## Known Pilot Limitations

| Area | Status | Notes |
|---|---|---|
| Buyer notifications (outbid, won) | Mock (console only) | Notifications are logged but not emailed. Wiring to emailService.js is a post-pilot TODO. |
| SMS notifications | Not implemented | Opt-in SMS is a future feature |
| Final seller report email | Requires SMTP | `POST /api/admin/auctions/:id/send-final-report` throws if SMTP not configured |
| Operational close email | Requires SMTP | Uses `operationalCloseEmailService.js`; graceful failure documented |
| Seller final report join | Pre-existing bug | `pdfGenerationService.js` joins on `created_by_user_id` which may not match schema; test before pilot |
| Rate limiting | None | No rate limiter on bid or payment routes; acceptable for pilot scale |
| Multi-instance | Not supported | Single Node process; no Redis for session/rate state |
