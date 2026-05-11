# Lead Routing Workflow

Defines how leads move from initial contact point through qualification and into
the seller onboarding flow. This document covers routing logic — the CRM
automation that executes it is in `/ops/crm/workflow-logic.md`.

---

## Lead Entry Points

```
Paid search landing page
  └── Inbound form submit → Lead: warm, qualify by form data
  
BD partner referral
  └── Partner sends contact or referral link → Lead: warm, note source
  
Organic / SEO scenario page
  └── CTA click → Seller application → Lead: high intent

Cold outreach email reply
  └── Reply / click → Lead: interested, route to warm follow-up

Prior consignor re-engagement
  └── Claim flow or re-application → Lead: returning, high priority

Directory / LinkedIn
  └── Replied to direct message → Lead: cold, needs qualification call
```

---

## Lead Qualification Criteria

A lead is "qualified" when:

- [ ] Has inventory to auction (not just browsing)
- [ ] Inventory is in a serviceable area (pickup logistics are feasible)
- [ ] Timeline is compatible with auction scheduling
- [ ] Not actively already using a competing auction service (or willing to switch)
- [ ] No red flags: unrealistic price expectations, non-standard items outside scope

**Disqualifying factors:**
- Single item of minimal value (does not meet minimum lot threshold — *ops to define*)
- Geographic area outside service range (no pickup partner available)
- Items that cannot be legally auctioned (hazardous materials, restricted items)

---

## Routing Logic

### Hot lead (seller application submitted)

```
Application submitted
  → Ops receives notification (email / CRM alert)
  → Ops reviews within [X hours] — SLA TBD
  → If qualified: schedule call / assessment → move to auction planning
  → If not qualified: send polite decline email with explanation
  → If more info needed: send follow-up email requesting details
```

### Warm lead (form fill / landing page, did not complete application)

```
Form submit (lead capture, not full application)
  → CRM adds to "warm" sequence
  → Email 1: confirmation + next step prompt (Day 0)
  → Email 2: "How it works" education (Day 2)
  → Email 3: Social proof (Day 4)
  → Email 4: CTA — complete your application (Day 7)
  → If no action after Day 14: move to re-engagement sequence (30 days later)
```

### Cold lead (directory list, LinkedIn, outreach)

```
Initial outreach sent
  → Wait for reply (no follow-up before 5 business days)
  → Reply received: move to warm sequence
  → No reply after 2 touches: archive lead (do not continue cold outreach)
```

---

## CRM Fields Required for Routing

*(Submit to engineering for data model if CRM is platform-integrated)*

| Field | Type | Purpose |
|---|---|---|
| `lead_source` | Enum | Tracks entry point for attribution |
| `lead_status` | Enum | cold / warm / qualified / converted / declined |
| `assigned_to` | Text | Ops team member handling this lead |
| `first_contact_at` | Timestamp | When outreach or form first occurred |
| `last_activity_at` | Timestamp | Most recent action on lead |
| `qualification_notes` | Text | Free-form notes from ops review |
| `disqualification_reason` | Text | If declined, why |

---

## SLAs (To Be Confirmed with Operations)

| Lead type | Target response time |
|---|---|
| Hot (full application) | [X hours — ops to define] |
| Warm (partial form) | Automated Day 0 email immediately |
| BD partner referral | [X hours — define with partner agreement] |

---

## Open Questions for Operations

- [ ] What is the minimum inventory threshold for qualification?
- [ ] What service area is currently supported for pickup?
- [ ] What is the target response SLA for submitted applications?
- [ ] Who owns each lead routing step (operations vs. automated)?

*Last updated: 2026-05-11*
