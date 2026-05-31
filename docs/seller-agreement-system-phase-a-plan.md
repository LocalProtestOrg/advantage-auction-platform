# Seller Agreement System — Phase A Implementation Plan (Data Foundation + Admin Authoring)

*Implementation plan for review. **No Phase A code written yet.** Builds on the approved architecture proposal and the owner-locked decisions (2026-05-31). Migration-first, staging-first, additive, server-authoritative. Phase A delivers the data model + admin authoring + the variable-resolution engine. It does **NOT** touch seller-facing send/sign, PDF generation, bidding, payment, or auction-close.*

## Owner-locked decisions (carried into this plan)
1. **Signed-PDF storage = Cloudinary** (URL + SHA-256). *(Phase C consumer; not built in A.)*
2. **Dedicated `seller_terms` table**, history-preserving for auditability + reporting.
3. **Seller Agreement Assistant** = roadmap (not A); scoped Q&A over signed agreement / seller type / seller terms / payout schedule / auction status / account settings; **not a chatbot**; **"Contact Support" escalation on low confidence**.
4. **Expanded seller identity capture**: legal name, company name, signatory name, signatory title, address, phone, payout information.
5. **Long-term**: agreement-gated onboarding (signed before first auction). *(Phase D.)*

---

## Phase A scope (in / out)

**In:** complete additive schema; admin template authoring (immutable versions) + preview; admin management of per-seller identity + terms; the pure variable-resolution engine; audit + tests.
**Out (later phases):** sending agreements, seller review/sign pages, signature capture, PDF render/Cloudinary upload, resend/void, onboarding gate. The `agreements` + `agreement_signatures` tables are **created** in A (so the model is reviewed once) but **wired** in B — mirroring how Phase B landed the seller-type schema and Phase C was code-only.

---

## 1. Migrations (additive only; next free numbers after 052)

### 053_create_agreement_templates.sql
```
agreement_templates(
  id uuid pk, agreement_type text NOT NULL
    CHECK (agreement_type IN ('private','business','auction_house',
           'estate_sale_company','professional_liquidator','custom')),
  name text NOT NULL, description text,
  is_active boolean NOT NULL DEFAULT true,
  current_version_id uuid,            -- FK set after first version (nullable)
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now())

agreement_template_versions(          -- IMMUTABLE; never UPDATEd
  id uuid pk,
  template_id uuid NOT NULL REFERENCES agreement_templates(id) ON DELETE CASCADE,
  version_int int NOT NULL,
  body_markdown text NOT NULL,        -- contains {{variable}} placeholders
  variable_schema jsonb NOT NULL,     -- [{key,label,type,required,source}]
  effective_terms_defaults jsonb NOT NULL DEFAULT '{}', -- defaults by type
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(template_id, version_int))
```

### 054_create_seller_terms.sql  (history-preserving — decision 2)
```
seller_terms(
  id uuid pk,
  seller_profile_id uuid NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  commission_pct numeric(5,2), buyer_premium_pct numeric(5,2),
  credit_card_fee_pct numeric(5,2), marketing_fee_cents int,
  settlement_terms text, payout_schedule text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,          -- NULL = current row
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now())
CREATE INDEX idx_seller_terms_current
  ON seller_terms(seller_profile_id) WHERE superseded_at IS NULL;
```
Edits **append a new row** + stamp `superseded_at` on the prior → full history for reporting; exactly one current row per seller.

### 055_create_seller_identity.sql  (decision 4)
```
seller_identity(
  seller_profile_id uuid PRIMARY KEY REFERENCES seller_profiles(id) ON DELETE CASCADE,
  legal_name text, company_name text,
  signatory_name text, signatory_title text,
  address_line1 text, address_line2 text, city text, state text, postal_code text, country text,
  phone text,
  payout_info_ref text,               -- tokenized/non-sensitive reference ONLY (see Risks)
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now())
```
1:1 with seller_profiles. **No raw bank/card numbers** stored (security rule) — `payout_info_ref` points at the existing `seller_payout_preferences` (mig 016) or a tokenized descriptor.

### 056_create_agreements.sql  (created now, wired in Phase B)
```
agreements(
  id uuid pk,
  template_version_id uuid NOT NULL REFERENCES agreement_template_versions(id),
  seller_profile_id uuid NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  seller_user_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','viewed','signed','countersigned','void','expired')),
  party_snapshot jsonb,               -- frozen identity at send
  resolved_variables jsonb,           -- frozen financial terms at send
  rendered_body text,                 -- exact text the seller signs
  sent_at timestamptz, viewed_at timestamptz, signed_at timestamptz,
  void_at timestamptz, expires_at timestamptz,
  signed_pdf_url text, signed_pdf_sha256 text,   -- Phase C
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now())

agreement_signatures(
  id uuid pk,
  agreement_id uuid NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  signer_user_id uuid REFERENCES users(id),
  signer_role text CHECK (signer_role IN ('seller','admin')),
  method text CHECK (method IN ('typed','drawn')),
  typed_name text, drawn_image_url text,
  consent_acknowledged boolean NOT NULL DEFAULT false,
  intent_statement text,
  content_sha256 text,                -- hash of rendered_body the signer saw
  signed_at timestamptz, ip_address text, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now())
```

