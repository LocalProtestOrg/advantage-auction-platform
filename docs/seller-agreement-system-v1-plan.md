# Seller Agreement System v1 — Design & Deployment Plan (pre-implementation)

**Status:** DESIGN ONLY. No code written. Awaiting approval + decisions (§9).
**Date:** 2026-06-17

---

## 0. The key reframe (verified against live prod/staging)

This is **not greenfield.** Phases A & B of a seller agreement system were already built and are **deployed to production** — they are simply **unused** (no data).

Verified 2026-06-17:
- **Schema migrations 053–057 are LIVE on prod and staging.** Tables present on both: `agreement_templates`, `agreement_template_versions`, `seller_terms`, `seller_identity`, `agreements`, `agreement_signatures`.
- **Code is deployed & mounted on prod:** `/api/agreements/*` → 401 (auth-gated), `/api/admin/agreements/*` → 401, `/sign-agreement.html` → 200, `/my-agreements.html` → 200.
- **Data is empty:** 0 templates / 0 versions / 0 agreements / 0 signatures / 0 seller_terms / 0 seller_identity. Nothing is in use.

**Implication:** v1 = (a) reuse the existing model, (b) build the **4 genuinely-new pieces**, (c) author content + activate. No rebuild.

---

## 1. Requirement-by-requirement reconciliation

| # | Requirement | Status today | v1 work |
|---|---|---|---|
| 1 | Execute agreement before dashboard access | ❌ no gate exists | **NEW — onboarding gate** |
| 2 | Versioned system like terms_versions | ✅ `agreement_templates`→`agreement_template_versions` (immutable, per-type) — superset of terms_versions | reuse |
| 3 | Create `seller_agreement_versions` / `_acceptances` / `_signatures` | ⚠️ existing tables serve these roles under different names (see §2) | **recommend reuse, not new tables** |
| 4 | Signature workflow (legal name, checkbox, typed sig, timestamp, IP, UA) | ✅ all captured in `agreement_signatures` (`typed_name`, `consent_acknowledged`, `signed_at`, `ip_address`, `user_agent`, `content_sha256`); `trust proxy` on | reuse |
| 5 | After signing: PDF, store ref+version+metadata, **email PDF**, **enable dashboard** | ✅ PDF+store+version+metadata exist (PDFKit→Cloudinary private+SHA-256); ❌ email-of-PDF; ❌ dashboard enable | **NEW — email + gate flip** |
| 6 | Seller: view before signing, **download unsigned**, download signed, **re-download from account settings** | ✅ view (`sign-agreement.html`), signed download (`GET /:id/pdf`); ❌ unsigned PDF; ❌ account-settings entry | **NEW — unsigned PDF + account link** |
| 7 | Admin: view accepted, version history, download signed PDF, verify metadata | ✅ all via `/api/admin/agreements/*` + `admin/agreements.html` | reuse (minor surfacing) |
| 8 | Activate seller immediately after execution | ❌ | **NEW — part of the gate** |
| 9 | Auction publication stays human-reviewed | ✅ publish already admin-only (`auctionService` publish requires admin; "Advantage publishes auctions, not sellers") | unchanged — confirm only |
| 10 | No Stripe / Buyer Premium / Buyer Terms / settlement / payment changes | ✅ none of the above are touched by this design | hard guardrail |

**Net-new work = 4 things:** (A) onboarding/dashboard gate, (B) email the signed PDF, (C) unsigned-copy PDF + download, (D) auto-send the agreement on seller signup so there is something to sign. Everything else is reuse + content authoring.

---

## 2. On the three requested table names

Recommendation: **do NOT create `seller_agreement_versions` / `seller_agreement_acceptances` / `seller_agreement_signatures`.** The existing tables already fill those roles with a stronger, audited model. Creating parallel tables would fragment the data and duplicate logic.

| Requested table | Existing equivalent | Why the existing one is better/equivalent |
|---|---|---|
| `seller_agreement_versions` | `agreement_templates` + `agreement_template_versions` | Immutable, per-`seller_type` versioned templates with a `variable_schema` and frozen render — richer than a flat versions table. |
| `seller_agreement_acceptances` | `agreements` (lifecycle: draft→sent→viewed→signed→…) | A full per-seller agreement instance with frozen `rendered_body` + `resolved_variables` + status, not a passive click-ledger. |
| `seller_agreement_signatures` | `agreement_signatures` | Same name, same purpose — already captures typed/drawn sig, consent, intent, timestamp, IP, UA, content SHA-256. |

**Owner-locked 2026-06-17:** reuse existing tables; **do not create duplicate tables** and **do not add views or rename** anything. The literal names `seller_agreement_versions/_acceptances/_signatures` are NOT created — the existing tables are the single source of truth.

---

## 3. Architecture (v1)

