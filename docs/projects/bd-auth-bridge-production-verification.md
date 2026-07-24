# BD → Advantage.Bid Identity Bridge — PRODUCTION VERIFICATION RECORD

**Permanent record. Do not delete.** The bridge is live-verified in production. This documents the
verified milestone so future work (e.g. the Unified Member Experience) does not break it.

## Status: PRODUCTION-VERIFIED ✅ (2026-07-24)

A logged-in Brilliant Directories member reaches the Advantage Auction Platform authenticated, with
no second login, keyed solely on their BD member ID.

## Verified production flow
1. Logged-in BD member opens `https://www.advantage.bid/enter-auctions`.
2. BD renders a **protected Single Web Page** (access: **Only Allow Members**) whose content is the
   shortcode **`[widget=ADVANTAGE_BRIDGE]`**.
3. The widget runs server-side in BD: reads `[me=user_id]` / `[me=email]` / `[me=first_name]` /
   `[me=last_name]`, POSTs them to `https://bid.advantage.bid/api/auth/bd/exchange` with the shared
   secret in the `X-Bridge-Key` header (server-to-server; browser never sees it).
4. The app mints a single-use, hashed, 120s opaque code and returns only a `redirect_url`.
5. Browser navigates to `https://bid.advantage.bid/auth/bd/return?code=…`; the app redeems the code
   and provisions identity **atomically** (one transaction, rollback-safe).
6. A transparent no-store seed page stores the standard login JWT in localStorage and
   `location.replace('/dashboard.html')`. Member lands authenticated; `?code=` never remains in the URL.

## Key facts
- **Deployed commit (prod / `main`):** `a7975dc`. Bridge branch `feat/bd-auth-bridge`.
- **Migrations applied to prod (surgical, recorded in `schema_migrations`):** `094_bd_identity_bridge.sql`,
  `095_bd_bridge_contact_identity.sql`.
- **Feature flag:** `IDENTITY_BRIDGE_ENABLED` (default off; enabled on prod for the verified test).
- **Production BD widget file:** `scripts/bd/bd-bridge-widget-production.php` (widget name `ADVANTAGE_BRIDGE`).
- **BD page:** Single Web Page, slug `/enter-auctions`, access Only Allow Members, content
  `[widget=ADVANTAGE_BRIDGE]`. (A "Custom Widget as Web Page" also works but the protected Single Web
  Page is the chosen production architecture.)
- **Env vars (names only):** `IDENTITY_BRIDGE_ENABLED`, `PUBLIC_APP_URL=https://bid.advantage.bid`,
  `BD_BRIDGE_SECRET` (production-only, never the test value — **never store the real secret in any file**).
- **Test member:** BD member id **367** (`support@1800lastbid.com`).
- **Neon prod restore point:** branch `prod-pre-bd-bridge-2026-07-23` (`br-ancient-flower-antz8vw4`).

## Server-side verification — 11/11 (read-only, prod)
1 bridge user; 1 external identity (`provider=brilliant_directories`, `provider_subject=367`); role
**buyer** only; `users.email = bd-367@bridge.invalid` (placeholder); `users.contact_email =
support@1800lastbid.com` (real); recipient resolution → `contact_email` (never the placeholder); no
email-based linking; no native account modified; no duplicate users/identities; single-use code
(1 minted, 1 used, 0 reusable/unexpired remaining).

## Identity & trust model (do NOT change without approval)
- BD member ID (`provider_subject`) is the **sole** automatic identity key. **Never** merge/associate/
  authenticate by email.
- Bridge accounts: `users.email` = namespaced placeholder; real inbox in `users.contact_email`; names
  on `external_identities`. Repeat visits reuse the same user and refresh contact info only.
- All buyer transactional email resolves through `recipientService` (`COALESCE(NULLIF(contact_email,''),
  email)`) — the placeholder is never an outbound recipient.
- The secret, member payloads, JWTs, and one-time codes are never exposed to the browser.

## Logout behavior (accepted, not a defect)
Logging out of the auction platform ends only the auction-platform (localStorage JWT) session; the BD
session persists. Re-visiting `/enter-auctions` re-authenticates via BD. A future "Log Out Everywhere"
option requires a supported BD method + security review before implementation.

## Rollback
Set `IDENTITY_BRIDGE_ENABLED=false` → bridge routes unmount (404); native login unaffected. Migrations
094/095 are additive and safe to leave.

## Related docs
`docs/projects/bd-auth-bridge-production-runbook.md`, `docs/projects/prod-migration-bookkeeping-drift-followup.md`,
`docs/projects/bd-identity-bridge-options-memo.md`.
