# BD Identity Bridge — Non-Production Deploy & Live-Test Runbook (Option 2)

**Branch:** `feat/bd-auth-bridge` (off `main`). **Flag-gated** (`IDENTITY_BRIDGE_ENABLED`, default off) —
production auth is untouched until you deploy this to a **non-production** environment and turn the
flag on. **Do not run any of this against production.** The deploy + browser click-through are yours
(I have no Railway/BD/browser access); I built + tested the code and wrote these steps.

## What was built (files changed on this branch)
- `db/migrations/094_bd_identity_bridge.sql` — `external_identities`, `bd_login_codes` (hashed,
  single-use), `users.auth_source`. Additive; depends only on `users`.
- `src/lib/bridgeConfig.js` — the `IDENTITY_BRIDGE_ENABLED` flag + config.
- `src/services/bridgeCodeService.js` — mint/redeem opaque codes (256-bit, hashed, 120s, atomic
  single-use) + validation + constant-time `safeEqual` + destination allowlist.
- `src/services/bridgeIdentityService.js` — identity-only link-or-create (existing link → reuse; else
  minimal **buyer**; never merges on email; never grants seller/org-owner/admin).
- `src/services/bridgeHandlers.js` — pure `handleExchange` / `handleReturn` / `buildSeed` (the
  transparent no-store, nonce-CSP seed page; JWT only inside the inline script).
- `src/routes/authBridge.js` — `POST /api/auth/bd/exchange` (X-Bridge-Key) + `GET /auth/bd/return`;
  reuses the **exact login JWT** (`jwt.sign({id,role}, JWT_SECRET, …)`).
- `server.js` — mounts the bridge **only** when the flag is `true`.
- `tests/bridge/bd-auth-bridge.test.js` — 15 security tests (all pass).
- BD widget: `scripts/poc/bd-launch-widget.php` (reuse; point it at the non-prod host + temp secret).

## Prerequisites (temporary, non-production only)
- A **non-production** Railway service (separate from prod) — a preview/staging service.
- A **Neon branch** DB (isolated from prod) for that service.
- A **temporary** `BD_BRIDGE_SECRET` (generate 32+ random chars) — never a production secret.

## Step 1 — Isolated DB (Neon branch) + migrations
1. Create a Neon branch off your dev/staging (NOT prod).
2. Apply migrations through **094** on that branch (`094_bd_identity_bridge.sql` is additive/idempotent).

## Step 2 — Deploy this branch to the non-production service
1. Point the non-prod Railway service at branch **`feat/bd-auth-bridge`** (push it when you're ready —
   tell me and I'll push).
2. Set these env vars on the **non-prod** service only:
   - `DATABASE_URL` = the Neon branch from Step 1
   - `JWT_SECRET` = a **non-production** secret (any strong value; it just signs the test session)
   - `IDENTITY_BRIDGE_ENABLED` = `true`
   - `BD_BRIDGE_SECRET` = your temporary 32+ char secret
   - `PUBLIC_APP_URL` = the non-prod app's URL (e.g. `https://bd-auth-nonprod.up.railway.app`)
3. Deploy. Confirm the log line `[identity-bridge] ENABLED (non-production feature flag on)` and that
   `GET <app>/dashboard.html` loads (unauthenticated it will bounce to login — that's expected).

## Step 3 — Temporary BD widget + page
1. In BD Widget Manager, create a **new temp widget** `CAP2_BRIDGE_POC_TEMP` (HTML tab) with the code
   from `scripts/poc/bd-launch-widget.php`, setting:
   - `$poc_host` = your `PUBLIC_APP_URL` from Step 2 (no trailing slash)
   - `$poc_secret` = the same `BD_BRIDGE_SECRET`
2. Render it via a **new** "Custom Widget as Web Page" page, e.g. slug `enter-auctions-temp`, access
   **Only Allow Members**. (Do not modify any existing widget/page.)

## Step 4 — Live test as normal BD member 367
1. Log into **BD** as member **367** (a normal member).
2. Open `https://advantage.bid/enter-auctions-temp`.
3. Expected: BD server-to-server exchange → browser gets only the opaque code at
   `<app>/auth/bd/return?code=…` → transparent seed → **lands authenticated on `/dashboard.html`**,
   no second login, no visible code/JWT, no Continue button, no success page.
4. Verify: refresh stays logged in; normal dashboard navigation works; the account is a **buyer** with
   no seller/admin access; logout (existing control) clears the session.

## Step 5 — Cleanup (fully reversible)
- Delete the temp BD page `enter-auctions-temp` and the temp widget `CAP2_BRIDGE_POC_TEMP`.
- Set `IDENTITY_BRIDGE_ENABLED=false` (or tear down the non-prod service).
- The Neon test branch can be deleted. No production object was touched.

---

## Report template — fill these in from your run (I will NOT fabricate them)
- Exact URL/page member 367 landed on: __________ (expected `/dashboard.html`)
- Second login screen shown? ☐ No ☐ Yes
- Standard Advantage.Bid session created (localStorage `token` present; `/api/auth/me` returns 367's account)? ☐ Yes ☐ No
- Refresh + normal dashboard navigation stayed authenticated? ☐ Yes ☐ No
- Logout ended the session normally? ☐ Yes ☐ No
- Any console/network errors? __________

## Test totals (from me)
- Bridge security suite: **15 passed / 0 failed**. Full branch suite: **641 passed / 0 failed**.

---

## Exact production rollout plan (SEPARATE, owner-approved gate — do NOT do this yet)
1. **Pre-prod hardening (required before prod):**
   - Replace the non-prod placeholder email in `bridgeIdentityService` with the **verified BD email
     fetched via the BD API**, and require the approved **email-verification confirmation** before
     linking to any existing same-email account (never silent-merge).
   - Confirm every allowlisted destination path exists in prod.
   - Security review of the diff (done: adversarial + tests) + a rotation plan for `BD_BRIDGE_SECRET`.
2. **Backup** prod DB (Neon branch), then **apply migration 094** to prod (additive).
3. **Deploy** the reviewed bridge to prod with `IDENTITY_BRIDGE_ENABLED=false` first; smoke-test that
   nothing changed; set a **production** `BD_BRIDGE_SECRET`.
4. Configure the **real** BD launch widget (production host + secret) on the member-facing button.
5. Flip `IDENTITY_BRIDGE_ENABLED=true`, run the live smoke test, monitor logs/audit.
6. **Rollback:** set `IDENTITY_BRIDGE_ENABLED=false` (bridge disappears; native login unaffected);
   migration 094 is additive and safe to leave. Remove the BD widget.
7. Later, separately: the **HTTP-only cookie-session migration** (post-launch auth hardening) — a
   distinct project, not part of this task.

*Non-production only. No production authentication was changed; the bridge is inert unless the flag is
explicitly enabled on a non-prod service.*
