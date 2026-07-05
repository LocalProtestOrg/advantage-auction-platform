# Partner Foundation — Architecture (Phase 2)

**Status:** Implemented (migration 078, additive). Makes the platform truly multi-tenant. Governed by `project-constitution.md` §7, §8, §9, §11. Builds on Phase 1 (`tenancy-and-capabilities.md`).

## Four pillars

### A) Capability enforcement (§11)
- `plan_capabilities` maps each plan tier → capabilities (free: organizations/events/widgets; standard: +imports/shipping; premium: +api/reporting/ai/live_auctions).
- **Onboarding grants** the plan's capabilities (`organizationsService.onboardOrganization` → `capabilityService.grantPlanCapabilities`); the migration **backfills** grants for all existing orgs. Admins grant/override via `/api/admin/partners/:orgId/capabilities`.
- **Enforcement:** `requireOrgCapability(cap)` middleware checks the acting org (admins bypass). Wired to event submission (`POST /api/org/events/:id/submit` requires `events`). Grant-all-first → no lockouts. `requireCapability` (Phase 1) remains for host/platform-tenant checks.

### B) Organization configuration (§9)
- `platform_config` (defaults) + `organization_config` (overrides); effective = override ?? default. `configService.get/getAll/setOrgConfig/setPlatformConfig`.
- Seeded branding + business-rule values (buyer premium / commission / platform fee). **Business-rule values are config only — NOT consumed by the settlement engine** (that wiring is a gated payment-architecture step).
- Surfaces: `GET /api/config/branding` (public), `/api/config/platform` (admin), `/api/config/org` (partner self-service), `/api/admin/partners/:orgId/config` (admin).

### C) Legal document framework (§8/§12)
- `legal_documents` (per org; NULL = platform default) → `legal_document_versions` (versioned, one published) → `legal_acceptances` (per-user ledger). `legalService`.
- Publishing a version unpublishes siblings; `getPublished(org, type)` falls back to the platform default. Surfaces: `GET /api/legal/:docType` (public), `POST /api/legal/accept` (auth), admin manage under `/api/legal/documents|versions`.

### D) Marketplace syndication (§7)
- `auctions.is_syndicated` (default true) + `marketplace_status` (syndicated|hidden|removed) + `is_featured`/`is_promoted` + `marketplace_updated_by/at`.
- **Default-on syndication**; public marketplace listing filters `marketplace_status='syndicated'`, detail excludes `removed`. **Admin-only** controls (`marketplaceService`) via `/api/admin/marketplace/:auctionId/(hide|show|remove|restore|feature|unfeature|promote|unpromote)`, each **audited** to `audit_log`. Partners cannot change visibility.

## Behavior changes (intended)
- Event **submit** now requires the org's `events` capability (all orgs have it via plan/backfill).
- Public marketplace now respects syndication status (all existing auctions default `syndicated` → no regression).

## Not changed / deferred
Settlement/tax/payment engine (business-rule config is data only) · host-based branding resolution (Phase 5) · secondary public listings (`/auctions/near`, past) still to inherit the syndication filter (follow-up) · partner/admin HTML UIs (APIs delivered; thin UI to follow).

## Validation
- **Tier 1** (scratch, 076+077+078): `tests/partner/partner-foundation.test.js` — plan→capability seeds + grant-on-onboard + admin override; config default/override/inheritance; legal version/publish/fallback/acceptance; marketplace default-syndicated + admin hide/restore/feature + audit.
- **Tier 2** (staging): migration applied via `stg-migrate-078`; marketplace/legal/config/capability endpoints + no-regression smoke.

## Rollback
Neon backup restore, or guarded `scripts/rollback-078.js` (drops new tables + auction columns + ledger row; leaves harmless `source='plan'` capability grants). Additive migration → low behavior risk.