```
Seller signs up ──► (D) auto-send matching template agreement (status=sent, token)
        │
        ▼
Seller logs in ──► onboarding gate (A): hasSellerDashboardAccess(sellerProfileId)?
        │                       │
        │  NO (no signed agreement, not waived)        YES (signed OR admin-waived OR grandfathered)
        ▼                                              ▼
  redirect to /sign-agreement.html              full seller dashboard
        │
        ▼
  Review (frozen rendered_body) ─ download UNSIGNED (C) ─ checkbox + typed name + (optional drawn)
        │
        ▼  POST /api/agreements/:id/sign  (auth + ownership; captures IP/UA/timestamp/SHA-256)
  status=signed ──► PDFKit→Cloudinary private (existing) ──► (B) email signed PDF ──► gate flips OPEN
        │
        ▼
  Seller dashboard enabled immediately (req 8). Auction publish still admin-reviewed (req 9).
```

**Server-authoritative principle:** the gate is enforced in the API/middleware, never only in the browser. The dashboard HTML redirect is a UX convenience; the seller-write endpoints independently enforce the gate.

---

## 4. Migrations (additive only)

Existing 053–057 stay as-is. **One new additive migration:**

**`070_seller_agreement_gate.sql`**
- `ALTER TABLE seller_profiles ADD COLUMN agreement_waived_at TIMESTAMPTZ NULL;`  — admin override / grandfather marker.
- `ALTER TABLE seller_profiles ADD COLUMN agreement_waived_by UUID NULL REFERENCES users(id);`
- `ALTER TABLE agreements ADD COLUMN signed_pdf_emailed_at TIMESTAMPTZ NULL;`  — idempotency for the PDF email (req 5).
- (Optional, decision §9-A) three read-only `CREATE VIEW seller_agreement_versions/_acceptances/_signatures AS …` over existing tables.

No table drops, no type changes, no backfill required. Fully reversible (drop columns/views). Follows the project's per-file guarded migration + `schema_migrations` ledger discipline.

**Grandfathering:** existing sellers with live/active auctions are not locked out (their `agreement_waived_at` is set during the cutover migration, or the gate treats "has any non-draft auction" as grandfathered — decision §9-C).

---

## 5. API endpoints

**Reuse (already deployed):** all of `/api/admin/agreements/*` (templates, versions, terms, identity, send, resend, reissue, revoke) and seller `/api/agreements/{mine,:id,:id/sign,:id/pdf,by-token/:token}`.

