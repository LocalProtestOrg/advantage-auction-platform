# Operations Admin Center — Phase A Implementation Plan

*Phase A planning document for the Operations Admin Center governance infrastructure. Scope source: §11 Phase A of [`docs/admin-center-rbac-architecture.md`](./admin-center-rbac-architecture.md). Nothing in this document exceeds that scope; the architecture doc remains authoritative for anything not explicitly covered below.*

**Operating constraints:** additive rollout only · least privilege by default · no speculative rewrites · architecture first · operational safety first · financial correctness first.

**Decision status (recorded for traceability):** the §11 decisions list has been formally reviewed and approved. Specifically:
- `legacy_admin` transitional-role strategy — approved
- Generated seed SQL from `permissionRegistry.js` (CI-enforced drift prevention) — approved
- DB-trigger + service-layer mutual-exclusion enforcement (defense-in-depth) — approved
- `/api/admin/v2/*` naming convention — approved
- `engineer_on_call` 1-hour default time-bound — approved
- 24-hour approval request TTL default — approved
- `permission_audit` retention matching `audit_log` retention — approved
- In-place TIMESTAMPTZ migration approach at current scale — approved
- Non-partitioned `audit_log` strategy at current scale — approved

**Rollout sequencing and partial-state safety matrix (§1) are now authoritative** and must remain so throughout implementation.

---

## 0. Phase A scope recap (per architecture doc §11)

In Phase A and only Phase A:

| In | Out |
|---|---|
| Audit log extension (the deferred Phase 2 work from payment hardening) | New routes for refunds, payouts (Phase C) |
| 9 new DB tables for RBAC | MFA enrollment flow (Phase B) |
| `permissionRegistry.js` and helper services | Admin session model (Phase B) |
| Middleware modules (compiled, tested, exported — used only by new v2 admin-management endpoints in Phase A) | Step-up auth enforcement on financial routes (Phase B) |
| Seed migration for default roles + permissions + legacy_admin transition | Any UI (Phase D) |
| New admin-management API: `/api/admin/v2/{roles,users,permissions,approvals}` | Migration of v1 financial routes (Phase C) |
| Test suite covering schema invariants, separation rules, audit completeness | Quarterly access reviews (Phase E) |

**Exit criteria for Phase A** (from architecture doc): RBAC schema in place, default roles seeded, all v1 admin routes still pass tests, audit log additions deployed, no user-visible change.

---

## 1. Additive schema rollout sequencing

Six migrations, deployable in order. Each is independently revertable.

| # | File | What it adds | Depends on |
|---|---|---|---|
| **A1** | `db/migrations/048_extend_audit_log.sql` | `actor_ip`, `actor_user_agent`, `actor_session_id`, `request_id`, `before_value`, `after_value`, `outcome`, `risk_level`, `approval_request_id`; convert `created_at` to `TIMESTAMPTZ`; new indexes | nothing (additive on existing `audit_log`) |
| **A2** | `db/migrations/049_create_rbac_roles_permissions.sql` | `roles`, `permissions`, `role_permissions` tables | nothing |
| **A3** | `db/migrations/050_create_admin_user_grants.sql` | `admin_user_roles`, `admin_user_permissions` tables; partial index enforcing time-bounded `engineer_on_call` | A2 (FK to roles, permissions); existing `users` |
| **A4** | `db/migrations/051_create_admin_sessions_mfa.sql` | `admin_sessions`, `admin_mfa_factors` tables (defined now, **not used until Phase B**) | existing `users` |
| **A5** | `db/migrations/052_create_approval_workflow.sql` | `approval_requests` table with `CHECK (approver_id != requested_by)` | existing `users` |
| **A6** | `db/migrations/053_create_permission_audit.sql` | `permission_audit` table | A2, A3 |
| **A7** | `db/migrations/054_seed_rbac_defaults.sql` | INSERTs: default 9 roles, default permission rows, role↔permission mappings, transitional `legacy_admin` role grants | A2, A3, A6 |
| **A8** | `db/migrations/055_revoke_audit_log_mutations.sql` | `REVOKE UPDATE, DELETE ON audit_log FROM <app_role>` | A1; appears separately so the revoke is reviewable in isolation |

### Migration order rationale

