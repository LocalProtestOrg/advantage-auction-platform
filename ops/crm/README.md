# CRM Architecture

Planning directory for Advantage's customer relationship management system.
Covers lead capture, contact management, automation, and analytics.

**Current status:** No CRM is live. This directory plans what it should be.

---

## CRM Scope

The CRM manages three relationship types:

| Relationship | Contacts | Actions tracked |
|---|---|---|
| Seller leads | Prospective sellers who have not yet applied | Outreach, opens, replies |
| Active sellers | Sellers with submitted or in-progress applications | Application status, follow-ups |
| Past consignors | Sellers who have completed at least one auction | Re-engagement, repeat consignment |

*(Buyers are handled by the platform's payment and notification system — not CRM)*

---

## CRM Requirements

### Must Have

- Contact record with lead source, status, and history
- Lead routing logic (see `/ops/growth/outreach/lead-routing.md`)
- Email sequence automation (post-form, follow-up, re-engagement)
- Integration with seller application form (pass submitted applications to CRM)
- Basic analytics: open rates, reply rates, conversion rates

### Nice to Have

- Two-way email sync (replies from sellers update CRM record)
- Calendar scheduling integration (for assessment call booking)
- Ops notes on each contact
- Tag-based segmentation (estate vs. commercial, region, deal size)

### Do Not Need (at this stage)

- Complex pipeline management (platform handles auction lifecycle)
- Buyer CRM (platform handles buyer relationships)
- Revenue forecasting (ops handles this manually at current scale)

---

## CRM Tool Options (TBD)

| Tool | Notes |
|---|---|
| HubSpot (free tier) | Good for early stage; email sequences, forms, contact records |
| Airtable + Zapier | Flexible; good if ops prefers spreadsheet model |
| Notion + make.com | Lightweight; good for docs-first teams |
| Custom-built | Only if platform integration is critical and no tool fits |

**Recommendation:** Start with HubSpot free tier or Airtable.
Delay custom integration with the platform until CRM workflows are proven manually.
*This is a growth operations decision — not an engineering decision.*

---

## Platform Integration (Future)

When workflows are proven and a CRM tool is selected, the following integrations
may be requested from engineering:

| Integration | Description |
|---|---|
| Seller application → CRM | POST to CRM when application is submitted |
| Auction close → CRM | Trigger re-engagement sequence after payout |
| Seller profile activation → CRM | Sync activated sellers to "active" segment |

These are engineering requests, not self-service. Document them here before
submitting to the engineering machine.

*Last updated: 2026-05-11*
