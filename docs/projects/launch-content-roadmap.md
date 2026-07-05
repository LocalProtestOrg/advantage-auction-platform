# Advantage.Bid — Launch & Platform Roadmap (planning only)

**Status:** PLANNING ONLY — do not implement from this document. Governed by `docs/projects/project-constitution.md`. Sequences the path from the Organizations & Events v1 release (`f0a7648`, migration 076) to an operational marketplace and, ultimately, the White‑Label Partner Network.

## Guiding sequencing principle
**Advantage.Bid is Partner #1.** Get operational fast on a **multi‑tenant‑ready foundation**: do the cheap‑now/expensive‑later work (tenant key on core tables + scoped queries + syndication defaults) before data accretes, but **defer the heavy white‑label machinery** (custom domains, branding UI, per‑tenant config editing, Partner console) until a real Partner needs it. Configuration over customization throughout.

## Adjusted priorities (highest → lower)
1. **Become operational** — payments LIVE‑ready, content in the two live markets, buyer trust primitives.
2. **Multi‑tenant foundation** — tenant key + scoping + syndication model, added quietly while single‑tenant.
3. **Marketplace strength** — syndication, discovery, shared bidder pool.
4. **White‑Label Partner Network** — host‑based branding/config, Partner onboarding, per‑tenant legal/economics.
5. **Enterprise & long‑term** — RBAC, partner reporting, monetization, network effects.

---

# Milestone sequence (grouped)

## A. Must Have Before Public Launch
Fastest path to "operational," on a foundation that won't need retrofitting.
- **Stripe LIVE readiness** — payments/settlement/tax sign‑off (currently TEST). *Approval‑gated (payment/infra).*
- **Buyer card verification live** — implement the stubbed `cardVerificationService` (<$1 auth at signup/card change) — required business rule for real money.
- **Tenant foundation (schema)** — introduce the Partner/tenant key on core tables (reuse/extend `organizations`), tenant‑scoping query discipline, Advantage as Partner #1; existing sellers/auctions migrate under it. *Additive migration; no behavior change yet.*
- **Marketplace syndication model** — Partner auctions default `syndicated=true`; **admin‑only** visibility controls (hide/feature/promote/remove/override) with an **audit trail**. Partners cannot control visibility.
- **Content launch (Houston + NYC/Tri‑State)** — onboard initial Partner Organizations; seed & publish real events; embed the BD widget (manual until BD page‑edit access). AAC flagship "Advantage" org events as anchor content.
- **Legal versioning + acceptance ledger** — solidify buyer terms / seller agreement version capture (mostly exists) so every acceptance is recorded per version.
- **Production hardening** — monitoring, backups, incident SOPs (largely in place); confirm `EVENTS_ALLOWED_ORIGINS`, health checks, rollback runbooks.

## B. Should Have Shortly After Launch
- **Per‑tenant economics as configuration** — buyer premium / commission / fees as data consumed by the **single settlement engine** (no forked logic). *Payment‑adjacent → approval‑gated.*
- **Organization/Partner verification workflow** (schema exists; badge already derived).
- **Location‑based buyer discovery** (radius search / geocode‑at‑publish) — already roadmapped.
- **Imported events strategy** — `source='imported'` + attribution (schema exists), moderated, clearly badged.
- **Recurring events**.
- **CRM / analytics from platform data** — funnel, attribution, marketing value.

## C. White‑Label Partner Network
- **Host‑based tenant resolution** — resolve Partner branding + config from the incoming host (`bid.partnername.com`). *Custom domains + TLS = infrastructure → approval‑gated.*
- **Per‑tenant branding** — logo, colors, fonts, email branding, homepage content, loaded by host; config inheritance (platform defaults → Partner overrides).
- **Per‑tenant legal document set** — buyer terms, seller agreement, privacy, refund, pickup — editable + versioned, per Partner, with acceptance ledger.
- **Partner admin console** — Partner‑scoped management of their auctions/events/users/branding within platform‑governed rails; Partners never touch marketplace visibility.
- **Partner onboarding + Partner Agreement** — including syndication consent.
- **Per‑tenant business rules** — settlement/tax/shipping/pickup as configuration.

## D. Enterprise Expansion
- **RBAC** — Partner‑scoped roles/permissions for staff.
- **Partner financial reporting** — statements, payouts, reconciliation per Partner.
- **Enterprise auth options** — SSO/OIDC for Partner staff (not buyers).
- **Partner API + webhooks**.
- **Tiered Partner plans**, white‑glove onboarding, SLAs.
- **Stronger isolation** — RLS for payments/PII if warranted.

## E. Long‑Term Vision
- **Network effects** — cross‑Partner discovery, unified marketplace search, shared SEO/marketing.
- **Marketplace monetization** — featured/promoted placements, memberships, advertising on organizations.
- **Presentation‑adapter plurality** — BD becomes one of many adapters; platform independence preserved.
- **Ecosystem** — potential Partner extensions/integrations marketplace.

---

# Content‑launch execution detail (supports Milestone A)
- **Houston** (`market=houston`, BD `/houston`): recruit 5–10 organizations; seed 10–20 published events on a rolling 4–6 week horizon; embed JS widget below intro content.
- **NYC / Tri‑State** (`market=nyc_tristate`, BD `/new-york` primary, `/new-jersey`, `/connecticut`): recruit across all three states; tag events `nyc_tristate`; embed widget on all three pages.
- **Initial org onboarding:** via the live portal (auto‑onboard on first event); free plan to start; upgrade high‑volume organizers.
- **AAC launch events:** an "Advantage" (source `admin`) organization seeds flagship anchor events in both markets.
- **Public launch checklist:** ≥10 published events/market with imagery · widget embedded + verified on all city pages · Create‑Event deep‑link present · `EVENTS_ALLOWED_ORIGINS` confirmed · pages reviewed mobile/desktop · moderation SLA defined · funnel analytics.
- **BD widget rollout:** pilot Houston → expand NYC/Tri‑State → iframe only where `<script>` unavailable → retire BD native events after parity. All BD edits manual until BD page‑edit access enabled.
- **Future BD MCP integration:** none today (read‑only REST API only); when added, least‑privilege (read=allow, write=ask, delete=deny).
- **Unified authentication roadmap:** unify seller↔organization identity; media upload behind capability‑based authz (`requireCapability('media_upload')`); no deep two‑way BD login sync.

---
*Constitution: `docs/projects/project-constitution.md`. Blueprint: `docs/projects/local-events-architecture.md`. v1 release: `docs/releases/organizations-events-v1.md`.*
