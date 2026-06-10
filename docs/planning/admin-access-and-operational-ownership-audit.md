# Admin Access & Operational Ownership Audit

**Type:** Read-only operational-readiness audit. **Date:** 2026-06-10 · Production release `e0f005f`, Stripe TEST.
**Scope:** administrator accounts, account recovery, operational ownership. **No code, schema, migration, deploy, or commit performed.**

> Security note: this document references seeded credentials by their source file only and does **not** reproduce any password value.

---

## ✅ Remediation Status — admin cleanup COMPLETE (2026-06-10)
The administrator-account findings below (R1, R2, and REQUIRED-BEFORE-PILOT items 1–3) have been **remediated**. Final production admin state:

| Email | Role | Active | Purpose |
|---|---|---|---|
| `admin@advantage.bid` | admin | **active** | Primary operational admin (provisioned via secure hidden-prompt script, bcrypt cost 10) |
| `tylerwitt2015@gmail.com` | admin | **active** | Personal / recovery admin |
| `validation-admin@advantage.bid` | admin | **disabled** (`is_active=false`) | Seeded — **disabled, retained not deleted** (R1 closed) |
| `test-admin@example.com` | admin | **disabled** (`is_active=false`) | Seeded — **disabled, retained not deleted** (R2 closed) |

Login to `admin@advantage.bid` verified by the operator. Seeded admins can no longer authenticate (`authService` rejects `is_active=false`). The sections below preserve the original as-found audit for the record, annotated with resolution.

---

## Current State

### How administrator access works (evidence)
- **Grant mechanism:** admin privilege is conferred **solely** by `users.role = 'admin'`. There is **no API to grant/promote admin** — it is set only by direct database writes.
  - `src/middleware/roleMiddleware.js`: `roles.includes(req.user.role)` → 403 otherwise. Authorization is a simple role string check.
  - `src/middleware/authMiddleware.js`: JWT Bearer; `req.user = { id, role }` from the signed token.
- **No privilege escalation via signup (positive):** `src/routes/auth.js:24` — `/register` **hard-codes `role='buyer'`**; the role is never read from the request body. Public users cannot self-assign admin.
- **Provisioning paths (DB-write only):**
  - `scripts/provision-admin.js` (secure, hidden-prompt, prod-guarded, bcrypt cost 10) — used to create the real operator admin.
  - `scripts/seed-validation-fixtures.js` — seeds `validation-admin@advantage.bid` (role admin, **fixed UUID**, **password hard-coded in the script**).
- **Auth surface:** `src/routes/auth.js` exposes only `POST /register`, `POST /login`, `GET /me`. **No reset/forgot/recover route exists** anywhere in `src/routes` or `src/services`.
- **No login auditing:** the production `users` table has **no `last_login` column** (query errored `column "last_login" does not exist`), so dormancy/last-use cannot be measured.

### Production administrator roster (AS-FOUND at audit time — see "Remediation Status" above for the final post-cleanup state)
3 admin accounts (role counts at audit time: **admin 3, buyer 16, seller 9**):

| # | Email | Active | Created | Origin / provenance | Assessment |
|---|---|---|---|---|---|
| 1 | `test-admin@example.com` | ✅ true | 2026-05-07 | **No origin found in repo** (created ad-hoc/manually); `@example.com` test pattern | Undocumented test-only admin on production |
| 2 | `validation-admin@advantage.bid` | ✅ true | 2026-05-11 | `scripts/seed-validation-fixtures.js` — **password hard-coded in a committed script**, fixed UUID | **Repo-known credential = active prod admin** |
| 3 | `tylerwitt2015@gmail.com` | ✅ true | 2026-06-10 | `scripts/provision-admin.js` (hidden prompt; password known only to operator) | Legitimate real operator admin |

---

## Findings

