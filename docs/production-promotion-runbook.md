# Production Promotion Runbook — `deploy/seller-studio-1b` → production

*Planning only. No code, no migrations, no deploys. This runbook promotes the entire staged branch to production. **Read §1 first — this is a large release, not just "agreements."***

> 🚫 **OPEN PRODUCTION BLOCKERS (from the 2026-06-01 read-only preflight) — do NOT promote email-dependent features until resolved:**
> 1. **Postmark DKIM inactive for `advantage.bid`.** Return-Path verified + SPF includes `spf.mtasv.net`, but DKIM is not active and the Postmark **account shows a deactivated warning**. The published DKIM record is *valid and well-formed* (`v=DKIM1; k=rsa; p=…`, single record, propagated), so the issue is **not** the DNS record's structure — most likely a **stale/rotated key mismatch** (published key ≠ Postmark's current expected key) and/or **Postmark account deactivation/pending approval**. Owner action in the Postmark dashboard: byte-compare the dashboard DKIM value vs the published one, replace if different, resolve account approval, re-Verify. **All 12 migrations are genuinely absent on prod (verified) — clean apply, no reconciliation.**
> 2. **Stripe is in TEST mode on prod** — confirm pilot-vs-GA intent before accepting real payments.
> 3. **`PUBLIC_BASE_URL` unset** — set to the canonical prod domain before enabling agreement send (links currently fall back to the Railway URL).

> ⚠️ **Scope reality:** `origin/main` (production) is at **`51dc8c9`** ("Phase 1 P1-D"). The branch tip `deploy/seller-studio-1b` is **`a7d63e8`** — a **52-commit** delta that has never reached production. It includes: GOV/AUD governance, OPS (suspension/audit), INT (auto-close scheduler), AI Catalog Assistant Phase 2A, Seller-Type Rules (B + C/C.2), Background-Removal fix, and Seller Agreements A/B. **12 migrations (046–057)** are new in this delta. Treat this as a major release with staged feature *activation*, not a small agreements push.

---

## 1. Production Readiness Assessment

### 1.1 Current staging-green checkpoints (all on `deploy/seller-studio-1b`, sequential)
| Checkpoint tag | Commit | Covers |
|---|---|---|
| `checkpoint/seller-type-phase-c-c2-staging-green` | `5048307` | Seller-type 48h rule + pro-only controls |
| `checkpoint/bg-removal-persistence-fix-staging-green` | `a02ad0a` | Background-removed image persists |
| `checkpoint/seller-agreement-phase-a-staging-green` | `e1d919d` | Agreements data + admin authoring |
| `checkpoint/seller-agreement-phase-b-staging-green` | `a7d63e8` | Agreements send/sign/PDF lifecycle |
> The branch tip `a7d63e8` contains all four. Promoting it promotes the whole 52-commit delta.

### 1.2 Production environment
- **Service:** `advantage-auction-platform` (Railway), tracks `main`, domain `advantage-auction-platform-production.up.railway.app`.
- **DB:** prod Neon endpoint `ep-proud-leaf-an8pzkib` (distinct from staging `ep-polished-cake-anq3xrza` — verified isolated).
- **Currently running:** `main` @ `51dc8c9`.

### 1.3 Production prerequisites
- Migrations **046–057** applied to the prod DB **before** the code deploy (additive; code tolerates their presence, but the new code requires the new tables/columns).
- A confirmed **Neon backup branch** of prod (rollback point).
- Required env vars present on the prod service (§1.4).
- A maintenance/low-traffic window; rollback owner on call.