- **A1 first.** Audit log extension is a Phase 2 payment-hardening item the platform already needs regardless of RBAC. Lands a stable target before RBAC tables start referencing it via `approval_request_id`.
- **A2 → A3 → A4 → A5 → A6** follows FK dependencies. A4 (sessions/MFA) is in Phase A so the schema is available when Phase B starts; the tables are empty and unread until then.
- **A7 (seed) is last.** Cannot run until all referenced tables exist. Seed data is a normal migration, not a code path — that keeps it under the same version control + rollback discipline.
- **A8 (REVOKE) is separately reviewable.** A REVOKE statement on a production table deserves its own commit + diff line. Also lets the rollback be a targeted `GRANT` rather than a column drop.

### Mid-deploy partial-state safety matrix

| Migrations applied | Code state | Safe? |
|---|---|---|
| A1 only | Old code | ✅ — new columns nullable, old code ignores them |
| A1–A6 (no seed) | Old code | ✅ — RBAC tables empty; old code doesn't query them |
| A1–A7 (seeded) | Old code | ✅ — RBAC tables populated; old code still doesn't query them. `legacy_admin` grants exist but the new middleware isn't loaded yet |
| All migrations + new Phase A code | New code | ✅ — full feature set live |
| A8 applied + Phase A code that tries `UPDATE audit_log` | New code | ❌ would fail. **Phase A code MUST NOT write `UPDATE`/`DELETE` to audit_log under any condition.** Tests assert this. |
| Phase A code without migrations applied | Old DB | ❌ INSERTs against missing columns/tables fail. **Migrations always lead.** |

---

## 2. Migration dependency order

```
A1 (audit_log extension)
  │
  ├─→ A2 (roles, permissions, role_permissions)
  │     │
  │     ├─→ A3 (admin_user_roles, admin_user_permissions)
  │     │     │
  │     │     └─→ A7 (seed) ──┐
  │     │                     │
  │     └─→ A6 (permission_audit)
  │                           │
  ├─→ A4 (admin_sessions, admin_mfa_factors)
  │                           │
  ├─→ A5 (approval_requests)  │
  │                           │
  └─→ A8 (REVOKE on audit_log) ── runs LAST, after all writes proven safe in tests
```

Each migration is a single SQL file. None is reversible without the explicit DOWN script written alongside (see §6).

---

## 3. Middleware insertion order (modules created in Phase A; **enforcement not yet applied to existing routes**)

Phase A creates the middleware modules and ships them into `src/middleware/`. They are wired into ONLY the new admin-management routes (`/api/admin/v2/roles`, `/api/admin/v2/users`, `/api/admin/v2/permissions`, `/api/admin/v2/approvals`). No existing route is touched.

### Module creation order

1. **`src/permissions/permissionRegistry.js`** — pure data + frozen export. No DB dependency. Defines every permission key, metadata, mutual-exclusion rules.
2. **`src/permissions/permissionService.js`** — `hasPermission(user, key, ctx)`. Pure function over user grants + registry. DB-stubbed for tests.
3. **`src/permissions/roleService.js`** — CRUD on roles + grants. Enforces mutual-exclusion rules at write time. Writes to `permission_audit`.
4. **`src/permissions/approvalService.js`** — approval request lifecycle. Atomic claim on `approval_requests.status` to prevent replay.
5. **`src/middleware/requireAdminSession.js`** — confirms the JWT is an admin session, not a buyer/seller token. **Phase A note:** until Phase B's session model exists, this middleware accepts any `users.role='admin'` JWT for compatibility. The check is in the right place from day one; the policy hardens in Phase B.
6. **`src/middleware/requirePermission.js`** — 403 if user lacks the permission. Uses `permissionService`.
7. **`src/middleware/requireApproval.js`** — Phase A version: present in the module tree, used by the new admin-management routes for role-grant operations (since those are Tier-3 super-permissions). Not yet wired to financial routes.
8. **`src/middleware/auditCapture.js`** — writes audit rows before + after every admin v2 request. Includes outcome on response.
9. **`src/middleware/requireStepUp.js`** — Phase A version: a no-op stub that always passes. The hook is in the right place from day one; real enforcement activates in Phase B. **Documented as a stub in code.**

### Middleware chain on a representative Phase A v2 route

