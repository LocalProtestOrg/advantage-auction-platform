# Advantage.Bid — Project Constitution

**Status:** RATIFIED 2026-07-05 (with the Engineering Charter, `docs/projects/engineering-charter.md`). Governing document — all future development aligns with this. Amendments require explicit Product Owner approval.
**Roles:** Product Owner = the human owner. Engineering execution = Lead Software Architect / Engineering Manager (this agent).

---

## 1. Mission
Advantage.Bid is **not** a single online auction website. It is a **multi‑tenant, white‑label auction network**: one platform powering many independent auction businesses ("Partners") — auction companies, estate‑sale companies, liquidators, nonprofits, municipalities, and others — each running a fully branded experience while participating in a shared marketplace. The goal is to be the **technology platform powering many businesses**, not one auction company.

## 2. Core philosophy
Always **one** of each: codebase, backend, production database, operational platform, engineering team. **Many** Partners. Favor **configuration over customization** — one feature, many configurations, never many custom implementations. Never hard‑code Partner‑specific logic.

## 3. Ownership model
**Each Partner owns:** their branding, their staff/seller users, their auctions, their events, their buyer *relationships*, their business rules, their legal agreements, their financial arrangements.
**Advantage.Bid owns:** the platform, infrastructure, marketplace visibility, marketplace promotion, security, engineering, the **shared bidder network**, shared search, shared discovery, shared technology, and **buyer authentication**.

## 4. Terminology (canonical)
**Partner, Partner Organization, Partner Network, White‑Label Platform, Marketplace, Syndication.** Never "client." This is an ecosystem, not client software.

## 5. Tenancy model — RATIFIED
- **Organization = Partner = tenant.** There is **no separate Partner entity**; we **extend Organizations**. Do not duplicate ownership models. **Sellers become roles/members within a Partner Organization.**
- **Advantage Auction Company is Organization / Partner #1.** All future Partners use the **exact same architecture** — avoid special cases.
- **Every tenant‑owned row carries the Organization (tenant) key; every query is tenant‑scoped.** Adding this early is cheap; retrofitting is expensive and leak‑prone. Standing requirement for all new tables/features.
- **Isolation:** logical scoping (tenant key + scoped queries) at minimum; Postgres RLS considered for payments/PII as the network grows.

## 6. Buyer identity — RATIFIED
- **Buyer accounts belong to the Advantage.Bid Network** — one global account per buyer. **Partners do not own buyer identities.**
- Partners own the **relationship, branding, communications, auctions, staff, and business rules** — not the buyer login.
- **The marketplace owns authentication and the buyer network.** Auth is native to Railway; no deep two‑way external login sync.

## 7. Marketplace rules — RATIFIED
- **Syndication is platform policy.** Every Partner auction **auto‑syndicates** to Advantage.Bid **by default**. **Partners cannot disable marketplace visibility.**
- **Only Platform Administrators** may hide, feature, promote, remove, or override syndication. **Every override is auditable** (who/when/why).
- Auto‑syndication is a term of the **Partner Agreement**.

## 8. Settlement engine — RATIFIED
- **One settlement engine.** All commissions, buyer premiums, platform fees, payout percentages, and financial agreements are **configuration**, never duplicated logic. Per‑tenant economics are data consumed by the single engine.

## 9. Configuration hierarchy — RATIFIED
```
Platform Defaults  →  Partner (Organization) Configuration  →  Auction Configuration
```
Resolution flows top‑down with override at each level; a new Partner is usable with zero config (inherits platform defaults). **Never hard‑code organization‑specific rules.**

## 10. Zero‑Fork Policy — RATIFIED (architectural rule)
- **Never fork code for a Partner.** New Partners should **almost never require new code**.
- If onboarding a Partner requires software customization, **stop and redesign the architecture** (make it configurable) before implementing. Configuration should solve nearly every Partner variation.
- Custom development for a single Partner requires **explicit Product Owner approval**.

## 11. Capability‑Based Platform — RATIFIED
- Build toward **capabilities**, not plans. **Plans grant capabilities.** Capabilities **drive authorization and future billing**.
- Capability set (extensible): Auctions, Events, Organizations, Imports, Shipping, White‑Label, Widgets, API, Live Auctions, AI, Reporting, Custom Domains.
- Authorization checks resolve to capabilities (e.g. `requireCapability('events')`), not to plan names or user types. Media upload and similar cross‑cutting features move behind capability checks (`requireCapability('media_upload')`).

## 12. White‑label platform
Supports `auctions.partnername.com` / `bid.partnername.com` on the **same backend**; branding + config resolve from the **incoming host**. No duplicate deployments/databases/codebases. Host‑based resolution is a deliberate security surface (host‑header trust, per‑tenant CORS).

## 13. Shared marketplace / network effects
Partners gain a shared bidder pool, shared SEO/marketing, shared infrastructure/technology, shared discovery. Advantage gains more inventory, more buyers, a stronger marketplace, a larger network. Intent: **network effects benefiting every Partner.**

## 14. Engineering philosophy
Configuration over customization; one feature, many configurations; reusable platform capabilities. **Become operational quickly** — do not over‑engineer or refactor working code for elegance alone; ship complete, production‑ready capabilities; cleanup follows launch. Enforce every important rule **server‑side**. Identity, payment, bidding, and close logic are critical infrastructure. The platform remains operational without Brilliant Directories; **BD is one presentation/engineering adapter among many**, never an operational dependency.

