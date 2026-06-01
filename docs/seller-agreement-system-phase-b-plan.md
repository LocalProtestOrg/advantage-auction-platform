# Seller Agreement System — Phase B Architecture & Implementation Plan (Send → Review → Sign → PDF)

*Status: **APPROVED 2026-05-31** — including the two key decisions: (1) **signing requires authentication** (token = view capability; sign requires authenticated seller match), and (2) **enable Express `trust proxy`** for accurate Railway client-IP capture. Frozen-render model, PDF architecture, and resend/reissue/revoke lifecycle all approved. Builds on Phase A (shipped @`e1d919d`: schema 053–056, template/terms/identity services, pure resolver, admin authoring). Phase B makes agreements real: admin sends, seller reviews via a secure link, seller signs (typed/drawn), a signed PDF is generated and stored on Cloudinary, and the lifecycle is fully audited. Migration-first, staging-first, additive, server-authoritative. Does NOT build the Agreement Assistant or the onboarding gate (Phases C/D).*

## Reuse (no new infra invented)
- **Resolver** `agreementVariableService` (pure) — used **once at send**, then frozen.
- **PDF** `pdfGenerationService` pattern (PDFKit → Buffer) — but store to **Cloudinary**, not local `reports/`.
- **Cloudinary** `cloudinaryService` — raw/`resource_type:'auto'` upload for the signed PDF.
- **Email** `emailService.sendEmail` (Postmark HTTP, HTML+text, **no attachments** → link-based) + `notifications_queue`/notification worker.
- **Audit** `writeAuditLog` (entity_type `agreement` / `agreement_signature`).
- **Middleware** `authMiddleware`, `roleMiddleware`, `idempotency`. Phase A router `/api/admin/agreements` is extended; a new seller-facing router `/api/agreements` is added.

## Migration 057 (additive) — make the model send/sign-ready
Phase A created `agreements` + `agreement_signatures`. Phase B needs:
- **Widen `agreements.status` CHECK** to the requested model: `draft, sent, viewed, signed, expired, superseded, revoked` (retain `countersigned` for forward-compat; `void`→ replaced by `revoked`).
- **Add columns** to `agreements`: `access_token_hash TEXT`, `token_expires_at TIMESTAMPTZ`, `superseded_by_agreement_id UUID`, `revoked_at TIMESTAMPTZ`, `revoke_reason TEXT`, `pdf_status TEXT DEFAULT 'pending'` (pending|stored|failed).
- Index on `access_token_hash`. *(All `ADD COLUMN IF NOT EXISTS` / constraint swap — additive, staging-first.)*

---