```
POST /api/admin/v2/roles/:roleId/permissions      (super_admin grants permission to a role)
  ->  auth                            (existing)
  ->  requireAdminSession             (NEW — Phase A pass-through, Phase B hardens)
  ->  requirePermission('identity:role:grant')
  ->  requireApproval({ actionType: 'role.permission_grant' })   ← Tier-3, dual approval enforced
  ->  requireStepUp({ maxAgeSeconds: 300 })                       ← stub in Phase A
  ->  auditCapture
  ->  handler                          (roleService.grantPermissionToRole)
```

### What gets wired in Phase A vs. later

| Middleware | Phase A v2 admin-management routes | Phase B (deferred) | Phase C (financial routes) |
|---|---|---|---|
| `requireAdminSession` | ✅ pass-through | hardened | enforced |
| `requirePermission` | ✅ enforced | enforced | enforced |
| `requireApproval` | ✅ enforced (Tier-3 admin-management only) | enforced | enforced (Tier-2 financial) |
| `requireStepUp` | stub | enforced | enforced |
| `auditCapture` | ✅ enforced | enforced | enforced |

This staging means Phase A delivers working dual-control for role grants — the most dangerous action in the system — without waiting for MFA. The trade-off: until Phase B, the "approve" identity is only as strong as the admin's existing JWT. That's an explicit, scoped weakness, documented in the Phase A release notes.

---

## 4. Default role seed strategy

The seed migration (A7) is the single source of truth for the v0 role↔permission matrix. Changes after seed go through `roleService` with audit.

### Seed contents (representative, full list defined alongside `permissionRegistry.js`)

| Role | Permissions granted at seed |
|---|---|
| `super_admin` | All `identity:*`, `audit:log:read`, `audit:log:export` (with approval), `platform:*`. Explicitly **NOT** `*:execute` on payments/refunds/payouts. |
| `platform_admin` | `auctions:*` (except `auctions:auction:override`), `lots:*`, `moderation:*`, `analytics:read` |
| `finance_admin` | `payments:payment:read`, `payments:payment:override` (with approval), `refunds:refund:initiate`, `refunds:refund:execute` (Tier-1 threshold), `invoices:*`, `payouts:payout:read` |
| `payout_approver` | `payouts:payout:read`, `payouts:payout:approve` (dual-control counterpart to executor) |
| `support_agent` | `*:read` for user-facing entities, `support:user_address:override`, `support:notification_pref:update` |
| `seller_success` | `seller:*` (no bank-info execute), `*:read` for sellers |
| `content_moderator` | `moderation:*`, `lots:lot:read` |
| `read_only_viewer` | All `*:read` and `*:list` permissions; `audit:log:read` |
| `engineer_on_call` | `platform:setting:update` (time-boxed), specific debugging permissions. **No financial perms ever.** |

### Mutual-exclusion enforcement at seed time

The seed migration assigns these permission sets but does NOT assign them to humans (with one exception — the `legacy_admin` transition below). The mutual-exclusion check fires only on grant; seeding role↔permission pairs is itself not a violation (only granting a *user* both `refunds:refund:execute` and `refunds:refund:approve` is forbidden).

Test asserts: every role's permission set, taken alone, satisfies the mutual-exclusion rules.

### Permission registry source of truth

`permissionRegistry.js` contains the canonical list with metadata. The seed migration is **generated from the registry** (a build step that emits the SQL). This guarantees:
- The seed cannot grant a permission key that doesn't exist in the registry.
- Adding a permission to the registry requires adding it to the seed in the same commit (caught by test).

Implementation note: the generation step is a small `scripts/generate-permission-seed.js` that reads the registry and emits `db/migrations/054_seed_rbac_defaults.sql`. CI fails if the committed seed diverges from what the registry would generate.

---

## 5. Legacy admin transition strategy

The single most important compatibility guarantee in Phase A: **every existing `users.role='admin'` user keeps full admin capability** through Phase A, B, and C. They lose specific permissions only as Phase C migrates individual routes to the v2 model.

### Mechanism

1. **Seed creates a `legacy_admin` role.** Hidden from the normal role list (UI flag `is_system=true`, `is_legacy=true`). Carries every permission in the registry — including the Tier-2 and Tier-3 ones — so anything the old `role(['admin'])` middleware would have allowed is allowed via the new model too.

2. **Seed grants `legacy_admin` to every user with `users.role='admin'`.** Single INSERT with `granted_by = '<seed-system-uuid>'`, `granted_at = now()`, `expires_at = NULL`, `reason = 'phase-a-transition'`.

