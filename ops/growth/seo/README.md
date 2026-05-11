# SEO Systems

Search engine visibility strategy for Advantage.Bid. Covers keyword targeting,
content architecture, internal linking, and technical SEO requirements.

---

## SEO Goals

1. Rank for high-intent seller acquisition queries (estate auction, liquidation consignment)
2. Rank for buyer discovery queries (estate sale near me, online auction)
3. Build topical authority in the auction / liquidation / estate sale domain
4. Support BD partner page distribution via structured widget pages

---

## Target Keyword Clusters

### Seller acquisition (high priority)

| Keyword | Intent | Competition | Target page |
|---|---|---|---|
| estate auction company | Seller/executor researching | High | `/seller` |
| online estate auction | General research | Medium | `/seller` or blog |
| liquidation auction | Commercial surplus | Medium | `/scenarios/liquidation` |
| consign furniture auction | Specific item | Low-medium | `/scenarios/furniture` |
| sell estate contents online | Executor intent | Low | `/seller` |
| estate sale vs auction | Education | Low | Blog / FAQ |

### Buyer discovery (secondary)

| Keyword | Intent | Competition | Target page |
|---|---|---|---|
| online estate auction near me | Buyer ready to bid | Medium | Homepage widget |
| estate sale auctions online | Browsing | High | Homepage |
| antique auction online | Category buyer | High | Category pages (future) |

---

## Content Architecture Plan

```
/seller                      ← primary seller acquisition landing page
/how-it-works                ← seller process explainer
/faq                         ← FAQ for sellers and buyers
/auction-types/              ← category landing pages
  estate-sale/
  liquidation/
  commercial-surplus/
  collections/
/blog/ (future)              ← educational content (estate planning, auction prep)
/sellers/[slug]              ← seller profile pages (existing — SEO opportunity)
/auctions/[id]               ← individual auction pages (existing — SEO opportunity)
```

---

## Technical SEO Requirements

*(Submit to engineering when ready to build)*

- [ ] `<title>` and `<meta description>` templating for auction/seller pages
- [ ] Canonical URLs on all public pages
- [ ] Structured data: `AuctionEvent` schema on auction detail pages
- [ ] `robots.txt` — confirm `/api/*` and `/admin/*` are blocked
- [ ] Sitemap generation for public auction and seller profile pages
- [ ] Open Graph tags for social sharing on auction pages
- [ ] Page load performance on public discovery pages (<2s FCP target)

---

## Internal Linking

See `internal-linking-map.md` for the full internal link structure.

*Last updated: 2026-05-11*
