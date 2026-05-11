# CRM Workflow Logic

Defines the specific automation sequences, triggers, and branching logic for
Advantage's CRM workflows. This document is the source of truth for what the
CRM should do — separate from which tool executes it.

---

## Workflow 1 — New Lead from Landing Page

**Trigger:** Form submitted on any seller acquisition landing page

```
TRIGGER: form submit
  │
  ├── Create contact in CRM (or update if exists)
  │     Fields: name, email, phone, city/state, description, timeline, source
  │
  ├── Set status: "warm"
  │
  ├── Send Email 1: Application confirmation (Day 0, immediate)
  │     Subject: "We received your auction inquiry"
  │     Body: confirms receipt, sets expectation ("hear from us within X hours"),
  │           links to "how it works" page
  │
  ├── Notify ops team: new lead alert (email or Slack)
  │
  └── If no ops action within [X hours]:
        Enroll in warm email sequence (Workflow 3)
```

---

## Workflow 2 — Application Submitted (Full)

**Trigger:** Seller submits the full application in the platform

```
TRIGGER: full application submitted
  │
  ├── Create / update CRM contact
  ├── Set status: "application submitted"
  ├── Notify ops: "New application from [Name]"
  │
  ├── Send Email: "Application received — here's what happens next"
  │     Includes: typical assessment timeline, what to have ready
  │
  └── OPS REVIEW (human step — no automation)
        ├── Qualified → Schedule assessment call → set status: "qualified"
        ├── Need more info → Send info request email → status: "pending info"
        └── Not qualified → Send decline email → status: "declined"
```

---

## Workflow 3 — Warm Nurture Sequence

**Trigger:** Lead enrolled after landing page form (did not submit full application)

```
Day 0:  Email 1 — "You're on the right track"
        [Confirmation + "what happens when you apply" overview]

Day 2:  Email 2 — "Here's what an estate auction actually looks like"
        [Scenario education — links to scenario page]

Day 4:  Email 3 — "What sellers say about Advantage"
        [Social proof — testimonials or auction results]

Day 7:  Email 4 — "Common questions about consigning"
        [FAQ-style objection handling]

Day 10: Email 5 — "Ready to take the next step?"
        [Primary CTA: "Start your application →"]

Day 14: Email 6 — Final nudge
        [Light urgency: "We have limited auction slots — if you're ready..."]

Day 21: Move to "inactive" status — no further automated outreach
        [Ops may manually re-engage based on notes]
```

---

## Workflow 4 — Stalled Application

**Trigger:** Application started in platform but not submitted after 48 hours

*(Requires save-draft feature — engineering request needed)*

```
TRIGGER: application created, not submitted, 48 hours elapsed
  │
  ├── Send Email: "Were you still thinking about consigning?"
  │     Includes: link back to saved draft, offer to answer questions
  │
  └── If no action after 7 days:
        Enroll in warm nurture sequence (Workflow 3) from Day 2
        Set source tag: "stalled_application"
```

---

## Workflow 5 — Post-Auction Re-Engagement

**Trigger:** Seller payout recorded in platform

*(Requires payout event hook — engineering request needed)*

```
TRIGGER: payout marked complete
  │
  ├── Wait 30 days
  │
  ├── Send Email: "Your auction results — and what comes next"
  │     Includes: brief summary reference, invitation to consign again
  │
  └── If reply or click: notify ops for personal follow-up
        Set status: "re-engagement active"
```

---

## Status Values

| Status | Meaning |
|---|---|
| `lead` | First contact, not yet qualified |
| `warm` | In nurture sequence |
| `application_submitted` | Full application received |
| `pending_info` | Ops requested more information |
| `qualified` | Ops approved — assessment scheduled |
| `active_seller` | Auction in progress |
| `past_seller` | At least one completed auction |
| `declined` | Not a fit — documented reason |
| `inactive` | No response after all sequences — archived |

---

## Open Questions for Operations

- [ ] What is the ops response SLA for new applications?
- [ ] Who receives new lead / application notifications?
- [ ] What is the criteria for "qualified" vs "need more info"?
- [ ] Should declined leads be re-approachable after 6 months?
- [ ] What channel does the ops team prefer for lead alerts? (email, Slack, SMS)

*Last updated: 2026-05-11*