3. **The mutual-exclusion check is suspended for `legacy_admin`.** Specifically: a single user holding `legacy_admin` does NOT trigger the "cannot have both refund:execute and refund:approve" rule, because that user holds these permissions via a single grant of the transitional role. This is an explicit, documented exception with a test that asserts: the exception applies ONLY to `legacy_admin` and NOT to any other role.

4. **Existing v1 routes are unchanged.** They keep using `role(['admin'])` middleware. They do not call `requirePermission`. Nothing in Phase A changes their behavior.

5. **As Phase C migrates a v1 route to v2**, that route's admin permission is **removed from `legacy_admin`**. Affected users keep the permission only if they have it via another role grant. This forces operators to explicitly assign roles like `finance_admin`, `platform_admin` as they go — and to recognize when they're consolidating super-permissions on one user.

6. **End state (after Phase C complete):** `legacy_admin` has zero permissions. The role row remains in the DB for audit history but cannot be granted further. Optional: a Phase E migration deletes the role.

### Why `legacy_admin` as a role rather than a code shortcut

Could equally have made the `requirePermission` middleware fall through to `users.role='admin'` for any unknown user-permission pair. We chose the role approach because:
- It writes the permission story to the DB, where it can be audited and queried.
- Removing the legacy fallback in Phase C is a `DELETE FROM role_permissions WHERE role_id='legacy_admin' AND permission_id='...'` — a recorded, audited change — rather than a code edit hidden in a commit.
- It models reality: legacy admins ARE elevated; that should be visible in the access-review query.

### Audit log entry on seed

The seed migration writes one `permission_audit` row per `legacy_admin` grant:
```
change_type:   'role.grant.seed.phase_a_transition'
target_user_id: <user.id>
target_role_id: <legacy_admin.id>
changed_by:    <seed-system-uuid>
justification: 'Phase A transition — granted to preserve v1 admin route access during RBAC rollout'
```

This makes the transition discoverable later via standard audit queries.

---

## 6. Audit log extension sequencing

Migration A1 (`048_extend_audit_log.sql`) — the most touched table in the codebase. Order of operations within the migration:

```sql
-- 1. Add new columns (all nullable, defaults safe)
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS actor_ip          TEXT,
  ADD COLUMN IF NOT EXISTS actor_user_agent  TEXT,
  ADD COLUMN IF NOT EXISTS actor_session_id  UUID,
  ADD COLUMN IF NOT EXISTS request_id        TEXT,
  ADD COLUMN IF NOT EXISTS before_value      JSONB,
  ADD COLUMN IF NOT EXISTS after_value       JSONB,
  ADD COLUMN IF NOT EXISTS outcome           TEXT,
  ADD COLUMN IF NOT EXISTS risk_level        TEXT,
  ADD COLUMN IF NOT EXISTS approval_request_id UUID;

-- 2. Add CHECK constraints (NOT VALID first so existing rows don't block, then VALIDATE separately)
ALTER TABLE audit_log
  ADD CONSTRAINT chk_audit_outcome
    CHECK (outcome IS NULL OR outcome IN ('success','failure','partial')) NOT VALID;
ALTER TABLE audit_log VALIDATE CONSTRAINT chk_audit_outcome;

ALTER TABLE audit_log
  ADD CONSTRAINT chk_audit_risk_level
    CHECK (risk_level IS NULL OR risk_level IN ('low','medium','high','critical')) NOT VALID;
ALTER TABLE audit_log VALIDATE CONSTRAINT chk_audit_risk_level;

-- 3. Convert created_at to TIMESTAMPTZ
--    Postgres preserves values during the type change; the cast assumes UTC for naive timestamps.
ALTER TABLE audit_log
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

-- 4. Indexes for new query patterns (Phase B+ uses these; created now to avoid a Phase B reindex window)
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_session ON audit_log(actor_session_id) WHERE actor_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_approval_request ON audit_log(approval_request_id) WHERE approval_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_risk_level ON audit_log(risk_level) WHERE risk_level IS NOT NULL;
```

The REVOKE statement is intentionally NOT in this migration — it's A8, separate review.

### Order rationale for the column additions

