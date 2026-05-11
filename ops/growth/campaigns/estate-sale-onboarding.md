# Estate Sale Seller Onboarding Campaign

**Status:** Planning
**Owner:** Growth Operations
**Engineering dependency:** Seller application flow (existing), email sequences (CRM TBD)

---

## Objective

Acquire qualified estate sale sellers — executors, estate attorneys, senior move
managers, and direct families managing estate liquidation — and guide them into
the Advantage seller onboarding flow.

**Success metric:** Qualified seller applications submitted (not just clicks).

---

## Target Seller Profiles

| Profile | Description | Estimated deal size |
|---|---|---|
| Estate executor | Managing a single estate liquidation | $10k–$150k inventory |
| Estate attorney | Recurring referral relationship, multiple estates per year | High referral value |
| Senior move manager | Professional downsizer, recurring | Medium-high |
| Direct family | One-time estate, no professional help | Varies widely |
| Small liquidator | Operating independently, wants better auction reach | Medium, recurring |

---

## Funnel Architecture

```
Awareness
  └── SEO / paid search / partner referral
      └── Scenario landing page (e.g. "How Estate Auctions Work")
          └── CTA: "See if your estate qualifies"
              └── Lead capture / pre-qualification form
                  ├── Qualified → Seller application → Onboarding flow
                  └── Not qualified → Educational drip sequence (re-qualify over time)
```

---

## Key Messages

- **Trust signal:** "Managed by Advantage — a full-service auction team, not just software"
- **Ease signal:** "We handle listings, photos, bidding, payment, and buyer coordination"
- **Control signal:** "You set the terms. We handle the buyers."
- **Timeline signal:** "From intake to close in [X weeks]" *(confirm with ops before publishing)*
- **No upfront cost:** Advantage earns from buyer premium — sellers pay nothing upfront

---

## Landing Page Requirements

*(Submit to engineering machine when ready to build)*

- Page slug: `/seller` or `/estate-auction` (SEO-optimized)
- Above fold: headline + 1-sentence value prop + primary CTA button
- Section: How it works (3-step visual)
- Section: What we auction (estate, commercial, collections)
- Section: What sellers say (testimonials — placeholder until collected)
- Section: FAQ (pickup logistics, timeline, payment, photos)
- CTA: Link to seller application flow (existing `/seller-create.html`)
- No new API endpoints required — links to existing seller app

---

## Email Sequence (Post Lead Capture)

*(Requires CRM integration — see `/ops/crm/workflow-logic.md`)*

| Email | Timing | Subject |
|---|---|---|
| 1 — Welcome | Day 0 | "Your estate auction — here's what happens next" |
| 2 — Education | Day 2 | "What makes an estate auction successful?" |
| 3 — Social proof | Day 4 | "Recent auctions on Advantage" |
| 4 — Objection handling | Day 7 | "Your questions about consigning, answered" |
| 5 — Application CTA | Day 10 | "Ready to get started? Here's your next step." |
| 6 — Final nudge | Day 14 | "One last thing before we close your spot" |

---

## Dependencies

| Dependency | Status | Owner |
|---|---|---|
| Seller application flow | Live | Engineering |
| Email delivery (SMTP/ESP) | TBD — requires CRM setup | Engineering |
| CRM lead capture form | Not built | Engineering (request needed) |
| Landing page | Not built | Engineering (request needed) |
| Testimonials / social proof | Not collected | Growth Ops |

---

## Next Actions

- [ ] Define pre-qualification criteria with operations team
- [ ] Draft landing page copy (submit to engineering for build)
- [ ] Select email service provider (see CRM planning)
- [ ] Collect 3+ seller testimonials for social proof section
- [ ] Design A/B test for primary CTA copy ("Get started" vs "See if you qualify")

*Last updated: 2026-05-11*
