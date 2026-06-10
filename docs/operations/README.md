# Operations Runbooks — Advantage Auction Platform

Operational documentation for the production pilot. Created 2026-06-10 against production release `e0f005f`.

## Production architecture (at time of writing)
| Component | Detail |
|---|---|
| App | Railway service **`advantage-auction-platform`**, env `production`, deploys `origin/main` @ `e0f005f`. URL: `https://advantage-auction-platform-production.up.railway.app` |
| Background workers | Forked child processes: `src/workers/notificationWorker.js` (email/notifications + state-transition scheduler) and `src/workers/imageProcessingWorker.js`. Auto-respawn 5s after exit. |
| Database | Neon PostgreSQL, prod branch endpoint `ep-proud-leaf-an8pzkib` (pooled). DDL via the **direct** endpoint (strip `-pooler`). Migration tracking: `schema_migrations` (highest applied `057`). |
| Email | Amazon SES SMTP — `email-smtp.us-east-1.amazonaws.com:2587` (STARTTLS, `SMTP_SECURE=false`). From `notifications@advantage.bid`, reply-to `advantageauction.bid@gmail.com`. |
| Payments | **Stripe TEST mode** (`stripe_mode=test`). LIVE cutover gated — see `docs/stripe-live-cutover-prerequisites.md`. |
| Health | `GET /api/health` → `{status, env, db_reachable, stripe_configured, stripe_mode, email_configured}` |
| Admin access | Login `/login.html` → `/admin/index.html`. Auth = JWT Bearer (`Authorization: Bearer <token>`), role `admin`. Browser stores it in `localStorage['token']`. |
| Active admins (as of 2026-06-10) | **`admin@advantage.bid`** — primary operational admin. **`tylerwitt2015@gmail.com`** — personal / recovery admin. Seeded admins `validation-admin@advantage.bid` and `test-admin@example.com` are **disabled** (`is_active=false`, retained not deleted). See `docs/planning/admin-access-and-operational-ownership-audit.md`. |

## Index
1. `pilot-seller-onboarding-runbook.md`
2. `buyer-support-runbook.md`
3. `auction-publish-runbook.md`
4. `auction-close-runbook.md`
5. `production-incident-response-runbook.md`
6. `first-week-monitoring-checklist.md`
7. `pilot-launch-checklist.md`

> These are operational guides, not code. They do not change application behavior. Verify any endpoint/state against the codebase before relying on it for a destructive action.
