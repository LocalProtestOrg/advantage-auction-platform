# Seller Agreement v1 - Staging Validation Plan

**Branch:** `feat/seller-agreement-v1`. Staging-first. **Stop before production.**
**Guardrails:** existing tables only (no dup/rename); migration 070 = 3 additive columns; Buyer Terms v2 untouched; Stripe untouched; Buyer Premium inactive; no payout/payment-flow changes; auctions/lots still require admin review; agreement content em-dash clean.

## What shipped in this branch
- Migration `070_seller_agreement_gate.sql` (additive: `seller_profiles.agreement_waived_at`, `agreement_waived_by`; `agreements.signed_pdf_emailed_at`) + guarded runners `stg-migrate-070.js` / `prod-migrate-070.js`.
- Gate: `agreementService.dashboardAccess()` / `getOnboardingStatus()`; `requireSellerAgreement` middleware on `GET /api/sellers/me/dashboard`; gate check on `POST /api/auctions`.
- Endpoints: `GET /api/agreements/onboarding-status`; `GET /api/agreements/:id/pdf?variant=unsigned`; admin `GET/POST/DELETE /api/admin/agreements/sellers/:id/{gate,waive}`.
- Signed-PDF email **attachment** + `signed_pdf_emailed_at` idempotency stamp (`emailService` gained `attachments`; `agreementPdfService.generateAndStore` returns the buffer; new `buildUnsignedPdfBuffer`).
- UI: `seller-guard.js` (on `seller-dashboard.html`), unsigned-download + onboarding load on `sign-agreement.html`, seller "Seller Agreement" link in `account.html`.
- Content: `docs/seller-agreement-v1-content.md` authored into a template per `seller_type` via the admin UI.
- Tests: `tests/seller-agreement-gate.test.js` (gate + email idempotency), `tests/agreement-unsigned-pdf.test.js`. Full unit suite green (23 suites / 202 tests).

## Pre-deploy (local)
- [ ] `npx jest tests/` green.
- [ ] `node scripts/check-dashes.js` clean.
- [ ] `node --check` on all changed JS (done in build).

## Staging deploy sequence
1. `railway run --service advantage-staging --environment production node scripts/stg-migrate-070.js` -> expect `RESULT: PASS` (ledger[070] recorded + 3 columns present).
2. `railway up --service advantage-staging --environment production --detach` -> wait for green; confirm `/api/health` 200.
3. Author content (admin, staging): create one `agreement_template` (agreement_type per seller_type) + publish a version whose `body_markdown` = the v1 content; set seller `seller_terms` + `seller_identity` so required variables resolve. (Existing admin UI `/admin/agreements.html`.)

## Validation matrix (staging)
**Gate (server-authoritative)**
- [ ] Seed/choose a seller with NO signed agreement and NO non-draft auction. `GET /api/agreements/onboarding-status` -> `dashboard_access:false, required:true`.
- [ ] `GET /api/sellers/me/dashboard` as that seller -> **403 AGREEMENT_REQUIRED** (with `agreement_id` once one is sent).
- [ ] `POST /api/auctions` as that seller -> **403 AGREEMENT_REQUIRED** (cannot create auctions unsigned).
- [ ] Admin `GET /api/sellers/me/dashboard` (admin) -> not gated (bypass).

**Send -> view -> unsigned -> sign -> access**
- [ ] Admin `POST /api/admin/agreements/agreements` sends the agreement (status `sent`, token + link).
- [ ] Seller opens `/sign-agreement.html?onboarding=1` -> loads the pending agreement; "Download unsigned copy" returns a `%PDF` (unsigned, watermarked).
- [ ] Seller signs (typed name + both checkboxes) -> 200; status `signed`; signature row has IP / user-agent / content_sha256 / timestamp.
- [ ] After signing: `onboarding-status` -> `dashboard_access:true, reason:signed`; `GET /api/sellers/me/dashboard` -> 200; `POST /api/auctions` allowed.

**PDF + email**
- [ ] `agreements.pdf_status='stored'`, `signed_pdf_public_id` set; `GET /:id/pdf` returns a 5-min signed URL (PDF downloads).
- [ ] Signed-PDF email delivered to the seller WITH a PDF attachment; `agreements.signed_pdf_emailed_at` stamped exactly once (re-trigger does not re-send).

**Admin visibility / waive (req 7, override)**
- [ ] Admin `GET /api/admin/agreements/agreements/:id` shows the agreement + signatures (metadata verifiable).
- [ ] Admin `GET /api/admin/agreements/sellers/:id/gate` reports state; `POST .../waive` grants access (gate -> 200 for that seller); `DELETE .../waive` re-imposes it. Both audited.

**Grandfather**
- [ ] A seller with an existing non-draft auction (e.g. the demo seller) -> `onboarding-status.reason='grandfathered'`, `dashboard_access:true` (not locked out).

**Guardrail regressions (must be unaffected)**
- [ ] Buyer Terms: v1 still current, v2 still draft (unchanged).
- [ ] Stripe TEST; no payment/premium/payout code paths touched; a buyer bid/checkout on an active staging auction still behaves exactly as before.
- [ ] Auction publish still admin-only (no seller self-publish).
- [ ] `check-dashes.js` clean on the deployed tree; rendered agreement body shows no em/en dashes.

## Rollback (staging)
- Revert the branch deploy; drop the 3 columns (`ALTER TABLE ... DROP COLUMN`); the gate logic treats a seller with non-draft auctions as grandfathered so nothing is hard-locked. No data loss (additive only).

## Production
- NOT in scope for this step. After staging sign-off + counsel review of the agreement content, a separate prod plan: backup tag/branch + Neon snapshot -> `prod-migrate-070.js` -> FF `main` -> author prod template(s) -> grandfather/waive as needed -> validate. Stop here until approved.