- Columns added first, populated by new code over time. Old code keeps inserting rows with these columns NULL; that's fine because they are nullable.
- CHECK constraints added with `NOT VALID` then `VALIDATE` — the two-step pattern means the lock during ADD is brief and the VALIDATE scan happens online.
- TIMESTAMPTZ conversion is the only potentially expensive operation. Risk: large existing `audit_log` could lock writes during the conversion. Mitigation: time-box the migration window; if `audit_log` is millions of rows, use `pg_repack` or split into a batched migration. For the current platform scale (pilot, low volume), an in-place ALTER is fine.

### Phase A code's relationship to extended columns

- The new `auditCapture` middleware writes `actor_ip`, `actor_user_agent`, `request_id`, `outcome`, `risk_level` for every v2 admin request.
- It writes `before_value`/`after_value` for state-mutating endpoints (role grants, permission grants).
- `actor_session_id` and `approval_request_id` are populated as Phase B and C activate those subsystems. NULL is correct for Phase A audit rows that pre-date those subsystems.

---

## 7. Rollback strategy

Per-migration rollback files live alongside each migration (convention: `<n>_<name>.down.sql`). All rollbacks are additive-reversal — no destructive data loss for pre-Phase-A state.

| Migration | Rollback |
|---|---|
| A1 (audit_log extension) | `ALTER TABLE audit_log DROP COLUMN ...` for each added column; restore `created_at` to `TIMESTAMP` via `ALTER COLUMN ... TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC'`. Drop the new indexes. **Note:** any data written into the new columns after migration is lost on rollback. Acceptable because these columns are only used by Phase A's new code paths. |
| A2 | `DROP TABLE role_permissions, permissions, roles CASCADE` |
| A3 | `DROP TABLE admin_user_permissions, admin_user_roles CASCADE` |
| A4 | `DROP TABLE admin_mfa_factors, admin_sessions CASCADE` |
| A5 | `DROP TABLE approval_requests CASCADE` |
| A6 | `DROP TABLE permission_audit CASCADE` |
| A7 (seed) | `DELETE FROM role_permissions; DELETE FROM admin_user_roles; DELETE FROM admin_user_permissions; DELETE FROM permissions; DELETE FROM roles;` Order matters (FKs). |
| A8 (REVOKE) | `GRANT UPDATE, DELETE ON audit_log TO <app_role>` |

### Code rollback

`git revert <phase-a-commit>` removes the middleware imports, the v2 admin-management routes, and the permission registry. Since the v1 admin routes are unchanged in Phase A, reverting Phase A code does not affect any existing admin functionality.

### Cross-state safety

Documented in the partial-state matrix (§1). Summary: Phase A is fully reversible at any point because nothing in the existing codebase reads from or writes to the new tables. The only one-way operation in Phase A is the TIMESTAMPTZ conversion of `audit_log.created_at` (data is preserved but the column type changed); the rollback restores the type and preserves the values (with UTC assumption).

### Rollback ordering rule

If multiple migrations need to be reversed, run rollbacks in **strict reverse order of forward application**: A8 → A7 → A6 → A5 → A4 → A3 → A2 → A1. Code revert can happen before, during, or after — the schema rollbacks do not depend on any code state.

---

## 8. Testing strategy

Three layers, each gated separately.

### 8.1 Pure unit tests (no DB)

| Suite | What it asserts |
|---|---|
| `tests/permissions/registry.test.js` | Every permission key follows `<domain>:<resource>:<action>` syntax. Domains and actions match the closed enums. Risk levels are valid. Mutual-exclusion rules are syntactically consistent. |
| `tests/permissions/permissionService.test.js` | `hasPermission` correctly resolves direct grants + role grants. Expired grants return false. Mutual-exclusion violations on a single user return false. |
| `tests/permissions/mutualExclusion.test.js` | Every pair in the §12 hard-separation list is enforced. Adding a new permission without classifying it fails the build. |
| `tests/permissions/approvalService.test.js` | Approval request lifecycle: pending → approved → executed; rejected; expired. `approver_id != requested_by` enforced. Replay of executed approval fails. |
| `tests/middleware/requirePermission.test.js` | 403 with structured error body when permission missing. 200 when present. Audit row written. |
| `tests/middleware/requireApproval.test.js` | First call returns 202 with approval_request_id. Second call by different user with approval returns handler result. Same-user second call returns 403. |
| `tests/middleware/auditCapture.test.js` | Audit row written before handler runs. Outcome updated after. Failure writes `outcome='failure'`. before/after values captured for mutating routes. |

### 8.2 Schema & migration tests (DB required, ephemeral)

