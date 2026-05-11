# Advantage Auction Platform — Agent Operating System

## Overview

This directory is the operational headquarters for multi-agent development on the Advantage Auction Platform. It defines which agent owns which files, what each agent is responsible for, how work cycles are structured, and how checkpoints are managed.

**Four agents. Clear boundaries. No overlapping file ownership during an active work cycle.**

---

## The Four Agents

| Agent | Domain | Tag Prefix |
|---|---|---|
| **Alpha-Core** | Platform foundation — auth, bidding, payments, auction lifecycle, admin ops | `checkpoint-{work}-v{N}` |
| **Bravo-Discovery** | Public marketplace discovery API — `/api/public/*`, ranking, geo | `checkpoint-discovery-{work}-v{N}` |
| **Charlie-BD** | BD integration layer — widgets, embed contracts, public-facing BD pages | `checkpoint-bd-{work}-v{N}` |
| **Delta-Testing** | Test infrastructure — E2E specs, seeds, validation scripts, coverage audits | `checkpoint-testing-{work}-v{N}` |

Each agent directory contains five files:

| File | Purpose |
|---|---|
| `mission.md` | Agent's purpose, responsibilities, hard boundaries |
| `owned-files.md` | Explicit file ownership map — primary, shared, forbidden |
| `current-work.md` | Active sprint work, tasks, status |
| `blocked-items.md` | Blockers awaiting resolution from another agent |
| `checkpoint-log.md` | Historical record of completed checkpoints |

---

## Multi-Agent Workflow Discipline

### The Cardinal Rule

> **No two agents modify the same file during an active work cycle.**

Before any agent begins modifying a file, it must verify that no other agent's `current-work.md` lists that file. If there is a conflict, the work is either sequenced (one agent waits) or escalated to the human operator.

### Work Cycle Lifecycle

```
1. PICK UP WORK
   Human operator assigns a task via current-work.md.
   Agent reads its mission.md and owned-files.md before starting.
   Agent confirms no file conflicts with other agents' current-work.md.

2. EXECUTE
   Agent works only within its owned-files.md boundaries.
   Any cross-boundary need is logged in blocked-items.md and handed off.
   Agent never speculatively modifies files outside its ownership.

3. VALIDATE
   All production-facing changes require Playwright test coverage.
   Agent runs its own spec suite and confirms no regressions in the full suite.
   Delta-Testing is available to audit coverage gaps.

4. CHECKPOINT
   Agent commits with a descriptive message.
   Agent creates a git tag (see Checkpoint Strategy below).
   Agent updates its checkpoint-log.md with test counts and what's next.
   Agent clears current-work.md.
```

### File Conflict Resolution

If two agents need the same file:

1. **Sequence it**: determine which work must come first; second agent waits
2. **Refactor to separate files**: if the pattern recurs, the file should be split
3. **Escalate**: if neither is possible, flag to human operator

Never modify a file another agent currently owns. The risk of merge conflicts and behavioral regressions outweighs any speed benefit.

---

## Checkpoint Strategy

Every completed work cycle ends with a checkpoint:

```bash
git add <specific files — never git add -A>
git commit -m "Descriptive message explaining WHY, not just what"
git tag checkpoint-{descriptive-name}-v{N}
```

Checkpoints are restore points. The tag names must be:
- Self-describing (a future agent reading the tag should know what it represents)
- Versioned with `-v1`, `-v2` etc. for iteration
- Never squashed or overwritten

**Test counts must be recorded in `checkpoint-log.md` at checkpoint time.** The format is:

```
## checkpoint-{name}-v{N} (commit hash)
- What was done
- Test counts: N passing, M pre-existing failures (unchanged)
- What's next
```

---

## Global Platform Rules

These rules apply to all agents and cannot be overridden by any individual agent's mission:

### 1. Discovery API Sovereignty
`/api/public/*` is the single source of truth for all public-facing data consumed by BD widgets. No widget, embed, or third-party integration may call internal routes (`/api/admin/*`, `/api/auctions/*`, `/api/lots/*`, etc.) directly. Bravo-Discovery owns the public API contract; Charlie-BD consumes it.

### 2. No Auth Leakage to BD
BD widgets operate without authentication tokens. `public/widgets/*.js` must never include, store, or forward any JWT or session credential. All data must be fetched from unauthenticated `/api/public/*` endpoints only.

### 3. No BD Database Coupling
BD has no direct access to the Railway/Neon PostgreSQL database. All integration is read-only, API-based, and mediated through the public discovery layer. This is non-negotiable and must be preserved in all future work.

### 4. Payment and Bidding Isolation
Bravo-Discovery and Charlie-BD must never import, call, or modify code in:
- `src/routes/bids.js`
- `src/routes/payments.js`
- `src/services/bidService.js`
- `src/services/paymentService.js`
- Any file in `src/middleware/`

These are Alpha-Core critical infrastructure. A discovery bug must never be able to affect bid processing or payment state.

### 5. Test Coverage Mandatory
No production-facing change is complete without a corresponding Playwright test. If Delta-Testing finds a coverage gap, the originating agent must add coverage before the checkpoint is considered stable.

### 6. Allowlist-Only Public Payloads
All `GET /api/public/*` responses must use explicit `SELECT` field lists — never `SELECT *`. The allowed fields must exclude: internal FKs (`seller_id`, `user_id`), financial internals (`reserve_cents`, `winning_buyer_user_id`, `winning_amount_cents`), admin flags (`capabilities`, `metadata`, `admin_notes`), and security fields (`address_encrypted`, `password_hash`).

### 7. Migrations Are Append-Only
No agent may modify an existing migration file. All schema changes must be new migration files with incrementing numbers. Migration 039 and below are immutable historical record.

### 8. Server.js Is Shared Infrastructure
`server.js` is a coordination point, not a free-for-all. Any agent mounting a new router must announce it in `current-work.md` before touching the file. Only one agent may modify `server.js` at a time.

---

## Assigning Work to Future Agents

When the human operator assigns new work:

1. **Identify the domain**: does it touch core platform logic (Alpha), public discovery (Bravo), BD widgets (Charlie), or test infrastructure (Delta)?

2. **Check for cross-domain dependencies**: if work spans domains, sequence it. Document the dependency in the dependent agent's `blocked-items.md` until the prerequisite work is checkpointed.

3. **Update `current-work.md`**: populate the file with the task description, the specific files to be modified, and the expected validation approach before the agent begins.

4. **Confirm no file conflicts**: read all other agents' `current-work.md` files and confirm no shared files.

5. **Set checkpoint expectations**: decide what the checkpoint tag will be named before work starts. This creates a clear definition of done.

---

## When to Spawn a New Agent vs. Using an Existing One

- Work that fits squarely in one domain → assign to that agent
- Work that requires changes across two domains → sequence: upstream agent checkpoints first, then downstream agent picks up
- Work that is purely new infrastructure with no domain owner yet → consider whether a fifth agent is warranted, or whether it fits under Alpha-Core (operational) or Delta-Testing (infrastructure)
- Refactors that touch many files across many agents → hold until a planned "refactor cycle" with explicit human operator oversight

---

## Current Platform State

As of the initial Agent OS establishment:

| Agent | Last Checkpoint | Tests Passing |
|---|---|---|
| Alpha-Core | checkpoint-admin-moderation-v1 | 241+ (full audit) |
| Bravo-Discovery | checkpoint-discovery-phase2-v1 | 312 total (87 discovery) |
| Charlie-BD | Not yet assigned | — |
| Delta-Testing | Not yet assigned | — |

The platform has 312 passing tests across 19+ spec files. All failures are pre-existing and documented.