**New / changed:**
| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/api/agreements/onboarding-status` | seller's gate state: `{ required, signed, waived, agreement_id, dashboard_access }` | drives the redirect + dashboard render |
| GET | `/api/agreements/:id/pdf?variant=unsigned` | download **unsigned** copy (C) | new PDFKit render path (no signature block); auth+ownership |
| POST | `/api/agreements/:id/sign` | **extend** existing: after signed, (B) email signed PDF (attach or link), set `signed_pdf_emailed_at`; gate auto-opens | no behavior change to the legal capture itself |
| POST | `/api/admin/agreements/sellers/:sellerProfileId/waive` | admin waives the gate (override) | `agreement_waived_at/by`; audited |
| (hook) | seller registration | (D) auto-create + send matching `seller_type` template agreement | server-side, on signup |

**Gate enforcement points (server-side):** the seller-dashboard data endpoints and any seller write path (e.g. auction create/submit) call `requireSellerDashboardAccess` middleware → 403 `AGREEMENT_REQUIRED` with the agreement id to sign. Admin bypasses (admin override preserved).

---

## 6. UI flow

- **`sign-agreement.html`** (exists) — add an **"Download unsigned copy"** button (C). Otherwise unchanged (frozen body, checkbox, typed name, optional drawn canvas, login-to-sign).
- **Onboarding redirect** — a tiny shared check (reuse `buyer-nav`/a seller-nav include or a `seller-guard.js`): on seller pages, call `/api/agreements/onboarding-status`; if `dashboard_access=false`, redirect to `/sign-agreement.html?onboarding=1` (which loads the seller's pending agreement). After signing → redirect to dashboard.
- **`account.html`** — add a "Seller Agreement" row (re-download signed copy; link to `my-agreements.html`) (req 6).
- **`my-agreements.html`** (exists) — already lists agreements with Review/Download; surfaced from account settings.
- **`admin/agreements.html`** (exists) — already covers view accepted / version history / download signed / verify metadata (req 7); add a "Waive gate" control for the override.
- **No auction-platform homepage/index changes. No BD widget work.** (Standing guardrails.)

---

## 7. Storage approach

Unchanged from the deployed design (owner-locked):
- Signed PDF → **Cloudinary private raw** asset (`folder: agreements`, `resource_type: raw`, `type: private`, `public_id: agreement-{id}`), with `signed_pdf_public_id` + `signed_pdf_sha256` stored on `agreements`.
- Delivery via **5-minute signed download URLs** (`cloudinary.utils.private_download_url`) through the auth-gated `GET /:id/pdf` — the raw Cloudinary URL is never exposed.
- Unsigned copy (C): generated on demand from the frozen `rendered_body`; **not stored** (no signature, no legal weight) — streamed directly or via the same signed-URL pattern. (Decision §9-B if we prefer to store it.)
- Frozen-render integrity: signature binds to `content_sha256(rendered_body)`; tamper-evident.

---

## 8. PDF generation approach

- **Library:** PDFKit (`agreementPdfService`, already in prod).
- **Signed PDF:** `buildPdfBuffer(agreement, signature)` → title, party snapshot, frozen body, signature block (typed name, drawn image, role, server `signed_at`, IP, UA, SHA-256, intent, consent). Unchanged.
- **Unsigned PDF (new):** add `buildUnsignedPdfBuffer(agreement)` — same body render, signature block replaced by a "DRAFT — UNSIGNED COPY" watermark/notice. Pure function, unit-testable.
- **Email of signed PDF (B):** the email transport is **SES via nodemailer**, which **does** support attachments. Two viable deliveries (decision §9-D):
  - **(D1) Attach the PDF buffer** to the post-signing confirmation email (add `attachments` support to `emailService.sendEmail`). Simplest match to "email signed PDF"; watch ~size/deliverability.
  - **(D2) Email a secure link** (the existing pattern) to the auth-gated download. Safer for deliverability/privacy; "PDF" reachable in one click but not attached.
- PDF generation stays **non-blocking to the legal act** (signing succeeds even if PDF/email lags; retried), exactly as today.

---

## 9. Locked decisions (owner, 2026-06-17)

- **A. Table names:** reuse existing tables only. No duplicate tables, no views, no renames.
- **B. Gate model:** **hard onboarding gate** — a seller's setup is not "complete" and the dashboard is not accessible until a current agreement is signed; signing happens on the standalone `sign-agreement.html` reachable while logged-in-but-unsigned. Enforced server-side; admin always bypasses.
- **C. Grandfathering:** auto-waive existing sellers who already have non-draft auctions (set `agreement_waived_at` during cutover) so live sellers are never locked out.
- **D. Email delivery:** **attach the signed PDF** to the post-signing confirmation email (add `attachments` support to `emailService.sendEmail`, which runs on SES/nodemailer and supports it); keep the auth-gated signed-URL download as the durable re-download path.
- **E. Auto-send trigger:** auto-create + send the matching `seller_type` template agreement on seller signup, so onboarding is self-serve; admin can also send/resend/reissue manually (existing).

## 9a. Seller Agreement v1 legal content

The v1 agreement body (original Advantage.Bid language, structured after a standard consignment/auction seller agreement; **not** copied from any sample) is authored in **`docs/seller-agreement-v1-content.md`**. It is loaded into `agreement_template_versions.body_markdown` (one template per `seller_type`) via the existing admin authoring UI, with `{{variable}}` placeholders resolved from `seller_terms` + `seller_identity` + overrides by the existing `agreementVariableService`. Includes an attorney-review disclaimer; not legal advice.

---

## 10. Deployment plan (staging-first; prod only on approval)

**Pre-req content (both envs):** author at least one `agreement_template` + published version per active `seller_type` (admin UI already exists). Without a template, nothing can be sent/signed. This is data, done via the admin API/UI.

**Sequence (mirrors the daily-fixes discipline that just succeeded):**
1. Branch `feat/seller-agreement-v1` off current `main` (677aa0d).
2. Implement A–D + migration 070 + tests (unit: gate helper, unsigned PDF, email-attach; API matrix; Playwright sign+gate flow).
3. **Staging:** apply `070` (guarded per-file runner) → deploy → seed a template → full validation matrix (gate blocks unsigned seller; sign → dashboard opens; unsigned+signed download; email received; admin view/verify; publish still admin-only; **bid/payment/premium/terms untouched**).
4. Backup tag/branch + Neon prod snapshot.
5. **Prod (on approval):** apply `070` to prod DB (additive) → FF `main` → auto-deploy → author prod template(s) → validate → grandfather existing sellers per §9-C.
6. Rollback: revert `main` to the pre-deploy tag (code), drop `070` columns/views (additive/reversible), no data destruction; grandfather-waive everyone if the gate misbehaves (instant un-block).

**Hard stops:** any failure touching bidding/payments/payout/premium/buyer-terms (must be zero — none are in scope); gate locking out a seller with live auctions; FF not clean.

**Guardrails (unchanged):** Stripe TEST; Buyer Premium inactive; Buyer Terms v2 stays draft; no settlement/payout/payment changes; no BD widget; no auction-platform homepage/index changes.