### A. Administrator account audit
- **A1.** Three active admins; only **one (#3) is a real, intentional operator account.** The other two are seeded/test artifacts that survived into production.
- **A2. Seeded admins still exist on production** and are **active**. They should **not** remain as-is. — **✅ RESOLVED 2026-06-10:** both seeded admins disabled (`is_active=false`).
- **A3. (HIGH) `validation-admin@advantage.bid` is a known-credential production admin.** Its password is hard-coded in `scripts/seed-validation-fixtures.js`, which is in the repository. **Anyone with read access to the repo can authenticate to production as an administrator.** This is an active exposure, not theoretical. — **✅ RESOLVED 2026-06-10:** account disabled (`authService` rejects inactive accounts at login, so the repo-known credential no longer grants access). Account retained (not deleted) for audit history.
- **A4. `test-admin@example.com` is an undocumented, test-pattern admin** with no traceable provisioning origin in the codebase and unknown password provenance — it has no legitimate place on production.
- **A5. No login/dormancy auditing** (no `last_login`) — we cannot prove whether the seeded admins have ever been used, which compounds the risk (silent misuse would be invisible).
- **A6. (positive)** No self-service path to admin: `/register` forces `buyer`; admin is DB-write-only.

### B. Recovery capability audit
- **B1. No self-service password reset.** There is no forgot-password/reset endpoint for any user.
- **B2. No administrator-initiated reset.** There is no admin endpoint to reset another user's password or create users (none in `src/routes/admin.js`).
- **B3. Another admin cannot "recover" a peer in-app** — they could only act if they already know that peer's password; there is no reset tooling.
- **B4. The only recovery is infrastructure-level:** a direct DB write to `password_hash` (e.g., re-running `scripts/provision-admin.js` via `railway run` against the prod service) — which requires **Railway + Neon access**.
- **B5. Production does not become *unavailable* if admin is lost** — buyers/sellers keep using the app — but **all administrator operations** (governance, publishing, closing, support actions, email test) would be blocked until an admin is restored via infra access.

#### Single points of failure
| SPOF | Description |
|---|---|
| **Infra access = sole recovery** | With no app-level reset, regaining admin depends entirely on whoever can run scripts against Railway/Neon. If that person is unavailable, there is no admin recovery path. |
| **One real operator admin** | `tylerwitt2015@gmail.com` is the only legitimate admin. (The seeded admins are a *de-facto* backup **only** because their credentials are known/known-to-repo — which is itself the A3 risk.) |
| **Root-of-trust** | `JWT_SECRET` + infra credentials are the real root of trust; their custody isn't documented here and may rest with one person. |

### C. Pilot operations ownership audit
Every admin-gated responsibility currently depends on the **single real operator** (bus factor = 1). No documented owners, backups, or on-call.

| Responsibility | Mechanism | Current owner | Backup? |
|---|---|---|---|
| Seller onboarding | `/admin/agreements`, agreement issue/sign | Single operator | **None** |
| Auction review (governance) | `/admin/moderation.html`, return-to-draft/reject | Single operator | **None** |
| Auction publishing | `POST /api/admin/auctions/:id/publish` | Single operator | **None** |
| Auction closing | scheduler + `POST .../close`, final report | Single operator | **None** |
| Seller support | admin tools | Single operator | **None** |
| Buyer support | admin tools | Single operator | **None** |
| Email monitoring | `POST /api/admin/email/test`, SES/worker logs, reply-to inbox `advantageauction.bid@gmail.com` | Single operator | **None** |
| Incident response | `docs/operations/production-incident-response-runbook.md` | Single operator | **None** |
| Production monitoring | `/api/health`, Railway logs, first-week checklist | Single operator | **None** |

**Every row depends on one person.** There is no second human who can cover any responsibility today.

---

## Risks
| ID | Risk | Severity | Notes |
|---|---|---|---|
| R1 | Repo-known credential is an **active production admin** (`validation-admin@advantage.bid`) | **High** | **✅ RESOLVED 2026-06-10** — disabled (`is_active=false`); repo-known credential no longer grants login. |
| R2 | Undocumented test admin (`test-admin@example.com`) active on prod | **Medium-High** | **✅ RESOLVED 2026-06-10** — disabled (`is_active=false`); retained for audit history. |
| R3 | **No account-recovery mechanism** (no reset of any kind) | **High** | Lost admin password ⇒ recovery only via infra DB write. |
| R4 | **Recovery depends on a single person's infra access** | **High** | If unavailable, no admin recovery; admin ops frozen. |
| R5 | **Bus factor = 1** across all 9 operational responsibilities | **High** | No coverage if the one operator is unavailable. |
| R6 | No `last_login` / admin login auditing | **Medium** | Misuse of seeded admins would be invisible. |
| R7 | Operator admin password custody undocumented | **Medium** | If `tylerwitt2015` password is lost and seeded admins are removed, recovery collapses to R3/R4. |

---

## Recommendations

### 1. Pilot launch administrator structure
- **At least two real, named operator admins** with strong, unique passwords (e.g., the primary operator + one trusted backup). Real human accounts only.
- **Production admins = named people only.** No test/seed/example accounts.

### 2. Emergency recovery administrator structure
- **Break-glass procedure (documented):** since there is no in-app reset, define a written runbook for infra-based recovery — reset/create an admin via `scripts/provision-admin.js` over `railway run` against `advantage-auction-platform` (prod-guarded, hidden-prompt). Store it alongside the incident runbook.
- **Remove the infra-access SPOF:** ensure **≥ 2 trusted people** can perform recovery (Railway + Neon access), **or** escrow those credentials + `JWT_SECRET` custody notes in a secured team vault. *(Human/ownership decision.)*
- **Optional dedicated break-glass admin:** a single, clearly-labeled emergency admin whose credentials live **only** in a password manager/vault (never in code), used only for recovery.
- **Record the operator password** (#3) in the team vault so its loss isn't catastrophic.

### 3. Seeded admin accounts — disposition
- `validation-admin@advantage.bid` → **REMOVE from production** (minimum: **DISABLE** `is_active=false` immediately). It is a repo-known credential (R1).
- `test-admin@example.com` → **REMOVE** (or disable). Undocumented test admin (R2).
- **Sequencing (important):** establish a real backup admin (Rec #1) **before** removing the seeded ones, so deletion doesn't create a recovery SPOF. Then disable → verify real admins work → remove. Every change should be audit-noted.

### 4. Operational ownership model during pilot
- Assign **named primary + backup** for each of the 9 responsibilities; no responsibility should rest on one person.
- Define **on-call + escalation** (who holds the pager; who is secondary) and record it in `docs/operations/`.
- Designate a monitored owner for the **reply-to inbox** (`advantageauction.bid@gmail.com`) with an SLA.
- Minimum viable: two humans share full coverage so bus factor ≥ 2.

---

## Pilot Readiness Assessment
Administrator **authorization** is sound (role-gated, no signup escalation). **Account hygiene is now remediated** (2026-06-10); **recovery and ownership remain to be addressed**:
- ✅ The repository-known production admin and the undocumented test admin (R1/R2) are **closed** — both seeded admins disabled; a real second operator admin (`admin@advantage.bid`) is in place.
- ⬜ There is still **no account-recovery mechanism** and recovery hinges on **one person's infrastructure access** (R3/R4).
- ⬜ **All operational duties still depend on a single operator** (R5).

These are operational/identity gaps, not application-code defects — addressable via account changes, documentation, and ownership assignment (no code required for the must-fix items).

---

## REQUIRED BEFORE PILOT
1. ✅ **DONE (2026-06-10) — Close R1:** `validation-admin@advantage.bid` disabled (`is_active=false`, retained not deleted).
2. ✅ **DONE (2026-06-10) — Close R2:** `test-admin@example.com` disabled (`is_active=false`, retained not deleted).
3. ✅ **DONE (2026-06-10) — Second real, named operator admin provisioned:** `admin@advantage.bid` (role admin, active; secure hidden-prompt provisioning, login verified). Active admins are now `admin@advantage.bid` (primary) + `tylerwitt2015@gmail.com` (personal/recovery).
4. ⬜ **Open — Document the break-glass recovery procedure** (infra-based admin reset via `provision-admin.js`).
5. ⬜ **Open — Confirm recovery is not single-person:** ≥ 2 trusted people (or a secured vault) hold Railway + Neon access and `JWT_SECRET` custody. *(Decision/ownership item.)*
6. ⬜ **Open — Record the operator admin passwords** (`admin@advantage.bid`, `tylerwitt2015@gmail.com`) in a secure team vault.

## RECOMMENDED BEFORE PILOT
1. Assign **named owner + backup** for each of the 9 operational responsibilities; publish on-call/escalation in `docs/operations/`.
2. Assign a monitored owner + SLA for the reply-to inbox.
3. Establish a dedicated, vault-stored **break-glass admin** account.
4. Add a brief admin-account register (who/why) to operations docs and review quarterly.

## CAN WAIT UNTIL AFTER PILOT
1. Build a real **self-service / email-based password reset** flow (net-new feature; removes the infra-only recovery dependency).
2. Add an **admin-initiated password reset + user-management UI** (create/disable admins, reset peers) to avoid DB-script provisioning.
3. Add **`last_login` tracking + admin login audit** (closes R6).
4. Expand to **least-privilege admin sub-roles** / formal RBAC beyond the single `admin` role.

---
*Documentation only. No code, schema, migration, deployment, or commit performed. Evidence: `src/routes/auth.js`, `src/routes/admin.js`, `src/middleware/roleMiddleware.js`, `src/middleware/authMiddleware.js`, `scripts/provision-admin.js`, `scripts/seed-validation-fixtures.js`; production `users` table (read-only roster query); `docs/operations/*`.*
