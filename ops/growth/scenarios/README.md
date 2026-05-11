# Scenario Pages and Educational Ecosystem

Scenario pages serve two purposes simultaneously: SEO-optimized landing pages
for specific auction types, and educational content that converts uncertain
sellers into confident applicants.

Each scenario page represents one context in which Advantage is the right
solution — estate sales, liquidations, collections, commercial surplus, etc.

---

## Scenario Page Index

| File | Scenario | Status |
|---|---|---|
| `estate-sale-planning.md` | Estate Sale — seller education and planning guide | Draft |
| `liquidation-workflow.md` | Commercial Liquidation — surplus and inventory auction | Draft |

*(Add new scenario files as topics are identified)*

---

## What Makes a Good Scenario Page

A scenario page is not a generic marketing page. It speaks to one specific
situation a potential seller is in:

- **Who is in this situation?** (executor, business owner, collector)
- **What are they worried about?** (timeline, price, process, trust)
- **What does the process look like for them specifically?** (step-by-step)
- **What does success look like?** (concrete outcomes — cleared estate, paid out)
- **What is the one thing they should do next?** (single CTA)

Good scenario pages rank for long-tail queries because they speak to exact intent,
not generic "auction" language.

---

## Scenario Ecosystem Map

```
/scenarios/
├── estate-sale/          ← executor, family, estate attorney
├── liquidation/          ← commercial surplus, business closing, manufacturing
├── collections/          ← coin, art, antique, sports memorabilia collectors
├── furniture-estates/    ← high-volume household contents (future)
├── commercial-surplus/   ← equipment, office, retail inventory (future)
└── sample-auction/       ← "See what an auction looks like" walkthrough (future)
```

---

## Educational Content Types

| Type | Format | Purpose |
|---|---|---|
| Scenario page | Web page (HTML) | SEO + conversion |
| FAQ block | Inline on page | Objection handling |
| Process walkthrough | Step-by-step visual | Confidence building |
| Sample auction | Live or demo auction | Social proof |
| Video walkthrough | Embedded video | Trust building |

---

## Engineering Requests for Scenario Pages

When scenario page copy is finalized in this directory, submit to engineering:

- Page slug (e.g. `/scenarios/estate-sale`)
- Copy document (the `.md` file here, reformatted as copy brief)
- CTA destination: links to `/seller-create.html` (existing)
- No new API endpoints required for static scenario pages

*Last updated: 2026-05-11*
