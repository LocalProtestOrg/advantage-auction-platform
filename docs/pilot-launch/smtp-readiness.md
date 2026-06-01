> ⛔ **SUPERSEDED (2026-06-01) — historical reference only.** This SMTP/Postmark-era readiness checklist is replaced by the Amazon SES migration plan (Postmark was abandoned — account rejected). **Do not use for current email setup.** Current source of truth: `docs/postmark-to-ses-migration-plan.md`, `docs/aws-ses-onboarding-checklist.md`, `docs/postmark-to-ses-phase1-emailservice-spec.md`.

# SMTP Readiness — Pilot Launch Checklist

*Last updated: 2026-05-11 | SMTP Validation Cycle*

See also: `docs/email-launch-checklist.md` (full provider guide)

---

## Current Status

**SMTP configured in Railway — outbound port blocked by Railway network.**

Railway environment variables are correctly set. Production health endpoint returns
`email_configured: true`. Notification worker started in delivery mode.

SMTP delivery is blocked at the network level — Railway's infrastructure does not
allow outbound TCP connections to port 465 (SMTPS) from application containers
by default. This is a Railway firewall policy, not a code or configuration error.

### What was validated
- `GET /api/health` → `{ email_configured: true }` ✅
- Notification worker: `[notify] Worker started — polling every 5s` ✅
- SMTP env vars present and readable at runtime ✅
- Code correctly uses `secure: true` for port 465, `EMAIL_FROM` from `SMTP_FROM` ✅
- `POST /api/admin/email/test` → `502 { smtp_error: "Connection timeout", smtp_host: "mail.advantage.bid", smtp_port: "465" }` — network blocked

### Root cause
```
Railway container → TCP SYN → mail.advantage.bid:465 → [Railway egress firewall drops packet]
```
`mail.advantage.bid` ports 465 and 587 are both open and reachable from the
internet (confirmed from dev machine). The block is Railway-side.

### Resolution options

**Option A — Request Railway to unblock outbound SMTP (preferred)**
1. Go to https://discord.gg/railway (Railway community) or https://help.railway.com
2. Request: "Please unblock outbound TCP ports 465 and 587 for project
   e327dbb4-ab21-41de-980a-c2c83e43904e (Advantage Auction)"
3. Once unblocked, no code changes needed — the current configuration will work

**Option B — Switch to a managed transactional SMTP relay**
Change 4 Railway env vars to use a provider that Railway's infrastructure can reach:

| Provider | SMTP_HOST | SMTP_PORT | SMTP_SECURE | Notes |
|---|---|---|---|---|
| Postmark | smtp.postmarkapp.com | 587 | false | Best deliverability |
| Gmail SMTP | smtp.gmail.com | 587 | false | Use App Password |
| SendGrid | smtp.sendgrid.net | 587 | false | Free 100/day tier |

For Option B, also update `EMAIL_FROM` to a verified sender address for that provider.

---

## Verification Steps (run against Railway production URL)

**Step 1 — Confirm health endpoint**
```
GET https://<railway-url>/api/health
→ { "email_configured": true }
```
`email_configured` is `true` when `SMTP_HOST` and `SMTP_USER` are both set in the
server process. If still `false`, the Railway service has not restarted yet.

**Step 2 — Send admin test email**
```
POST https://<railway-url>/api/admin/email/test
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "to": "info@advantage.bid" }
```
Expected response:
```json
{ "success": true, "message": "Test email sent to info@advantage.bid", "message_id": "<id>", "email_configured": true }
```
If `email_configured: false` is returned, SMTP vars are still missing in Railway.

**Step 3 — Verify delivery in inbox**
Open the received email and check:
- Subject: `Advantage Auction — SMTP delivery test`
- View headers (Gmail: ⋮ → Show original):
  - `Authentication-Results: spf=pass` (requires SPF record on advantage.bid)
  - `Authentication-Results: dkim=pass` (requires DKIM record)
  - If SPF/DKIM are missing, emails may land in spam — see `docs/email-launch-checklist.md`

