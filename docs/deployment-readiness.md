# Deployment Readiness — Advantage Auction Platform

*Last updated: 2026-05-08 | Pilot phase*

---

## Current Persistence Architecture

| Asset | Provider | Notes |
|---|---|---|
| Primary database | Neon PostgreSQL (serverless) | `DATABASE_URL` in `.env` |
| Images/media | Cloudinary | `CLOUDINARY_*` vars in `.env` |
| Session tokens | JWT (stateless) | Signed with `JWT_SECRET`; 24h expiry |
| Payment intents | Stripe | `STRIPE_SECRET_KEY`, idempotency table in DB |
| Idempotency keys | DB table `payment_idempotency_keys` | Deduplication for charge-lot |

---

## Required Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | **Yes** | Min 32 chars recommended; rotate on compromise |
| `DATABASE_URL` | **Yes** | Neon connection string with `sslmode=require` |
| `STRIPE_SECRET_KEY` | **Yes** | `sk_test_*` (test) or `sk_live_*` (production) |
| `STRIPE_PUBLISHABLE_KEY` | **Yes** | Passed to frontend via `/api/payments/config` |
| `STRIPE_WEBHOOK_SECRET` | **Yes** | From Stripe dashboard webhook settings |
| `PORT` | No | Default: 3000 |
| `NODE_ENV` | No | Set to `production` on server |
| `FRONTEND_URL` | No | For CORS; default: `http://localhost:3001` |
| `SMTP_HOST` | No | Required for seller email reports |
| `SMTP_PORT` | No | Default: 587 |
| `SMTP_USER` | No | SMTP authentication |
| `SMTP_PASS` | No | SMTP authentication |
| `EMAIL_FROM` | No | Sender address for transactional email |
| `CLOUDINARY_CLOUD_NAME` | No | Required for image uploads |
| `CLOUDINARY_API_KEY` | No | Required for image uploads |
| `CLOUDINARY_API_SECRET` | No | Required for image uploads |

---

## Backup-Critical Assets

1. **Neon database** — Contains all auction, lot, bid, user, payment, invoice, and seller data. Neon provides automatic daily backups (free tier: 7-day history). For production pilot, verify backup schedule and test restore procedure before go-live.

2. **`.env` file** — Contains all secrets. Must be backed up securely (NOT in git). Loss of `JWT_SECRET` invalidates all active sessions. Loss of `STRIPE_*` keys requires Stripe dashboard recovery.

3. **Cloudinary media** — Lot images are stored in Cloudinary. Images are referenced by URL in the database. Cloudinary free tier does not include automatic backup; images can be regenerated from re-upload if sellers retain originals.

---

## Recovery Risks

| Scenario | Impact | Recovery |
|---|---|---|
| `JWT_SECRET` changed | All active sessions invalidated | Users re-login; no data loss |
| `DATABASE_URL` changed | Server fails to start | Update `.env`, restart |
| DB connection lost | Server degraded (health: degraded) | Automatic reconnect on next query |
| Stripe keys revoked | Payments fail; config endpoint returns empty key | Update `.env`, restart |
| Cloudinary credentials lost | Image upload fails; existing image URLs still work | Recover via Cloudinary dashboard |
| Neon DB data loss | All auction/user/payment data lost | Restore from Neon backup snapshot |

---

## Single Points of Failure

- **Neon PostgreSQL**: All operational data. Downtime → server returns 503 from health check.
- **Stripe**: Payment intent creation fails. Existing auctions/bids unaffected.
- **JWT_SECRET**: If rotated, all sessions expire immediately. No graceful logout cascade.
- **Server process**: Single process, single port. No clustering currently.

---

## Production Deployment Requirements

### Runtime
- Node.js >= 18.x (for `fetch` built-in and ES2022 syntax)
- npm >= 9.x

### Environment
- `NODE_ENV=production` — enables production error handler (no stack traces in responses)
- All required env vars set (server validates at startup and exits if missing)
- Stripe webhook configured in Stripe dashboard pointing to `https://yourdomain.com/api/payments/webhook`

### Process Management
- Use a process manager (PM2 or systemd) to restart on crash
- `server.on('error')` exits with code 1 on port conflict — process manager will restart
- No background workers currently (all operations are request-scoped)

### CORS
- Set `FRONTEND_URL` to the deployed frontend origin
- If frontend and API are on the same domain, CORS headers are still present but not restricted

### Reverse Proxy (recommended)
- Nginx or Caddy in front of Node for TLS termination, static asset caching, and rate limiting
- Set `X-Forwarded-For` headers if using Nginx; rate limiter uses `req.ip`

---

## Operational Hardening Checklist

### Before Pilot Go-Live
- [ ] Set `NODE_ENV=production` on server
- [ ] Rotate `JWT_SECRET` from dev value to production value
- [ ] Switch Stripe keys to `sk_live_*` / `pk_live_*` (or confirm test is acceptable for pilot)
- [ ] Verify Stripe webhook secret matches deployed webhook URL
- [ ] Confirm Neon backup schedule and test DB restore
- [ ] Set `FRONTEND_URL` to production domain
- [ ] Configure SMTP for transactional email (seller reports)
- [ ] Verify `/api/health` returns `{ status: "ok" }` after deploy
- [ ] Run full test suite against staging DB before launch

### Monitoring (manual, pilot phase)
- Poll `GET /api/health` to verify DB reachability and uptime
- Check `GET /api/admin/diagnostics/auctions` for open lot counts and auction states
- Check `GET /api/admin/diagnostics/payments` for payment status distribution
- Review server logs for `[ERROR]` and `[WARN]` entries during auction events

### Post-Pilot Recommendations
- Add APM (e.g., Datadog, New Relic) for request tracing
- Add structured JSON logging for log aggregation
- Add Redis for session/rate-limit state across multiple instances
- Add DB read replica for reporting queries
- Add email/SMS alerting on payment failures or server errors

---

## Email Infrastructure Status

### Services and delivery behavior

| Service | File | Delivery | Behavior when SMTP missing |
|---|---|---|---|
| Buyer notifications (outbid, won, payment, pickup) | `notificationService.js` | **Mock only** — logs to console, never sends | Logs to console regardless |
| Registration confirmation | `notificationService.js` | **Mock only** | Logs to console regardless |
| Seller operational close email | `operationalCloseEmailService.js` | Real (nodemailer) | **Throws** — admin endpoint fails |
| Seller final PDF report | `pdfGenerationService.js` | Real (nodemailer) | **Throws** — admin endpoint returns 500 |
| Transactional email helper | `emailService.js` | Real (nodemailer) | Gracefully skips with console.warn |

### Pilot email strategy

For the pilot, two behaviors are relevant:

1. **Buyer notification emails are NOT sent.** `notificationService._sendEmail` is mock — outbid, won, and payment confirmation emails console.log only. Buyers will not receive automated emails during the pilot unless this is wired to `emailService.js` post-pilot.

2. **Admin seller report requires SMTP.** `POST /api/admin/auctions/:id/send-final-report` calls `pdfGenerationService.sendFinalSellerReport`, which throws if `SMTP_HOST`, `SMTP_USER`, or `SMTP_PASS` is missing. Do not trigger this endpoint until SMTP is configured.

### Configuring SMTP for pilot

Set in `.env`:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-account@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM=noreply@advantageauction.bid
```

Verify SMTP is live: `GET /api/health` returns `email_configured: true` when `SMTP_HOST` and `SMTP_USER` are set.
