# Charlie-BD — File Ownership

## Ownership Tiers

- **PRIMARY** — Charlie-BD is the sole owner; no other agent modifies without explicit handoff
- **SHARED-COORD** — Multiple agents may reference; coordination required before modifying
- **READ-ONLY** — Charlie reads for context; does not modify
- **FORBIDDEN** — Charlie must never touch these files

---

## PRIMARY Ownership

### Widget Scripts
```
public/widgets/featured-auctions.js        (inherited from Bravo Phase 2)
public/widgets/featured-auctions.html      (inherited from Bravo Phase 2)
public/widgets/                            (all future widget files)
```
Future widget files Charlie will create:
```
public/widgets/sold-lots.js
public/widgets/auction-calendar.js
public/widgets/seller-spotlight.js
public/widgets/category-browser.js
public/widgets/featured-auctions-v2.js    (if breaking interface change needed)
```

### Integration Contracts and Architecture Docs
```
docs/bd-integration-architecture.md
docs/integration-contract-bd.md
```

---

## SHARED-COORD Ownership

None at this time. Charlie's work is entirely in `public/widgets/` and `docs/`, which are not shared with other agents.

---

## READ-ONLY (context only, do not modify)

```
src/routes/public.js               — Bravo owns; Charlie reads to understand
                                     the API contract that widgets consume
e2e/public-discovery.spec.js       — Delta/Bravo owns; reference for API behavior
e2e/public-discovery-phase2.spec.js — Delta/Bravo owns; reference for API behavior
agents/bravo-discovery/checkpoint-log.md  — understand what Bravo has built
agents/bravo-discovery/owned-files.md     — understand what the public API exposes
```

---

## FORBIDDEN (Charlie must never touch)

```
src/routes/           (entire directory — all Alpha-Core and Bravo route files)
src/services/         (entire directory — Alpha-Core services)
src/middleware/       (entire directory — Alpha-Core middleware)
src/lib/              (entire directory — Alpha-Core shared utilities)
src/db/               (entire directory — Alpha-Core database layer)
db/migrations/        (entire directory — append-only, Alpha-Core governed)
server.js             (Alpha-Core primary; Bravo has coordinated access; Charlie does not)
imageProcessingWorker.js
notificationWorker.js
public/admin/
public/lot.html
public/dashboard.html
public/invoice.html
public/payment.html
public/seller-dashboard.html
public/seller-create.html
public/demo.html
public/favicon.svg
scripts/
e2e/                  (Delta-Testing owns — Charlie can propose tests, Delta writes them)
```

---

## API Consumption Contract

Charlie-BD may call these endpoints from widget scripts:

```
GET /api/public/auctions             ✓ safe to call
GET /api/public/auctions/near        ✓ safe to call
GET /api/public/auctions/:id         ✓ safe to call
GET /api/public/auctions/:id/lots    ✓ safe to call
GET /api/public/featured-auctions    ✓ safe to call (this is the primary widget endpoint)
GET /api/public/featured-lots        ✓ safe to call
GET /api/public/featured-videos      ✓ safe to call
GET /api/public/locations            ✓ safe to call
GET /api/public/sellers/:id/profile  ✓ safe to call
GET /api/health                      ✓ safe to call (status check)
```

Charlie-BD must NEVER call:
```
GET/POST /api/auth/*          — authentication routes
GET/POST /api/admin/*         — admin-only routes
GET/POST /api/auctions/*      — internal auction routes
GET/POST /api/lots/*          — internal lot routes
GET/POST /api/bids/*          — bidding routes
GET/POST /api/payments/*      — payment routes
GET/POST /api/invoices/*      — invoice routes
GET/POST /api/sellers/*       — seller management routes
GET/POST /api/watchlist/*     — user-specific routes
Any route requiring Authorization header
```

---

## What "Inheriting" a File Means

Bravo-Discovery created `public/widgets/featured-auctions.js` and `featured-auctions.html` during Phase 2. Charlie-BD inherits these files as primary owner going forward. This means:
- Charlie is responsible for bug fixes and enhancements to these files
- Charlie should not make changes that alter the API endpoints the widget calls without coordinating with Bravo (the contract is Bravo's responsibility)
- If the widget interface (data attributes) needs a breaking change, Charlie creates a v2 file rather than modifying the existing one
