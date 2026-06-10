# Production Incident Response Runbook

**Audience:** Engineer/operator on call. **Scope:** Railway app + Neon DB + SES + Stripe (TEST) for the pilot.

## 0. First 5 minutes — triage
1. **Health check:** `curl -s https://advantage-auction-platform-production.up.railway.app/api/health`
   - Expect `{status:ok, db_reachable:true, stripe_configured:true, stripe_mode:test, email_configured:true}`.
   - `db_reachable:false` → DB incident (§2). Non-200 / no response → app/deploy incident (§1).
2. **Railway status:** confirm service `advantage-auction-platform` deployment is `SUCCESS` and instance `RUNNING`.
3. **Logs:** Railway → service → Logs. Look for crash loops, unhandled rejections, repeated worker respawns ("worker exited" every ~5s).
4. Declare severity, note start time, open an incident note (capture timestamps + audit refs).

## 1. App / deployment incident
- **Symptom:** 5xx, app down, boot failure.
- **Identify deployed commit** (should be `e0f005f` or later): Railway deployment metadata.
- **Rollback (fastest):** Railway → Deployments → select last known-good (`51dc8c9` predates this release; prefer the last good post-launch deploy) → **Redeploy/Rollback**.
- **Git rollback** if needed: `git revert -m 1 <merge>` on `main`, or reset `main` to the last good SHA and push (prod auto-deploys `origin/main`). **Promote/rollback via `origin/main` only — never via local `main`** (local main carries the unrelated, unreleased Line B; see `docs/stripe-live-cutover-prerequisites.md`).
- **Env regressions:** verify SES/JWT/DB vars present (`railway variables --service advantage-auction-platform --environment production`).

## 2. Database incident (Neon)
- **Endpoint:** `ep-proud-leaf-an8pzkib` (pooled). For any manual DDL/repair use the **direct** endpoint (strip `-pooler`); the pooled endpoint is PgBouncer transaction-mode (session `SET`/`ALTER` unreliable).
- **Read-only error (`cannot execute … in a read-only transaction`):** Neon compute may default `default_transaction_read_only=on`. Durable fix (direct endpoint): `ALTER DATABASE neondb SET default_transaction_read_only = off`, then restart the service.
- **Connectivity/credential failure:** verify `DATABASE_URL`; check Neon branch health in console.
- **Data corruption / bad migration:** restore from the pre-promotion backup branch **`prod-pre-promo-2026-06-10`** (Neon Console → Branches → Restore / PITR to a timestamp before the incident). Migrations are additive; prefer code rollback first.
- **Migrations:** never run the full migration runner blindly in prod — it would attempt unrelated/colliding files. Apply specific migrations via a targeted, prod-guarded, direct-endpoint, fail-fast script (pattern: `scripts/promote-046-057.js`).

## 3. Email / SES incident
- **Symptom:** emails not arriving (agreements, notifications, operational close, final report).
- **Connectivity test:** `POST /api/admin/email/test` `{ "to": "<address-you-own>" }` (admin JWT). Returns `message_id` on success, or `502` with `smtp_error`.
- **Common cause — port:** Railway blocks outbound 25/465/587. Prod **must** use `SMTP_PORT=2587` (STARTTLS, `SMTP_SECURE=false`). If `Connection timeout`, confirm `2587`.
- **Auth/identity:** SES creds `SMTP_USER`/`SMTP_PASS`; `EMAIL_FROM=notifications@advantage.bid` (domain must remain SES-verified). Check SPF/DKIM/DMARC on `advantage.bid` if mail lands in spam.
- **Queue backlog:** notifications flow through `notifications_queue` → `notificationWorker`. If backed up, confirm the worker is running (it auto-respawns 5s after exit; a crash loop blocks sends).

## 4. Payments / Stripe incident
- **Mode is TEST** — there is no real money. If real charges are observed, **STOP**: keys were switched to LIVE without the gated reconciliation. Revert to TEST and escalate.
- **Webhook/refund anomalies:** the webhook idempotency + refund-integrity hardening (Line B `b33d720`/`f03809b`) is **NOT in production**. Do not improvise refunds in Stripe; escalate to engineering. See `docs/stripe-live-cutover-prerequisites.md`.

## 5. Worker incident
- Workers: `notificationWorker.js` (emails + state-transition/auto-close scheduler), `imageProcessingWorker.js` (lot image enhancement). Forked by `server.js`; auto-respawn 5s after exit.
- **Auctions not closing / not promoting to active** → `notificationWorker` (the scheduler lives there) is down or crash-looping. Check logs; a restart (redeploy) re-forks workers.
- **Lot images stuck** → `imageProcessingWorker` issue; check Cloudinary creds and worker logs.

## Communication & closeout
- Keep a timeline (UTC). Preserve `audit_log` references for any data actions.
- After resolution: confirm `/api/health` green, run the relevant smoke checks (see first-week checklist), write a brief post-incident note (cause, fix, follow-up).

## Escalation contacts / assets
- Reply-to inbox: `advantageauction.bid@gmail.com`.
- Backup branch: `prod-pre-promo-2026-06-10`.
- Stripe LIVE prerequisites: `docs/stripe-live-cutover-prerequisites.md`.
