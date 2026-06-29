# Operations Admin Center — Architecture & Permission Model

*Institutional governance architecture for the Advantage Auction Platform internal operations layer. This is governance infrastructure, RBAC architecture, financial authority segregation, operational auditability infrastructure, and employee access governance — not "just an admin dashboard." Treat changes to this document with the same discipline as changes to production code.*

**Posture:** layered onto the existing system, not a replacement. The legacy `users.role` and the `auth → role(['admin'])` middleware keep working through the rollout. New machinery sits beside them and migrates routes one at a time.

---

## 1. Recommended RBAC architecture

### Recommendation: **hybrid RBAC with permission-string atoms + dual-control overlay**

Pure RBAC (only roles) is brittle: every new edge case creates a new role. Pure ABAC (only attributes) is too complex for ~5–50 employees. The right shape:

| Layer | What it does | Source of truth |
|---|---|---|
| **Permission keys** | Atomic strings like `payments:refund:execute` | Code constants (`permissionRegistry.js`) |
| **Roles** | Named bundles of permissions | DB `roles` + `role_permissions` |
| **User → Role grants** | Many-to-many, time-boxable | DB `admin_user_roles` |
| **User → Permission direct grants** | One-off overrides (rare, audited, time-boxed) | DB `admin_user_permissions` |
| **Dual-control overlay** | Some permissions require an approval flow, not just possession | DB `approval_requests` + middleware |
| **Step-up overlay** | High-risk permissions require fresh re-auth (TOTP within N minutes) | Session + middleware |

**Decision algorithm (runtime):**
```
hasPermission(user, key, context) =
   (user has direct grant AND grant not expired)
OR (user has role with grant AND role-grant not expired)
AND (if key.requiresStepUp → session.last_step_up_at within N min)
AND (if key.requiresApproval → context.approval_request_id exists AND approved by ≠ user)
```

**Permission key registry is code, not data.** A permission key only exists if it's declared in `permissionRegistry.js`. The DB stores grants but cannot grant a permission that doesn't exist in code. This prevents "ghost permissions" from drift.

---

## 2. Recommended core roles

Start with 9 roles. Resist adding more until friction proves they're needed.

| Role | Purpose | Typical count | Notes |
|---|---|---|---|
| `super_admin` | Manage roles, manage admins, emergency override | **1–2 humans, max** | Cannot grant themselves perms; cannot bypass audit; rate-limited |
| `platform_admin` | Day-to-day operations: publish auctions, manage lots, moderation queue | 2–5 | Most-used role; NO financial execution |
| `finance_admin` | Refund execution, invoice ops, payment reconciliation | 1–3 | NO content moderation, NO role management |
| `payout_approver` | Dual-control counterparty for payout release | 1–2 | A `finance_admin` cannot also be a `payout_approver`. CFO or operations lead. |
| `support_agent` | User-facing fixes: notification prefs, address corrections, password resets | 3–10 | Read-mostly; small set of writes; never financial |
| `seller_success` | Onboarding, seller profile updates, seller comms | 2–5 | NO buyer-side actions |
| `content_moderator` | Walkthrough video approval, lot photo moderation | 2–5 | NO PII access beyond what's needed; NO financial |
| `read_only_viewer` | Auditor, compliance, observer access | unlimited | Read everything; write nothing; can read audit log |
| `engineer_on_call` | Break-glass debugging in production incidents | rotation pool | **Auto-expires in 1h**; activation alerts security@; logged loudly |

**Constraints encoded in the schema:**
- Role assignment is many-to-many, but `super_admin` is mutually exclusive with `finance_admin` and `payout_approver` (no individual can authorize their own promotion).
- `engineer_on_call` cannot be a persistent grant; the grants table refuses inserts without `expires_at <= now() + 1h`.
- `read_only_viewer` cannot be combined with any write role (their value is the strict separation).

---

## 3. Permission grouping strategy

### Naming pattern: `<domain>:<resource>:<action>`

Three-part colon-separated string. Lowercase, snake_case within parts. Immutable once shipped.

### Domains (closed enum)

| Domain | Scope |
|---|---|
| `platform` | Settings, feature flags, marketplace config |
| `identity` | Users, roles, sessions, MFA |
| `payments` | Payment intents, status changes |
| `refunds` | Refund initiation, approval, execution |
| `payouts` | Seller payout records, release execution |
| `invoices` | Invoice viewing, status changes |
| `auctions` | Auction lifecycle |
| `lots` | Lot lifecycle, featured selection |
| `seller` | Seller profile, capabilities, payout preferences |
| `buyer` | Buyer profile, paddle numbers, notification prefs |
| `moderation` | Content approval queues |
| `marketing` | Campaign management, recipient lists |
| `analytics` | Reporting, dashboards, exports |
| `support` | User-facing fixes, address overrides |
| `audit` | Audit log read |

