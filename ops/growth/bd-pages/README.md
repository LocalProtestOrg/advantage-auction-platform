# BD-Facing Pages and Partner Assets

Planning directory for landing pages, pitch materials, and integration assets
designed for BD (partner) distribution — real estate agents, estate attorneys,
senior move managers, funeral homes, liquidation companies.

BD partners embed Advantage widgets on their own sites or refer clients directly
to Advantage. These assets support both use cases.

---

## BD Partner Types

| Partner Type | How They Engage | Asset Needed |
|---|---|---|
| Real estate agent | Refers estate clients needing auction | Referral landing page, partner badge |
| Estate attorney | Refers executor clients | Professional referral one-pager |
| Senior move manager | Refers downsizing clients | Partner embed page, referral flow |
| Funeral home | Refers families settling estates | Discreet referral card / page |
| Liquidation company | Sub-contracts auction management | Integration landing page |
| Local auction gallery | Co-brand or overflow referral | Partner portal (future) |

---

## Asset Types Being Planned

### 1. Partner Referral Landing Page
A co-branded or white-label landing page that BD partners can link to.
Shows the partner's name + Advantage branding.
CTA: "Begin your auction with Advantage"

*(Requires engineering: parameterized landing page or partner slug system)*

### 2. Embeddable Widget Page
A showcase page demonstrating how BD partners can embed the Featured Lots
or Featured Near You widget on their own site.
Links to the widget demo pages that already exist at `/widgets/demo-featured-lots.html`.

*(No engineering work required — links to existing demo)*

### 3. Integration One-Pager (PDF / Print)
A printable or PDF asset explaining what Advantage offers to professional referral
partners. Not web-based. Produced by growth operations.

### 4. Partner Badge / Trust Mark
"Powered by Advantage" or "Auction services by Advantage" badge for BD partner
websites. A static image asset with optional link-back.

*(Growth ops produces asset; engineering is not required)*

---

## BD Pitch Materials Index

*(Add files here as they are created)*

| File | Type | Status |
|---|---|---|
| *(none yet)* | | |

---

## Engineering Integration Requirements

*(Not yet submitted — document here before requesting)*

| Feature | Priority | Description |
|---|---|---|
| Partner slug pages | Medium | `/partners/[slug]` co-branded referral landing pages |
| Referral tracking | Medium | `?ref=[partner_id]` parameter captured on seller application |
| Partner portal | Low (future) | Admin interface for BD partners to track referrals |

---

## Widget Assets Already Available

These exist in the engineering codebase and can be referenced by BD partners today:

- `/widgets/demo-featured-lots.html` — live demo of featured lots widget
- `/widgets/demo-featured-near-you.html` — live demo of near-you widget
- Widget embed instructions documented in both demo pages

*Last updated: 2026-05-11*