## 15. Brilliant Directories
When MCP/edit access permits, BD is **another engineering surface** (create/edit pages, update widgets/layouts, improve navigation/presentation). Protocol: **summarize intended BD changes before applying; validate results after.** Until access permits, BD edits are manual and BD API access is read‑only.

## 16. Approval gates (explicit approval required)
Production deployments (when requested) · Authentication redesign · Security model changes · Infrastructure changes (domains/TLS/hosting) · **Breaking schema changes** · **Stripe LIVE changes** · Payment architecture changes · Destructive operations. Everything else proceeds autonomously inside an approved milestone.

## 17. Standing architectural decisions (ratified decision log)
1. Organization = Partner = tenant; sellers are members; **no separate Partner entity**.
2. Advantage Auction Company = Organization/Partner #1; no special cases.
3. Global network buyers (shared pool) + tenant‑scoped staff/sellers; marketplace owns auth.
4. Auto‑syndication default‑on; admin‑only, audited visibility controls.
5. Single settlement engine; per‑tenant economics as configuration.
6. Configuration hierarchy: Platform → Partner → Auction.
7. Zero‑Fork Policy — Partners solved by configuration, not code.
8. Capability‑based platform — plans grant capabilities; capabilities drive authz + billing.
9. Host‑based white‑label; one deployment, one database.

## 18. Open questions (confirm before the relevant milestone)
- Custom‑domain mechanism (Railway custom domains vs wildcard/proxy) + TLS strategy.
- Timing of per‑tenant economics exposure (before vs after public launch).
- Isolation strength for payments/PII (logical vs RLS) and escalation trigger.

---

# Amendment — Marketplace Activation & Organization Lifecycle (2026-07-05b, RATIFIED in principle)

## 19. Brilliant Directories = Partner Acquisition Platform
BD is not merely the marketing website. It is the **Partner Acquisition Platform**, responsible for: Discovery, SEO, the Directory, **Claim Listings**, Lead Generation, Local Market Pages, Community, and **Partner Acquisition**. Railway is the **operational platform + system of record**. BD already contains 300+ real businesses; the objective is to **activate an existing nationwide network**, not fabricate launch data. **First objective: activate existing organizations, not create Partners.**

## 20. Organization Lifecycle (business‑relationship model)
```
Prospect → Directory Listing → Organization (Inactive) → Claimed → Verified → Active Partner → White‑Label Partner → Enterprise Partner → Partner Ambassador
```
This is both a software `lifecycle_state` and our long‑term **business relationship** model. Organizations progress along it; claiming and verification **enrich and activate an existing Organization**, they do not create one.

## 21. Organization‑First & hybrid materialization
- **Organizations are the permanent master business entity.** Every real business eventually has an Organization record **regardless of claim status**. Railway is the long‑term source of truth.
- **Everything attaches to the Organization:** events, auctions, images, reviews, followers, analytics, legal documents, capabilities, branding, marketplace status, reporting, communication history, and (future) CRM.
- **Hybrid materialization (not lazy, not eager‑full):** businesses are represented as **lightweight, inactive Organization "shells"** (minimal fields, no owner/capabilities/config) mirrored one‑way from BD directory listings via `bd_listing_id`. **Claiming enriches and activates the existing shell** (adds owner, verification, capabilities, config) — it never creates a duplicate. This keeps Organizations the master entity for the whole network while avoiding premature import of full Partner records.
- BD continues to own the public directory listing; Railway owns the Organization. **No two‑way sync.**

## 22. Partner CRM & Organization Health (design intent — not built yet)
Architect so these emerge naturally, without over‑engineering:
- **Partner CRM** stages (Contacted, Demo Scheduled, Interested, Claimed, Activated, Inactive, Former Partner, Partner Ambassador) map onto `lifecycle_state` + a future append‑only `organization_activity` log (the existing `audit_log` is the activity spine today). Everything keys off `organization_id`.
- **Organization Health / Completion Score** (claimed, verified, logo, photos, description, website, events, auctions, recent activity, marketplace participation) is **derivable from existing fields** — compute on demand; cache only if needed. No new schema required now.

## 23. Sync doctrine (reaffirmed)
BD → Railway is **one‑way, API‑based, read‑only** (directory listings + claim signals), evolving to **event‑driven (webhook)** for claims when BD write/webhook access exists. Railway → BD (Partner status/badges) is one‑way, display‑only, deferred. **Never two‑way Organization‑data sync.** Favor simple, reliable synchronization over complexity. Adapter‑based, not dependency‑based.

## 17b. Additional standing decisions (ratified)
10. BD = Partner Acquisition Platform; Railway = operational platform + source of truth.
11. Organization‑First: Organizations are the permanent master entity; everything attaches to `organization_id`.
12. Hybrid materialization: inactive Organization shells mirrored from BD; claim enriches/activates, never duplicates.
13. Organization Lifecycle is the canonical relationship model (Prospect → … → Partner Ambassador).
14. CRM + Organization Health are derivable/append‑only extensions — design for them, don't build yet.

*Related: `engineering-charter.md` (how we execute), `marketplace-activation-strategy.md` (activation/growth/governance), `partner-lifecycle.md` (business relationships), `local-events-architecture.md`, `launch-content-roadmap.md`, `../releases/organizations-events-v1.md`.*