| Suite | What it asserts |
|---|---|
| `tests/migrations/048_audit_log_extension.test.js` | Forward migration adds all columns. Existing rows preserved. CHECK constraints reject invalid values. Rollback restores prior schema. |
| `tests/migrations/049-053_rbac_tables.test.js` | All tables created with correct constraints. FK cascades behave as designed. Unique constraints fire on duplicate inserts. `approval_requests.approver_id != requested_by` enforced. |
| `tests/migrations/054_seed.test.js` | All 9 default roles exist. Every role's permission set matches the registry expectation. `legacy_admin` exists and carries every permission. `users.role='admin'` users are granted `legacy_admin`. Mutual-exclusion check passes for every default role taken alone. |
| `tests/migrations/055_audit_revoke.test.js` | After REVOKE, the app's DB role cannot UPDATE or DELETE audit_log. INSERT still works. |
| `tests/migrations/rollback.test.js` | Each migration's rollback restores prior schema exactly. Forward-then-rollback-then-forward leaves state identical to single forward apply. |

### 8.3 Integration tests (DB + HTTP)

| Suite | What it asserts |
|---|---|
| `tests/admin-v2/role-management.test.js` | A super_admin can create a role, assign permissions, grant to a user. Mutual-exclusion violation returns 409. Audit row written for every grant/revoke. |
| `tests/admin-v2/legacy-transition.test.js` | A user with `users.role='admin'` (legacy) successfully calls a v1 admin route AND a v2 admin route. Their permissions come from `legacy_admin`. Audit log shows the grant. |
| `tests/admin-v2/approval-flow.test.js` | Tier-3 action (e.g., grant super_admin to a new user) requires approval. Initiator gets 202. Approver gets handler result. Self-approval blocked. Approval expiry works. |
| `tests/regression/existing-admin-routes.test.js` | Every existing `/api/admin/*` route still returns the same response shape and status codes as pre-Phase-A. No behavior change visible to v1 callers. |

### 8.4 Coverage targets

- 100% of permission keys covered by either a direct test or a parameterized registry test
- 100% of mutual-exclusion pairs covered by a dedicated assertion
- 100% of v2 routes covered by an integration test
- 100% of migrations covered by a forward-then-rollback test

These are mechanical to enforce — they will be reported in the Phase A commit report.

### 8.5 What NOT to test in Phase A

- Step-up auth enforcement (Phase B)
- MFA enrollment flow (Phase B)
- Financial route migration (Phase C)
- Admin UI (Phase D)

Tests for those phases ship with those phases.

---

## 9. Operational rollout sequencing

Phase A is one logical change broken into commit-sized pieces. The order below preserves the "migration leads code" rule at each step.

### Sub-batch A.1 — Audit log extension + REVOKE

Files:
- `db/migrations/048_extend_audit_log.sql`
- `db/migrations/048_extend_audit_log.down.sql`
- `db/migrations/055_revoke_audit_log_mutations.sql`
- `db/migrations/055_revoke_audit_log_mutations.down.sql`
- `tests/migrations/048_audit_log_extension.test.js`
- `tests/migrations/055_audit_revoke.test.js`

Deploy: migrations to staging → verify → migrations to production → commit. No code change in this sub-batch.

### Sub-batch A.2 — RBAC tables + seed (no enforcement yet)

Files:
- `db/migrations/049_create_rbac_roles_permissions.sql` + `.down.sql`
- `db/migrations/050_create_admin_user_grants.sql` + `.down.sql`
- `db/migrations/051_create_admin_sessions_mfa.sql` + `.down.sql`
- `db/migrations/052_create_approval_workflow.sql` + `.down.sql`
- `db/migrations/053_create_permission_audit.sql` + `.down.sql`
- `db/migrations/054_seed_rbac_defaults.sql` + `.down.sql`
- `src/permissions/permissionRegistry.js`
- `scripts/generate-permission-seed.js` (regenerates `054_seed_rbac_defaults.sql` from the registry)
- `tests/migrations/049-053_rbac_tables.test.js`
- `tests/migrations/054_seed.test.js`
- `tests/permissions/registry.test.js`
- `tests/permissions/mutualExclusion.test.js`

Deploy: migrations + seed to staging → verify legacy admins still log in and use v1 routes → production migration. Code-only commit follows.

