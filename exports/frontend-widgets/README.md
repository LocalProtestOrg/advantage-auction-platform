# Frontend Widget Export Pipeline

Controlled deployment artifacts for Advantage Auction Platform widgets.
These packages bridge the engineering/build machine and the BD/frontend operations workflow.

---

## Machine Boundary

```
Engineering Machine (source-of-truth)        Frontend Operations
─────────────────────────────────────        ───────────────────────────────
/public/widgets/          ─────────────────► /exports/frontend-widgets/
/src/routes/              (canonical source)  (deployment artifacts)
/db/migrations/                              /ops/frontend/
/e2e/                                        BD pages / landing pages
```

**Engineering owns:**
- Widget JavaScript source code (`/public/widgets/`)
- All APIs the widgets call (`/src/routes/`)
- Database schema and migrations
- Stripe / payment systems
- Infrastructure and deployment
- Playwright validation
- This export pipeline's contents

**Frontend operations consumes:**
- Widget export packages (`/exports/frontend-widgets/`)
- Operational docs (`/ops/frontend/`)
- Never modifies export packages directly

---

## What These Exports Are

Each package in this directory is a **deployment artifact** — not application source code.

| File | What it is | What it is NOT |
|---|---|---|
| `widget.js` | A thin embed loader that initializes the widget and loads from CDN | A copy of widget source code |
| `widget.css` | CSS custom properties the BD page can override for branding | The widget's runtime CSS |
| `README.md` | Complete deployment guide for frontend operations | Engineering documentation |
| `version.json` | Package version metadata and compatibility notes | A build manifest |

Widget runtime CSS is injected automatically by the widget script — BD pages do not need
to include it. `widget.css` provides only the override layer for brand customization.

---

## Package Directory

| Package | Status | Purpose |
|---|---|---|
| `featured-lots/` | Stable v1.0.0 | Cross-auction featured lot showcase grid |
| `featured-near-you/` | Stable v1.0.0 | Geo-aware featured auction discovery grid |
| `seller-cta/` | Stable v1.0.0 | Standalone seller call-to-action card |
| `city-enhancements/` | Stable v1.0.0 | Regional city-specific auction grids |
| `onboarding-flow/` | Planned — not yet built | Seller/buyer onboarding entry sequence |

---

## Versioning Discipline

- Package versions follow **semver**: `MAJOR.MINOR.PATCH`
- `MAJOR` — breaking change (container ID, API endpoint, removed data-* attribute)
- `MINOR` — additive change (new optional attribute, new analytics event)
- `PATCH` — bug fix or visual correction, no interface change
- Engineering bumps version in `version.json` when publishing an update
- Frontend operations checks `version.json` before deploying to confirm they have the current package

**Never modify a published export package directly.** Engineering publishes updates;
frontend operations consumes them. If a package needs changes, it goes to engineering.

---

## Engineering: How to Publish a Widget Update

1. Make and test changes in `/public/widgets/` (source-of-truth)
2. Run full Playwright suite — all specs must pass
3. Update `version.json` in the relevant export package:
   - Bump semver appropriately
   - Update `release_date`
   - Add entry to `changelog[]`
   - Update `compatibility_notes` if relevant
4. Update `README.md` in the export package if embed code, config keys, or behavior changed
5. If the loader in `widget.js` needs updating (new data-* attrs, new config), update it
6. Commit with message: `export: bump [widget-name] to vX.Y.Z — [brief reason]`
7. Push to main — frontend operations picks up the update from the export directory

**For MAJOR version bumps:** Notify frontend operations before merging.
Provide a migration guide in the `README.md` before pushing.

---

## Frontend Operations: How to Consume a Widget Update

1. Check `version.json` in the relevant package to confirm version and release date
2. Read the `README.md` — check the changelog section for anything that affects live deployments
3. For MINOR and PATCH updates: deploy normally using the updated embed code from `README.md`
4. For MAJOR updates: follow the migration guide in the updated `README.md`
5. Test in staging before touching any live BD page
6. Log the update in `ops/frontend/docs/deployment-log.md`

---

## Rollback Policy

- Every deployment must have a rollback snapshot (see `ops/frontend/docs/rollback-guide.md`)
- Rollback means replacing the widget embed with the pre-deployment HTML — not reverting the export package
- Old `version.json` history can be retrieved from git if a specific previous version is needed
- If a widget bug requires urgent rollback of the platform itself, that is an engineering decision

---

## What Frontend Operations Must NOT Do

- Do not edit files inside `/exports/frontend-widgets/` directly
- Do not copy widget source code out of `/public/widgets/` and host it elsewhere
- Do not modify `widget.js` loader logic or API endpoint references
- Do not create new export packages — engineering creates packages
- Do not embed widgets that call non-public API endpoints (`/api/admin/*`, `/api/seller/*`)
- Do not pass auth tokens or credentials to widget embed code

---

## Agent Rules for /exports/

Engineering agents (Alpha-Core, Charlie-BD) may update export packages when publishing
widget updates. No other agents work inside `/exports/`.

Growth/ops agents (any agent working inside `/ops/`) must not touch `/exports/`.
If a growth agent needs a change to an export package, they document the requirement
and escalate to engineering.

*Last updated: 2026-05-11*
