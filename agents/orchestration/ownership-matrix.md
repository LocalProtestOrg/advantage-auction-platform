# Ownership Matrix

Last updated: 2026-05-11
Maintained by: Human Operator / Orchestration Layer

This is the file ownership authority for all seven workstreams.
Before any stream begins modifying a file, the operator must verify that no other
active stream lists that file in its `current-work.md`.

---

## Legend

| Symbol | Meaning |
|---|---|
| **OWN** | Primary owner — may read and write freely |
| **READ** | May read for context; must not modify |
| **CONSUME** | May read published artifacts; must not modify source |
| **PROPOSE** | May draft content and submit to owner for review; owner applies changes |
| **APPEND** | May add new entries only; must not modify existing entries |
| **FORBIDDEN** | Must not access under any circumstances |

---

## Path Ownership Table

| Path | Alpha | Bravo | Charlie | Delta | Frontend Ops | Growth Ops | MI |
|---|---|---|---|---|---|---|---|
| `src/routes/auth.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/auctions.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/bids.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/payments.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/lots.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/admin.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/sellers.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/invoices.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/watchlist.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/payoutPreferences.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/imageProcessing.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/uploads.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/ai.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/marketing.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/marketingReports.js` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/public.js` | READ | OWN | READ | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/routes/analytics.js` | READ | OWN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/services/` (all except analytics) | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/services/analyticsService.js` | READ | OWN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | READ |
| `src/middleware/` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/workers/` | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/lib/` | OWN | READ | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `src/db.js` | OWN | READ | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `server.js` | OWN† | READ | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `db/migrations/` | OWN‡ | OWN‡ | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `public/widgets/shared/` | READ | READ | OWN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `public/widgets/featured-*.js` | FORBIDDEN | FORBIDDEN | OWN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `public/widgets/*.html` | FORBIDDEN | FORBIDDEN | OWN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `public/admin/` | OWN | FORBIDDEN | READ | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `public/` (other static files) | OWN | FORBIDDEN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `exports/frontend-widgets/` (source files) | FORBIDDEN | FORBIDDEN | OWN | READ | CONSUME | FORBIDDEN | FORBIDDEN |
| `exports/frontend-widgets/deployment-log.md` | READ | READ | READ | READ | APPEND | FORBIDDEN | READ |
| `exports/frontend-widgets/CHANGELOG.md` | READ | READ | OWN | READ | READ | FORBIDDEN | READ |
| `e2e/` | READ | READ | READ | OWN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `scripts/seed-*.js` | READ | FORBIDDEN | FORBIDDEN | OWN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `_validate_pipeline.js` | READ | FORBIDDEN | FORBIDDEN | OWN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `ops/frontend/` | FORBIDDEN | FORBIDDEN | OWN | FORBIDDEN | READ | FORBIDDEN | FORBIDDEN |
| `ops/branding/` | READ | FORBIDDEN | READ | FORBIDDEN | READ | OWN | FORBIDDEN |
| `ops/crm/` | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | OWN | READ |
| `ops/growth/` | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | OWN | READ |
| `ops/onboarding/` | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | OWN | FORBIDDEN |
| `ops/docs/` | READ | READ | READ | READ | READ | OWN | PROPOSE |
| `docs/analytics-telemetry.md` | READ | OWN | READ | READ | FORBIDDEN | FORBIDDEN | PROPOSE |
| `docs/security/` | READ | READ | READ | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `docs/integration-contract-bd.md` | READ | READ | OWN | READ | READ | FORBIDDEN | FORBIDDEN |
| `docs/` (other) | OWN | READ | READ | READ | READ | READ | READ |
| `agents/alpha-core/` | OWN | READ | READ | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `agents/bravo-discovery/` | READ | OWN | READ | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `agents/charlie-bd/` | READ | READ | OWN | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `agents/delta-testing/` | READ | READ | READ | OWN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `agents/orchestration/` | READ | READ | READ | READ | READ | READ | READ |
| `agents/README.md` | READ§ | READ§ | READ§ | READ§ | READ | READ | READ |
| `CLAUDE.md` | READ | READ | READ | READ | READ | READ | READ |
| `.gitignore` | OWN | READ | READ | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `.env.example` | OWN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `package.json` | OWN | READ | READ | READ | FORBIDDEN | FORBIDDEN | FORBIDDEN |

