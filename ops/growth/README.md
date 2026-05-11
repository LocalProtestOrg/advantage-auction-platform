# Growth Systems

Umbrella directory for all marketplace growth initiatives: campaigns, SEO,
scenario pages, BD assets, and outreach architecture.

---

## Subdirectories

| Directory | Purpose |
|---|---|
| `campaigns/` | Outbound and seller acquisition campaigns |
| `seo/` | Search engine strategy, internal linking, content planning |
| `scenarios/` | Scenario landing pages, liquidation education, estate sale guides |
| `bd-pages/` | BD-facing landing pages, pitch decks, partner integration guides |
| `outreach/` | Outreach system architecture, lead routing, email sequences |

---

## Growth Priorities (Current Planning Stage)

### Tier 1 — Seller Acquisition
The primary near-term growth lever is qualified seller acquisition:
estate liquidators, downsizing households, and commercial surplus holders.

- Estate sale onboarding campaign → `campaigns/estate-sale-onboarding.md`
- Seller scenario education pages → `scenarios/`
- AI-assisted onboarding flow → `../onboarding/ai-agents/`

### Tier 2 — Market Presence
Build discoverable presence for types of auctions the platform serves.

- SEO content targeting liquidation, estate auction, and surplus search queries → `seo/`
- Scenario landing pages that serve both SEO and direct conversion → `scenarios/`

### Tier 3 — BD / Partner Growth
Support BD (partner) channels with assets they can embed and present.

- BD landing pages and widget showcase → `bd-pages/`
- Integration reference (engineering owns the API contract in `/docs/integration-contract-bd.md`)

---

## Rules for Growth Agents Working Here

- All content is planning Markdown. No production code lives here.
- If a page design requires a new API endpoint, document the requirement and
  submit a formal request to the engineering machine.
- Brand and copy decisions that affect production (e.g., CTA text in widgets)
  must be documented here first, then implemented via the config system
  (`/api/admin/config/platform`) by the engineering machine.

*Last updated: 2026-05-11*