**Step 4 — Check Railway log**
After the test email and first auction event, logs should show:
```
[email] Sent "Advantage Auction — SMTP delivery test" to info@advantage.bid — messageId: <id>
[notify] Worker started — polling every 5s
```
NOT the paused message:
```
[notify] SMTP not configured — delivery paused...
```

---

## Required Railway Environment Variables

| Variable | Value |
|---|---|
| `SMTP_HOST` | Your provider's SMTP host (e.g., `smtp.gmail.com`) |
| `SMTP_PORT` | `587` (STARTTLS) |
| `SMTP_USER` | SMTP username (usually your email address) |
| `SMTP_PASS` | SMTP password or app-specific password |
| `EMAIL_FROM` | `info@advantage.bid` (must match SMTP auth identity) |

`EMAIL_FROM` **must be set explicitly** in Railway. If omitted, the code falls back
to `noreply@advantageauction.bid` which will not match the SMTP credentials for
`info@advantage.bid`, causing authentication failures.

---

## Email Notification Coverage (Pilot)

### Fully wired and SMTP-ready

| Event | Delivery path | Status |
|---|---|---|
| Buyer outbid | `bidService` → `notifications_queue` → worker → SMTP | READY |
| Buyer leading bid | `bidService` → `notifications_queue` → worker → SMTP | READY |
| Bidding extended (late bid) | `bidService` → `notifications_queue` → worker → SMTP | READY |
| Lot ending soon | Worker scheduler → `notifications_queue` → SMTP | READY |
| Close to winning | Worker scheduler → `notifications_queue` → SMTP | READY |
| Final seconds | Worker scheduler → `notifications_queue` → SMTP | READY |
| New auction to followers | `followerNotificationService` → `notifications_queue` → SMTP | READY |
| Operational close email to seller | `auctionService` → `operationalCloseEmailService` → direct SMTP | READY |

### Gaps — not wired for pilot

| Event | Current state | Impact |
|---|---|---|
| Payment confirmation to buyer | `emitEvent` fires with no listener | Buyer gets no receipt email |
| Pickup slot assigned to buyer | `emitEvent` fires with no listener | Buyer gets no pickup email |
| Lot winner notification (WINNING) | Worker handles type but nothing queues it | Winner gets no "you won" email |
| Registration confirmation | No code emits USER_REGISTERED | No welcome email on signup |
| Password reset / forgot password | No flow implemented anywhere | Must be done manually during pilot |

These gaps do not block a controlled pilot with trusted buyers (Advantage can
communicate pickup details manually), but should be addressed before public launch.

---

## DB State: Historical Failed Notifications

```
notifications_queue: 538 rows, all status='failed', all attempts=3
```

All 538 are stale dev/test notifications (outbid, leading, extended_bidding, new_auction)
from 2026-05-08 to 2026-05-11. They exhausted 3 delivery attempts when SMTP was not
configured. They will NOT be retried by the worker (only `status='pending'` rows are
processed). They are safe to leave as-is during pilot.

Admin visibility: `GET /api/admin/diagnostics/notifications` shows queue depth and
recent delivery status. Monitor for `status='failed'` rows accumulating after SMTP
goes live (would indicate a new delivery problem, not the historical dev backlog).

---

## Pilot Email Volume Estimate

For a controlled pilot with 5–10 buyers and 1 seller:

| Event | Count |
|---|---|
| Outbid notifications | 2–5 per lot (bidding activity) |
| Ending-soon reminders | 1–2 per active buyer per closing lot |
| Operational close email | 1 per auction |

Total estimated volume: under 100 emails per pilot auction.
Any provider's free tier is sufficient.

---

## Not Blocking Pilot (but recommended before public launch)

- **SPF/DKIM on advantage.bid** — required for reliable inbox delivery. For a
  closed pilot with trusted bidders, delivery to known inboxes is reliable without
  it, but spam-folder risk is elevated.
- **EMAIL_FROM explicitly set in Railway** — confirm Railway env includes
  `EMAIL_FROM=info@advantage.bid` (not just SMTP_HOST/USER/PASS).
- **Payment + pickup notification wiring** — buyer-facing transaction emails not
  yet wired. Acceptable for pilot; blocking for public launch.
