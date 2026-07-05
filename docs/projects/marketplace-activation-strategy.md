# Marketplace Activation Strategy (PROPOSED — awaiting approval)

Governing strategy for activating the **Advantage.Bid Partner Network**. Complements `project-constitution.md` (§19–§23) and `partner-lifecycle.md`. Focus: **activation, growth, acquisition, governance, launch** — not content fabrication.

## Vision
We are building the **Advantage.Bid Partner Network** — software that enables a network of hundreds→thousands of independent auction/estate‑sale/liquidation/nonprofit/municipal organizations, each keeping its own brand. **The software enables the network; the network creates the value.**

## The reality that reframes Phase 3
Brilliant Directories already contains **300+ real businesses**, many as unclaimed **Claim Listings**. Phase 3 is **Marketplace Activation**: convert existing businesses into Active Partners. **BD = Partner Acquisition Platform** (Discovery, SEO, Directory, Claim Listings, Lead Gen, Local Market Pages, Community, Acquisition). **Railway = operational platform + source of truth.**

## Organization philosophy — Organization‑First + hybrid materialization
**Organizations are the permanent master business entity.** Every real business eventually has an Organization record **regardless of claim status**; everything attaches to `organization_id` (events, auctions, images, reviews, followers, analytics, legal, capabilities, branding, marketplace status, reporting, comms, CRM).

**Hybrid materialization** (the approved middle path):
- Mirror BD directory listings one‑way into **lightweight, inactive Organization "shells"** — minimal fields (name, category, city/state, `bd_listing_id`, `lifecycle_state`, `source`), **no owner / capabilities / config / legal**.
- **Claiming enriches and activates the existing shell** (owner + verification + capabilities + config) — never creates a duplicate.
- Result: Organizations are the master entity for the **whole** network (enabling CRM, health, analytics on any business), while we avoid importing full Partner records prematurely.

## Lifecycle (canonical)
```
Prospect → Directory Listing → Organization (Inactive) → Claimed → Verified → Active Partner → White‑Label Partner → Enterprise Partner → Partner Ambassador
```
A single ordered `lifecycle_state` on `organizations`; each transition audited and grants capabilities progressively (capability‑based platform already built). See `partner-lifecycle.md` for the relationship model.

## BD ↔ Railway relationship (refined)
| Flow | Direction | Mechanism | Notes |
|---|---|---|---|
| Directory listings → inactive Org shells | **BD → Railway** | one‑way, read‑only, API‑based (batch import + incremental refresh, idempotent on `bd_listing_id`) | source data for the master entity |
| Claim signals | **BD → Railway** | one‑way; **on‑demand/polled now**, **event‑driven (webhook) later** | triggers claim/enrichment |
| Partner status/badges/links | Railway → BD | one‑way, display‑only, **deferred** (needs BD write) | manual/BD‑edit for now |
| Organization operational data | — | **never two‑way** | Railway is source of truth |

Adapter‑based (`bdDirectoryService` isolates all BD coupling), not dependency‑based. Favor simple, reliable sync over complexity.

## Hybrid vs Lazy materialization — recommendation
**Recommend HYBRID** (inactive shells) over lazy (create‑on‑claim), for this vision:
| Dimension | Lazy (Org on claim) | **Hybrid (inactive shells)** |
|---|---|---|
| Org = master entity for whole network | ✗ claimed only | ✓ every business |
| Partner CRM (track pre‑claim prospects) | ✗ nothing to attach to | ✓ native |
| Organization Health scoring (unclaimed) | ✗ | ✓ |
| Network analytics on Railway | ✗ (BD round‑trips) | ✓ |
| Claim UX | create | **enrich existing (cleaner)** |
| Row count | minimal | +300 now → thousands (thin rows) |
| Sync | on‑demand read | one‑way import/refresh (idempotent) |
| Retrofit risk as vision grows | **HIGH** (rebuild master + CRM later) | none |

**Tradeoffs of hybrid:** more (thin) rows + a one‑way import/refresh job + BD data‑quality management. **Long‑term:** hybrid is the only model that supports the full Partner Network + CRM + Health + network analytics; lazy would force a painful retrofit. Mitigations: keep shells minimal; `lifecycle_state` cleanly separates inactive shells from active partners in every query (marketplace shows only active‑partner content); import market‑scoped/batched at scale.

## Revised Phase 3 execution plan (Marketplace Activation)
- **3A — Activation foundation** (engineering, additive): migration adds `organizations.lifecycle_state`, `bd_listing_id` (unique), `source`; `bdDirectoryService` (read‑only BD adapter); `organizationLifecycleService` (state machine + audit + stage capability grants); tests. *Gate: prod deploy.*
- **3B — Directory mirror + Claim/onboarding** (additive): one‑way import of BD listings → inactive shells (idempotent, staging‑dry‑run first); claim → enrich/activate flow (prefill, verify, Partner Agreement, activate). *Gates: prod import, BD edits, legal publishing.*
- **3C — Pilot activation**: activate a small set of **real** claimed listings (start Houston) as first Active Partners; their real events/auctions fill the marketplace. *Gate: production activation.*
- **3D — Activation‑aware readiness dashboard**: funnel metrics — listings mirrored / claimed / verified / active partners / partner‑published events + auctions.

## Governance & guardrails
Railway source of truth; BD acquisition + presentation adapter; Zero‑Fork; capability + config driven; no Stripe/settlement/payment or destructive changes; White‑Label/Enterprise as configuration. Activation of **real** businesses replaces artificial data.

## Growth / acquisition (strategy)
BD drives discovery + claim; the platform converts claims → Active Partners; Active Partners' auctions auto‑syndicate, strengthening the marketplace and SEO, which drives more discovery — a compounding **network‑effects loop**. Ambassadors (top tier) refer peers.

---
**STOP — awaiting approval.** On approval this becomes the governing Marketplace Activation roadmap; I will then ratify the Constitution/Roadmap/Dashboard updates and begin **3A** (additive, staging‑validated), holding all gated activation/import/BD/legal steps for their approvals.
