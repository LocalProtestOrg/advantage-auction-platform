# Internal Linking Map

Defines how pages on Advantage.Bid link to each other to distribute authority,
support navigation, and guide users through discovery and conversion flows.

**Status:** Draft — page inventory incomplete. Update as pages are built.

---

## Link Flow Principle

Every page has one clear next step. Internal links reinforce that step and
connect to adjacent educational content without creating dead ends.

```
Awareness pages (SEO / scenario)
  └── Education pages (how it works, FAQ)
      └── Conversion page (seller application)
          └── Confirmation / onboarding
```

---

## Page Inventory and Outbound Links

### `/` — Homepage

| Links to | Reason |
|---|---|
| `/seller` | Primary seller CTA in nav and hero |
| `/how-it-works` | Secondary CTA for unsure visitors |
| `/auctions` | Buyer discovery — browse active auctions |
| `/faq` | Footer link |
| `/sellers/[slug]` | Featured seller profiles (future) |

---

### `/seller` — Seller Acquisition Page

| Links to | Reason |
|---|---|
| `/how-it-works` | "Learn how it works first" option |
| `/seller-create.html` | Primary CTA — start application |
| `/faq` | Inline FAQ links for objection handling |
| `/scenarios/liquidation` | Contextual: "We also handle commercial liquidation" |
| `/scenarios/estate-sale` | Contextual: "Estate sales are our specialty" |

---

### `/how-it-works` — Process Explainer

| Links to | Reason |
|---|---|
| `/seller-create.html` | End-of-page CTA |
| `/faq` | Extended FAQ |
| `/seller` | Back-link for users who want to re-read overview |

---

### `/scenarios/estate-sale` — Estate Sale Scenario Page

| Links to | Reason |
|---|---|
| `/seller` | Primary CTA |
| `/how-it-works` | Education link |
| `/faq#estate` | Estate-specific FAQ anchor |
| `/scenarios/liquidation` | "Also considering liquidation?" cross-link |

---

### `/scenarios/liquidation` — Liquidation Scenario Page

| Links to | Reason |
|---|---|
| `/seller` | Primary CTA |
| `/how-it-works` | Education link |
| `/faq#commercial` | Commercial surplus FAQ |
| `/scenarios/estate-sale` | Cross-link |

---

### `/auctions` — Public Auction Discovery

| Links to | Reason |
|---|---|
| Individual auction pages `/auctions/[id]` | Primary navigation |
| `/seller` | "Have inventory to sell?" footer CTA |

---

### `/sellers/[slug]` — Seller Profiles

| Links to | Reason |
|---|---|
| Seller's active auctions | Core content |
| `/seller` | "Sell with us too?" CTA |

---

## Pages Not Yet Built (Priority)

| Page | Priority | Estimated engineering scope |
|---|---|---|
| `/seller` | High | 1–2 day build — landing page only, links to existing app |
| `/how-it-works` | High | 1 day — static explainer page |
| `/faq` | Medium | 1 day — static, structured data markup |
| `/scenarios/estate-sale` | Medium | 1 day per scenario page |
| `/scenarios/liquidation` | Medium | 1 day |
| `/blog/` | Low | Requires CMS decision |

---

## Engineering Requests Needed

- [ ] Meta tag templating (title, description, og:*) on all public pages
- [ ] Seller profile page SEO improvements (`/sellers/[slug]`)
- [ ] Individual auction page SEO (`/auctions/[id]` needs title and description tags)

*Last updated: 2026-05-11*
