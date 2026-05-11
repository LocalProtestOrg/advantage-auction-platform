# Operational Documentation Index

Master index of operational documentation for Advantage.Bid growth systems.
This is separate from engineering documentation in `/docs/`.

---

## Engineering Documentation (in `/docs/`)

The following documents are maintained by the engineering machine and should
not be modified by growth operations:

| Document | Purpose |
|---|---|
| `/docs/business-rules.md` | Core auction business rules (authoritative) |
| `/docs/deployment-readiness.md` | Deployment checklist and infrastructure |
| `/docs/integration-contract-bd.md` | BD API integration contract |
| `/docs/product-vision.md` | Product vision and roadmap |
| `/docs/pilot-runbook.md` | Live pilot operating procedures |
| `/docs/sop-*.md` | Standard operating procedures (payment, refunds, payout, onboarding) |

**Growth operations reads these for context but does not edit them.**

---

## Operations Documentation (in `/ops/docs/`)

| Document | Purpose |
|---|---|
| `operations.md` | This file — master index |
| `workflow-discipline.md` | How growth agents work safely within /ops |
| `agent-operating-rules.md` | Rules for any agent assigned to work in /ops |

---

## Growth System Documentation (in `/ops/`)

| Path | Purpose |
|---|---|
| `/ops/growth/campaigns/` | Campaign planning and copy |
| `/ops/growth/seo/` | SEO strategy and internal linking |
| `/ops/growth/scenarios/` | Scenario page copy and education content |
| `/ops/growth/bd-pages/` | BD partner assets |
| `/ops/growth/outreach/` | Outreach architecture and lead routing |
| `/ops/onboarding/` | Seller onboarding experience |
| `/ops/onboarding/ai-agents/` | AI onboarding agent designs |
| `/ops/crm/` | CRM architecture and workflow logic |
| `/ops/branding/` | Brand guidelines and assets |

---

## Active Work Queue

*(Update as work is in progress)*

| Work Item | Status | Owner | Target date |
|---|---|---|---|
| Estate sale onboarding campaign — copy draft | In progress | Growth Ops | TBD |
| CRM tool selection | Planning | Operations | TBD |
| Seller landing page (`/seller`) — copy brief | Draft | Growth Ops | TBD |
| Scenario pages (estate, liquidation) — copy | Draft | Growth Ops | TBD |

---

## How to Submit a Work Request to Engineering

When growth operations needs something built or modified in the platform:

1. Document the requirement clearly in the relevant `/ops` planning file
2. Create a new section titled **"Engineering Request"** in that file
3. Specify:
   - What you need built
   - What it should do (functional requirements, not design prescriptions)
   - What existing system it connects to
   - Priority (must-have / nice-to-have)
   - Dependencies (what must be ready first)
4. The request is then handed to the engineering machine in a separate session

**Do not submit verbal or informal requests.** Written documentation ensures
requirements are captured accurately and implementation is traceable.

*Last updated: 2026-05-11*
