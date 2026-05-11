# Delta-Testing — File Ownership

## Ownership Tiers

- **PRIMARY** — Delta-Testing is the sole owner; no other agent modifies without explicit handoff
- **SHARED-COORD** — Multiple agents may reference; coordination required before modifying
- **READ-ONLY** — Delta reads for context; does not modify
- **FORBIDDEN** — Delta must never touch these files

---

## PRIMARY Ownership

### E2E Spec Files
```
e2e/                                         (entire directory — Delta owns all spec files)
e2e/public-discovery.spec.js
e2e/public-discovery-phase2.spec.js
e2e/admin/admin-idempotency.spec.js
e2e/admin/close-auction-concurrency.spec.js
e2e/audit/audit-log.spec.js
e2e/bidding.spec.js
e2e/buyer-flow.spec.js
e2e/payments/payment-idempotency.spec.js
e2e/production-readiness.spec.js
e2e/rehearsal.spec.js
e2e/seller-dashboard.spec.js
e2e/seller-audience.spec.js
```
Future spec files Delta will create follow naming conventions:
```
e2e/coverage-audit.spec.js
e2e/regression-{feature}.spec.js
e2e/charlie-bd-{widget-name}.spec.js         (when Charlie requests widget coverage)
```

### Seed and Fixture Scripts
```
scripts/seed-validation-fixtures.js          (deterministic admin/buyer/seller accounts)
scripts/seed-demo-data.js                    (demo auction/lot/payment seed data)
scripts/seed-payment-test.js
scripts/seed-test-fixtures.js
```

### Validation Pipeline
```
_validate_pipeline.js                        (manual validation script, repo root)
```

### Playwright Configuration
```
playwright.config.js                         (SHARED-COORD — see below)
```

---

## SHARED-COORD Ownership

```
playwright.config.js       — Alpha-Core and Delta-Testing both have legitimate reasons to
                             modify this. Coordinate before changing baseURL, timeout,
                             reporter, or parallelism settings. Changes must not break
                             any agent's existing spec files.
```

---

## READ-ONLY (context only — do not modify)

Delta must read these files to audit coverage, but never writes to them:

```
src/routes/admin.js              — Alpha-Core owns; Delta reads to identify admin endpoints
src/routes/public.js             — Bravo owns; Delta reads to identify public endpoints
src/routes/                      (all other route files — read to enumerate endpoints)
src/services/                    (all service files — read to understand business logic under test)
src/middleware/                  (read to understand auth/role behavior being tested)
src/lib/                         (read to understand shared utilities)
server.js                        (read to confirm route mounting and middleware order)
public/widgets/                  (Charlie's files — read to write widget E2E specs)
db/migrations/                   (read to understand schema; never append or modify)
agents/alpha-core/current-work.md     — coordinate to avoid spec file conflicts
agents/bravo-discovery/current-work.md
agents/charlie-bd/current-work.md
```

---

## FORBIDDEN (Delta must never touch)

```
src/routes/           (all route source files — read only for coverage audit)
src/services/         (all service files)
src/middleware/       (all middleware)
src/lib/              (all shared utilities)
src/db/               (database layer)
db/migrations/        (append-only, Alpha-Core governed — Delta never modifies)
server.js             (Alpha-Core primary)
imageProcessingWorker.js
notificationWorker.js
public/admin/         (admin UI — Alpha-Core owns)
public/lot.html
public/dashboard.html
public/invoice.html
public/payment.html
public/seller-dashboard.html
public/seller-create.html
public/demo.html
public/favicon.svg
public/widgets/       (Charlie-BD owns — Delta does not modify widget source files)
```

Exception: Delta may create a test fixture page under `public/widgets/` only if
Charlie-BD explicitly requests it in writing (in Charlie's current-work.md or via
a coordination note in Delta's blocked-items.md).

---

## Fixed UUID Namespace — Must Never Change

The following UUIDs are hardcoded in seed scripts and referenced across multiple specs.
These values are immutable — changing them breaks all specs that depend on them:

```
dd000000-0000-0000-0000-000000000001   admin user
dd000000-0000-0000-0000-000000000002   buyer user
dd000000-0000-0000-0000-000000000003   seller user / seller profile
```

Any new deterministic fixtures must use the `dd000000-*` namespace to avoid
collision with production UUIDs.

---

## Coverage Audit Scope

When Delta performs a coverage audit, it reads every file in `src/routes/` to
enumerate endpoints, then checks `e2e/` for a corresponding spec. The audit
targets are:

| Route File | Primary Spec Coverage |
|---|---|
| src/routes/admin.js | e2e/admin/*.spec.js, e2e/production-readiness.spec.js |
| src/routes/public.js | e2e/public-discovery.spec.js, e2e/public-discovery-phase2.spec.js |
| src/routes/auth.js | e2e/buyer-flow.spec.js, e2e/seller-dashboard.spec.js |
| src/routes/auctions.js | e2e/bidding.spec.js, e2e/rehearsal.spec.js |
| src/routes/lots.js | e2e/bidding.spec.js |
| src/routes/payments.js | e2e/payments/*.spec.js |
| src/routes/invoices.js | e2e/payments/*.spec.js |
| src/routes/sellers.js | e2e/seller-dashboard.spec.js, e2e/seller-audience.spec.js |
| src/routes/buyers.js | e2e/buyer-flow.spec.js |
| public/widgets/ | e2e/charlie-bd-*.spec.js (when Charlie builds widgets) |
