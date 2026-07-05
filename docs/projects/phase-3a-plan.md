# Phase 3A — Activation Foundation (APPROVED plan)

Foundation for Marketplace Activation. Additive, behavior‑preserving. Builds on Phase 1/2. Governed by `project-constitution.md` (§19–§23), `marketplace-activation-strategy.md`, `partner-lifecycle.md`.

## Objective
Introduce the Organization **lifecycle** as the single master status axis, consolidate ownership, add BD linkage + dedup matching, make Organization code **null‑owner‑safe** (inactive shells), and bake **strict claim security** into a lifecycle service — so BD listings can later be mirrored and real Partners activated without regret.

## Schema (migration 079, additive)
- `organizations.lifecycle_state` (NOT NULL, **default `inactive`** = fail‑closed) CHECK ∈ {prospect, directory_listing, inactive, claimed, verified, active_partner, white_label_partner, enterprise_partner, partner_ambassador}.
- `organizations.source` (NOT NULL default `onboarding`) CHECK ∈ {onboarding, direct_signup, bd_import, directory_claim, admin}.
- `organizations.bd_listing_id` TEXT + partial UNIQUE index.
- `organizations.match_key` TEXT + index (normalized name+state; dedup natural key).
- Indexes: lifecycle_state, match_key.
- **Deprecation comments** (non‑destructive): `organizations.seller_profile_id`, `seller_profiles.capabilities`.
- **Backfill:** existing orgs → `active_partner`; `match_key` computed; platform tenant `source='admin'`.

## Master status model
`lifecycle_state` = master progression. `verification_status` = derived trust‑badge projection (set by the `verify` transition; badge code still reads it). `status` (active/suspended) = orthogonal operational flag. `auctions.organization_id` = canonical auction owner; `seller_profiles.organization_id` = legacy bridge; `organizations.seller_profile_id` + `seller_profiles.capabilities` = deprecated.

## Services
- `organizationLifecycleService`: `createShell` (inactive, no owner), `claim` (→claimed, owner, **0 caps**), `verify` (admin →verified, sets verification_status, baseline caps), `activate` (admin →active_partner, operational caps). From‑state guards + audit each transition.
- `organizationMatchingService`: `computeMatchKey`, `findByBdListingId`, `findCandidatesByMatchKey` (dedup candidates; advisory).
- `organizationsService`: onboarding sets lifecycle=`active_partner`/source/match_key (grant unchanged); add `getOwner`/`hasOwner` (null‑safe).
- Admin endpoint `POST /api/admin/partners/:orgId/lifecycle {action: verify|activate}` (admin‑only).

## Security
Claim grants **no** capabilities; capabilities begin at `verified`/`activated` (admin‑gated); every transition audited. Inactive shells are **internal‑only** (default fail‑closed `inactive`; not publicly exposed). Self‑service onboarding unchanged (user is inherently owner → no impersonation risk).

## Tests (Tier 1) / Staging (Tier 2) / Prod (gated)
Tier 1 scratch: migration/backfill/comments; lifecycle transitions + guards + grant timing + audit; matching; null‑owner; onboarding fields. Tier 2 staging: guarded `stg-migrate-079` + backfill verify; no‑regression smoke; service‑level lifecycle run + admin endpoint gating. Prod: Neon backup → `prod-migrate-079` → merge → validate — **gated**.

## Out of scope (later)
BD import/mirror (3B), claim UI (3B), public org discovery, real partner activation (3C), removing deprecated columns, changing self‑service grants, Stripe/payment/settlement/tax.

## Deferred triggers
acting‑org context (before 3B multi‑partner writes) · RLS (before multi‑partner writes) · health caching (CRM list views) · generic limits (2nd product limit) · CRM tables (structured CRM) · BD webhooks (BD write access + volume) · white‑label host resolution (Phase 5).