### Sub-batch A.3 — Services + middleware modules (no route wiring yet)

Files:
- `src/permissions/permissionService.js`
- `src/permissions/roleService.js`
- `src/permissions/approvalService.js`
- `src/middleware/requireAdminSession.js`
- `src/middleware/requirePermission.js`
- `src/middleware/requireApproval.js`
- `src/middleware/auditCapture.js`
- `src/middleware/requireStepUp.js` (stub)
- Unit tests for each

Deploy: code-only. Modules exported, nothing imports them yet, no behavior change.

### Sub-batch A.4 — v2 admin-management routes

Files:
- `src/routes/admin/v2/roles.js`
- `src/routes/admin/v2/users.js`
- `src/routes/admin/v2/permissions.js`
- `src/routes/admin/v2/approvals.js`
- `src/routes/admin/v2/audit.js`
- `server.js` updates: mount the new routers at `/api/admin/v2/*`
- Integration tests

Deploy: code-only. New endpoints reachable; existing v1 endpoints unchanged.

### Sub-batch A.5 — Operator runbook + initial role assignments

- `docs/sop-rbac-administration.md` (new SOP for super_admin daily operations: creating users, granting roles, reviewing approval inbox)
- Manual operator step on staging: assign appropriate roles to staging admins (move from `legacy_admin` to specific roles like `finance_admin`, `platform_admin`)
- Verify staging continues to work end-to-end with non-legacy role grants
- Production: keep `legacy_admin` as the only grant initially; promote individuals to specific roles only after Phase B's MFA lands

This sub-batch is mostly documentation + manual ops; it does not modify code.

### Sequencing rules across sub-batches

- A.1 must be deployed and verified before A.2 (because A2 depends on audit log having `approval_request_id` column for FK consistency in tests).
- A.2 must be deployed before A.3 (modules import nothing until the schema exists).
- A.3 must be deployed before A.4 (routes import middleware).
- A.5 happens after A.4 in production but can be drafted earlier.

Each sub-batch has its own staging validation window. No sub-batch ships to production until staging proves it.

---

## 10. Risk register specific to Phase A

| # | Risk | Mitigation in Phase A |
|---|---|---|
| 1 | TIMESTAMPTZ conversion locks `audit_log` during migration | Time-box the migration window; run during low-traffic window; if table grows beyond ~1M rows, switch to batched migration |
| 2 | Seed migration mis-grants `legacy_admin` to a non-admin user | Seed query is `WHERE role = 'admin'` only; test asserts no other users receive the grant |
| 3 | `permissionRegistry.js` and seed migration drift | CI step regenerates seed from registry; commit fails if regenerated SQL differs from committed file |
| 4 | A new permission added to the registry without a default role assignment | Test asserts every registry key is granted to at least one role OR explicitly listed as "intentionally unassigned" in the registry metadata |
| 5 | Mutual-exclusion check bypassed by a bulk-grant path | All grant operations go through `roleService.grant*`; raw INSERT against grant tables is rejected by a DB trigger that calls the same check |
| 6 | `legacy_admin` exception leaks to other roles via copy-paste | Test asserts the exception applies only to the specific role key `legacy_admin` and no other |
| 7 | Approval workflow can be replayed after execution | `approval_requests.status='executed'` flips atomically inside the executing transaction; second execute attempt returns 410 |
| 8 | REVOKE on `audit_log` accidentally applied before code is ready to write only via INSERT | A.1 (column adds) and A.8 (REVOKE) are separate migrations; A.8 ships only after Phase A code is verified write-only |
| 9 | Phase A middleware breaks existing admin routes via unintended side effects | Regression suite in §8.3 asserts every existing `/api/admin/*` route returns identical responses pre- and post-Phase-A |
| 10 | Staging admins lose access during the transition | Seed runs `INSERT ... ON CONFLICT (user_id, role_id) DO NOTHING` so re-running is safe; manual rollback procedure documented (`DELETE FROM admin_user_roles WHERE role_id='legacy_admin'`) — though this should never be needed |

---

## 11. Decisions needed before Phase A implementation starts

These reference the architecture-doc §13 list but narrow them to the ones that gate Phase A specifically. The full §13 list still applies for Phases B–E.

