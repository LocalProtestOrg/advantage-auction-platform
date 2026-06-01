# Deployment Readiness — Advantage Auction Platform

*Last updated: 2026-06-01 | Refreshed for the current Railway architecture + feature set. Release mechanics live in `docs/production-promotion-runbook.md`; this doc is the readiness/risk reference.*

> **Status legend:** ✅ Ready now · ⏳ Blocked by SES (AWS production-access pending) · 📦 Blocked by production promotion (migrations 046–057 + branch merge) · 🔭 Future roadmap.

---

## 1. Architecture (current — Railway)
| Concern | Provider / mechanism | Notes |
|---|---|---|
| Hosting | **Railway** — services `advantage-auction-platform` (prod, `main`) and `advantage-staging` (`deploy/seller-studio-1b`) | Managed process + TLS + restarts; **auto-deploy on git push**; **no VPS/Nginx/PM2** |
| Config | **Railway service env vars** | **No `.env` file on a server** in prod/staging; secrets live in Railway, never in git |
| Proxy / client IP | `app.set('trust proxy', 1)` | Real client IP via `X-Forwarded-For` (used for signatures/logging) |
| Workers | **2 forked workers** after `listen()` | `imageProcessingWorker` (Cloudinary enhancement) + `notificationWorker` (drains `notifications_queue` → email). *(Corrects the prior "no background workers" claim.)* |
| Database | **Neon PostgreSQL** (`DATABASE_URL`) | Prod (`ep-proud-leaf-an8pzkib`) and staging (`ep-polished-cake-anq3xrza`) are **isolated** |
| Media + PDFs | **Cloudinary** (`CLOUDINARY_*`) | Lot images, bg-removal, **private signed-agreement PDFs** (short-lived signed URLs) |
| Payments | **Stripe** (`STRIPE_*`) + `payment_idempotency_keys` | **Prod currently TEST mode** |
| Email | **Amazon SES (SMTP)** ⏳ | Migration from Postmark (account rejected); see `postmark-to-ses-migration-plan.md` |
| Sessions | JWT (`JWT_SECRET`), 24h | Stateless |

## 2. Required environment variables (current)
**Hard-required (startup exits if missing — `server.js` REQUIRED_ENV + Stripe-in-prod):** `JWT_SECRET`, `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.
**Feature env:**
| Var | Purpose | Status |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME`/`API_KEY`/`API_SECRET` | images + signed-agreement PDFs | ✅ set on prod |
| `SMTP_HOST`/`PORT`/`SECURE`/`USER`/`PASS` | transactional email transport | ⏳ **SES-pending** (will be SES SMTP) |
| `EMAIL_FROM` = `notifications@advantage.bid` | sender | ⏳ confirm at SES cutover |
| `EMAIL_REPLY_TO` = `info@advantage.bid` | reply-to | ⏳ |
| `PUBLIC_BASE_URL` (or `FRONTEND_URL`/`SITE_URL`) | agreement/notification **links** | ⚠️ **prod unset** → falls back to Railway URL; set before relying on emailed links |
| `ANTHROPIC_API_KEY` | AI Catalog Assistant | ✅ set on prod (truthful 503 if absent) |
| `SENTRY_DSN`, `ADMIN_EMAIL`, `NODE_ENV=production` | errors / ops | recommended |

## 3. Readiness by category
### ✅ Ready now (server-authoritative; staging-validated)
- Seller-type rules + **reconciled 48h pickup rule** (non-pro ≥48h, professional exempt, sanity floor) — `sellerTypeRules`.
- Governance moderation lifecycle (submit / return-to-draft / reject / publish / close) + audit visibility.
- Background-removal persistence fix; AI Catalog Assistant (with `ANTHROPIC_API_KEY`).
- Seller **agreement authoring + signing + private signed-PDF** (in-app; signing needs no email).
- Health + admin diagnostics; Cloudinary media; Stripe payment flow (in TEST mode).

### ⏳ Blocked by SES (AWS production-access pending)
- **Delivery** of all transactional email: account verification, password reset, outbid, winning-bidder, reminders, **governance notifications** (return-to-draft/rejected), **agreement signing-link emails**, operational close email, final-report PDF email.
- Until cutover, `emailService.sendEmail` skips/queues — `notifications_queue` **retries; nothing is lost**. In-app workarounds exist (admin copies the agreement `signing_link`; sellers use `/my-agreements.html`).

### 📦 Blocked by production promotion (`production-promotion-runbook.md`)
- **Migrations 046–057** must be applied to the prod DB (all genuinely absent — clean apply) **after a Neon backup**, then merge `deploy/seller-studio-1b` → `main`. Until then, prod runs the old `main` (`51dc8c9`) and none of the current feature set is live in prod.