### Actions (closed enum)

`read`, `list`, `create`, `update`, `delete`, `execute`, `approve`, `override`, `export`, `impersonate`

**Constraint:** there is no `audit:log:update` or `audit:log:delete` permission. It is not a permission you can omit — it is a permission that cannot exist. Audit log is append-only at the schema and grant layers.

### Examples (representative, not exhaustive)

```
identity:user:list
identity:user:create
identity:user:impersonate          ← time-boxed only
identity:role:grant
identity:role:revoke
identity:session:revoke

payments:payment:read
payments:payment:override          ← admin mark-paid
refunds:refund:initiate            ← single-actor, under threshold
refunds:refund:execute             ← single-actor execute
refunds:refund:approve             ← dual-control approver
refunds:refund:override_threshold  ← raise the threshold for one txn

payouts:payout:read
payouts:payout:initiate
payouts:payout:approve
payouts:payout:execute
payouts:preference:update          ← bank info change

auctions:auction:publish
auctions:auction:override          ← admin override of seller-locked fields
lots:lot:feature_override

moderation:video:approve
moderation:video:reject

support:user_address:override
support:notification_pref:update

audit:log:read
audit:log:export                   ← bulk export, separate permission

platform:feature_flag:update
platform:setting:update
```

### Risk level metadata

Each permission key carries metadata in code:

```
{ key: 'refunds:refund:execute',
  risk: 'high',
  requires_step_up: true,
  requires_approval: { threshold_cents: 50000 },
  audit_required: 'before_and_after' }
```

The middleware reads metadata at request time. Adding a new permission requires explicit risk classification in the same commit.

---

## 4. Financial permission segregation model

This is the most consequential section. **Every rule here is a tripwire designed to require collusion between two humans to defraud.**

### Tier 0 — read

Anyone with `*:read` can observe. No segregation needed for reads (audit-log-read is itself read-only).

### Tier 1 — single-actor execution (low amount, low risk)

A small refund (e.g., < $500) can be executed by one `finance_admin`. Single audit row, no approval flow.

Single actor still requires:
- Active step-up auth (TOTP within last 5 min)
- Per-action reason field captured to audit
- Per-actor daily cap (e.g., cumulative refunds in 24h < $X)

### Tier 2 — dual control (high amount, high risk, or sensitive bank info)

Required for:
- Refunds over the threshold (`refunds:refund:execute` blocked above threshold without a matching `refunds:refund:approve` from a different user)
- All payout releases
- All seller payout-preference (bank info) changes
- Role grants that include any Tier-2 or Tier-3 permission
- Disabling MFA on another admin
- Audit log export

Schema: `approval_requests` row stores:
- `requested_by` (initiator)
- `payload` (what they want to do — JSONB snapshot)
- `approver_id` + `approved_at` (must differ from `requested_by`)
- `executed_at` + `executed_by` (often == approver, sometimes the system)
- `expires_at` (request expires if not approved within window, e.g., 24h)

Middleware enforces: any route that touches a Tier-2 permission either creates an `approval_request` (initiator call) OR consumes one (executor call). The executor verifies `approver_id != requested_by` before proceeding.

### Tier 3 — super-permission (catastrophic blast radius)

- Granting `super_admin` to a new user
- Revoking `audit:log:read` from anyone (paradoxically — auditors should be hard to remove)
- Changing the role definition of an existing role
- Disabling MFA platform-wide

These require **dual approval** (two `super_admin` users, neither is the initiator) AND a **time delay** (changes apply 1 hour after approval, so a third party can catch attacks in progress).

### Hard separation rules (encoded as DB constraints + checks)

