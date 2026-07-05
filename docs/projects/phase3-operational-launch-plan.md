# Phase 3 — Operational Launch Plan

**Status:** Active. Governed by `project-constitution.md` + `engineering-charter.md`. Builds on Phase 1 (Tenant Foundation, mig 077) + Phase 2 (Partner Foundation, mig 078) — both LIVE in prod. **No Stripe/settlement/payment changes; no destructive DB changes; uses existing Partner Foundation architecture.**

## Objective
Make Advantage.Bid **operational**: real Partner organizations, real published events + auctions, BD widget/page integration, published platform legal content, validated public marketplace, and a launch‑readiness dashboard — all on the multi‑tenant foundation.

## Workstreams

### 1. Launch‑readiness dashboard (BUILT — non‑gated)
- `GET /api/admin/launch-readiness` (admin, read‑only) aggregates foundation/content/legal/BD signals → `ok|warn|todo` per item + summary.
- `public/admin/launch-readiness.html` renders the checklist.
- Prod deploy of this dashboard is **gated** (production deployment); build + staging‑validate now.

### 2. Real content seeding strategy (GATED: prod seeding)
- **Partner organizations:** seed via the live portal/services (`organizationsService.onboardOrganization`) — real orgs (auction houses / estate‑sale companies) for Houston + NYC/Tri‑State. Advantage Auction Company (Org #1) already exists for flagship content.
- **Events:** create + moderate + publish ≥10 per market on a rolling 4–6 week horizon (via existing events API + admin moderation). Cover images via Cloudinary.
- **Auctions:** flagship Advantage auctions under Partner #1 (existing auction creation flow); they auto‑syndicate.
- **Idempotent, guarded seed scripts** (`scripts/seed-*` pattern) prepared for review; **not executed against prod without approval**. Staging dry‑run first.
- Safety: additive inserts only; no updates to existing rows; no destructive ops.

### 3. BD integration plan (GATED: BD publishing)
- Reference: `docs/projects/bd-events-embed-integration.md` (verified prod URLs + per‑city snippets). BD access is **read‑only API only** (no page‑edit) — edits are **manual by the owner** or await BD page‑edit access.
- **Approved page‑edit set (for owner to apply / approve):**
  - `/houston` → JS widget `data-market="houston"` below intro.
  - `/new-york`, `/new-jersey`, `/connecticut` → JS widget `data-market="nyc_tristate"`.
  - Create‑Event button → `/org/events/new?market=…` (live redirect).
  - iframe fallback only where `<script>` is disallowed.
- Post‑embed: validate render + funnel; leave BD native events untouched.

### 4. Platform legal content publishing (GATED: publishing)
- Drafts authored in `docs/legal/platform-legal-drafts.md` (buyer_terms, seller_agreement, privacy_policy, refund_policy, pickup_policy) — **DRAFT, require legal review**.
- Publish via the Phase‑2 framework: `POST /api/legal/documents` → `/versions` → `/versions/:id/publish` (platform‑level, `organization_id=null`), recorded as versions with an acceptance ledger.
- **Held for approval** (legal publishing gate + attorney sign‑off).

### 5. Public marketplace validation (non‑gated read‑only)
- After seeding: verify public listings (`/api/public/auctions`, `/api/public/events`) show syndicated content; widgets render; legal endpoints serve published docs; readiness dashboard reflects green.

## Production validation plan
1. Read‑only smoke: `/api/health`, `/api/public/auctions`, `/api/public/events`, `/api/config/branding`, `/api/legal/:type`, `/api/admin/launch-readiness` (admin).
2. Content checks: published events per market ≥ target; syndicated auctions > 0; partner orgs ≥ 1.
3. Widget render (browser) on prod; BD embed render (post‑edit).
4. Legal: published docs retrievable; acceptance recording works.
5. Dashboard summary trends to all‑green.

## Rollback / safety notes
- Dashboard + routes are **additive, read‑only** — rollback = revert the deploy commit (no schema/data change).
- Content seeding is **additive inserts**; rollback = archive/hide via admin marketplace controls or delete seeded rows by known ids (scripted, reversible). No destructive updates.
- Legal publishing is reversible (publish a prior version / unpublish); acceptance ledger is append‑only.
- No payment/settlement/Stripe/infrastructure changes in Phase 3.

## Approval gates (per owner)
BD page publishing (material) · prod data seeding creating public content · legal document publishing · any Stripe/payment/settlement · infrastructure/domain.

## Recommendation for Phase 4 — Commercial Launch
Once operational content + legal + BD are live and validated, proceed to **Phase 4 (gated, money):** buyer card verification (implement stubbed `cardVerificationService`), **Stripe LIVE** enablement, settlement activation, and wiring the Phase‑2 business‑rule config into the settlement engine — each behind explicit approval, staging‑first, with CPA/attorney sign‑off for tax.
