# Partner Lifecycle (business relationship model)

Companion to `project-constitution.md` (§20–§22) and `marketplace-activation-strategy.md`. This document describes the **business relationship** with an Organization across its life — not the engineering. It is the shared language for acquisition, onboarding, success, and growth.

## The lifecycle
```
Prospect → Directory Listing → Organization (Inactive) → Claimed → Verified → Active Partner → White‑Label Partner → Enterprise Partner → Partner Ambassador
```

| Stage | What it means (relationship) | How they enter | What we do | Where it lives |
|---|---|---|---|---|
| **Prospect** | A business we want in the network; not yet engaged. | Outreach target / lead. | Contact, qualify, invite to claim. | CRM (lead); optional thin Org. |
| **Directory Listing** | Present in BD's public directory (one of 300+). | Exists in BD / we add it. | SEO, local pages, discovery — BD acquisition. | BD (public); mirrored to an inactive Org. |
| **Organization (Inactive)** | A permanent master record exists on Railway, unclaimed. | One‑way mirror of a BD listing. | Track, score health, target for activation. | Railway Organization (shell). |
| **Claimed** | A real owner has claimed the listing. | Owner claims (BD or Railway), authenticates. | Enrich profile, guide onboarding, request verification. | Railway Org + owner member. |
| **Verified** | Advantage confirmed the business is legitimate. | Admin verification. | Grant baseline capabilities; enable events. | `verification_status='verified'`. |
| **Active Partner** | Operational — publishing events/auctions that syndicate. | Publishes first content (or admin activation). | Support operations, growth, marketplace features. | Capabilities: auctions/events/etc. |
| **White‑Label Partner** | Runs a fully branded experience (domain, branding, legal, business rules). | Opts into white‑label. | Provision domain/branding config; per‑Partner legal. | Config + white_label capability. |
| **Enterprise Partner** | Advanced needs — API, reporting, RBAC, SLA, high volume. | Enterprise agreement. | Advanced capabilities, dedicated support. | api/reporting/live_auctions capabilities. |
| **Partner Ambassador** | Top‑tier advocate who refers peers and leads community. | Invitation / performance. | Referral/community program; co‑marketing. | Relationship tier (CRM). |

**Directionality:** the lifecycle is generally forward, but relationships can regress (e.g., Active → Inactive) or end (Former Partner). Every transition is audited.

## Partner CRM stages (relationship management — future)
CRM stages overlap and enrich the lifecycle: **Contacted → Demo Scheduled → Interested → Claimed → Activated → Inactive → Former Partner → Partner Ambassador.** These live as relationship metadata on the Organization + an append‑only activity history (today: `audit_log`; future: `organization_activity`). Nothing is built yet — the architecture simply keeps everything keyed to `organization_id` so CRM emerges naturally.

## Organization Health / Completion (outreach signal — future)
A per‑Organization score derived from existing data: claimed · verified · logo · photos · description · website · events · auctions · recent activity · marketplace participation → **overall completion**. Used to prioritize onboarding help and outreach. **Derivable on demand — no new schema now.** Low completion + high potential = an outreach target; high completion + inactive = a re‑engagement target.

## How BD and Railway serve the relationship
- **BD (acquisition):** discovery, SEO, directory, claim listings, lead generation, local market pages, community — fills the top of the funnel and hands off claims.
- **Railway (operations + record):** owns the Organization from Inactive onward, runs onboarding/verification/activation, powers auctions/events/marketplace, and holds all relationship data.
- Hand‑off is **one‑way BD → Railway** (listings + claims). Railway is the single source of truth for the relationship.

## Guiding principle
We are not selling software to clients; we are **growing a network of Partners**. Every stage should reduce friction toward the next, and each Active Partner strengthens discovery for the rest — the compounding value of the Advantage.Bid Partner Network.
