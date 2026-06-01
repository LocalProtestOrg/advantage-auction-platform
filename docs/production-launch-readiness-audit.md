# Production Launch Readiness Audit (2026-06-01)

*Audit/documentation only — no code, no env, no deploys. SES is treated as **blocked pending AWS production-access review**. This audit separates work that can proceed **now** from work that is blocked, and reviews the operational documentation for currency.*

## 0. Verified ground truth (from the read-only prod preflight + repo)
- **Prod** = `advantage-auction-platform` (Railway, branch `main` @ `51dc8c9`, Neon `ep-proud-leaf-an8pzkib`). **Live data:** 27 users, 34 auctions, 88 lots, 17 bids, 12 payments, 504 audit rows.
- **Staging tip** `a7d63e8` is **52 commits** ahead; **migrations 046–057 are genuinely absent on prod** (clean apply, no reconciliation).
- **Stripe = TEST mode** on prod. **`PUBLIC_BASE_URL` unset** (links fall back to the Railway URL).
- **Email = blocked** (Postmark rejected; SES production access pending). Email features degrade gracefully (`sendEmail` returns `{skipped}`; `notifications_queue` retries) — they don't crash, but they don't deliver.

## 1. Production promotion readiness audit — dependency matrix
| Workstream | Gated on | SES-blocked? | Can progress now? |
|---|---|---|---|
| Apply migrations 046–057 to prod (Neon backup first) | owner go/no-go | **No** | ✅ plan/dry-run now (read-only preflight already done) |
| Code promotion (merge `deploy/seller-studio-1b` → `main`) | owner go/no-go; migrations first | **No** (email skips gracefully) | ✅ plan now; execute on go/no-go |
| Stripe **TEST → LIVE** | owner decision (pilot vs GA) | No | ✅ decide now |
| Set **`PUBLIC_BASE_URL`** to canonical prod domain | ops | No | ✅ do as part of cutover |
| Seller-type rules / governance / bg-removal / AI-catalog **activation** | code promotion | No | ✅ ship with promotion |
| **Agreement send** activation | code + **SES** + `PUBLIC_BASE_URL` | **Yes** | ⛔ hold |
| **Governance notification emails** (return-to-draft/rejected) delivery | code + **SES** | **Yes** | ⚠️ workflow works; emails won't deliver until SES |
| Operational close email / final-report PDF email | **SES** | **Yes** | ⛔ hold |