*No migration to `audit_log`* — reuse it (entity_type = `agreement_template` | `seller_terms` | `seller_identity` | `agreement` | `agreement_signature`). Optional later: an indexed `agreement_id` column.

## 2. Services (`src/services/`)
- **`agreementTemplateService.js`** — create template; **publish new immutable version** (bumps `version_int`, sets `current_version_id`); list/get; activate/deactivate. Never mutates an existing version.
- **`sellerTermsService.js`** — `getCurrentTerms(sellerId)`; `setTerms(sellerId, patch, actor)` → append new row + supersede prior (transactional) + audit `seller_terms_changed`.
- **`sellerIdentityService.js`** — `getIdentity` / `upsertIdentity` + audit `seller_identity_changed`.
- **`agreementVariableService.js`** — **pure, DB-free core** + a thin resolver: given `template_version`, `seller_terms`, `seller_identity`, and send-time overrides → `{ resolved, missingRequired, renderedBody }`. Renders `{{key}}` placeholders; **required-but-unresolved ⇒ structured error** (blocks future send). Unit-testable without a DB. This is the heart of Phase A.

## 3. Routes (admin-only; reuse `auth` + `role(['admin'])` + `idempotency`; pattern = `adminConfig.js`)
- `GET/POST /api/admin/agreement-templates` — list / create
- `POST /api/admin/agreement-templates/:id/versions` — publish new immutable version
- `POST /api/admin/agreement-templates/:id/preview` — render with sample/explicit variables (no persistence)
- `GET/PUT /api/admin/sellers/:sellerProfileId/terms` — read current / append new (audited)
- `GET/PUT /api/admin/sellers/:sellerProfileId/identity` — read / upsert (audited)

All writes audited via `writeAuditLog`; all admin-gated; no seller-facing routes in A.

## 4. Admin UI
New **"Agreements"** area (new `public/admin/agreements.html`, or a tab in `moderation.html` following its tab pattern): template list + version editor + live preview; per-seller **Terms** and **Identity** editors reachable from the existing Sellers tab. Read-only history view of `seller_terms` rows (demonstrates the auditability the table was chosen for).

## 5. Tests (Jest unit + integration; Playwright optional for admin UI)
- **Unit (`agreementVariableService`):** placeholder render; required-missing → error; type coercion; defaults→override precedence (type default < seller_terms < send-override); unknown placeholder handling.
- **Unit (`sellerTermsService`):** append-and-supersede keeps exactly one current row; history retained.
- **Integration:** template create + version publish (immutability: re-publish makes v2, v1 unchanged); terms/identity PUT writes audit events; role enforcement (non-admin → 403); preview never persists.
- **Regression:** existing audit/seller endpoints unaffected.

## 6. Validation (staging-first)
Apply 053–056 to **staging DB only** (`run-migrations.js`, gated on the staging Neon endpoint — same discipline as 051/052). Seed one template per `seller_type`. API matrix: create template → publish v1 → preview renders → set seller terms+identity → resolve variables green; required-missing blocks; audit events present; non-admin blocked. Confirm staging clean. **Checkpoint:** `checkpoint/seller-agreement-phase-a-staging-green`. **HOLD before production** (prod needs 053–056 applied first).

## 7. Risks & constraints (Phase A)
- **Payout-info sensitivity** — store only a tokenized/non-sensitive `payout_info_ref`; never raw bank/card data (security rule). Defer real payout capture to a dedicated, reviewed step.
- **Identity PII** — `seller_identity` holds personal/business data; consider encrypting sensitive columns (precedent: `auctions.address_encrypted`). Decide before exposing seller-facing capture (Phase B/D).
- **Immutability discipline** — versions and (later) signed agreements are append-only; enforce in service layer + tests.
- **Migration prerequisite** — like 051/052, prod enforcement is meaningless until 053–056 are applied to prod; track explicitly.
- **Scope** — Phase A writes only the new tables + audit; it must not touch payments, bidding, or auction-close.

## 8. Recommended sequencing
1. Migrations 053–056 (+ apply to staging, verify).
2. `agreementVariableService` (pure) + unit tests — prove resolution in isolation.
3. `sellerTermsService` + `sellerIdentityService` (+ audit) + tests.
4. `agreementTemplateService` + admin routes + idempotency.
5. Admin UI (templates/preview + per-seller terms/identity + terms history).
6. Integration + regression tests.
7. Staging validation matrix → checkpoint tag → HOLD.

## 9. Roadmap (captured; NOT Phase A)
- **Phase B** — send / review / sign (server-authoritative; tokenized link via Postmark; typed signature first).
- **Phase C** — PDF (PDFKit) → **Cloudinary** (durable) + SHA-256; resend / void / reissue; drawn signatures.
- **Phase D** — **agreement-gated onboarding** (block first auction submission until signed); terms layer becomes the platform's canonical fee source.
- **Seller Agreement Assistant** (decision 3) — scoped, grounded Q&A over {signed agreement, seller type, seller terms, payout schedule, auction status, account settings}; **not a chatbot**; **low-confidence ⇒ "Contact Support"** (no silent AI fallback — see seller-studio Defect 4). Retrieval limited to the authenticated seller's own records; server-authoritative; auditable.

---

*End of Phase A plan. Produced for review. No code, migrations, or files beyond this document. Awaiting approval before implementation.*
