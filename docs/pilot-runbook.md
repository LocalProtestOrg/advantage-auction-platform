# Pilot Runbook — Advantage Auction Platform

*Last updated: 2026-06-01 | Pilot phase | Reflects the current platform: Railway hosting, seller types, governance moderation, seller agreements (A/B), real queued notifications, and the reconciled 48h pickup rule.*

> ⏳ **SES-pending marker:** sections marked **`⏳ SES-PENDING`** require Amazon SES production access (email provider migration from Postmark; see `docs/postmark-to-ses-migration-plan.md` + `docs/aws-ses-onboarding-checklist.md`). Until SES is approved and `emailService` is cut over, outbound **email delivery is queued/retried but not delivered** — in-app flows still work; email links do not arrive. Do not rely on emailed links during this window.

> 📦 **Promotion prerequisite:** production currently runs an older `main`. Shipping this feature set to prod requires the **migration + merge** in `docs/production-promotion-runbook.md` (apply migrations **046–057** to the prod DB after a Neon backup, then merge `deploy/seller-studio-1b` → `main`). This runbook is the **operational** guide; the promotion runbook is the **release** guide.

---

## 1. Deployment topology (Railway)
```
Internet ──► Railway edge (TLS, proxy) ──► Node (server.js)
                                            │  app.set('trust proxy', 1)  → real client IP
                                            │  serves public/ (static) + /api/* + Socket.IO
                                            │  forks 2 workers after listen:
                                            │     • imageProcessingWorker (Cloudinary enhancement jobs)
                                            │     • notificationWorker    (drains notifications_queue → email)
   ├─► Neon PostgreSQL (DATABASE_URL)   all operational data + audit_log + agreements
   ├─► Stripe (STRIPE_*)                payment intents + webhook   [prod currently TEST mode]
   ├─► Cloudinary (CLOUDINARY_*)        lot images, bg-removal, signed-agreement PDFs (private + signed URLs)
   └─► Amazon SES (SMTP_* )  ⏳ SES-PENDING   transactional email (was Postmark; account rejected)
```
**Services:** `advantage-auction-platform` (prod, branch `main`) and `advantage-staging` (branch `deploy/seller-studio-1b`) — both in one Railway project, **auto-deploy on git push** to their branch. Each has its own Neon database (prod and staging are isolated). No VPS/Nginx/PM2 — Railway manages the process, restarts, and TLS.

