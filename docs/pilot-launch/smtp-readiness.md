# SMTP Readiness — Pilot Launch Checklist

*Last updated: 2026-05-11 | Pilot-Safe Payments Sprint*

See also: `docs/email-launch-checklist.md` (full provider guide)

---

## Current Status

`email_configured: false` — SMTP is not set in the Railway environment.

All notification workers are running and hold queued rows in the `notifications`
table. No data is lost. Delivery resumes immediately once SMTP is configured.

---

## What Does Not Work Without SMTP

| Feature | Impact |
|---|---|
| Payment confirmation email | Buyer receives no receipt |
| Pickup schedule notification | Buyer gets no pickup details |
| Auction ending-soon reminder | No outbid/ending alerts |
| Operational close email to seller | Seller gets no post-auction summary |
| Final seller report | Admin must deliver manually |

---

## Railway Environment Variables Required

Set all five in the Railway project → Variables panel:

```
SMTP_HOST=smtp.postmarkapp.com      # or your provider
SMTP_PORT=587
SMTP_USER=<your-smtp-api-token>
SMTP_PASS=<your-smtp-api-token>
EMAIL_FROM=noreply@advantageauction.bid
```

**Do not put real credentials in any code file, .env.example, or git history.**
Set them only in the Railway environment panel.

---

## Verification Sequence (after setting env vars)

**Step 1 — Restart the Railway service**
After setting env vars, trigger a deploy/restart so the new values load.

**Step 2 — Confirm via health endpoint**
```
GET /api/health
→ { "email_configured": true }
```

**Step 3 — Trigger a test notification**
Use the admin panel or run a seed close to trigger one real notification and
verify delivery in the recipient inbox and in the SMTP provider's sent log.

**Step 4 — Check notification worker log**
The Railway log should show:
```
[notify] SMTP configured — delivery active
```
and not the paused message.

---

## Pilot Email Volume Estimate

For a controlled pilot with 5–10 buyers and 1 seller:

| Event | Count |
|---|---|
| Payment confirmation emails | 1 per paid lot |
| Pickup schedule notifications | 1 per paid lot |
| Outbid notifications | Low (trusted bidders) |
| Operational close email | 1 per auction |

Total estimated volume: under 50 emails per pilot auction.
Any provider's free tier is sufficient.

---

## Not Blocking Pilot (but recommended)

- **Domain email address** — using `@advantageauction.bid` for `EMAIL_FROM` requires
  SPF/DKIM records. For a closed pilot with trusted bidders, delivery to known inboxes
  is reliable regardless. Implement proper domain setup before public launch.
- **Email templates** — current emails use plain text. HTML templates are a future
  enhancement, not a pilot blocker.