**Key insight:** the **code + migration promotion is NOT strictly SES-blocked** — most of the 52-commit release (seller-type rules, governance moderation, bg-removal, AI catalog, agreement *authoring*) can go live with email simply not delivering yet. **Email-dependent *activation*** (agreement send, notification delivery) is the SES-gated subset. So promotion can be **planned and (on owner go/no-go) partly executed** without SES — with email features left dormant until SES is live. *(Recommendation: still hold the full promotion until the owner is ready and the non-SES decisions below are resolved; don't ship a half-live email surface to real users.)*

## 2. Open NON-SES decisions (resolve while SES is pending)
1. **Stripe test-vs-live** — prod runs `sk_test_*`. Pilot (test payments) or GA (real payments → live keys + live webhook)? Blocks real-money launch.
2. **Promotion scope/timing** — promote the whole 52-commit branch at once (recommended; integration-tested as a unit) vs. a close-engine flag split (see promotion runbook). Owner go/no-go + window.
3. **`PUBLIC_BASE_URL`** — set to the canonical prod domain (affects agreement/notification links; also a branding decision).
4. **The 4 "tracking-gap" migrations (008/017/032/046-class)** — on prod, 046–057 are all genuinely absent, so the apply is clean; confirm no lower-numbered gaps need reconciliation (out of preflight scope).
5. **Pickup-gap rule reconciliation (business-rule discrepancy)** — see §4.

## 3. Pilot launch SOP review — `docs/pilot-runbook.md` ✅ REWRITTEN (2026-06-01)
*Rewritten to current reality: Railway topology + forked workers, env vars, governance moderation lifecycle, seller-type administration, seller agreements (authoring/send/sign/PDF), real queued notifications, the 48h pickup rule, and explicit `⏳ SES-PENDING` markers on all email-delivery sections. The stale findings below are retained for context.*

*(original finding:)* (⚠️ was STALE, 2026-05-08)
Substantively out of date vs the deployed platform:
- **Deployment topology wrong:** describes Nginx/Caddy + PM2/systemd + `.env` on a VPS. **Reality: Railway** (managed, auto-deploy from `main`, `trust proxy` set, **forked workers** for image-processing + notifications). The runbook says "no background worker processes" — false now.
- **Stale business rule:** "pickup ≥ **36 hours**" — deployed enforcement is **48h for non-professional** sellers + professional exemption (seller-type Phase C). 
- **Stale notification status:** lists buyer notifications as "Mock (console only)… wiring to emailService is a post-pilot TODO." **Reality:** `notificationWorker` already sends via `emailService.sendEmail`; the mock is the separate `notificationService._sendEmail` path.
- **No coverage** of: seller-type rules, agreements (send/sign/PDF), governance moderation lifecycle (submit/return-to-draft/reject), audit visibility, AI catalog. 
- **Email section** references Gmail SMTP — superseded by SES.
- **Flagged pre-existing bug to verify:** "`pdfGenerationService.js` joins on `created_by_user_id` which may not match schema" — confirm before relying on final-report email.
**Verdict:** needs a rewrite to reflect Railway + the current feature set + 48h rule + real notifications. **Can be done now (doc work, no SES).**

## 4. Business-rule currency — pickup-gap discrepancy ✅ RESOLVED (2026-06-01)
*Reconciled across `CLAUDE.md`, `business-rules.md`, `product-vision.md`, `sop-pilot-validation.md`, `pilot-runbook.md` to the enforced 48h-non-professional + professional-exemption + sanity-floor rule (basis: Seller-Type Rules Phase C locked decision; "No 36h anywhere"). Documentation-only; no code/rule change. Historical seller-type **plan** docs intentionally retain 36h as decision history.*

*(original finding, for context:)*
- `CLAUDE.md`, `docs/business-rules.md`, `docs/product-vision.md`, `docs/sop-pilot-validation.md` state **"36 hours."**
- Deployed enforcement (seller-type Phase C, validated on staging) is **48h for non-professional** + **professional exemption** + a sanity floor (pickup ≥ close).
- **Reconcile which is canonical** (likely 48h won, per the Phase C decision) and update the rule docs accordingly. This is a **documentation truth** issue independent of SES.

## 5. Deployment / runbook review
| Doc | Status |
|---|---|
| `docs/production-promotion-runbook.md` | ✅ **Current** (this initiative; reflects Railway, 52-commit delta, migrations 046–057, the 3 open blockers) |
| `docs/deployment-readiness.md` | ✅ **Refreshed 2026-06-01** — Railway-aligned; Ready/SES-blocked/promotion-blocked/roadmap split; blockers, risks, migration deps, rollback, validation; stale PM2/nginx/.env/Gmail/mock-notification claims corrected |
| `docs/aws-ses-onboarding-checklist.md`, `postmark-to-ses-*` | ✅ Current (SES initiative) |
| `ops/frontend/docs/deployment-workflow.md`, `rollback-guide.md` | ℹ️ BD widget embeds — separate concern; still valid for that scope |

## 6. Seller onboarding & operational documentation review
| Doc | Verdict | Note |
|---|---|---|
| `docs/sop-seller-onboarding.md` (2026-05-09) | ⚠️ likely **stale** | predates seller-type rules + agreements; manual DB role assignment described — review against current onboarding + the future agreement-gated onboarding (Phase D) |
| `docs/sop-pilot-validation.md` | ⚠️ stale | mentions 36h + Postmark |
| `docs/sop-staging-signoff.md` | ℹ️ references Railway — review for agreement/seller-type coverage |
| `docs/sop-payout-release.md`, `sop-refunds.md`, `sop-incident-response.md` | ℹ️ review for currency (payment/ops) — not obviously stale |
| `docs/sop-postmark-validation.md`, `sop-postmark-dkim-remediation.md`, `email-launch-checklist.md`, `pilot-launch/smtp-readiness.md` | 🗑️ **superseded by SES** | retire/redirect to the SES docs after cutover |
| Public seller pages (`start-selling`, `how-it-works`, `how-sellers-get-paid`, `seller-faq`, `terms`) | ℹ️ review | check for 36h vs 48h, agreement/e-sign mention, payout terms accuracy |

## 7. Recommended NON-SES activities to do now (productive while blocked)
1. **Reconcile the pickup-gap rule** (36h → 48h + professional exemption) across `CLAUDE.md`, `business-rules.md`, `product-vision.md`, `sop-pilot-validation.md`. *(Decision + doc updates.)*
2. **Rewrite `pilot-runbook.md`** for Railway + the current feature set (seller-type, governance, agreements-authoring, real notifications, 48h rule) — clearly marking email/agreement-send as SES-pending.
3. **Refresh/retire `deployment-readiness.md`** (point to the promotion runbook).
4. **Review/refresh `sop-seller-onboarding.md`** against current onboarding (and note the future agreement-gated flow).
5. **Verify the flagged `pdfGenerationService` `created_by_user_id` join** against the live schema (read-only) — a real pre-pilot bug check, SES-independent.
6. **Resolve the open non-SES decisions** (§2): Stripe test/live, promotion window, `PUBLIC_BASE_URL`.
7. **Audit public seller-facing pages** for stale terms (36h, payout, agreement mention).
8. **Mark the Postmark SOPs superseded** (add a redirect banner to the SES docs).

## 8. Launch readiness scorecard
| Area | State |
|---|---|
| Code (staging-validated) | ✅ Ready (4 staging-green checkpoints) |
| Prod DB migration path | ✅ Clean apply list known (046–057); ⏳ needs backup + go/no-go |
| Payments | ⚠️ Decision: Stripe TEST vs LIVE |
| Email / notifications / agreements send | ⛔ **Blocked on SES** |
| Operational docs (runbooks/SOPs) | ⚠️ Several **stale** — refresh recommended (non-SES) |
| Business-rule docs | ⚠️ 36h↔48h discrepancy to reconcile |
| Go/No-Go owner sign-off | ⏳ Pending |

---

## 🛑 Holding on SES; ready to proceed on documentation
SES implementation remains fully paused. The above are **SES-independent** activities. **Recommended next doc tasks (no code):** (1) reconcile the 36h→48h rule across the canonical docs, (2) rewrite the stale `pilot-runbook.md` for Railway + current features. Tell me which to start and I'll draft it (documentation only). If AWS replies to the support case, paste it and I'll draft the response.
