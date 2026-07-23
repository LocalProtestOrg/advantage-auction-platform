# Step 2 — Identity & Seamless Bridge: File-by-File Implementation Plan

**Status:** PLAN ONLY. Contingent on **CAP 2 = PASS** (BD custom-page server-side execution). **No
implementation, no production auth change, PR #83 untouched** until the capability probe succeeds.
**Date:** 2026-07-22

## Principles baked into this design
1. **The Advantage.Bid application is the identity authority.** Railway is hosting, not the IdP. Every
   choice below is standard Node/Express/**PostgreSQL** (Neon) — no Railway-specific lock-in; sessions
   and codes live in Postgres, secrets in env. Portable to any host.
2. **Default landing = the user's unified Advantage.Bid Dashboard** (buyers, sellers, business owners).
3. **Protected actions preserve their destination**; generic login/account/dashboard → the dashboard.
4. **The identity FOUNDATION (external-identity mapping, org ownership, linking, membership sync,
   sessions, dashboard) is built regardless** — it works with a normal Railway login even if the
   seamless BD handoff is deferred. The handoff is a thin layer on top.
5. **Automatic membership sync via the BD API at login** is preferred over permanent manual assignment.
6. **Canonical architecture preserved** — `bid.advantage.bid` = source of truth for auctions; BD =
   marketing/directory/content; the bridge only provides a seamless experience between them.
7. **Option B** (BD → authenticated POST → Railway mints a short-lived opaque one-time code) is the
   implementation, unless a demonstrably more secure approach appears. (None has; B keeps all crypto on
   the app side.)

---

## 1. Architecture overview

```
IDENTITY AUTHORITY = the Advantage.Bid application (Postgres-backed, host-independent)
   sessions (server-side, revocable, HTTP-only cookie)   ← new, replaces reliance on localStorage JWT
   users ── external_identities ──(provider=brilliant_directories, subject=BD user_id)
     │            │
     │            └── organization_external_links ──(claim/verify)── organizations ──(bd_listing_id=user_id)
     │
     └── organization_members (owner/admin/editor)     plan_tier ← subscription_plan_map ← BD subscription

LOGIN PATHS → both end at a Railway-issued session + the unified /dashboard (or an allowlisted action):
  (a) Native login  (email+password)                          [works today; gains a cookie session]
  (b) Seamless bridge (Option B)  [CAP 2 gated]:
        BD /launch (server-side) → POST /api/auth/bd/exchange (X-Bridge-Key) → opaque code
          → redirect → GET /auth/bd/return?code → consume once → link/create user → session → dest
```

## 2. Database schema — migration `db/migrations/094_identity_bridge_foundation.sql` (additive, idempotent)

- **`external_identities`** — the user↔provider map (the foundation, principle 4):
  `id UUID pk, user_id UUID→users, provider TEXT, provider_subject TEXT, provider_email TEXT,
   provider_status TEXT, provider_subscription_id TEXT, provider_subscription_name TEXT,
   linked_at TIMESTAMPTZ, last_verified_at TIMESTAMPTZ, metadata_json JSONB DEFAULT '{}',
   created_at, updated_at`. **UNIQUE(provider, provider_subject)**; index `(user_id)`. For BD:
  `provider='brilliant_directories'`, `provider_subject=BD user_id`.
- **`organization_external_links`** — company ownership mapping (never overload the user row):
  `id, organization_id UUID→organizations, provider TEXT, provider_listing_id TEXT,
   provider_member_id TEXT, relationship_type TEXT, status TEXT CHECK IN
   ('admin_created','unclaimed','claim_pending','member_verified','admin_verified','suspended','revoked'),
   verified_at, verified_by UUID→users, metadata_json JSONB, created_at, updated_at`.
  UNIQUE(provider, provider_listing_id); index `(organization_id)`, `(provider, provider_member_id)`.
- **`bd_login_codes`** — the production one-time code store (hashed; the PoC's in-memory map made durable):
  `id, code_hash TEXT UNIQUE, bd_user_id TEXT, dest TEXT, nonce TEXT, issued_at, expires_at,
   used_at, consumed_ip INET, created_at`. Only the **hash** of the code is stored; row is single-use.
- **`sessions`** — server-side, revocable sessions (principle 1; host-independent):
  `id, user_id UUID→users, token_hash TEXT UNIQUE, created_at, expires_at, last_seen_at,
   rotated_from UUID, ip INET, user_agent TEXT, revoked_at, revoke_reason TEXT`. Index `(user_id)`,
  `(expires_at)`.
- **`subscription_plan_map`** — data-driven BD level → tier (admin-editable, no code deploy to change):
  `provider TEXT, provider_subscription_id TEXT, provider_subscription_name TEXT, plan_tier TEXT→
   organization_plans, is_active BOOLEAN, notes TEXT, PRIMARY KEY(provider, provider_subscription_id)`.
- **`users`** touch (additive): `auth_source TEXT DEFAULT 'native'` (native|bd_bridge), `last_membership_sync_at TIMESTAMPTZ`. (`password_hash` is already nullable → passwordless-until-set BD users are fine.)

*No changes to auctions/bids/payments/events/organizations core. All additive + idempotent.*

## 3. Environment / config

- **New:** `BD_BRIDGE_SECRET` (shared BD↔Railway bearer for `/exchange`; server-only both sides),
  `SESSION_COOKIE_NAME` (default `adv_session`), `SESSION_TTL_HOURS` (absolute, e.g. 24),
  `SESSION_IDLE_HOURS` (e.g. 12), `BRIDGE_CODE_TTL_SECONDS` (e.g. 120), `SESSION_COOKIE_DOMAIN`
  (**`bid.advantage.bid` only — never broadened to `.advantage.bid`**).
- **Reuse:** `BD_API_KEY`, `JWT_SECRET` (bearer kept for API back-compat), `PUBLIC_APP_URL`,
  `FRONTEND_URL`/`ALLOWED_ORIGINS`.
- Secrets never rendered to any page/JS/URL/log (enforced by design + a log-redaction check in tests).

## 4. File-by-file changes

### Migrations
- `db/migrations/094_identity_bridge_foundation.sql` — §2. (Optional companion `scripts/prod-migrate-094.js` for the gated deploy, not run now.)

### Services (all new unless noted)
- `src/services/sessionService.js` — `createSession(userId, {ip,ua})` (random 256-bit token, store
  hash, set cookie), `rotateSession(oldToken)` (mint new, revoke old — prevents fixation),
  `resolveSession(token)` (valid + unexpired + not revoked; slide idle TTL), `revokeSession(token, reason)`,
  `revokeAllForUser(userId)`. Cookie: HTTP-only, Secure, SameSite=Lax, domain-scoped.
- `src/services/externalIdentityService.js` — `findBySubject(provider, subject)`,
  `getForUser(userId)`, `linkOrCreate({provider, subject, email, status, subscription})` returning
  `{user, created, needsEmailConfirm}`, `beginEmailLinkChallenge(existingUserId, provider, subject)`
  (reuses `emailVerificationService` primitive — no new email infra), `confirmEmailLink(token)`.
- `src/services/bdMemberService.js` — `fetchMember(userId)`: single-member read via the BD API if the
  endpoint supports a by-id filter; **fallback** to the most recent daily-sync record (from the imported
  org's `bd_metadata`) if not — no new service either way. `mapSubscriptionToTier(member)` via
  `subscription_plan_map`. `isEligible(member)` (active/not-suspended/not-expired).
- `src/services/subscriptionSyncService.js` — `applyMembershipFromBD(userId)`: fetch member → map tier
  → if changed call the existing `organizationsService.setPlanTier` (auto-reconciles capabilities) →
  stamp `last_membership_sync_at` → audit. Idempotent. **Preserves** auction/invoice/settlement/audit
  records on downgrade; only restricts future management. Called at every login + by webhook + daily.
- `src/services/bdBridgeService.js` — `mintLoginCode({bdUserId, dest})` (validate numeric id +
  allowlisted dest → random code, store hash in `bd_login_codes`, TTL) → returns `{code, redirectUrl}`;
  `consumeLoginCode(code, ip)` (hash-lookup, single-use, unexpired → returns `{bdUserId, dest}` or a
  typed rejection: unknown|used|expired); `resolveIdentityAndProvision(bdUserId)` — the linking rules
  (§5.3).
- `src/lib/destinations.js` — the **allowlist** map (route KEY → path) + `resolveDestination(key)`:
  `dashboard→/dashboard`, `create-event→/org/event-new.html`, `manage-events→/org/events.html`,
  `create-auction→/seller-create.html`, `manage-auctions→/seller/dashboard`. Unknown/absent → `/dashboard`.
  Rejects absolute/protocol-relative/encoded URLs (never a browser-supplied URL).

### Middleware (modify — backward compatible)
- `src/middleware/authMiddleware.js` — **dual-mode**: accept the existing `Authorization: Bearer <JWT>`
  (unchanged, for API/programmatic clients) **OR** the new session cookie (`resolveSession`). Sets
  `req.user`. No existing caller breaks; the web app gains cookie auth.

### Routes
- `src/routes/authBridge.js` (new) — mounted in `server.js`:
  - `POST /api/auth/bd/exchange` — **server-to-server only**; requires `X-Bridge-Key` (constant-time
    compare); body `{bd_user_id, dest}`; rate-limited; → `bdBridgeService.mintLoginCode`; returns
    `{redirect_url}`. Never trusts anything from a browser.
  - `GET /auth/bd/return` — browser lands with **only** the opaque code; `consumeLoginCode` →
    `resolveIdentityAndProvision` → `applyMembershipFromBD` → `sessionService.createSession` (sets
    cookie) → 302 to `resolveDestination(dest)`. CSRF-safe (no state mutation from a forgeable form; the
    code is the single-use capability). Rejections render a safe error, never leak why beyond a generic code.
- `src/routes/auth.js` (modify) — on native **login/register success**, ALSO create a cookie session
  (rotate on login) alongside the existing JWT; accept an allowlisted `to` and return the resolved
  destination (default `/dashboard`); add `POST /api/auth/logout` → `revokeSession` + clear cookie
  (finally a real logout). Native login now also calls `applyMembershipFromBD` when the user has a BD link.
- `src/routes/dashboard.js` (new) — `GET /api/me/dashboard` returns a role-shaped summary (buyer:
  watchlist/invoices; seller: auctions/events; org owner: org + membership tier + pending claims). Feeds
  the unified dashboard page.
- `src/routes/webhooksBd.js` (new; **post-launch**) — `POST /api/webhooks/bd` receives BD member events.
  Treated as **unsigned notifications**: verify whatever BD provides, dedupe by event id (idempotent),
  then **re-fetch the member via the API** before any change; enqueue `applyMembershipFromBD`. Never
  authorizes from the payload alone.
- `src/routes/adminExternalLinks.js` (new) OR extend `adminPartners.js` — admin review of
  `claim_pending` org links: list, `member_verified`/`admin_verified`, `suspend`/`revoke`. Admin-only.

### Frontend
- `public/dashboard.html` (new) — the **unified landing page**: shared chrome (buyer-nav), reads
  `GET /api/me/dashboard`, renders role-appropriate tiles + quick links to Event Creator, Event
  Management, Auction Creation, Seller Auction Dashboard. This is where generic login lands (principle 2).
- Login page (`public/login.html`) — after auth, honor the allowlisted `to`/`next` (destination
  preservation, principle 3); default `/dashboard`. Store nothing sensitive; the session is the cookie.
- `public/org/*` and seller entry points — protected links pass a route KEY (`?to=create-event`), never a URL.

### BD side (Developer Hub — you paste; productionized from the PoC)
- **`/launch` custom page** (server-side, logged-in-gated): reads member id from BD's authenticated
  context, validates an allowlisted `to`, POSTs to `/api/auth/bd/exchange` with `X-Bridge-Key` (secret
  in BD server-side config, never in page HTML), redirects to the returned `redirect_url`. Page marked
  **no-cache / per-member**. Anonymous → BD login with return preserved.
- BD protected buttons (Create Event, Manage Events, Create Auction, Manage Auctions) → `/launch?to=<key>`.

## 5. Key flows

- **5.1 Native login:** email+password → verify (bcrypt) → rotate/create cookie session → if BD-linked,
  `applyMembershipFromBD` → redirect to allowlisted `to` or `/dashboard`.
- **5.2 Seamless bridge (Option B):** BD `/launch` → `/exchange` (server-to-server) → opaque code →
  `/auth/bd/return` → consume once → provision (5.3) → membership sync → session → destination.
- **5.3 Account provisioning / secure linking** (from a **trusted** BD `user_id`, obtained server-side):
  1. `external_identities` hit → log into the linked user.
  2. Else fetch BD member; if a local user shares that email → **do NOT silent-merge**; send an
     email-verification **link challenge** (reuse the 082 primitive); link only on confirm.
  3. Else create a minimal `buyer` (email from BD, `password_hash` null = passwordless until set,
     `auth_source='bd_bridge'`), create the `external_identity`.
  4. **Organization ownership — NO automatic and NO one-click claim (CORRECTED 2026-07-22):** a
     securely authenticated BD member proves **only the member's identity**, NOT ownership of any
     business listing. Most BD business listings were **admin-created** and are not yet actively
     managed by the business, so a `bd_user_id` that appears to match a field currently called
     `bd_listing_id` is **not** proof of ownership. **Before any ownership logic is built, verify the
     actual semantics of every BD identifier** (is `bd_listing_id` the listing's owning-member id, or
     merely the listing's own id? confirm with BD). On bridge login the member is authenticated and
     linked to their **identity** only; any organization they appear associated with stays
     **`unclaimed` / `claim_pending`** until the relationship is verified through **reliable BD data
     (confirmed ownership semantics) or administrator approval**. **Never** grant another
     organization's management access from a browser-supplied id, and **never** auto-grant the
     **seller** (auction) role or **admin** — those remain behind their existing separate gates.
- **5.4 Membership sync:** at every login/handoff (primary, trusted), by webhook notification
  (post-launch), and by the existing daily reconcile (backstop). `subscription_id → plan_tier` via the
  data-driven map → `setPlanTier`.
- **5.5 Dashboard routing:** generic login/account/dashboard → `/dashboard`; a protected action's route
  KEY → its specific page; navigation within the dashboard is shaped by role/permissions.

## 6. Session architecture (the upgrade)
Server-side, revocable sessions in Postgres (host-independent). Opaque 256-bit token in an **HTTP-only,
Secure, SameSite=Lax** cookie scoped to `bid.advantage.bid` (never broadened). **Rotate on login**
(new row, revoke old) → prevents fixation. Absolute + idle TTL with sliding refresh. Real **logout**
revokes server-side. The existing **bearer JWT stays accepted** for API/programmatic clients
(back-compat) — this is additive, not a rip-and-replace. Cross-origin stays bearer-only for the public
widgets (no cookies there), so nothing about the BD embed model changes.

## 7. Audit logging (reuse `auditService.logEvent`)
`identity.bridge_code_minted`, `identity.bridge_code_consumed`, `identity.linked`, `identity.created`,
`identity.link_challenge_sent`, `identity.link_confirmed`, `org.ownership_claimed`,
`org.ownership_admin_verified`, `org.ownership_suspended`, `membership.synced` (from→to tier),
`session.created`, `session.rotated`, `session.revoked`, `bridge.rejected` (reason:
bad_key|expired|replay|bad_dest|anonymous|ineligible_member). Store ids + reasons only — **no secrets,
no code values, no tokens**.

## 8. Security testing (`tests/auth-bridge/*.test.js`)
Valid handoff · expired code · replayed code (single-use) · forged/guessed code · missing/invalid
`X-Bridge-Key` · non-allowlisted `dest` (open-redirect blocked) · anonymous → BD login · disabled/
suspended/expired BD member → rejected · existing linked account → logs in · existing local same-email,
no link → **challenge required, never silent-merge** · cross-company/tenant access blocked server-side ·
duplicate webhook (idempotent) · out-of-order webhook · BD API unavailable → graceful, no lockout ·
session rotation on login · logout revokes · admin BD account **not** auto-granted platform admin ·
seller role **not** auto-granted · secret/token **absent from logs** (redaction) · rate-limit on
`/exchange` and `/auth/bd/return`. (Mirrors your Step-4 list; source-level + Neon-branch integration.)

## 9. Human acceptance testing (script)
1. Deploy to a Neon branch + non-prod app; configure `/launch` in Developer Hub. 2. Logged out → `/launch`
→ BD login → returns. 3. Logged-in test member → `/launch?to=create-event` → lands on **Event Creator**,
signed in. 4. Generic login → lands on **the dashboard**, not the event creator. 5. Correct local
account created/linked; refresh keeps the session; **logout** works and the session is dead. 6. Editing
the `code`/`to` in the URL changes nothing (single-use, allowlisted). 7. Cannot access another company.
8. BD subscription tier auto-applied (Gold/Silver/Individual/Appraiser) — verify capabilities. 9.
Same-email different-person → verification required, no merge. 10. Cancelled/suspended BD member →
future management restricted, records preserved. 11. Ordinary marketplace browsing still works. 12.
Existing Railway admin/native logins still work (bearer + cookie).

## 10. Deployment sequence
1. Neon branch; apply `094` there. 2. Deploy the **foundation** (tables, services, dual-mode auth,
   dashboard, membership-sync-at-login) to non-prod **behind a feature flag** (`IDENTITY_BRIDGE_ENABLED`);
   run §8 tests + §9 HAT. 3. (CAP 2 confirmed) deploy the **bridge endpoints**; configure the BD
   `/launch` page against non-prod; re-run bridge tests + HAT. 4. **Prod approval gate** — present final
   architecture, migration, env vars, BD changes, test results, rollback, exact deploy steps. 5. On
   approval: apply `094` to prod (backup first), deploy behind the flag OFF, smoke-test, flip ON, then
   the owner publishes the BD `/launch` links. Keep read-only widgets independent throughout.

## 11. Rollback
Everything is **additive + flag-gated**. Rollback = flip `IDENTITY_BRIDGE_ENABLED` off (bridge +
cookie-session paths disabled; native bearer-JWT login continues unchanged) and, if needed, revert the
commits + redeploy. Migration `094` is additive and safe to leave; tables can be truncated. The BD
`/launch` page is removed by the owner. No destructive data changes at any point; no existing auction/
payment/event data touched.

---

## A. What must be completed **before launch**

**Minimum (hard requirement): nothing** — Marketplace Events (PR #83) launches without any of this;
admins assign the handful of real tiers manually. But **recommended before launch** (the "correct from
the beginning" identity foundation, principle 4, all low-risk + additive):
- Migration `094` (external_identities, organization_external_links, sessions, subscription_plan_map).
- `externalIdentityService`, `bdMemberService`, `subscriptionSyncService` (auto-tier at login).
- `sessionService` + dual-mode `authMiddleware` + real **logout**.
- The **unified `/dashboard`** + allowlisted destination routing (principles 2–3).
- Audit events + the foundation security tests.
- **If (and only if) CAP 2 = PASS:** the seamless bridge (`authBridge` routes, `bdBridgeService`,
  `bd_login_codes`, the BD `/launch` page). This is the "seamless before launch if feasible" piece.

## B. Recommended **after launch**
- Webhook-driven **real-time** membership sync (`webhooksBd`) once BD's event catalog + verification are
  confirmed (replaces reliance on login-time + daily sync).
- Full migration of the web app **off localStorage-JWT** to cookie sessions everywhere (retire bearer
  for browser use; keep it for API).
- **Team / sub-account** support (multiple members per company) once BD confirms the model.
- Passwordless "set a password later" + account-recovery polish; richer dashboard tiles; admin tooling
  for the external-link queue; secret rotation runbook.

---

## Confidence level

**93%** that the seamless bridge can be implemented **entirely** with the existing BD Developer Hub +
Railway + Neon + current infrastructure **if CAP 2 passes**, **without any new recurring software or
authentication platform.**

- The ~7% residual is **not** about needing a paid service — it's BD-side operational unknowns, each with
  an in-house workaround: (a) whether the BD API can fetch a **single** member by id at login (else we
  use the daily-sync cache — no new service); (b) BD **egress/timeout** limits on the outbound POST
  (mitigable with retries/timeouts); (c) BD custom-page **caching** quirks (handled by no-cache + the
  fail-safe single-use code); (d) BD **webhook** signing/catalog gaps (handled by re-fetch, post-launch).
- Because every one of those has a no-new-service fallback, my confidence in the narrower claim — **"no
  new recurring software / auth platform required"** — is **~97%**. The only thing that could raise a
  cost is if BD says custom-page PHP requires their **paid custom-development service**; that would be a
  **one-time** BD engagement, not a recurring auth bill, and the free redirect-to-Railway-login remains
  a fully-secure fallback.

*Plan only — nothing implemented, production authentication unchanged, PR #83 untouched. Execution
begins only after CAP 2 = PASS and your approval, in a Neon-branch / non-production environment, and
stops again at the production approval gate.*
