# Alpha-Core — File Ownership

## Ownership Tiers

- **PRIMARY** — Alpha-Core is the sole owner; no other agent modifies without explicit handoff
- **SHARED-COORD** — Alpha-Core is primary but other agents may need to append (require announcement in current-work.md)
- **READ-ONLY** — Alpha-Core reads for context; does not modify
- **FORBIDDEN** — Alpha-Core must never touch these files

---

## PRIMARY Ownership

### Routes
```
src/routes/auth.js
src/routes/auctions.js
src/routes/bids.js
src/routes/payments.js
src/routes/invoices.js
src/routes/lots.js
src/routes/sellers.js
src/routes/admin.js
src/routes/marketing.js
src/routes/marketingReports.js
src/routes/payoutPreferences.js
src/routes/ai.js
src/routes/watchlist.js
src/routes/imageProcessing.js
src/routes/uploads.js
```

### Services
```
src/services/auctionService.js
src/services/bidService.js
src/services/paymentService.js
src/services/walkthroughVideoService.js
src/services/followerNotificationService.js
src/services/pdfGenerationService.js
src/services/notificationSchedulers.js  (if exists)
```

### Middleware
```
src/middleware/authMiddleware.js
src/middleware/roleMiddleware.js
src/middleware/idempotency.js
src/middleware/logger.js
src/middleware/  (entire directory)
```

### Infrastructure
```
src/lib/logger.js
src/lib/  (entire directory)
src/db/
db/index.js
db/migrations/  (all files — append-only, never modify existing)
```

### Workers
```
imageProcessingWorker.js
notificationWorker.js
```

### Admin UI
```
public/admin/moderation.html
```

### Buyer/Seller UI
```
public/lot.html
public/dashboard.html
public/invoice.html
public/payment.html
public/seller-dashboard.html
public/seller-create.html
public/demo.html
public/favicon.svg
public/login.html          (if exists)
public/register.html       (if exists)
public/index.html          (if exists, and not demo.html)
```

### Scripts (operational)
```
scripts/run-migrations.js
scripts/seed-demo-data.js
scripts/seed-validation-fixtures.js
scripts/seed-payment-test.js
scripts/seed-test-fixtures.js
scripts/create-pickup-tables.js
scripts/get-payment-url.js
scripts/test-sentry.js
```

### Config and Operational
```
.env                        (never committed, but Alpha-Core manages the schema)
.env.example                (if exists)
CLAUDE.md
docs/deployment-readiness.md
docs/pilot-runbook.md
```

### Validation
```
_validate_pipeline.js
```

---

## SHARED-COORD Ownership

### Server Entry Point
```
server.js
```
Alpha-Core is the primary maintainer. Other agents (Bravo, Charlie) may append a route mount line. Protocol:
1. Announce the intended change in your `current-work.md` before touching
2. Confirm Alpha-Core's `current-work.md` does not list server.js as active
3. Make only the minimal additive change (one `require` + one `app.use` line)
4. Do not modify any existing code in server.js

### Playwright Config
```
playwright.config.js  (if exists)
```
Delta-Testing may propose changes; Alpha-Core approves and applies.

---

## READ-ONLY (context only, do not modify)

```
src/routes/public.js          — Bravo-Discovery owns
public/widgets/               — Charlie-BD owns
e2e/                          — Delta-Testing owns (read for context)
docs/bd-integration-architecture.md  — Charlie-BD owns
docs/integration-contract-bd.md      — Charlie-BD owns
agents/                       — read for coordination context
```

---

## FORBIDDEN (Alpha-Core must never touch)

```
src/routes/public.js
public/widgets/featured-auctions.js
public/widgets/featured-auctions.html
public/widgets/         (all files)
docs/bd-integration-architecture.md
docs/integration-contract-bd.md
```

**Rationale:** These files represent the BD integration boundary. Alpha-Core's core systems must not become entangled with the public discovery or BD presentation layer. Coupling in either direction breaks the BD-safe architecture.

---

## File Creation Policy

When Alpha-Core needs a new file:
- New routes go in `src/routes/`
- New services go in `src/services/`
- New middleware goes in `src/middleware/`
- New migrations go in `db/migrations/` with the next sequential number
- New scripts go in `scripts/`
- New public UI pages go in `public/` (not in `public/widgets/`)

Alpha-Core does not create files in `agents/` (that is operational governance, managed by the human operator or jointly by all agents).
