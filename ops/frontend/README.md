# Frontend Deployment Pipeline

Structured transfer system between Advantage.Bid engineering and BD/growth
frontend operations. Every widget ships as a versioned, self-contained package
document that can be deployed, reviewed, and rolled back independently.

---

## Who This Is For

**Frontend/Growth Operators** — deploy widget packages into BD pages, landing pages,
onboarding flows, scenario pages, and partner embeds.

**BD Integration Team** — embed Advantage widgets on external partner sites without
requiring backend access or engineering involvement.

---

## How It Works

```
Engineering Machine
  └── builds and tests widgets in /public/widgets/
      └── publishes package documents to /ops/frontend/packages/
          └── Frontend Ops picks up versioned packages
              └── deploys embed code into BD pages
                  └── logs deployment in /ops/frontend/docs/deployment-log.md
```

Engineering owns the widget source. Frontend ops owns the embed deployment.
Neither touches the other's domain.

---

## Package Directory

```
ops/frontend/
├── README.md                          ← you are here
├── docs/
│   ├── widget-versioning.md           ← naming and version discipline
│   ├── deployment-workflow.md         ← step-by-step deployment process
│   ├── shared-css-strategy.md         ← CSS architecture and theming
│   ├── rollback-guide.md              ← how to safely roll back any widget
│   └── deployment-log.md             ← running log of all BD deployments
└── packages/
    ├── shared-platform-layer/
    │   └── v1.0.0.md                  ← shared utils, config, components
    ├── widget-featured-lots/
    │   └── v1.0.0.md                  ← Featured Lots widget
    └── widget-featured-near-you/
        └── v1.0.0.md                  ← Featured Auctions Near You widget
```

---

## Current Package Inventory

| Package | Version | Status | Purpose |
|---|---|---|---|
| `shared-platform-layer` | v1.0.0 | Stable | Shared utilities, config, and UI components |
| `widget-featured-lots` | v1.0.0 | Stable | Cross-auction featured lot showcase grid |
| `widget-featured-near-you` | v1.0.0 | Stable | Geo-aware featured auction discovery grid |

---

## Deployment Rules

1. **Never deploy unpublished packages.** Only packages with a version document
   in `/ops/frontend/packages/` are cleared for BD deployment.

2. **Test the embed in a staging page before going live.** All widgets can be
   tested by setting `data-api-base="https://auctions.advantage.bid"` before
   any BD page is modified.

3. **Log every deployment.** Add an entry to `docs/deployment-log.md` whenever
   a widget is deployed or replaced in BD.

4. **One widget per deployment.** Deploy one widget at a time. Verify it works
   before deploying the next.

5. **Keep rollback ready.** Before replacing an existing BD section, save the
   previous HTML in the deployment log.

---

## Production Widget URLs

All widgets are hosted at the canonical Advantage platform:

```
https://auctions.advantage.bid/widgets/shared/utils.js
https://auctions.advantage.bid/widgets/shared/config.js
https://auctions.advantage.bid/widgets/shared/components/badge.js
https://auctions.advantage.bid/widgets/shared/components/skeleton-card.js
https://auctions.advantage.bid/widgets/shared/components/auction-card.js
https://auctions.advantage.bid/widgets/shared/components/seller-cta.js
https://auctions.advantage.bid/widgets/shared/components/empty-state.js
https://auctions.advantage.bid/widgets/shared/components/error-state.js
https://auctions.advantage.bid/widgets/featured-lots.js
https://auctions.advantage.bid/widgets/featured-near-you.js
```

Public config API (for remote config loading):
```
https://auctions.advantage.bid/api/public/config
https://auctions.advantage.bid/api/public/config/widgets/featured-lots
https://auctions.advantage.bid/api/public/config/widgets/featured-near-you
```

*Last updated: 2026-05-11*