## 2. Environment variables
**Hard-required (server exits without these):** `JWT_SECRET`, `DATABASE_URL`; in production also `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET`.
**Feature env:**
- `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` — images + signed-agreement PDFs.
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` — **⏳ SES-PENDING** (will be SES SMTP); `EMAIL_FROM=notifications@advantage.bid`, `EMAIL_REPLY_TO=info@advantage.bid`.
- `PUBLIC_BASE_URL` (or `FRONTEND_URL` / `SITE_URL`) — canonical domain for agreement/notification **links**. *(Prod: currently unset → falls back to the Railway URL; set before relying on emailed links.)*
- `ANTHROPIC_API_KEY` — AI Catalog Assistant (degrades to a truthful 503 if unset).
- `SENTRY_DSN` (errors), `ADMIN_EMAIL`, `NODE_ENV=production`.

## 3. Health & monitoring
- `GET /api/health` → `{ status, env, uptime_seconds, db_reachable, stripe_configured, stripe_mode, email_configured }`.
- `GET /api/admin/diagnostics/auctions` (admin) — auction states, open lots, recent activity.
- `GET /api/admin/diagnostics/payments` (admin) — payment statuses; watch `failed` accumulation.
- `GET /api/admin/diagnostics/notifications` (admin) — queue depth + `failed` counts. **⏳ SES-PENDING:** during the SES gap, expect notifications to **queue/retry** rather than send; this is expected, not a fault.
- **Railway logs** — boot banner, worker start, `[email] …` lines, `[ERROR]` lines.
- **Stripe / Cloudinary / SES / Neon** consoles for provider-side health (see §9).

## 4. Admin operational procedures

### 4.1 Governance moderation lifecycle (current)
Auction states: `draft → submitted → under_review → published → active → closed`, plus `rejected`.
- **Seller submits** a draft for review (`PATCH /api/auctions/:id` state→`submitted`; edit-lock engages for private sellers).
- **Return to draft** (request revisions): `POST /api/admin/auctions/:id/return-to-draft` `{reason}` → state→`draft`, `revision_count++`, seller sees the reason banner. Audited; **⏳ SES-PENDING** notification email.
- **Reject**: `POST /api/admin/auctions/:id/reject` `{reason}` → state→`rejected`, reason recorded. Audited; **⏳ SES-PENDING** notification email.
- **Publish**: `PATCH /api/admin/auctions/:id/publish` → `submitted/under_review → published`.
- **Close**: `POST /api/admin/auctions/:id/close` → auction + lots close; winners set; invoices available.
- **Audit timeline**: admin `GET /api/admin/audit-log?auction_id=…`; sellers see an allow-listed subset via `GET /api/sellers/me/audit`.

### 4.2 Seller-type administration
- Assign type: `POST /api/admin/sellers/:profileId/seller-type` `{ seller_type }` (private/business/other/auction_house/estate_sale_company/professional_liquidator). Audited.
- Effects: **professional** types are exempt from the 48h pickup rule and may use pro-only controls (Preview Start/End, lot starting bid, reserve). Non-professional types are gated server-side. Suspension: `POST /api/admin/sellers/:id/suspend` / `…/unsuspend` (reversible; suspended sellers cannot log in).

### 4.3 Seller agreements (admin authoring + lifecycle)
*Admin UI: `/admin/agreements.html`. Requires migrations 053–057.*
- **Author**: create a template per seller type → publish an immutable version (`{{placeholders}}` + variable schema + term defaults); set per-seller **terms** and **identity** (history-preserving).
- **Send**: `POST /api/admin/agreements/agreements` `{ sellerProfileId, templateId? }` → resolves+freezes the agreement, returns a **signing link + token**. **⏳ SES-PENDING:** the email isn't delivered yet — **workaround:** copy the returned `signing_link` to the seller, or the seller opens it from `/my-agreements.html` (authenticated, no email needed).
- **Seller signs** (authenticated; typed/drawn) → status `signed`; a **private signed PDF** is generated (Cloudinary) and delivered via short-lived **signed URLs** (`GET /api/agreements/:id/pdf`).
- **Resend / reissue / revoke**: admin endpoints under `/api/admin/agreements/agreements/:id/…` (resend rotates the token; reissue supersedes; revoke invalidates).

### 4.4 Payments
- Manual record (out-of-band pay): `POST /api/admin/payments/:paymentId/record-success`.
- Failed payment: check `diagnostics/payments`; if Stripe collected but record is `pending`, use `record-success`; else buyer retries via `/payment.html`. **Prod Stripe is in TEST mode** — decide test-vs-live before real-money launch.

## 5. Seller onboarding (current)
1. Seller registers (`/register` → `POST /api/auth/register`); admin assigns `seller` role + `seller_type` as needed.
2. **Agreement (if used in pilot):** admin sends the seller-type-matched agreement; seller reviews + signs (via the link or `/my-agreements.html`). **⏳ SES-PENDING** email; use the link workaround. *(The future agreement-gated onboarding — blocking the first auction until signed — is NOT enabled yet.)*
3. Seller builds the auction at `/seller-create.html` and lots at `/dashboard/lots.html`: title, description, **required size category** (dimensions optional), **3 featured lots**, starting bids ($1 default), pickup window.
4. **Pickup rule (reconciled):** non-professional sellers must set pickup to start **≥ 48 hours after auction close**; professional sellers may set their own pickup timing; no pickup before close. Enforced server-side (`sellerTypeRules`); the form/API rejects violations (422) with an explanation.
5. Seller submits → enters governance review (§4.1). Admin returns-to-draft / rejects / publishes.

**Seller checklist (pre-event):** account + login confirmed; (agreement signed, if used); all lots entered with photos + size category + starting bids; 3 featured lots chosen; **pickup ≥ 48h after close (non-professional)**; auction submitted; understands publish/close/payment automation and that full address is hidden until payment is verified.

## 6. Notifications (real, queued)
- Notifications are written to **`notifications_queue`**; the **notificationWorker** drains it and sends via `emailService.sendEmail`. Types include registration/verification, outbid, winning-bidder, auction reminders, and governance events (returned-to-draft, rejected). SMS is opt-in only and not implemented at pilot.
- **⏳ SES-PENDING:** until SES is live, `sendEmail` returns `{skipped}` (or fails and **retries**) — **queued notifications are not lost**; they deliver once SES is cut over. Monitor `diagnostics/notifications` queue depth.

## 7. Backup + recovery
- **Before any prod migration/release:** create a **Neon backup branch** of the prod DB (instant, copy-on-write rollback point) — see the promotion runbook.
- **Recovery priority:** users (backup only; bcrypt hashes) → auctions/lots/bids/agreements (Neon backup) → payments (Stripe is authoritative; reconcile) → invoices (derivable).
- **JWT_SECRET rotation:** invalidates sessions (re-login), no data loss. **Stripe key change:** in-flight intents stranded (resolve in Stripe).

## 8. Known limitations / pending items
| Area | Status |
|---|---|
| **Email delivery (all types)** | ⏳ **SES-PENDING** (AWS production-access review). Queued + retried; links available in-app meanwhile. |
| Prod Stripe mode | TEST — decide test-vs-live before real-money launch |
| Prod schema | Migrations **046–057 not yet applied to prod** (promotion runbook) |
| `PUBLIC_BASE_URL` (prod) | Unset → links fall back to the Railway URL; set before relying on emailed links |
| Agreement-gated onboarding | Designed (Phase D), **not enabled** — does not block first auction yet |
| AI Catalog Assistant | Requires `ANTHROPIC_API_KEY`; truthful 503 if absent |
| `pdfGenerationService` final-report join | Verify `created_by_user_id` join vs live schema before relying on the final-report email |
| SMS notifications | Not implemented (opt-in future) |
| Rate limiting on bid/payment | None at pilot scale |

## 9. Monitoring during a live event
- Watch Railway logs for `[ERROR]`; `diagnostics/auctions` `open_lots` should decrease as lots close; after close, `payments.by_status` `pending → paid`.
- **⏳ SES-PENDING:** `diagnostics/notifications` will show a non-draining queue until SES is live — expected.
- Signs of trouble: `db_reachable:false` (Neon), `stripe_configured:false` (env), rising `failed` payments (webhook), agreement `pdf_status='failed'` (Cloudinary).

---

*Operational runbook. For the release/promotion mechanics see `docs/production-promotion-runbook.md`; for the email provider migration see `docs/postmark-to-ses-migration-plan.md`.*