### 1.4 Required environment variables (prod service)
**Hard-required (server exits without these — `server.js` REQUIRED_ENV + Stripe-in-prod):**
- `JWT_SECRET`, `DATABASE_URL` (prod Neon), `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
**Required for the promoted features:**
- `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` — lot images + **signed-PDF private delivery** (confirm the prod Cloudinary account allows **raw + private/authenticated** assets and signed URLs)
- `SMTP_PASS` (Postmark Server API token) + `EMAIL_FROM` / `EMAIL_REPLY_TO` — **agreement + notification emails** (prod must have a live token; staging had `email_configured:false`)
- `PUBLIC_BASE_URL` (and/or `FRONTEND_URL`, `SITE_URL`) = the **prod public domain**, so agreement **signing links** and notification links resolve correctly
- `ANTHROPIC_API_KEY` — AI Catalog Assistant Phase 2A (in this delta) and the future Agreement Assistant; without it those features must degrade to explicit errors, not silent fallback
**Recommended:** `SENTRY_DSN` (error monitoring), `ADMIN_EMAIL`, `NODE_ENV=production`.

### 1.5 Required migrations (new in this delta)
`046_add_users_is_active`, `047_add_auction_revision_columns`, `048_add_auction_returned_to_draft_notification`, `049_add_auction_rejection_columns`, `050_add_auction_rejected_notification`, `051_expand_seller_type`, `052_create_lot_ai_verifications`, `053_create_agreement_templates`, `054_create_seller_terms`, `055_create_seller_identity`, `056_create_agreements`, `057_agreements_phase_b`.
> **Note:** some (e.g. 046) may already be *physically* applied on prod but untracked in `schema_migrations` (this was true on staging). The **read-only prod preflight (§2.2)** determines the exact gap — do not assume.

### 1.6 Rollback readiness (must exist before starting)
- Neon backup branch created and its restore command known.
- The current prod commit (`51dc8c9`) recorded for code rollback.
- All additive migrations (safe to leave on rollback — they don't break the old code).
- A named go/no-go owner and a communication channel.

---

## 2. Database Promotion Plan (DB before code)

### 2.1 Backup strategy
- Create a **Neon branch/snapshot of the prod database** immediately before any migration (Neon branches are instant, copy-on-write — the cheapest reliable rollback). Record the branch name + timestamp.
- Do **not** mutate prod data during migration; 046–057 are additive (new tables/columns/constraints) and do not backfill destructively.

### 2.2 Read-only prod preflight (gated — confirm the real gap)
- Run a **read-only** script under `railway run --service advantage-auction-platform`, **gated** to assert the effective `DATABASE_URL` host is the prod endpoint (`ep-proud-leaf-an8pzkib`) before any read — mirror the staging preflight pattern.
- Output: which of 046–057 are recorded in `schema_migrations`; whether their objects already physically exist (e.g. `users.is_active`, `seller_profiles` constraint, `agreements` table); the current `agreements.status` CHECK.
- This produces the **authoritative apply list** and surfaces any tracking gaps (apply vs. skip vs. record-only).

### 2.3 Migration order + batched verification
Apply in ascending order, **surgically** (each in its own transaction, recorded in `schema_migrations`), gated on the prod endpoint — the same approach used for staging 051/052 and 053–057. Suggested **batches with a verification gate between each**:

- **Batch G — governance (046–050):** verify `users.is_active`, `auctions` revision/rejection columns, the two notification types exist; the governance suite's writers function.
- **Batch S — seller-type (051–052):** verify the widened `seller_profiles_seller_type_check` (includes `auction_house` etc.) and `lot_ai_verifications` table.
- **Batch A — agreements core (053–056):** verify `agreement_templates`, `agreement_template_versions`, `seller_terms`, `seller_identity`, `agreements`, `agreement_signatures`.
- **Batch B — agreements Phase B (057):** verify the widened `agreements.status` CHECK + token/supersede/revoke/`pdf_status`/`signed_pdf_public_id` columns.

After each batch: re-query the affected objects (column/constraint existence) and confirm `schema_migrations` recorded the batch. **Stop on any FAIL** and assess before proceeding.

### 2.4 DB rollback procedure
- Additive migrations are **safe to leave** even if the code is rolled back (old code ignores new tables/columns). Prefer leaving them.
- If a migration **fails mid-apply**: it ran in a transaction → rolled back automatically; fix and re-run that file only.
- If a destructive problem is discovered: **restore the prod DB from the Neon backup branch** taken in §2.1 (point-in-time), then re-assess.

---

## 3. Code Promotion Plan

### 3.1 Branch strategy
- Source: `deploy/seller-studio-1b` @ `a7d63e8` (staging-green tip).
- Target: `main` (prod-tracking).
- No rebase of the 52 commits; promote as-is (they are integration-tested on staging as a unit).

### 3.2 Merge strategy
- Open a **PR `deploy/seller-studio-1b` → `main`** (review the 52-commit delta + 12 migrations summary).
- Merge with a **merge commit** (preserve history/lineage) — *not* squash (keeps the per-feature commits + checkpoint lineage intact).
- **Order:** migrations (§2) **first**, then merge → prod auto-deploys. The new code needs the new schema present at boot.

### 3.3 Deployment sequence
1. Neon backup branch (§2.1) ✔
2. Prod preflight (§2.2) ✔
3. Apply migration batches G→S→A→B with verification (§2.3) ✔
4. Confirm prod env vars (§1.4) ✔
5. Merge PR → `main` → `advantage-auction-platform` auto-deploys.
6. Poll `railway status` until the new commit shows `SUCCESS` + instance `RUNNING`.

### 3.4 Deployment verification
- `GET /api/health` → `200`, `env` prod, `db_reachable:true`, `stripe_configured:true`; uptime reset confirms the new build is live.
- `railway status --json` deployment `commitHash === a7d63e8` (or the merge commit), status `SUCCESS`.
- No boot crash loop in Railway logs; workers (image-processing, notification) start.

---

## 4. Validation Matrix (post-deploy, against prod — read-mostly + clearly-labeled test data, cleaned up)
> Run with **seeded validation identities** only; never speculative credentials. Create only the smallest test artifacts and **clean them up** (mirror the staging matrices). Avoid mutating real seller/buyer data.

| Domain | What | How |
|---|---|---|
| **API** | core endpoints respond; auth/role gates hold | targeted API matrix (admin/seller/buyer seeded logins) |
| **Playwright** | governance regression suite | `e2e/governance-regression.spec.js` against prod `BASE_URL` (**note:** it mutates — confirm it is acceptable on prod, or run a read-only subset; the suite is staging-labeled by design) |
| **Admin** | moderation, seller-type assignment, agreement template authoring + per-seller terms/identity | admin API matrix (reuse the Phase A matrix shape) |
| **Seller** | dashboard loads, agreement review/sign, my-agreements | the Phase B sign-flow matrix (one seeded seller, cleaned up) |
| **Payment** | Stripe config endpoint, idempotency keys, webhook signature | `GET /api/payments/config`; `e2e/payments/*` idempotency specs (read-only/seeded) |
| **Agreement** | send → token view → sign → signed PDF (signed URL) → resend/reissue/revoke/expiry → audit | the Phase B API matrix (14 checks), cleaned up |
| **Notification** | Postmark actually delivers in prod | send one agreement to a **controlled internal address**; confirm Postmark `messageId` + delivery (prod has a live token, unlike staging) |

**Gate:** all domains green (or explicitly accepted) before enabling seller-facing agreement send.

## 5. Rollback Runbook
### 5.1 Code rollback
- Revert the merge on `main` (or reset `main` to `51dc8c9`) → prod auto-redeploys the prior build. Record the action.
### 5.2 Database rollback
- Default: **leave** additive migrations (old code ignores them — no rollback needed).
- If schema corruption/data issue: **restore prod from the Neon backup branch** (§2.1).
### 5.3 Decision thresholds (roll back if…)
- Boot crash loop / health endpoint not `200` after deploy.
- Auth, bidding, payment, or auction-close broken (critical infrastructure).
- Migration verification FAIL that can't be hotfixed in-window.
- Elevated 5xx / error-monitor spike attributable to the release.
### 5.4 Go/No-Go criteria (proceed only if ALL true)
- Neon backup branch exists; preflight ran; all migration batches verified.
- Prod env vars complete (§1.4); health green; deployment `SUCCESS`.
- Validation matrix (§4) green or risks explicitly accepted by the owner.
- Rollback owner on call.

## 6. Operational Monitoring (during + 24–48h after)
- **Railway:** `railway logs --service advantage-auction-platform` — boot, worker start, request errors; watch for restart loops.
- **Postmark:** dashboard — agreement/notification delivery, bounces, spam complaints (now that prod sends real email).
- **Cloudinary:** Media Library / usage — agreement PDF (raw/private) uploads succeed; signed-URL delivery works; no quota errors.
- **Railway/health:** periodic `GET /api/health` (uptime, db_reachable, stripe_mode).
- **Neon:** dashboard — connection count, storage, the backup branch retained until sign-off.
- **Error monitoring:** Sentry (`SENTRY_DSN`) — new error types post-release; set an alert threshold for the release window.

## 7. Launch Sequencing
> All 52 commits deploy **together** (one branch merge). Sequencing here means **activation order of seller-facing behavior**, not separate deploys.
1. **Seller-Type Rules (51/52 + code):** server-authoritative — active on deploy. Verify the 48h rule + pro-only controls behave; admins can assign `seller_type`.
2. **Background-Removal Persistence:** active on deploy; verify a seller upload with enhancement persists the processed image.
3. **Seller Agreements A then B:** ship admin authoring (A) **first-verified** (templates/terms/identity), then verify the full send→sign→PDF path (B) with one internal test agreement **before** announcing/enabling seller-facing send broadly.
4. **Future onboarding gate (Phase D):** **not in this release** — ship behind a flag later, only after agreements are proven in prod (avoid blocking real sellers' first auctions on day one).

## 8. Success Criteria — production acceptance checklist (objective)
- [ ] Neon prod backup branch created (name + timestamp recorded).
- [ ] Preflight ran; migrations 046–057 applied (or confirmed already-present) and recorded; all batch verifications green.
- [ ] Prod env vars complete (§1.4); `GET /api/health` 200 with `db_reachable:true`, `stripe_configured:true`.
- [ ] Deployment `SUCCESS`, prod serving the merge commit; workers running; no crash loop.
- [ ] Validation matrix (§4) green: API, governance, admin, seller, payment, agreement, **notification (real Postmark delivery)**.
- [ ] Agreement signed-PDF stored privately + retrievable via short-lived signed URL on prod.
- [ ] No critical errors in Sentry/Railway logs for the first 60 minutes.
- [ ] All test artifacts created during validation cleaned up; no test data left in prod.
- [ ] Rollback verified-available (backup branch + revert path).

## 9. Production Checkpoint Strategy
- **Naming convention:** `checkpoint/prod-promotion-<yyyymmdd>` for the release, and per-area prod confirmations `checkpoint/prod-<feature>-green` (e.g., `checkpoint/prod-seller-agreements-green`) once validated in prod. (Distinct from the `…-staging-green` tags.)
- **Promotion checkpoints:** tag the **merge commit on `main`** after the deployment is verified (annotated, with the migration list + validation summary); push to origin; verify peeled ref dereferences to the merge commit.
- **Documentation updates:** update `project_checkpoints.md` (memory) with the prod tag + what was validated; update `project_seller_agreement_system_decisions.md` / staging-state memories to record "promoted to prod @ <commit>, migrations 046–057 applied to prod"; note the prod migration baseline so future promotions know the new floor.

---

*End of runbook. Planning only — no code, migrations, or deploys performed. Awaiting go/no-go before any production action.*
