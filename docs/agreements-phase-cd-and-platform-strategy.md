# Phase C/D & Platform Strategy — Design Proposal (DESIGN ONLY)

*No code. Strategy + architecture for six topics. Builds on Agreement System Phase A (`e1d919d`) + Phase B (`a7d63e8`), both staging-green. Honors CLAUDE.md: admin control, server-authoritative rules, platform independence from BD (adapter-based), no silent AI fallback, privacy/identity rules. Each topic ends with a clear "next decision."*

Recommended sequencing across these topics: **(4) production promotion → (3) agreement-gated onboarding → (1) Agreement Assistant → (5) syndication → (6) white-label → (2) Seller Success Assistant.**

---

## 1. Seller Agreement Assistant (scoped, grounded, escalating — NOT a chatbot)
**Purpose:** answer an authenticated seller's questions about *their own* agreement, terms, payout schedule, auction status, and account settings. Not general chat; not legal advice.

**Architecture**
- **Context assembler (server, per-seller scoped):** for `req.user`, gather a bounded, structured bundle — latest **signed** agreement (`rendered_body` + `resolved_variables` + status + `signed_at`), `seller_type`, current `seller_terms`, `payout_schedule`, the seller's auctions + states, account settings (notification prefs). All rows filtered by `seller_user_id` server-side; never another seller's data.
- **LLM call:** Claude (latest model) via the existing Anthropic pattern (`aiDescriptionService`/`ANTHROPIC_API_KEY`). **Prompt-cache** the static system prompt + the assembled context (per the claude-api skill) to cut cost/latency. System prompt constrains the model to answer **only from the provided context**, **cite the source field**, and **refuse/escalate** otherwise.
- **Confidence gating + escalation (the core safety property):** model returns **structured output** `{ answer, grounded: boolean, citations: string[], confidence: number }`. If `grounded === false`, `confidence < threshold`, or required context is missing → **return a "Contact Support" escalation instead of an answer.** If `ANTHROPIC_API_KEY` is unset → `AIUnavailableError` → "assistant unavailable, contact support." **No silent fallback** (directly applies seller-studio Defect 4's lesson).
- **Endpoint:** `POST /api/agreements/assistant` (auth seller) `{ question }` → `{ answer, citations } | { escalate: true, support_path }`. Rate-limited; audited as `assistant_query` (store the question + grounded/escalated flag, **not** raw PII-heavy answers).
- **Guardrails:** legal questions → "consult counsel"; out-of-scope → escalate; never invent terms; retrieval scoped server-side; UI slot already reserved on the agreement view (Phase B).

**Next decision:** confidence threshold + whether to log answers (privacy) before building.

## 2. Seller Success Assistant (roadmap superset)
A **proactive + reactive** assistant that *supersets* the Agreement Assistant: onboarding-completion nudges, listing-quality tips, payout-setup reminders, agreement-pending prompts, and performance insights — using the same **grounded + escalate-on-low-confidence** discipline. Data sources expand to listing/auction performance and `analytics_events`. Proactive triggers run via the existing notification/worker pattern; reactive Q&A reuses the assistant endpoint. **Sequence after** the Agreement Assistant proves the grounding/escalation pattern in production. Roadmap only.

## 3. Agreement-gated onboarding (Phase D)
**Rule:** a seller cannot create/submit their **first** auction until they hold a **current signed** agreement.
- **Enforcement (server-authoritative):** at the auction-create chokepoint (`src/routes/auctions.js POST /` + the submit transition in `auctionService`) — the same chokepoint pattern as the Phase C seller-type rules. Helper `hasCurrentSignedAgreement(sellerProfileId)` = EXISTS an agreement with `status='signed'` and not `superseded`/`revoked`. Violation → `422 AGREEMENT_REQUIRED` with a CTA to sign.
- **Admin override preserved:** admin-created auctions bypass; admin may waive per-seller (flag) — CLAUDE.md admin-control rule.
- **Grandfathering:** sellers with existing live auctions are NOT blocked (don't disrupt ongoing operations); the gate targets new sellers / first auction. Roll out behind a config flag for staged enablement.
- **Onboarding wiring:** on seller registration, auto-**send** the template matching their `seller_type` (reuse Phase B `sendAgreement`); dashboard surfaces the pending agreement (my-agreements.html already exists); blocked auction-create links to it.
- Additive, **no schema change** (queries `agreements`).

**Next decision:** hard gate for all unsigned sellers vs. new-sellers-only; and the config-flag home (`platform_settings` is presentation-only — likely a dedicated flag).

## 4. Production promotion runbook
*The current feature branch `deploy/seller-studio-1b` carries seller-type rules + bg-removal fix + Agreement System A/B. Production (`advantage-auction-platform` service, `main`, Neon `ep-proud-leaf-an8pzkib`) is missing migrations **051, 052, 053–057** and possibly the 4 tracking-gap olds.*

**Order (DB before code — migrations are additive and code tolerates their presence):**
1. **Freeze + confirm** staging-green at the relevant checkpoint tags.
2. **Back up prod:** create a Neon **branch/snapshot** of the prod DB (instant rollback point).
3. **Apply migrations to PROD DB**, gated on the prod endpoint (mirror the staging `railway run … run-migrations`/surgical pattern, but pointed at prod): apply **051, 052, 053, 054, 055, 056, 057** in order. Decide on the 4 tracking-gap olds (008/017/032/046) — verify their objects already exist on prod (as on staging); the runner no-ops/fail-safes. Verify constraints/columns post-apply.
4. **Promote code:** merge `deploy/seller-studio-1b` → `main` via PR; the prod service auto-deploys.
5. **Env preconditions on prod:** `CLOUDINARY_*` (present), **`ANTHROPIC_API_KEY`** (for the future assistant), **Postmark token** (so agreement emails actually send — prod `email_configured` should be true), and **`PUBLIC_BASE_URL`** = prod domain so signing links are correct. Confirm Cloudinary allows **raw/private** assets + signed delivery on the prod account.
6. **Verify:** prod health; admin can list agreement templates; send a single internal test agreement to a seeded account; confirm signed-PDF signed-URL works; **then** enable seller-facing send.
7. **Rollback:** revert the merge (redeploy prior `main`) + restore the Neon branch if needed. Additive migrations are safe to leave.

**Risk callouts:** apply DB first; low-traffic window; ship admin-only authoring before seller-facing send; the same "prod needs the migrations" prerequisite that gated staging.

**Next decision:** go/no-go + window; and the 4-tracking-gap-migration reconciliation.

## 5. Professional Seller Website Syndication
**Goal:** let professional sellers (`auction_house`, `estate_sale_company`, `professional_liquidator`) display their auctions on their **own** external sites.
- **Reuse, don't rebuild:** the existing **public API** (`/api/public/*`, allowlisted fields, Cache-Control tiers) + **embeddable widgets** (`public/widgets/featured-*.js`) + the **BD integration contract** (adapter-based; `docs/integration-contract-bd.md`). Add a **seller-scoped** public feed: `GET /api/public/sellers/:sellerId/auctions` (a sibling to the existing `/api/public/sellers/:sellerId/profile`), serving only public-safe fields (no reserve/winner/PII).
- **Seller-scoped widget:** a `data-seller-id` variant of the featured widget renders that seller's live auctions on their site; **CORS allowlist** per `ops/frontend/docs/deployment-workflow.md`.
- **Gating:** syndication is a **professional-only, admin-enabled** capability (ties to `seller_type` + the capability model).
- **Principle:** external sites are a **presentation adapter only** — core auction ops (bidding/close/payment/identity, paddle privacy) stay server-authoritative on the platform (CLAUDE.md BD rules).

**Next decision:** which fields are syndication-public; per-seller CORS onboarding flow.

## 6. White-label auction website strategy
**Goal:** a fully **branded** auction site for a professional seller (their domain, logo, colors) **powered by the platform** (platform-independent, not BD).
- **Multi-tenant theming layer:** a `tenant`/`site` config (brand name, logo, colors, custom domain) — reuse the `platform_settings`/`widget_settings` admin-config pattern, namespaced per tenant; theme via the existing `marketplace.css` variables.
- **Custom-domain resolution:** seller domain `CNAME → platform`; **host-based tenant resolution** middleware maps the host → tenant → scoped catalog + branding. Phase ladder: **syndication widgets (lightest) → branded subdomain (`seller.advantage.bid`) → full custom-domain white-label.**
- **Scoped catalog, shared core:** the branded shell renders that seller's auctions (public API), but **bidding/payment/identity/close remain shared, server-authoritative platform infrastructure** — white-label is presentation only. Buyer privacy/paddle rules still enforced.
- **Admin control:** tenant config is admin-managed; admin publishes, sellers don't own operations.

**Next decision:** subdomain vs. custom-domain first; tenant config schema; whether white-label is a paid tier.

---

## Cross-cutting principles (all six)
- **Server-authoritative** core; admin override preserved; additive/migration-first/staging-first; **production needs each phase's migrations first**.
- **Platform independence from BD** — external surfaces (syndication, white-label) are adapters, never owners of auction logic.
- **No silent AI fallback** — assistants escalate to Contact Support on low confidence/unavailability.
- **Privacy** — per-seller scoping, allowlisted public fields, signed/expiring PDF delivery, no PII leakage to external sites.

*End of design proposal. No code, migrations, or files beyond this document. Awaiting direction on which topic to take into implementation planning.*