**† `server.js` coordination rule:** Alpha-Core owns `server.js` but any agent
mounting a new route must announce it in `current-work.md` before touching the file.
Only one stream may modify `server.js` at a time regardless of owner.

**‡ Migration append rule:** Both Alpha and Bravo may create new migration files.
No stream may modify an existing migration file. The next available number must be
confirmed in `active-work-queue.md` before creating a migration to prevent number collisions.

**§ `agents/README.md` update rule:** Changes to the top-level README require
human operator approval and must be announced in `active-work-queue.md` first.

---

## Absolute Forbidden Zones by Stream

### Frontend Ops — NEVER touches:
- `/src/` (any file)
- `/db/` (any file)
- `/public/widgets/` (any file)
- `/e2e/` (any file)
- `server.js`
- `package.json`
- `.env.example`
- Any backend runtime code

### Growth Ops — NEVER touches:
- `/src/` (any file)
- `/db/` (any file)
- `/public/` (any file)
- `/e2e/` (any file)
- `/exports/` (any file)
- `server.js`
- `package.json`
- `.env.example`

### Marketplace Intelligence — NEVER touches:
- `/src/` (write access — read is allowed with operator approval)
- `/db/` (write access — analytical reads are allowed via DB connection only)
- `/public/` (any file)
- `/e2e/` (any file)
- `/exports/` (any file)
- `server.js`
- `package.json`
- `.env.example`

---

## Parallelism Safety Table

Two streams are **safe to run in parallel** only when their active file sets have
zero overlap. Use this table as a quick guide. When in doubt, default to sequential.

| Stream A | Stream B | Parallel Safe? | Condition |
|---|---|---|---|
| Alpha-Core | Bravo-Discovery | **NO** | Share `server.js`, `src/`, `db/migrations/` |
| Alpha-Core | Charlie-BD | **CONDITIONAL** | Safe only if Alpha is not touching `server.js` or files Charlie reads |
| Alpha-Core | Delta-Testing | **CONDITIONAL** | Safe only if Delta is not writing specs for files Alpha is modifying |
| Alpha-Core | Frontend Ops | **YES** | Zero path overlap |
| Alpha-Core | Growth Ops | **YES** | Zero path overlap |
| Alpha-Core | Marketplace Intelligence | **YES** | MI is read-only |
| Bravo-Discovery | Charlie-BD | **NO** | Charlie depends on Bravo's endpoints; spec overlap risk |
| Bravo-Discovery | Delta-Testing | **CONDITIONAL** | Safe only if Delta is not writing specs for files Bravo is modifying |
| Bravo-Discovery | Frontend Ops | **YES** | Zero path overlap |
| Bravo-Discovery | Growth Ops | **YES** | Zero path overlap |
| Bravo-Discovery | Marketplace Intelligence | **YES** | MI is read-only |
| Charlie-BD | Delta-Testing | **CONDITIONAL** | Safe only if Delta is not testing files Charlie is modifying |
| Charlie-BD | Frontend Ops | **CONDITIONAL** | Safe if Charlie is not currently publishing new exports |
| Charlie-BD | Growth Ops | **YES** | Zero path overlap |
| Charlie-BD | Marketplace Intelligence | **YES** | MI is read-only |
| Delta-Testing | Frontend Ops | **YES** | Zero path overlap |
| Delta-Testing | Growth Ops | **YES** | Zero path overlap |
| Delta-Testing | Marketplace Intelligence | **YES** | MI is read-only |
| Frontend Ops | Growth Ops | **YES** | Different paths |
| Frontend Ops | Marketplace Intelligence | **YES** | MI is read-only |
| Growth Ops | Marketplace Intelligence | **YES** | Zero path overlap |

---

## Conflict Resolution

If two streams discover they need the same file simultaneously:

1. **Sequence it** — determine which work must come first; second stream logs a
   blocker in `blocked-items.md` and waits for the first stream to checkpoint.
2. **Refactor to separate files** — if the conflict recurs, the file should be split
   so each stream has a distinct owned path.
3. **Escalate** — if neither is possible, flag to the human operator. Never resolve
   a cross-stream file conflict autonomously.
