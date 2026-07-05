# Tenancy & Capabilities — Architecture (Phase 1: Platform Foundation)

**Status:** Implemented (migration 077, additive/non-breaking). Governed by `project-constitution.md` §5, §8, §9, §11.

## Summary
Establishes the multi-tenant spine: **Organization = Partner = tenant**, with **Advantage Auction Company as Organization / Partner #1** (the platform tenant), plus a first-class **capability model**. Additive and behavior-preserving — the read-layer helpers exist but are **not yet wired to any route**.

## Tenancy model
- **Organization is the tenant root.** `organizations.is_platform_tenant` flags the single platform tenant (Advantage). Reserved white-label columns (`primary_domain`, `custom_domains`) are schema-only for Phase 5.
- **Ownership chain (live auctions):** `users → seller_profiles → auctions → lots`. Tenant key added as nullable `organization_id` on `seller_profiles` and `auctions` (denormalized for direct tenant-scoped queries). `events.organization_id` already existed (076).
- **`app_auctions` / `app_bids`** are legacy demo scaffolding (dev-only reset) and are intentionally **not** tenant-tagged.
- **Backfill:** all existing sellers + auctions are assigned to Advantage (Partner #1). Idempotent (`WHERE organization_id IS NULL`).
- **Buyers are global** (network identities) and are **not** tenant-scoped (Constitution §6).

## Capability model (Constitution §11)
- **`capabilities`** — catalog of platform capabilities (12 seeded: auctions, events, organizations, imports, shipping, white_label, widgets, api, live_auctions, ai, reporting, custom_domains).
- **`organization_capabilities`** — per-org grants (`enabled`, `source` ∈ plan|grant|override). This is the **effective** capability set for a tenant. Admin overrides and plan-derived grants coexist via `source`.
- **Plans grant capabilities** (future onboarding seeds grants from the plan). The platform tenant is granted **all** capabilities.
- Authorization asks *"does this tenant have capability X?"* — never *"what plan / user type is this?"* This supersedes the legacy, unused `seller_profiles.capabilities` JSONB (left untouched; to be reconciled later).

## Read-layer helpers (additive; unwired)
- **`src/lib/tenantContext.js`** — `getPlatformTenant()`, `resolveTenant(req)` (Phase 1: always the platform tenant; Phase 5: resolve by Host), `getCapabilities(orgId)`, `hasCapability(orgId, cap)`. Single seam for future host-based resolution.
- **`src/middleware/requireCapability.js`** — `requireCapability(cap)` resolves the tenant, attaches `req.tenant`, and 403s if the capability isn't enabled. Not applied to existing routes yet (Advantage holds all capabilities, so it would never block today).

## Why this shape (reusable-architecture rationale)
- **Capability-based, not plan/user-type gating** → one authorization model scales across auctions/events/imports/API and future billing without per-Partner code (Zero-Fork, §10).
- **`resolveTenant` seam** → host-based white-label lands in one place, no caller changes.
- **Denormalized `organization_id`** on auctions → efficient marketplace/syndication filtering without deep joins.

## What this milestone intentionally defers
Host-based domain resolution · per-tenant branding/config editing · marketplace syndication controls · per-tenant economics · `NOT NULL` enforcement on tenant keys · RLS. These are later phases (see `launch-content-roadmap.md`).

## Validation
- **Tier 1** (isolated Neon scratch, 076+077): `tests/tenant/tenant-foundation.test.js` — schema/seeds, single Advantage platform tenant + all 12 capabilities, backfill leaves zero untenanted sellers/auctions, capability resolution.
- **Tier 2** (staging): migration applied via `stg-migrate-077.js`; existing auction/events endpoints unchanged (additive-only, nothing reads the new columns).

## Rollback
Additive: drop `organization_capabilities`, `capabilities`, the new columns/indexes, and the `schema_migrations` row for 077; or restore the pre-migration Neon backup. Backfill is reversible (`SET organization_id = NULL`) but unnecessary (no reader).