### 🔭 Future roadmap
- Agreement-gated onboarding (Phase D); Seller/Agreement Assistants; professional-seller syndication; white-label sites; SMS (opt-in); rate limiting; APM + structured-log aggregation; Redis for multi-instance.

## 4. Launch blockers & operational risks
| Item | Type | Action |
|---|---|---|
| **SES production access** | ⏳ blocker | Await AWS; then SMTP creds + Phase 1 cutover (`postmark-to-ses-phase1-emailservice-spec.md`) |
| **Migrations 046–057 not on prod** | 📦 blocker | Apply (gated, batched) per promotion runbook |
| **Stripe TEST mode on prod** | decision/blocker (for real money) | Pilot vs GA → live keys + live webhook if GA |
| **`PUBLIC_BASE_URL` unset on prod** | risk | Set to canonical domain before emailed links matter |
| Cloudinary shared between prod + staging (`dwenlikku`) | risk | Distinct folders/public_ids; consider separate accounts long-term |
| `pdfGenerationService` final-report `created_by_user_id` join | risk | Verify vs live schema before relying on final-report email |
| No rate limiting on bid/payment | risk (low at pilot scale) | Roadmap |
| Single instance (workers forked in-process) | risk | Acceptable at pilot; Redis/clustering is roadmap |

## 5. Migration dependencies
- New in the promotion delta: **046–050** (governance: revision/rejection columns, notification types), **051–052** (seller-type, lot_ai_verifications), **053–057** (agreements A/B). Apply in order, batched with verification, **after** a Neon backup branch. The read-only prod preflight confirmed all 12 are absent on prod (no record-only reconciliation needed).

## 6. Rollback requirements
- **Pre-release Neon backup branch of prod** (instant, copy-on-write) — mandatory.
- **Code rollback** = revert the merge on `main` (→ redeploy `51dc8c9`); additive migrations are safe to leave.
- **DB rollback** = restore from the Neon backup branch if schema/data issue.
- **Email rollback** = Postmark is **not** available (rejected); rely on `notifications_queue` retry + (optional) a backup SES region/SMTP behind the same `SMTP_*` env.

## 7. Validation steps (for a controlled promotion once SES is approved)
- **Pre-deploy:** unit suites green; staging-green checkpoints confirmed; read-only prod preflight re-run.
- **DB:** Neon backup branch created; migrations 046–057 applied + per-batch verification.
- **Post-deploy (prod):** `GET /api/health` 200 (`db_reachable`, `stripe_configured`); deployment `SUCCESS`; workers started.
- **Functional:** governance regression suite; admin (moderation, seller-type, agreement authoring); seller (sign flow); payment (config/idempotency/webhook); agreement (send→sign→signed-PDF); **notification: real SES delivery with SPF/DKIM/DMARC = pass** (the SES-gated check).
- **Cleanup:** remove any test artifacts created during prod validation.

## 8. Backup-critical assets & recovery risks (Railway-current)
- **Neon DB** — all auction/lot/bid/user/payment/invoice/agreement data + `audit_log`. Backup branch before releases; recovery priority: users (backup) → auctions/lots/bids/agreements (backup) → payments (Stripe authoritative) → invoices (derivable).
- **Railway env vars** — secrets (JWT/DB/Stripe/Cloudinary/SES). Not in git. `JWT_SECRET` change → re-login (no data loss); Stripe key change → strand in-flight intents (resolve in Stripe).
- **Cloudinary** — image URLs + signed agreement PDFs; no automatic backup on lower tiers.

## 9. Historical context (corrected — kept for usefulness only)
- **"Buyer notifications are mock-only" (old doc): CORRECTED.** The live path is `notificationWorker → emailService.sendEmail` (real, queued). `notificationService._sendEmail` is a dead console-log scaffold, **not** the production sender.
- **"No background workers" (old doc): CORRECTED.** Two workers are forked (image-processing, notification).
- **PM2 / Nginx / Caddy / VPS / `.env`-on-server / Gmail SMTP (old doc): SUPERSEDED** by Railway + service env vars + SES.

---

## Launch-readiness summary (concise)
- **Code:** ✅ staging-green (seller-type, bg-removal, agreements A/B). 
- **Two hard blockers:** ⏳ **SES production access** (email delivery) and 📦 **prod migrations 046–057 + branch merge** (nothing current is live in prod yet).
- **One decision:** Stripe **TEST vs LIVE** (real-money launch). **One config:** set **`PUBLIC_BASE_URL`** on prod.
- **Mandatory before promotion:** Neon prod backup branch + the gated migration apply + the validation matrix (incl. SES email SPF/DKIM/DMARC once SES is live).
- **Net:** the platform is **build-complete and staging-validated**; production go-live is gated on **SES approval** and the **controlled promotion** (per `production-promotion-runbook.md`) — not on further engineering.
