# Stabilization Sprint 1 — Release Readiness & Sprint-Close Validation/Promotion Plan

**Status: PLAN + PREP ONLY.** Nothing in this document has been deployed, pushed,
merged, or applied to production. Stripe remains **TEST**. Buyer Terms v2 is **not**
activated. Branch: `fix/stabilization-sprint-1` (off prod `main@2a13738`).

## 1. Sprint scope (9 committed, validated phases)
| Commit | Phase |
|---|---|
| `610f78e` | Session sliding-renewal + auth-tolerant load + countdown (#4, #7) |
| `f04ea16` | Price-banded increment ladder, single source of truth (#3, #8) |
| `d22d9fe` | Privacy-safe `viewer_is_high_bidder` serializer (#2, #10) |
| `2b384fb` | Real-time bid/close updates (socket.io + pg NOTIFY, polling fallback) (#1) |
| `e0eba88` | Winning/Outbid status panel + Increase-Your-Max-Bid + wording (#2, #10, #16) |
| `7108f7f` | Continuous registration flow + shared nav + My Bids + Watchlist (#5, #6) |
| `6394cfe` | Email reliability (lease/backoff/staleness) + enriched buyer emails (#11, #13, delay) |
| `5b0bd5c` | Lot title/category bug + bid chime + video verify (#12, #14, #15) |
| `1a49438` | Buyer Terms v2 recommendations (doc-only) |

**Automated tests:** 161 passing / 18 suites. **Live staging validations:** realtime
bridge 8/8, My Bids + Watchlist 7/7, email-queue mechanics 7/7.

## 2. Migration delta audit (proven, read-only — `neondb`, `ep-proud-leaf-an8pzkib`)
- Branch migration files: **65 (`001`–`065`)**. Prod `schema_migrations`: **61 rows**.
- **058–064:** applied AND schema objects present (launch-day promotion). ✔
- **065_notification_queue_lease:** **NOT recorded, object ABSENT** (no `next_attempt_at`;
  status CHECK still `pending/sent/failed`) → **truly pending, REQUIRED**. The new
  worker depends on the lease/backoff columns + `processing/skipped` states.
- **017, 032:** schema objects **present** (already applied) but ledger rows missing →
  **historical bookkeeping gaps, NOT promotion blockers.** Do not re-apply.
- **008_add_missed_pickup_handling:** object ABSENT (unapplied) **and its SQL is invalid**
  (partial `UNIQUE` table constraint). **Do NOT apply.** Not required by any live code.

### Migration rule for this promotion
- **Apply ONLY `065_notification_queue_lease.sql`.**
- **Never** run `run-migrations.js` against production (it would attempt `008` (errors) and
  redundantly re-attempt `017/032`).
- **Do NOT** apply `008`, `017`, or `032`.
- Apply via the dedicated guarded script `scripts/prod-migrate-065.js` (below).

## 3. Release-readiness verdict
Code-complete; unit- and data-validated. **Ready to enter the Sprint-Close Validation
gate.** Not ready to *promote* until the gate passes with explicit GO. New code must not
reach prod before 065 is applied (worker hard-depends on it).

## 4. Prep artifacts (this phase — built, not run against prod)
- `scripts/prod-migrate-065.js` — production-guarded, **065-only** apply (idempotent;
  pre/post schema verification; records the ledger row only for 065; refuses non-prod;
  never touches 008/017/032 or iterates the migrations dir).
- `scripts/prod-check-065.js` — read-only pre/post checker (safe on any endpoint).
- `scripts/stg-sprint-close-validate.js` — automated two-buyer staging harness (run AFTER
  staging deploy of the branch).
- `docs/projects/sprint-close-validation-checklist.md` — manual/visual/mobile checklist.

## 5. Sprint-Close Validation & Promotion sequence (each step gated on explicit GO)
1. **Confirm prep** — `prod-check-065.js` against prod (read-only) shows 065 ABSENT (the
   expected "before" state); 058–064 present.
2. **Backup** — create a fresh Neon prod backup branch; record name/ID/timestamp.
3. **Staging deploy** — deploy `fix/stabilization-sprint-1` to the staging service; confirm
   boot/health/workers.
4. **Full two-buyer staging validation (Stripe TEST)** — run `stg-sprint-close-validate.js`
   + work the manual checklist (visual/audio/mobile). Must pass.
5. **Merge (fast-forward, on approval):** `fix/stabilization-sprint-1 → deploy/seller-studio-1b → main`.
6. **Apply prod migration 065 ONLY** — after backup, `node scripts/prod-migrate-065.js`
   (RESULT: PASS). Re-run `prod-check-065.js` → 065 present.
7. **Deploy prod from `main`;** confirm new boot + health + workers + reconciliation block.
8. **Full prod validation (Stripe TEST)** — A–O suite + sprint items (checklist §"prod").
   Then **STOP**: no Stripe LIVE cutover, no Terms v2 activation.

## 6. Rollback
- **Code:** redeploy prior `main@2a13738`.
- **DB:** 065 is additive (new nullable columns + widened CHECK + indexes) — no destructive
  change; old code tolerates it. Worst case: restore from the Neon backup branch.
- **065 apply failure:** the script applies inside a transaction and rolls back on error;
  the ledger row is written only on success.

## 7. Hard constraints (all phases until explicit LIVE approval)
No Stripe LIVE. No Terms v2 activation. No custom-domain cutover (Railway prod domain).
Apply only 065. Never `run-migrations.js` on prod. Never apply 008.

## 8. Additional Release-Readiness Findings — Domain, Admin Controls, Buyer Premium, Tax Exemption
Audited 2026-06-14 (read-only). Detailed docs: `bid-domain-cutover-plan.md`,
`admin-auction-controls-audit.md`, `buyer-premium-audit-and-plan.md`,
`admin-buyer-controls-audit.md`, `tax-exemption-reseller-certificate-plan.md`.

- **bid.advantage.bid cutover** is part of launch readiness. It is **env/config-only**
  (set `FRONTEND_URL` + Railway custom domain + DNS CNAME) — pure JWT/localStorage (no
  cookies), relative links, `location.origin` Stripe returns, dashboard-configured
  webhook. Prod `FRONTEND_URL` is currently **unset** → email links fall back to the wrong
  domain. No code change for buyers (a dual-origin transition window would need a small
  socket.io cors change). Do at promotion; does not gate staging code validation.
- **Admin auction editing** — core fields (title/description/times/pickup/address/images/
  lifecycle) ARE admin-editable and audited. **Gaps:** no per-auction buyer premium or
  sales-tax controls (those features don't exist); orphan columns uneditable
  (`auction_terms`, `increment_ladder`, `default_starting_bid_cents`, `admin_notes`,
  `public_auction_type`); staggered-close/anti-snipe are hardcoded (match the rules); no
  seller reassignment; archive/discovery endpoints lack UI; no closed-state guard at the
  service layer. The editable set is **sufficient for a TEST-mode public launch** if the
  hardcoded-timing exception is accepted.
- **Buyer premium** — **not charged or displayed today (0%, hammer price only).** Live
  display is an unmet CLAUDE.md requirement. Editability/charging is **required before
  Stripe LIVE only if a non-zero premium will be charged**; safe to launch TEST at 0%.
- **Admin buyer controls** — **no admin buyer-management surface**; suspend/unsuspend are
  seller-keyed and cannot reach pure buyers. **Minimum (buyer search/view + user-id-keyed
  suspend/activate + registration revoke) is recommended as a public-launch operational
  requirement.** Schema is ready; endpoint+UI work only.
- **Tax exemption / reseller** — **sales tax itself is unbuilt.** A tax-collection decision
  plus a (manual-first) exemption flow is a **hard Stripe-LIVE gate and a compliance
  (attorney/CPA) gate** — **not** a TEST-launch blocker.

### Impact on production promotion
The stabilization sprint (9 phases) is **independent** of these gaps and can be promoted +
validated on its own. These findings shape **public-launch** (domain + minimal admin buyer
controls) and **Stripe-LIVE** (tax, premium-if-charged, Terms v2 money clauses) readiness —
they do not block the staging code validation.

### Updated Go / No-Go
**Promote stabilization sprint (Stripe TEST):**
- [ ] Staging two-buyer validation passes (checklist).
- [ ] Backup taken; **migration 065 only** applied (`prod-migrate-065.js` → PASS); 058–064 already present; 008 NOT applied.
- [ ] Prod deploy healthy; full prod validation (TEST) passes.

**Public launch (Stripe TEST) adds:**
- [ ] `bid.advantage.bid` configured (Railway custom domain + DNS) and **validated** (app loads, socket.io connects, emails link to it).
- [ ] **No Railway/`advantageauction.bid` buyer-facing links remain** in emails/public flows (`FRONTEND_URL` set).
- [ ] Admin can edit the required auction settings **or** the gaps are explicitly accepted as launch exceptions (hardcoded staggered/anti-snipe documented).
- [ ] **Minimum admin buyer controls** (find/view/suspend a buyer; revoke a registration) present **or** explicitly accepted as a launch exception.
- [ ] Buyer premium behavior is **known and approved** (e.g., launch at 0%).

**Stripe LIVE adds (hard gates):**
- [ ] **Tax treatment known and approved** (collection decision + at least a manual exemption flow), with attorney/CPA sign-off.
- [ ] Buyer premium implemented + disclosed live **if** any premium will be charged.
- [ ] Buyer Terms **v2** money clauses (premium, auto-charge, payment timing, tax) drafted (attorney) and activated, aligned with the LIVE cutover.
- [ ] Final production TEST-mode auction passed (existing gate).

## 9. Recommendation (Go/No-Go summary)
- **Proceed to staging validation now — YES.** The sprint is independent of the new gaps.
- **Plan admin/premium/tax/domain in parallel** — do not pause the staging validation for them.
- **Blocks PUBLIC launch (TEST):** `bid.advantage.bid` cutover (config) + minimum admin
  buyer controls (or accepted exception). Admin auction editing is sufficient as-is.
- **Blocks Stripe LIVE (hard stops):** tax-collection + exemption decision (compliance);
  buyer premium (if charging) implemented + live-disclosed; Terms v2 money clauses active.
- **Can wait:** increment-ladder editor, seller reassignment, admin read views, archive/
  discovery UI, `admin.advantage.bid`, walkthrough uploader, SEO canonicals.

**Direct call:** None of these pause the **stabilization-sprint** promotion or the staging
validation. They do gate the broader **public launch** (domain + admin buyer safety) and,
most importantly, **Stripe LIVE is blocked until the sales-tax/exemption decision is made
with attorney/CPA review** — that is the single largest LIVE prerequisite surfaced today.
