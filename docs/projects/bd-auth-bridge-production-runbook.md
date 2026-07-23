# BD → Advantage.Bid Identity Bridge — Production Rollout Runbook

Branch `feat/bd-auth-bridge`. Flag-gated (`IDENTITY_BRIDGE_ENABLED`, default off). Production auth is
untouched until the flag is enabled on the prod service. Owner-authorized; controlled rollout.

## Verified proofs (pre-production)
- **Isolated non-prod E2E (member 367):** BD authenticated member → server-side exchange → one-time
  code → return → provision → authenticated `/dashboard.html`, no second login. Confirmed on the
  `identity-bridge-test` Neon branch: exactly 1 `bd_bridge` buyer, 1 `external_identities` link
  (`provider=brilliant_directories`, `provider_subject=367`), 0 duplicates, 0 elevated roles, code used.
- **Jest (`tests/`):** 650 passed, 0 failed. Bridge suite 24, recipient-resolver suite included.
- **Live DB behavior proof (test branch), 18/18:** create (namespaced email + real contact_email +
  names), recipient resolves to real email (never placeholder), repeat-visit reuse + contact refresh,
  no duplicates, colliding-email → separate user with existing account untouched (no merge), native
  users resolve to `users.email`, atomic rollback (failed provision doesn't burn the code), replay rejected.

## What deploys (additive vs main)
Migration 094 (external_identities, bd_login_codes, users.auth_source) + 095 (users.contact_email,
external_identities.provider_first/last_name, bd_login_codes.provider_email/first/last). New bridge
source + `recipientService` + tests + docs. `server.js` flag-gated mount (7 lines). Solution B routes
all buyer transactional email through `COALESCE(NULLIF(contact_email,''), email)`; native accounts
(contact_email NULL) are unchanged.

## Ordering constraint (critical)
The Solution B code references `users.contact_email`. **Migrations 094+095 MUST be applied to prod
BEFORE the code is deployed**, or buyer notifications/invoices error. Deploy order below honors this.

## Deployment order (Phase 8)
1. **Backup**: create a Neon backup branch of production (restore point).
2. **Migrations**: run the app migration runner against prod `DATABASE_URL` → applies exactly 094+095
   (090–092 already applied; no 093 on this branch), recorded in `schema_migrations`.
3. **Deploy code**: merge `feat/bd-auth-bridge` → `main`; Railway prod auto-deploys with the flag OFF
   (bridge routes NOT mounted — inert). Smoke-test that existing login + a buyer notification path work.
4. **Env vars** (prod Railway service — OWNER): `IDENTITY_BRIDGE_ENABLED=true`,
   `PUBLIC_APP_URL=https://bid.advantage.bid` (no trailing slash), `BD_BRIDGE_SECRET=<new prod secret>`.
   Confirm the service uses the production Neon DB (not identity-bridge-test).
5. **Endpoint test (no CTA)**: verify `/api/auth/bd/exchange` rejects a bad secret (401) and
   `/auth/bd/return?code=bad` returns the 400 error page — bridge live, still no public entry point.
6. **BD widget/page** (OWNER): production widget `scripts/bd/bd-bridge-widget-production.php` (paste
   prod secret; confirm `[me=...]` shortcodes resolve) on a member-only page, e.g. `/enter-auctions`.
7. **Private smoke test** (OWNER): enter as your BD member → land authenticated on
   `https://bid.advantage.bid/dashboard.html`, no second login.
8. **Confirm records** (server-side): exactly 1 buyer + 1 link for that subject, role buyer, real
   contact_email, 0 duplicates.
9. **Enable CTA** (OWNER): wire the intended member entry point(s) to the page.
10. **Final acceptance tests** (Phase 9 A–L).

## Environment variables (names only)
`IDENTITY_BRIDGE_ENABLED`, `PUBLIC_APP_URL`, `BD_BRIDGE_SECRET` (+ existing `JWT_SECRET`, `DATABASE_URL`,
`JWT_EXPIRES_IN`). A NEW production secret — never the test secret.

## Rollback (any stage)
- Set `IDENTITY_BRIDGE_ENABLED=false` (bridge routes disappear; native login unaffected).
- Remove the BD production widget/page from navigation; restore the prior CTA.
- Roll back the Railway deployment to the previous image.
- Migrations 094+095 are additive and safe to leave; the Neon backup branch is the DB restore point.
- Existing direct login remains functional and is NOT removed.

## Post-launch follow-ups
- Required-before-broad-use: explicit, re-authenticated linking workflow for a person who already
  owns an Advantage.Bid account (never automatic by email).
- Safe improvements: BD-API cross-verification of identity fields; `BD_BRIDGE_SECRET` rotation plan;
  cookie/session hardening (separate project); expiring-code cleanup job.
