# Advantage Auction Platform — Agent Orchestration Layer

## What This Directory Is

The orchestration layer sits above the four engineering agents and governs the full
seven-stream agent operating system. It does not replace the per-agent files in
`agents/alpha-core/`, `agents/bravo-discovery/`, `agents/charlie-bd/`, or
`agents/delta-testing/`. Those remain the authoritative source for each agent's
mission, owned files, current work, and checkpoint log.

This layer provides:
- A single-pane view of all active work across all seven streams
- The file ownership matrix that prevents collisions between streams
- The cross-stream blocker registry
- The handoff protocol when work crosses a boundary
- The daily operator checklist before any terminal is opened

---

## The Seven Workstreams

| ID | Stream | Domain | Terminal |
|---|---|---|---|
| **Alpha-Core** | Platform stability, auth, bidding, payments, auction lifecycle | Engineering | Terminal A |
| **Bravo-Discovery** | Public discovery API, marketplace APIs, telemetry ingestion | Engineering | Terminal A |
| **Charlie-BD** | Widgets, exports, BD package governance | Engineering | Terminal A |
| **Delta-Testing** | Playwright, validation, regression protection | Engineering | Terminal A |
| **Frontend Ops** | BD deployment using `/exports/frontend-widgets/` only | Operations | Terminal B |
| **Growth Ops** | `/ops/` planning, onboarding, SEO, outreach | Operations | Terminal B |
| **Marketplace Intelligence** | Analytics queries, seller reporting, telemetry interpretation | Analysis | Terminal B |

Engineering streams (Alpha/Bravo/Charlie/Delta) share a single terminal by default.
Operations streams (Frontend Ops/Growth Ops/Marketplace Intelligence) may use a
second terminal when the conditions in `daily-operator-checklist.md` are met.

---

## Cardinal Rules (All Streams, No Exceptions)

1. **One file owner at a time.** No two streams modify the same file during an
   active work cycle. Check `active-work-queue.md` before starting.

2. **Engineering is source-of-truth.** Frontend Ops, Growth Ops, and Marketplace
   Intelligence never edit `/src`, `/db`, `/public/widgets`, or any backend
   runtime file.

3. **Frontend Ops reads exports, never source.** The boundary is `/exports/frontend-widgets/`.
   Frontend Ops may update `deployment-log.md` (append-only entries) and consume
   packaged artifacts. It does not publish or modify those artifacts.

4. **Growth Ops works in `/ops/` only.** Any content outside `/ops/` requires
   explicit operator approval and is treated as an engineering cross-boundary task.

5. **Marketplace Intelligence is read-only.** It queries analytics data, writes
   planning documents, and proposes telemetry schema additions. It does not write
   code, modify routes, or alter the database schema directly.

6. **Security rules from `docs/security/secret-management.md` and `CLAUDE.md`
   apply to every stream with no exceptions.** No credentials, keys, or tokens in
   any file regardless of which stream writes it.

7. **Analytics work must remain non-blocking and privacy-safe.** Any stream
   touching `src/services/analyticsService.js`, `src/routes/analytics.js`, or
   `public/widgets/shared/analytics.js` must preserve the fire-and-forget pattern,
   the PII stripping logic, and the IP hashing behavior.

8. **Migrations are append-only.** No stream modifies existing migration files.
   New schema changes require a new migration file with the next sequential number.

---

## Stream Authority Hierarchy

```
Human Operator
      │
      ▼
Orchestration Layer  (agents/orchestration/)
      │
      ├── Alpha-Core     (src/routes/*, src/services/*, src/middleware/, db/, server.js)
      ├── Bravo-Discovery (src/routes/public.js, src/routes/analytics.js, public discovery)
      ├── Charlie-BD     (public/widgets/*, exports/frontend-widgets/, ops/frontend/)
      ├── Delta-Testing  (e2e/*, scripts/seed-*, _validate_pipeline.js)
      │
      ├── Frontend Ops   (reads /exports/frontend-widgets/, writes deployment-log.md)
      ├── Growth Ops     (ops/ excluding ops/frontend/)
      └── Marketplace Intelligence  (read-only analytics + docs/analytics-telemetry.md)
```

---

## Files in This Directory

| File | Purpose |
|---|---|
| `README.md` | This file — orchestration overview and cardinal rules |
| `active-work-queue.md` | Live status of all seven streams |
| `ownership-matrix.md` | Which stream owns which path; conflict prevention |
| `blocked-items.md` | Cross-stream blockers waiting on another stream |
| `handoff-protocol.md` | How work is handed off across stream boundaries |
| `daily-operator-checklist.md` | What the operator must verify before opening any terminal |

---

## Relationship to Per-Agent Files

The per-agent files (`agents/*/current-work.md`, `agents/*/blocked-items.md`) remain
the source of truth for each engineering stream's detailed work state. The orchestration
files provide the cross-stream coordination view. When there is a conflict between a
per-agent file and an orchestration file, **escalate to the human operator** — do not
resolve it autonomously.

---

## Adding a New Workstream

1. The human operator approves the new stream.
2. Add the stream to `ownership-matrix.md` with explicit owned paths and forbidden paths.
3. Add the stream to `active-work-queue.md` with initial status IDLE.
4. Create `agents/<stream-name>/` with `mission.md`, `owned-files.md`,
   `current-work.md`, `blocked-items.md`, `checkpoint-log.md`.
5. Update `agents/README.md` to include the new stream.
6. Commit the new files before the stream begins any work.
