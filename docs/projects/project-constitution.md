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

*Related: `engineering-charter.md` (how we execute), `local-events-architecture.md` (Organizations & Events blueprint), `launch-content-roadmap.md` (roadmap), `../releases/organizations-events-v1.md` (v1 release).*