| # | Decision | Impact on Phase A | Status |
|---|---|---|---|
| 1 | Confirm `legacy_admin` transitional role approach | Drives §5 seed strategy. Default: yes, per architecture doc. | **APPROVED** |
| 2 | Audit log retention policy now | Drives whether A1 includes a partition strategy. Default: no partitioning yet (table is small); revisit at 10M rows. | **APPROVED** (non-partitioned at present scale) |
| 3 | TIMESTAMPTZ migration window | When can the migration run? Default: pilot has low write volume; in-place ALTER is fine. | **APPROVED** (in-place at present scale) |
| 4 | Naming convention `/api/admin/v2/*` | Confirms route prefix. Alternatives: `/api/ops/`, `/api/internal/`. Default: `/api/admin/v2/` (closest to existing convention). | **APPROVED** |
| 5 | Seed migration generation step (CI) | Approve the `scripts/generate-permission-seed.js` build step. Default: yes, for drift prevention. | **APPROVED** |
| 6 | Test database availability | Schema & integration tests need a real Postgres. Confirm CI has one or a containerized Postgres ready. | OPEN (operator confirmation needed before A.1) |
| 7 | Mutual-exclusion enforcement via DB trigger vs. service layer only | Trade-off: DB trigger is defense-in-depth (catches raw SQL); service-only is simpler. Recommend trigger AND service for finance-related permissions. | **APPROVED** (DB trigger + service layer, defense in depth) |
| 8 | `engineer_on_call` time bound | Default 1h per architecture doc. Confirm or specify. | **APPROVED** (1 hour) |
| 9 | Approval request TTL default | Default 24h. Confirm or specify. | **APPROVED** (24 hours) |
| 10 | `permission_audit` retention | Default same as `audit_log` (24 months hot). Confirm. | **APPROVED** (matches audit_log retention) |

Only decision #6 (CI database availability) remains open. Confirmation required before Sub-batch A.1 implementation begins.

---

## 12. What is explicitly NOT in Phase A (re-asserted)

- ❌ No MFA enrollment, no MFA-gated routes (Phase B)
- ❌ No admin session model enforcement (Phase B)
- ❌ No financial route migration (Phase C)
- ❌ No admin UI (Phase D)
- ❌ No SSO/SCIM integration (Phase E)
- ❌ No quarterly access review automation (Phase E)
- ❌ No audit log replication to S3 (Phase E)
- ❌ No hash chain on audit log (Phase E)
- ❌ No bulk-grant tooling (intentional friction; do it via individual grants until UI exists)
- ❌ No mid-session permission revocation (snapshot-at-login is enough at this scale)

---

## 13. Phase A summary

| Dimension | Phase A delivers |
|---|---|
| **Schema** | 9 new tables + extended audit_log + REVOKE; all additive, all reversible |
| **Code** | Permission registry, services, middleware modules, v2 admin-management routes |
| **Behavior** | No change for existing buyers, sellers, or admins; new v2 admin-management endpoints reachable by super_admin |
| **Audit** | Every v2 admin action audited with full actor + outcome context; v1 admin actions audited as before |
| **Tests** | Schema tests, unit tests, integration tests, regression suite confirming v1 unchanged |
| **Risk** | Fully reversible at any point; mid-deploy partial states safe per §1 matrix |
| **Operator visibility** | New SOP doc; staging admins assigned specific roles to validate; production stays on `legacy_admin` until Phase B's MFA |

Phase A delivers the **foundation** on which Phases B–E build. It is deliberately quiet from the operator's perspective: nobody loses access, nobody gains UI, but the platform now has the schema, the registry, the middleware, and the audit completeness to support genuine least-privilege governance in subsequent phases.

---

## Priority ordering with concurrent Phase 1 settlement-integrity work

**Phase A implementation does not begin until Phase 1 §E staging validation is successfully completed.** The §E runbook in [`docs/sop-staging-validation-e.md`](./sop-staging-validation-e.md) remains the higher-priority operational gate. Financial correctness over speed; no rushed governance rollout.

Order of operations:
1. Operator executes Phase 1 §E.1 → §E.12 with Claude review gates between each scenario.
2. §F sign-off achieved and recorded.
3. Production deploy of Phase 1 (migration 047 + Sub-batch 2 code).
4. Removal of temporary staging validation hooks (per their commit-message removal procedure).
5. *Only then* does Phase A planning move into implementation, beginning with Sub-batch A.1.

This discipline preserves the architecture → planning → validation → implementation sequence used throughout the platform's safety-critical work.