## A. Agreement Send Workflow
**Endpoint:** `POST /api/admin/agreements/agreements` (admin, idempotent).
**Inputs:** `sellerProfileId`, `templateId` (optional — defaults to the active template whose `agreement_type` = seller's `seller_type`), `overrides` (send-time variable overrides), `expiresInDays` (optional; default 14).
**Steps:**
1. Load template + **current version**; **version-lock**: pin `template_version_id = template.current_version_id` (immutable thereafter).
2. **Resolve variables** (Phase A resolver) from `effective_terms_defaults` < `seller_terms` (current) < `overrides`; identity-sourced from `seller_identity`.
3. **Block on `missingRequired`** → `422` listing the unresolved required keys (admin fixes terms/identity or supplies overrides). Server-authoritative.
4. **Snapshot**: `party_snapshot` (from seller_identity), `resolved_variables` (machine values), `rendered_body` (frozen text). These never change after send.
5. Set `status='sent'`, `sent_at=now()`, `expires_at = now() + expiresInDays`. Generate a **signing token** (`crypto.randomBytes(32)`); store only its **SHA-256** in `access_token_hash` (+ `token_expires_at`).
6. Audit `agreement_sent`; enqueue a Postmark email with the tokenized link `…/sign-agreement.html?token=<raw>` (raw token only in the email, never stored/logged).
**Expiration rules:** `expires_at` enforced two ways — **lazy** (any view/sign after expiry flips `status='expired'` and refuses) + a **periodic sweep** (notification-worker-style job marks overdue `sent/viewed` → `expired`, audited). Default window 14 days; admin-overridable per send.

## B. Seller Review Workflow
**Two entry paths, one frozen render:**
- **Tokenized link (email):** `GET /api/agreements/by-token/:token` — public capability endpoint. Hashes the token, looks up the agreement, validates not expired/revoked/superseded. Returns `rendered_body` (frozen), display `resolved_variables`, template name/type, status, `expires_at`. First successful view sets `status='viewed'` + `viewed_at` (audit `agreement_viewed`).
- **Seller dashboard (authenticated):** `GET /api/agreements/mine` + `GET /api/agreements/:id` (must be `req.user`'s agreement) — same frozen render, no token needed.
**Authenticated vs unauthenticated:** **viewing** is allowed via token (capability URL, unauthenticated) so the email link "just works"; **signing requires authentication as the agreement's seller** (`seller_user_id === req.user.id`) — a leaked link cannot be signed by a stranger. The signing page prompts login if needed, preserving the token.
**Terms snapshot preservation:** review/sign **always render `rendered_body`** (frozen at send) — never re-resolve. The seller signs exactly what was sent, regardless of later `seller_terms`/template changes. `resolved_variables` is shown read-only alongside.

## C. Signature Workflow
**Endpoint:** `POST /api/agreements/:id/sign` (authenticated seller; idempotent; single-use via status guard).
**Body:** `{ typed_name (required), drawn_image_data? (PNG data URL), consent_acknowledged (must be true), intent_acknowledged (must be true) }`.
**Steps:**
1. Verify ownership (`seller_user_id`), status ∈ {`sent`,`viewed`}, not expired (lazy check).
2. **Typed signature** required; **drawn** optional → upload PNG to Cloudinary → `drawn_image_url`.
3. `content_sha256 = sha256(rendered_body)` — binds the signature to the exact text.
4. Insert `agreement_signatures`: `signer_role='seller'`, `method` (`typed`|`drawn`), `typed_name`, `drawn_image_url`, `consent_acknowledged`, `intent_statement` (exact text shown), `content_sha256`, `signed_at = server now`, **`ip_address`** (`req.ip` — requires Express `trust proxy`), **`user_agent`**.
5. `agreements.status='signed'`, `signed_at`; audit `agreement_signed` (metadata: method, content hash, ip/ua). Then trigger PDF (D).
**Audit trail:** every transition (`sent`/`viewed`/`signed`/`expired`/`superseded`/`revoked`) is an `audit_log` row; the signature row is itself the legal attribution record.

## D. PDF Generation
- **Timing:** generated **immediately after a successful sign**, but **non-blocking to the legal act** — the signature + `content_sha256` are authoritative; if PDF render/upload fails the agreement stays `signed` with `pdf_status='failed'` and is retried (admin "regenerate" + sweep). On success `pdf_status='stored'`.
- **Render:** PDFKit (reuse `pdfGenerationService` style) → frozen `rendered_body` + a **signature block** (typed name, drawn image, server timestamp, IP, UA, `content_sha256`, signer identity).
- **Cloudinary storage:** upload the PDF Buffer (`resource_type:'auto'`, `agreements/` folder) → store `signed_pdf_url`.
- **SHA-256 verification:** compute over the PDF bytes → `signed_pdf_sha256`; downloadable re-verification (download → hash → compare).
- **Immutable signed copy:** once `signed_pdf_url`/hash are set they are never overwritten with different content; the frozen `rendered_body` guarantees a faithful, reproducible document. **Privacy:** signed PDFs hold PII/financial terms — serve via **`GET /api/agreements/:id/pdf` (auth-gated ownership/admin)**, not by exposing the raw Cloudinary URL (use Cloudinary authenticated/private resource or proxy + the unguessable URL as defense-in-depth).

## E. Resend / Reissue / Revoke Workflow
- **Resend** (unsigned only): `POST /api/admin/agreements/agreements/:id/resend` — re-emails the link, **rotates the token** (new hash), optionally extends `expires_at`; same agreement row; audit `agreement_resent`. Idempotent.
- **Reissue / supersede** (material change after send): create a **new** agreement (new template version and/or terms), set the prior `status='superseded'` + `superseded_by_agreement_id`, invalidate its token; audit `agreement_superseded` + `agreement_sent` (new). Never mutate a sent agreement's frozen content. A **signed** agreement can be superseded for go-forward validity, but its signed record/PDF remain immutable history.
- **Revoke:** `POST …/:id/revoke` `{reason}` — `status='revoked'`, `revoked_at`, `revoke_reason`; token invalidated; signing refused; audit `agreement_revoked`.
- **Version handling:** every agreement pins exactly one `template_version_id`; the supersede chain + audit preserve full lineage.

## F. Agreement Status Model
Allowed: `draft → sent → viewed → signed` (terminal-valid); `sent|viewed → expired` (time); `sent|viewed → revoked` (admin); `sent|viewed|signed → superseded` (reissue pointer; signed record preserved). Transitions enforced **server-side** in the service layer (guarded updates), each emitting an audit event. `draft` reserved for a future "compose before send" admin step (Phase B sends directly; `draft` optional).

## G. Seller Dashboard Experience
- `seller-dashboard.html` gains an **Agreements** panel: `GET /api/agreements/mine` → cards with status badge, template name/type, sent/expires/signed dates, and an action: **Review & Sign** (pending) or **Download signed PDF** (signed, via the auth-gated `/pdf` endpoint).
- A dedicated **`public/sign-agreement.html`** review/sign page (token entry from the email link; renders frozen body; typed + optional drawn canvas; consent + intent checkboxes; login prompt before sign).
- **Future Agreement Assistant hook (not built in B):** the agreement detail view reserves a UI slot for the scoped assistant (decision 3) — grounded only in {signed agreement, seller type, seller terms, payout schedule, auction status, account settings}, **not a chatbot**, **low-confidence → "Contact Support."** Phase B simply ensures all those data sources are now queryable per-seller; no AI added yet.

## H. Validation Strategy
- **API tests (staging, via the established `railway run` + matrix pattern):** send (resolve+freeze+token+audit; missingRequired→422); token-view marks `viewed`; ownership isolation (seller A cannot read B's agreement; stranger token-view allowed but **sign requires matching auth**); sign (signature row, status, `content_sha256`, ip/ua, audit); double-sign blocked; expiry (lazy + sweep); resend rotates token; reissue sets `superseded`; revoke blocks signing; admin-only guards; idempotency replays.
- **Playwright (staging):** email-link → `sign-agreement.html` renders frozen body → login → typed (+ drawn canvas) sign → status `signed` → **Download PDF** works; admin sends from `agreements.html`; non-owner blocked. Capture `pdf_status='stored'` and that the PDF hash endpoint verifies.
- **Email caveat:** staging `email_configured:false` → `sendEmail` returns `{skipped:true}`. Validation asserts the **agreement + token + audit** are created (data/flow), not actual inbox receipt; the raw token is read from the API/DB in tests, not from email.
- **Staging workflow:** apply **057** to staging only (gated) → deploy → run API matrix + Playwright → **clean up** (delete test agreements/signatures, Cloudinary PDFs, audit rows) → checkpoint `checkpoint/seller-agreement-phase-b-staging-green` → **HOLD before prod** (prod needs 053–056 **and** 057).

## Security & legal callouts
- **`trust proxy`** must be enabled (Railway) or `req.ip` is wrong/spoofable — required for honest IP capture.
- **Tokens:** 256-bit random; store only SHA-256; constant-time compare; rotate on resend; expire; never logged or persisted raw.
- **Attribution:** signing requires authenticated seller match (stronger than capability-only e-sign).
- **ESIGN/UETA posture:** explicit intent + consent (exact text retained), immutable record + downloadable copy + retention — *flag for counsel; not legal advice.*
- **PDF access control:** gate behind our auth; do not leak PII via public Cloudinary URLs.

## Recommended implementation order (Phase B)
1. Migration 057 (status widen + columns + token) → apply to staging.
2. Send workflow + token + email link (admin).
3. Seller review (token + authenticated view) + `GET /api/agreements/mine` + dashboard panel + `sign-agreement.html` shell.
4. Signature capture (typed first, then drawn) + audit + status.
5. PDF render → Cloudinary → SHA-256 + auth-gated download; `pdf_status` + retry.
6. Resend / reissue(supersede) / revoke + expiry sweep.
7. Validation (API + Playwright) → checkpoint → HOLD.

---

*End of Phase B plan. Design only — no code, migrations, or files beyond this document. Awaiting approval before implementation.*
