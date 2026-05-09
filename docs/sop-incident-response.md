# SOP: Incident Response

*Last updated: 2026-05-09 | Pilot phase*

---

## Severity Levels

| Level | Description | Response Time |
|---|---|---|
| P0 | Platform down, payments failing, data loss | Immediate |
| P1 | Auction close failed, bids not processing, email delivery broken | < 30 min |
| P2 | Slow performance, notification backlog, non-critical UI errors | < 2 hours |

---

## Immediate Checks (P0 / P1)

### 1. Health check

```
GET /api/health
```

Returns: `status`, `db_reachable`, `stripe_configured`, `email_configured`, `uptime_seconds`.

If `db_reachable: false` — database is down. Check Neon dashboard for outage.
If `stripe_configured: false` — Stripe env vars missing. Check Railway/Render env config.

### 2. Check server logs

Railway/Render → project → **Logs** tab. Filter for `[error]` or `FATAL`.

### 3. Check Sentry (if DSN configured)

Open Sentry project → Issues → filter to last 1 hour. Unhandled exceptions surface here with stack traces.

### 4. Check Stripe Dashboard

[dashboard.stripe.com](https://dashboard.stripe.com) → Payments → filter by date. Look for failed or refunded charges that shouldn't be.

---

## Specific Scenarios

### Auction close failed

1. Check `GET /api/admin/diagnostics/auctions` for auctions with `state = 'active'` past end time.
2. Manually trigger close:
   ```
   POST /api/admin/auctions/<auction-id>/close
   Authorization: Bearer <admin-token>
   ```
3. Verify winner assignment and payment queue in the response.

### Notification delivery backlog

1. Check queue depth:
   ```
   GET /api/admin/diagnostics/notifications
   ```
2. If `queue_depth` is high and SMTP is configured, the worker may have crashed. Check server logs for `[notify]` lines.
3. The worker auto-restarts in 5 seconds on crash. If it keeps crashing, check `failed_reason` in the `notifications` table.

### Payment webhook missed

Stripe will retry failed webhooks for up to 3 days. To replay:
1. Stripe Dashboard → Developers → Webhooks → select endpoint → **Resend** on the failed event.

If a payment was collected by Stripe but `payments.status` is still `pending`:
```
POST /api/admin/payments/<payment-id>/record-success
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "payment_intent_id": "<pi_...>" }
```

### Database connection exhausted

Symptom: 500 errors on all API calls, logs show `connection timeout`.
- Neon free tier has a connection limit. Check Neon dashboard.
- Restart the Node process (Railway: **Restart service**). This drains and recreates the pool.

---

## Communication During Incidents

1. If an active auction is affected, contact the seller directly via email.
2. If buyers cannot complete payment during auction close, extend the payment window manually by notifying them.
3. Log the incident timeline in a plain note (Notion, email thread, etc.) for post-mortem.

---

## Post-Incident

1. Confirm health check passes.
2. Run diagnostics on affected entities (auctions, payments, notifications).
3. If Sentry captured the crash, mark it resolved once confirmed fixed.
4. Note the fix and any follow-up work in the changelog.

---

## Emergency Contacts

- Platform ops: `advantageauction.bid@gmail.com`
- Stripe support: [support.stripe.com](https://support.stripe.com)
- Neon support: [neon.tech/docs](https://neon.tech/docs)