| Permission A | Cannot coexist with | Reason |
|---|---|---|
| `refunds:refund:execute` | `refunds:refund:approve` (within same user) | Self-approval = no control |
| `payouts:payout:execute` | `payouts:payout:approve` | Same |
| `payouts:preference:update` | `payouts:payout:execute` | Whoever changes bank info cannot release money there |
| `identity:role:grant` | `identity:role:approve` | Self-approval = no control |
| `identity:user:impersonate` | `*:execute` while impersonating | Acting AS another user must never gain elevated privilege |
| `audit:log:read` | `payments:override:*`, `refunds:*:execute`, `payouts:*:execute` | Auditors don't move money |
| `platform:feature_flag:update` | `payments:*`, `refunds:*`, `payouts:*` | Whoever can flip a kill switch can't also move money during the window |
| `marketing:export` | `support:user:read_pii` | PII access shouldn't enable bulk export (data exfil prevention) |
| `engineer:break_glass` | anything else (it's exclusive while active) | Break-glass is a temporary swap, not an addition |

### Reason capture

Every Tier-2+ action requires a free-text `reason` field captured to audit. UI presents a confirmation modal with the reason input. Reason ≥ 20 characters, ≤ 500. Reason is shown in the approval inbox to the approver.

### Daily caps

Per-actor caps (configurable, evaluated against the audit log in the request middleware):
- `finance_admin`: cumulative refund amount per 24h
- `payout_approver`: cumulative payout amount per 24h
- `support_agent`: number of `support:user_address:override` per 24h

Cap exceeded → request rejected with HTTP 429-equivalent + audit row.

---

## 5. Admin authentication & session model

### Don't share auth with buyers/sellers

Existing buyer/seller JWT continues to work for their flows. Admin auth is a **separate session model** with stricter rules.

### Recommended admin session shape

| Attribute | Value | Rationale |
|---|---|---|
| Login | Email + password + MFA (TOTP minimum; WebAuthn recommended) | Multi-factor required for all admins, no exceptions |
| Session token | Short-lived JWT (15 min) OR HttpOnly cookie session | Reduce blast radius of stolen token |
| Sliding refresh | Auto-extend on activity, hard max 8h before re-login | Limits drift |
| Step-up auth | Re-confirm TOTP/WebAuthn for any Tier-2+ action if last step-up > 5 min ago | Limits stolen-laptop window |
| IP allowlist | Optional per role; required for `super_admin` and `payout_approver` | Reduces remote attack surface |
| Device fingerprint | Captured per session, change → forces re-auth | Detects session-token theft |
| Concurrent session limit | 1 per user by default (configurable) | Detects credential sharing |
| Idle timeout | 30 min of inactivity → session revoked | Limits unattended-screen risk |
| Revocation | Central kill switch — any super_admin can revoke any session | Incident response |

### Login flow

1. Email + password → server validates
2. Prompt MFA challenge → user provides TOTP/WebAuthn
3. Capture device fingerprint, IP, user-agent
4. Issue session (cookie or short JWT)
5. Snapshot effective permissions at login time (so a mid-session permission revoke takes effect on the next refresh)
6. Audit row: `identity.session.created` with full context

### Step-up flow

1. User clicks a Tier-2 action button
2. Frontend checks `session.step_up_at` from session metadata
3. If > 5 min ago, prompt MFA challenge
4. On success, update `step_up_at`, return short-lived "step-up token" specific to this action
5. Server middleware validates step-up token matches the action being performed
6. Audit row: `identity.session.step_up` per challenge

### Impersonation (if enabled)

Strongly recommend: **don't build it in v1**. If pressured to add it later:
- Separate `identity:user:impersonate` permission, time-boxed only
- Visible "Acting as <user>" banner on every page
- All actions during impersonation tagged in audit with both actor (admin) and effective subject (impersonated user)
- Impersonator's perms restricted to read-only by default; writes require a second `identity:impersonate:write` perm
- Impersonation session capped at 30 minutes

### MFA recovery

When an admin loses their MFA device:
- Self-service recovery is **forbidden** (otherwise it's a backdoor)
- Recovery requires another `super_admin` to approve via the approval workflow
- New MFA enrollment generates a fresh secret, audited
- Old factor revoked atomically

---

## 6. Audit log integration requirements

The existing `audit_log` is the foundation but has known gaps (already in the Phase 2 plan). The Operations Admin Center makes audit completeness a hard requirement.

### Schema extensions (additive, see §7)

- `actor_ip TEXT`
- `actor_user_agent TEXT`
- `actor_session_id UUID` references `admin_sessions(id)`
- `request_id TEXT` (correlates with HTTP request)
- `before_value JSONB` (state snapshot pre-change)
- `after_value JSONB` (state snapshot post-change)
- `outcome TEXT CHECK (outcome IN ('success', 'failure', 'partial'))`
- `risk_level TEXT CHECK (risk_level IN ('low','medium','high','critical'))`
- Convert `created_at TIMESTAMP` → `TIMESTAMPTZ`
- Add `approval_request_id UUID` (nullable; populated for Tier-2 actions)

### Append-only enforcement

- Revoke `UPDATE` and `DELETE` on `audit_log` from the application DB role
- Only the `audit_writer` DB role (used by the application) can `INSERT`
- A separate `audit_admin` DB role (used by the migration system + nobody else) has owner privileges for emergency repair, logged out-of-band
- Optional: hash chain — each row stores `prior_hash` = SHA-256 of the previous row's serialized contents; a verification job detects tampering

### What gets audited

**Every admin action**, classified as:
- `*.requested` — when user submits an action (Tier-2+)
- `*.approved` / `*.rejected` — when approver acts
- `*.executed` — when the system performs the action
- `*.failed` — when execution errors

Plus session lifecycle: created, refreshed, step_up, revoked, expired.

Plus role/permission lifecycle: granted, revoked, expired, role created/modified/deleted.

### Retention

- Online retention: 24 months hot, 5 years warm
- Long-term: replicate to S3 with Object Lock (legal hold) — write-once-read-many
- Compliance regimes (PCI/SOC 2/insurance) typically require 12 months minimum; design for 5

### Read access

- `audit:log:read` for read-only auditors and incident response
- Per-entity audit views in admin UI (e.g., "show me everything that touched payment X")
- Per-actor audit views ("show me everything user Y did this week")
- Bulk export requires `audit:log:export` (separate permission, dual control, daily cap)

---

## 7. Recommended DB schema additions

All additive — no changes to `users` beyond optional new columns. Existing `users.role IN ('seller','buyer','admin')` is preserved.

### New tables

```
roles (
  id              UUID PK,
  key             TEXT UNIQUE NOT NULL,       -- 'super_admin', 'finance_admin', ...
  name            TEXT NOT NULL,
  description     TEXT,
  is_system       BOOLEAN NOT NULL DEFAULT false,  -- system roles can't be deleted
  created_at      TIMESTAMPTZ,
  created_by      UUID
)

permissions (
  id              UUID PK,
  key             TEXT UNIQUE NOT NULL,       -- 'payments:refund:execute'
  domain          TEXT NOT NULL,
  resource        TEXT NOT NULL,
  action          TEXT NOT NULL,
  description     TEXT,
  risk_level      TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  requires_step_up BOOLEAN NOT NULL DEFAULT false,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  approval_threshold_cents INTEGER,           -- nullable; for amount-gated dual control
  created_at      TIMESTAMPTZ
)

role_permissions (
  role_id         UUID REFERENCES roles(id) ON DELETE CASCADE,
  permission_id   UUID REFERENCES permissions(id) ON DELETE RESTRICT,
  granted_by      UUID NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (role_id, permission_id)
)

admin_user_roles (
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id         UUID REFERENCES roles(id) ON DELETE RESTRICT,
  granted_by      UUID NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ,                -- nullable; required for engineer_on_call
  reason          TEXT,
  PRIMARY KEY (user_id, role_id)
)

admin_user_permissions (         -- direct grants outside of roles, rare
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  permission_id   UUID REFERENCES permissions(id) ON DELETE RESTRICT,
  granted_by      UUID NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,       -- always time-boxed
  reason          TEXT NOT NULL,
  PRIMARY KEY (user_id, permission_id)
)

admin_sessions (
  id              UUID PK,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  ip              TEXT,
  user_agent      TEXT,
  device_fingerprint TEXT,
  started_at      TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  step_up_at      TIMESTAMPTZ,                -- last MFA challenge
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID,
  revoke_reason   TEXT,
  permission_snapshot JSONB                   -- effective perms at login
)

admin_mfa_factors (
  id              UUID PK,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  factor_type     TEXT NOT NULL CHECK (factor_type IN ('totp','webauthn','recovery_code')),
  factor_data_encrypted BYTEA NOT NULL,       -- encrypted with env-managed key
  verified_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ
)

approval_requests (
  id              UUID PK,
  action_type     TEXT NOT NULL,              -- 'refund.execute', 'payout.release', etc.
  target_entity_type TEXT,
  target_entity_id UUID,
  payload         JSONB NOT NULL,             -- the proposed action
  requested_by    UUID NOT NULL,
  requested_at    TIMESTAMPTZ,
  reason          TEXT NOT NULL,
  approver_id     UUID,
  approved_at     TIMESTAMPTZ,
  approval_reason TEXT,
  executed_by     UUID,
  executed_at     TIMESTAMPTZ,
  status          TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','executed','expired','canceled')),
  expires_at      TIMESTAMPTZ NOT NULL,
  CHECK (approver_id IS NULL OR approver_id != requested_by)  -- separation of duties
)

permission_audit (                            -- audit log specifically for permission changes
  id              UUID PK,
  change_type     TEXT NOT NULL,              -- 'role.grant', 'permission.direct.grant', 'role.modified', ...
  target_user_id  UUID,
  target_role_id  UUID,
  permission_id   UUID,
  changed_by      UUID NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL,
  before_value    JSONB,
  after_value     JSONB,
  justification   TEXT NOT NULL
)
```

### Schema invariants enforced at DB level

- `approval_requests.approver_id != requested_by` (CHECK constraint as above)
- `admin_user_roles.expires_at IS NOT NULL` when role is `engineer_on_call` (enforced via trigger or partial index)
- `admin_user_permissions.expires_at IS NOT NULL` (always required)
- Unique partial index: at most one active `admin_sessions` per `(user_id, NOT revoked_at)` if single-session policy enforced

### Existing schema changes (minimal)

- `users` — optionally add `is_employee BOOLEAN DEFAULT false` to distinguish staff from end users. Not strictly necessary if you keep `users.role = 'admin'` as the marker.
- `audit_log` — Phase 2 column additions per §6 (already planned).

---

## 8. Recommended backend architecture

### Module layout (proposed)

```
src/
  permissions/
    permissionRegistry.js     -- all permission keys + metadata (source of truth)
    permissionService.js      -- hasPermission(user, key, ctx)
    roleService.js            -- CRUD on roles + grants
    approvalService.js        -- approval request lifecycle
    stepUpService.js          -- MFA step-up
  middleware/
    requirePermission.js      -- 403 if missing
    requireStepUp.js          -- 401 if step_up_at too old
    requireApproval.js        -- 403 if action needs approval and none attached
    auditCapture.js           -- wraps every admin route, writes pre/post audit
  routes/
    admin/v2/
      roles.js
      users.js
      permissions.js
      approvals.js
      audit.js
  services/
    paymentService.js         -- existing, unchanged
    auditService.js           -- extended per Phase 2
```

### Middleware chain for an admin route (canonical example)

```
POST /api/admin/v2/payments/:id/refund
  ->  auth                              (existing JWT/session check)
  ->  requireAdminSession               (NEW: confirms admin session not buyer/seller token)
  ->  requirePermission('refunds:refund:execute')
  ->  requireStepUp({ maxAgeSeconds: 300 })
  ->  requireApproval({ actionType: 'refund.execute', amountField: 'refund_amount_cents' })
                                         -- consumes existing approval_request_id from body
                                         -- or initiates one if missing
  ->  auditCapture                       (NEW: writes *.requested before, *.executed/*.failed after)
  ->  handler                            (calls existing paymentService.processRefund)
```

The `requireApproval` middleware is the dual-control gate: if the request doesn't carry an `approval_request_id`, it returns 202 with a fresh approval_request ID and the request is converted to a pending approval. Once approved by a different user, the original requester (or any user with the execute permission) replays the request with the approval ID.

### API surface convention

- All admin v2 routes under `/api/admin/v2/*`
- All routes return `{ success: bool, data?, error? }` envelope
- Standard error codes: `403` (no permission), `401` (no step-up), `409` (approval pending), `429` (rate cap)

### Gradual route migration

- New v2 routes use the middleware stack above
- Existing v1 routes (`/api/admin/payments/:id/refund`) stay live with `role(['admin'])` until the v2 equivalent is operator-validated
- Once v2 is proven, v1 returns 410 Gone with a pointer to v2
- Migration is route-by-route, not big-bang

### Permission registry as compile-time check

`permissionRegistry.js` exports a frozen object. Middleware calls reference the constants:

```
requirePermission(PERMS.REFUNDS_REFUND_EXECUTE)
```

Typo'd permission keys are caught at startup. Adding a permission requires:
1. Define in `permissionRegistry.js` with metadata
2. Add to seed migration
3. Update RBAC test suite to verify default role assignments
4. Reference in middleware

### Permission cache

- Effective permissions per session snapshot at login
- Cached in-process per session token
- Invalidated on: session revocation, explicit `refreshPermissions` call (used after a grant change)
- Cache TTL = session lifetime (so revoked grants take effect on next login OR explicit refresh)

This means a fresh grant doesn't activate mid-session unless the user logs out and back in. For revocations, the central session-revoke endpoint forces a re-login. Trade-off: simpler cache invariants vs. instant grant activation. For an internal tool with manual provisioning, the simpler model wins.

---

## 9. Recommended frontend / admin UI architecture

**Don't build yet.** The architecture below is for planning, not implementation.

### Deployment model

- **Separate origin** for admin UI (e.g., `ops.advantage.bid` or `/admin/*` on the main domain with strict CSP)
- Distinct visual identity from buyer/seller UI (dark theme, sober colors — no celebration animations on a refund button)
- Served from the same Node app or split into a separate static deploy — either is fine; permissions middleware lives on the backend either way

### Tech recommendation (decision deferred)

Suggest a single-page app (React or Vue), kept thin: most logic stays on the backend. Skip server-side rendering — admin UI is internal, SEO doesn't apply, simplicity matters more.

### Information architecture

Top-level nav (gated by permission):
- **Dashboard** — your queue (pending approvals for you, your recent actions, system health summary)
- **Auctions** — list, search, drill into auction → lots → bids
- **Payments & Refunds** — search payments, issue refund (initiate/approve), refund audit per payment
- **Payouts** — pending payouts queue, release initiation, approval inbox
- **Users** — admin user management (sub-page for end-user lookup)
- **Roles & Permissions** — view roles, manage grants (requires super_admin)
- **Audit Log** — global search, per-entity views, per-actor views, export
- **Sessions** — your sessions, revoke other sessions (requires super_admin or self-only)

### UX rules with teeth

- Every action button shows the required permission in a tooltip ("requires `refunds:refund:execute` + step-up")
- High-risk actions open a confirmation modal with:
  - Summary of the action ("Refund $50.00 to buyer X for lot Y")
  - **Reason field** (required, ≥20 chars)
  - Active step-up indicator ("MFA confirmed 2 min ago") or "Step-up required" button
  - Estimated impact (e.g., "Buyer will be notified; payout for this auction will be reduced by $50.00")
- Bulk actions disabled by default for most financial operations
- Approval inbox is the homepage for users with `*:approve` permissions
- "Acting as <admin email>" indicator always visible at top of every page (session identity reminder)
- Session timeout warning at 25 min of inactivity, hard logout at 30 min
- After any logout (manual or expired), redirect to login with no preserved state

### Surfaces that are explicitly forbidden in v1

- Bulk refund UI (intentional friction — one at a time)
- Free-text SQL execution
- Direct DB-row edit screen
- File upload that runs server-side scripts
- "Login as user" without the impersonation safeguards in §5

---

## 10. Operational risk analysis

Risks ranked by severity × likelihood.

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| 1 | `super_admin` credential compromise | Catastrophic | Low | Hardware key required; IP allowlist; dual approval for super_admin grants; daily alert on super_admin activity to security@ |
| 2 | Permission drift (admins accumulate perms over time) | High | High (without process) | Time-boxed grants; quarterly access reviews; automatic expiry; perm-drift detection job |
| 3 | Audit log tampering by an admin with DB access | Catastrophic | Low | Append-only DB grants; hash chain; replicated to S3 Object Lock |
| 4 | Dual-control bypass via session sharing (one human, two browsers, two accounts) | High | Medium | Device fingerprint; per-action step-up forces interactive challenge; require physical distinct keys (WebAuthn) |
| 5 | Confused deputy — admin acts as another user | Medium | Medium | Impersonation explicitly modeled with banner + audit; deny silent impersonation |
| 6 | Privilege escalation via misconfigured role | High | Low | Role changes require dual approval + 1h delay; permission_audit table; tests assert default role assignments |
| 7 | Insider abuse (disgruntled employee) | High | Low–Medium | Session kill switch; off-boarding playbook; automated detection of anomalous activity (e.g., refund volume spike); cap enforcement |
| 8 | Lost MFA → social-engineered recovery | High | Medium | Self-service recovery forbidden; second super_admin must approve via approval workflow |
| 9 | API key for admin services leaked in logs | Medium | Medium | No long-lived admin API keys; all admin APIs require interactive session; audit log scrubs request bodies for secret-shaped strings |
| 10 | Cross-environment confusion (staging cred used in prod or vice versa) | Catastrophic | Medium | Environment marker in JWT; backend rejects token issued by wrong env; UI shows environment banner |
| 11 | Step-up bypass via replay of step-up token | High | Low | Step-up tokens bound to action + entity + nonce; single-use; short TTL |
| 12 | Approval request replay (use one approval for two actions) | High | Low | approval_request_id consumed atomically; `status='executed'` flips on first use; second use 410 |
| 13 | Role with `audit:log:read` granted to someone with write perms | High | Medium | Hard constraint encoded in roleService + tests; mutually exclusive sets enforced at grant time |
| 14 | Pre-prod environment uses real PII | Medium | Medium | Staging DB seeded with synthetic data; production data scrub job for staging restores |
| 15 | Approval inbox spam (admin clicks "approve" without reading) | Medium | High | Approvals require entering 20+ char justification; approval requires the approver to view full payload + diff |

---

## 11. Recommended phased rollout sequence

Five phases, ordered by risk/reward. Each phase has a checkpoint before the next.

### Phase A — Foundation (no UI, no behavior change visible to existing admins)

1. Audit log extension (Phase 2 plan already drafted): add columns, convert TIMESTAMPTZ, append-only DB grants
2. New DB tables (§7): roles, permissions, role_permissions, admin_user_roles, admin_user_permissions, admin_sessions, admin_mfa_factors, approval_requests, permission_audit
3. Permission registry in code (§3)
4. Middleware: `requirePermission`, `requireStepUp`, `requireApproval`, `auditCapture`
5. Seed migration: create default roles, default permission set, grant existing `users.role='admin'` users a transitional `legacy_admin` role with all permissions (so v1 routes continue to work)
6. Test suite: assert hard separation rules; assert default role grants; assert approval workflow correctness; assert audit completeness
7. Admin API only (no UI): `/api/admin/v2/roles`, `/api/admin/v2/users`, `/api/admin/v2/permissions`, `/api/admin/v2/approvals` — managed via curl by super_admin

**Phase A exit criteria:** RBAC schema in place, default roles seeded, all v1 admin routes still pass tests, audit log additions deployed, no user-visible change.

### Phase B — MFA + admin session model

1. `admin_sessions` + `admin_mfa_factors` tables active
2. Admin login flow: email/password + TOTP enrollment (WebAuthn deferred to Phase D)
3. Step-up middleware live
4. Session management API (revoke own session, super_admin revoke any)
5. Existing admin routes augmented: require admin session token (legacy JWT still works during transition)

**Phase B exit criteria:** every admin has TOTP enrolled, MFA enforced on all admin login, session revocation tested.

### Phase C — High-risk routes migrated to permission model

1. Migrate `POST /api/admin/payments/:id/refund` → `/api/admin/v2/payments/:id/refund` with dual-control approval flow
2. Build `POST /api/admin/v2/payouts/:id/release` (the new payout-release endpoint — replaces the SOP raw-SQL step from `docs/sop-payout-release.md`)
3. Migrate `POST /api/admin/payments/:id/record-success` with explicit `payments:payment:override` perm
4. Approval workflow operational (initiator → approver → executor)
5. Operator runbook updates: SOPs reference v2 endpoints

**Phase C exit criteria:** all financial-execution paths go through permission + step-up + dual-control middleware. v1 financial routes return 410.

### Phase D — Admin UI

1. Admin UI shell + login + session display
2. Audit log viewer (read-only, per-entity, per-actor)
3. Approval inbox
4. Per-domain pages migrated one at a time (start with refunds and payouts)
5. WebAuthn support added to MFA factors
6. Per-action confirmation modals with reason capture

**Phase D exit criteria:** all v2 endpoints reachable via UI, admins no longer using curl for routine ops.

### Phase E — Governance & enterprise features

1. Quarterly access review automation (each role's members + each member's roles, exported for review)
2. Permission drift detection job (alert if any user accumulates an unusual combo)
3. Auto-expiry enforcement: nightly job that fires on `expires_at < now()`
4. Compliance reports: weekly summaries to security@; monthly attestation log
5. SSO/SAML integration (if team grows past ~20)
6. SCIM provisioning (if team grows past ~50)
7. Hardware key enforcement (deprecate TOTP-only)
8. Audit replication to S3 Object Lock

**Phase E exit criteria:** ready for SOC 2 Type II audit kickoff.

---

## 12. Capabilities that should NEVER be grouped together

Hard list, encoded as constraints in `roleService` and verified by test:

| Group A | Group B | Why |
|---|---|---|
| Initiate refund | Approve refund | Self-approval defeats dual control |
| Initiate payout | Approve payout | Same |
| Modify payout preference (bank info) | Execute payout | One person can redirect funds to themselves |
| Grant role | Approve role grant | Self-promotion |
| Read PII at scale | Bulk export | Data exfil |
| Move money (any `*:execute` on payments/refunds/payouts) | Read audit log only — i.e., the auditor role | Auditors must not be capable of the actions they audit |
| Flip platform feature flag | Move money | Kill switch + money mover = silent fraud window |
| Impersonate a user | Perform writes while impersonating (default) | Confused deputy attacks |
| Disable another admin's MFA | Be the same admin whose MFA you're disabling | Self-recovery is a backdoor |
| Break-glass `engineer_on_call` | Any other persistent role simultaneously | Break-glass is a temporary swap, not addition |
| Update audit log | (anything — this permission does not exist) | Audit is append-only |
| Modify role definitions | Approve role definition modification | Same role can't be redefined and approved by one person |
| Read raw seller bank account info | Edit seller bank account info | Reduces "look and adjust" insider attack pattern |

The list is encoded as a `MUTUALLY_EXCLUSIVE_PERMISSIONS` set in `permissionRegistry.js`. `roleService.assignPermissionsToRole` and `userService.grantRole` reject any combination that would create a forbidden pairing for one user, returning HTTP 409 + audit row.

---

## 13. Future enterprise / compliance considerations

These are pointers for future planning — not work for the initial phases.

### Compliance regimes

- **SOC 2 Type II.** Most relevant for a financial marketplace. The audit log + access review process + change management you build here are the foundation. Allow 6 months of operating evidence before initiating an audit. Specific controls: MFA on all access (CC6.1), least-privilege (CC6.2), audit logs retained 12 months (CC7.2), change management (CC8.1).
- **PCI-DSS.** Currently out of scope as long as Stripe holds all PAN data. If you ever store card numbers directly, scope changes drastically (network segmentation, quarterly scans, etc.). Keep the Stripe-tokenized boundary inviolate.
- **GDPR / CCPA.** Data subject access requests (DSAR): need an admin endpoint that exports all data for a given user (perm `support:data_subject:execute`, dual control, audit). Right to deletion: anonymization endpoint that nulls PII while preserving aggregate records.
- **State / regional auction licensing.** Some jurisdictions require auctioneers to file periodic reports of activity. The audit log is the source.

### Identity & access

- **SSO via SAML/OIDC** when team > 20. Map SSO groups to roles (e.g., Okta group `finance` → role `finance_admin`). Off-boarding becomes "remove from SSO group" rather than "remember to revoke all roles."
- **SCIM provisioning** when team > 50. Automated lifecycle: new hire → SCIM provisions account → grants based on group → MFA enrollment prompted → admin can act on day 1. Termination → SCIM deletes account → all sessions revoked atomically.
- **Hardware security keys** for all admins past size ~10. WebAuthn with YubiKeys eliminates phishing-based credential theft. Make TOTP a recovery factor only, not primary.
- **Privileged Access Management (PAM)** for `super_admin`: just-in-time access requested via a separate system (e.g., Teleport), bounded to a session, recorded.

### Audit infrastructure

- **Immutable backup**: write audit_log to S3 with Object Lock (Legal Hold mode) so even AWS root cannot delete during the retention window.
- **SIEM integration**: stream audit_log to a SIEM (Datadog, Splunk, etc.) for cross-source correlation (admin actions + login attempts + network events).
- **Tamper-evident hash chain**: each row stores SHA-256 of prior row. Daily verification job + alert on mismatch.

### Insurance and contractual

- **Cyber liability insurance** typically requires: MFA on admins, audit log retention ≥ 12 months, encrypted backups, documented incident response, vulnerability scanning cadence. The architecture above satisfies these by default.
- **Enterprise customer contracts** (if you onboard B2B sellers) will often require SOC 2 report, breach notification SLA, sub-processor list. Build the audit log to support breach scope determination ("which records did this attacker touch?").

### Operational maturity

- **Quarterly access reviews**: managers must attest to each direct report's current grants. Removal triggers grant revocation.
- **Off-boarding playbook**: a documented sequence (revoke sessions → suspend account → revoke grants → archive audit logs → final report) executed within N hours of separation.
- **Incident response runbook**: which super_admin to call, how to revoke all sessions in 60 seconds, how to enable read-only mode, how to roll keys.
- **Bug bounty / responsible disclosure**: an external program once the surface stabilizes. Often surfaces RBAC weaknesses that internal review misses.

---

## Decisions needed before Phase A begins

Surfacing these now so they don't bottleneck implementation later. Pure planning input — no work blocked yet.

1. **Team size projection.** Year 1, 2, 5 employee counts shape role granularity. (Default assumption used above: 5–50 in Year 1.)
2. **MFA factor floor.** TOTP-only acceptable in Phase B, or WebAuthn from day one? TOTP is faster to ship; WebAuthn is phishing-resistant.
3. **SSO timeline.** If SSO is on the 12-month horizon, plan the role keys so SSO groups can map 1:1 later. Otherwise self-managed accounts in Phase A.
4. **IP allowlist scope.** Required for all admins, super_admin only, or optional?
5. **Refund auto-execute threshold.** Below what amount does a single `finance_admin` not require dual approval? Common defaults: $100, $500, $1000.
6. **Per-actor daily cap defaults.** Per-role 24h caps on refund volume, payout approvals, support overrides. Need an opening number; can be tuned.
7. **Audit retention.** Hot tier (24 months default). Long-term archival (5 years default). Confirm.
8. **Impersonation.** Build it (with safeguards) in v1, or forbid?
9. **Break-glass approver requirement.** Activation requires one super_admin or two?
10. **Permission cache invalidation policy.** Snapshot-at-login + manual refresh (recommended), or live re-evaluation per request (slower but instant)?
11. **Admin UI hosting.** Same origin as buyer/seller, or separate subdomain? Separate is safer (CSP, cookie scope) but requires DNS work.
12. **Environment marker in JWT.** Are you OK rejecting a JWT issued by staging that arrives at prod (and vice versa)? Standard practice; minor lift.

---

## What's NOT in this proposal (explicit non-goals)

- Refactoring the existing buyer/seller auth model
- Replacing the existing `users.role` column (additive only — legacy admin role keeps working through Phase B)
- A microservices split (single Node app remains correct at this scale)
- An external identity provider in v1 (deferred to Phase E)
- Real-time permission revocation mid-session (manual refresh model is good enough at this scale)
- A UI in this phase (Phase D)
- Migration of all existing admin routes in a single shot (route-by-route per Phase C)
