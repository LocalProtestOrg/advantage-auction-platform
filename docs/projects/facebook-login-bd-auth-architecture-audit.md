# Facebook Login / Brilliant Directories Authentication Architecture Audit

**Date:** 2026-09-10 · **Type:** inspection only — no production, Meta, or BD changes were made.
**Decision:** do not enable Facebook Login in Brilliant Directories. If social sign-in is wanted, implement it in Railway as an additional authentication method on the one canonical Advantage.Bid account.

## 1. Authoritative identity system (verified in canonical repo + production)

| Fact | Evidence |
|---|---|
| Canonical identity = Railway `users` (id, email UNIQUE, password_hash NULLABLE, role buyer/seller/admin, staff_role, auth_source native/bd_bridge, contact_email, is_active) | migrations 001, 046, 060, 068, 094, 095, 113; prod columns listed 2026-09-10 |
| Buyer registration = `POST /api/auth/register` (email + password only), user logged in immediately | `src/routes/auth.js:17` |
| Seller = promotion of the same user via `POST /api/sellers/enroll` (seller_profiles + role) — one account, both experiences | `src/routes/sellers.js:79` |
| Session = JWT `{id, role}` (24h, sliding) delivered as Bearer **and** `aap_session` cookie (httpOnly, secure, SameSite=Lax, host-only) | `src/lib/sessionCookie.js`, `src/middleware/authMiddleware.js` |
| Private HTML gated server-side by cookie | `src/middleware/htmlAuthGate.js` |
| Password reset = hashed single-use tokens; email verification optional | `passwordResetService.js`, `emailVerificationService.js` |
| **No OAuth / social login exists anywhere** (no passport, no Google, no Facebook markup on login.html) | repo-wide grep 2026-09-10 |
| Provider-link table already exists: `external_identities(provider, provider_subject, provider_email, …)` UNIQUE(provider, subject) — used today only by provider `brilliant_directories` | migration 094 |
| BD → Railway bridge LIVE (`IDENTITY_BRIDGE_ENABLED=true`): BD member id is the only automatic key; never merges by email; provisions a buyer `bd-<id>@bridge.invalid` | `src/routes/authBridge.js`, `bridgeIdentityService.js` |
| BD public `/login` is retired: header script redirects `/login` → `bid.advantage.bid/login.html`, `/login?action=loggedout` → Railway `/logout`, header swaps Login→My Account from `/api/auth/session-status` | live page fetch of www.advantage.bid/login |
| Production tallies | 93 users: 7 admin, 61 native buyers, 5 bridge buyers, 20 sellers; 5 external_identities (all BD) |
| BD member records | 347, all "Active"; 294 on plan 7 / 33 on plan 6 (directory listings provisioned by sync), 7 "General User Account"; 2 with a facebook field populated (profile URL, not login) |
| BD membership relied on by production functionality? | **No.** Railway reads BD only outbound (read-only `X-Api-Key` directory sync). Inbound = optional bridge. |

## 2. What BD Facebook Login actually does (BD documentation)

- It is BD's **One-Click Social Login add-on** ($10/month or included in some plans). "Account is created on the fly" — a **BD member account**, on the membership plan where the admin set "Enable Facebook Login = Yes". Captures first name, last name, email.
- Login later works only for members who signed up with Facebook or "synced" their BD profile with Facebook in the BD member dashboard; unsync available.
- BD requires: App ID, **App Secret** (BD says it is needed for the data-deletion callback `https://www.advantage.bid/unsync-fb`), App Domains containing www.advantage.bid, JS-SDK "Allowed Domains", `public_profile` + `email` at Advanced Access, privacy/terms URLs, SSL.
- BD exposes **no webhook, callback, hook, or API** after a social login. Nothing tells Railway that a Facebook sign-up happened.
- Result classification: **(A) authenticates only into a BD member account** and **(D) creates a parallel identity Railway knows nothing about.** (B) is impossible; (C) does not exist.

## 3. Traced flows

**Visitor on www.advantage.bid → Facebook button.** Where would they even see it? BD `/login` redirects to Railway, so the button would appear only on BD membership sign-up forms (`/signup` today shows only a "Member Login" widget with no plan flow; `/join` links to Railway pages). If reached: Meta auth → a BD member on some plan → logged into BD only → **cannot bid, cannot create an auction, no Advantage.Bid dashboard, bid.advantage.bid does not recognize them**. Only by then clicking BD's Dashboard link (bridge widget) would Railway provision a *new* buyer `bd-<id>@bridge.invalid`. If that person already had a native Railway account under the same email, they now hold **two** accounts; the bridge deliberately never links by email.

**Visitor → Railway login/register.** One `users` row, buyer immediately, seller by enrollment, dashboard at `/app.html`, marketplace and bidding work. BD header reflects the session.

Risks introduced by BD Facebook Login: duplicate accounts, email collisions across two identity stores, a "member" who cannot transact, two session boundaries, a third-party copy of the Meta app secret, unclear plan assignment, and support confusion ("I signed up with Facebook but can't bid").

## 4. Meta App 1609869093910347 (read-only Graph inspection)

- Name "Advantage.Bid Marketing", category Business, Live. `app_domains = ["bid.advantage.bid"]`; privacy/terms URLs on bid.advantage.bid.
- System-user token scopes: read_insights, instagram_basic, instagram_manage_comments, instagram_manage_insights, instagram_content_publish, pages_read_engagement, pages_manage_metadata, pages_read_user_content, pages_manage_posts, pages_manage_engagement, public_profile. **No `email`, no Facebook Login use case evidence.** App roles: 2.
- The same App Secret is the HMAC key that authenticates Meta webhooks (`X-Hub-Signature-256`) and signs `appsecret_proof` calls.
- `/app/permissions` returned empty; access levels are not exposed by API — the Owner can confirm `email` / `public_profile` access level under App Review → Permissions and Features (read-only look).

Additional configuration Facebook Login would need on any app: the "Authenticate and request data from users with Facebook Login" use case; Facebook Login settings (Client OAuth Login, Web OAuth Login, Enforce HTTPS, Strict Mode, Valid OAuth Redirect URIs); App Domains covering the login host; `email` + `public_profile` at Advanced Access (auto-granted to most business apps, otherwise Business Verification); a data-deletion callback or instructions URL (we already publish `/data-deletion.html`); annual Data Use Checkup. For BD specifically: www.advantage.bid in App Domains and JS-SDK allowed domains, and the App Secret stored inside BD.

Coupling assessment: a second app is **not** needed for theoretical purity, but it carries two concrete advantages if Facebook Login is ever built: independent secret rotation (the marketing secret would otherwise have to rotate in Railway *and* the login integration, and every rotation re-signs webhooks), and enforcement isolation (a login-related policy action — data deletion handling, DUC lapse — would otherwise suspend organic publishing, insights and webhooks). Recommendation: when Railway-native login is built, create "Advantage.Bid Login" in the same Business Portfolio; the secret lives only in Railway.

## 5. Options ranked

1. **Option C/E — Railway-native social sign-in as an additional method on the canonical account.** Reuses `external_identities` (providers `facebook`, `google`), `users.auth_source`, the JWT/cookie minting path and the existing BD header handoff. One identity, one login page, no re-entry of known data. *Recommended when social login is wanted.*
2. **Option A — status quo.** Email/password on Railway, BD login retired. Fully coherent today. *Recommended until social login is prioritised.*
3. **Option D — BD Facebook Login + bridge.** Works mechanically but produces the duplicate-identity problem above and shares the secret with BD. Not recommended.
4. **Option B — BD Facebook Login bridging into Railway.** Not possible: BD offers no post-login hook.
5. **BD Facebook Login alone.** Creates transactionally useless BD members. Rejected.

## 6. Security review

- BD **does** need the App Secret to complete the OAuth code exchange and verify the signed data-deletion request. It is stored in BD's hosted admin settings (third-party SaaS; storage form not ascertainable; must be usable in plaintext by BD's PHP).
- Giving BD the *marketing* secret expands blast radius: a leak allows minting app access tokens, forging webhook signatures to `/api/meta/webhook`, and reading app-level data; rotation would then break BD login and the Marketing Agency simultaneously.
- Railway-native implementation must include: `state` (CSRF) bound to the session, exact-match redirect URIs (Strict Mode), server-side code exchange with `appsecret_proof`, `debug_token` validation, provider `email` treated as unverified unless the provider marks it verified, and **explicit linking** to an existing email account (password or emailed confirmation), never silent merge.
- Existing defect to fix first: `auth.js` login calls `bcrypt.compare` with a possibly NULL `password_hash` (nullable since mig 060) and echoes `err.message` on the 500 path — a social-only account would hit this.
- Production drift noted: prod `users` lacks `email_verified` (migration 082 unapplied — known bookkeeping-drift item).

## 7. Future authentication value

Email/password + Google + Facebook can coexist cleanly on the current architecture: `external_identities` is the mapping table the BD contract asked for ("BD is one auth provider among others"); `password_hash` is already nullable; JWT minting is centralised. What is missing is only the provider callback routes, linking UX, and the null-password guard.

## 8. Owner action

- Leave BD "Enable Facebook Login" = **No**. Do not enter the App ID or App Secret into BD.
- Optional read-only check in the Meta dashboard: App Review → Permissions and Features → access level of `email` and `public_profile`.
- Decide whether social sign-in is a priority for buyers; if yes, authorise the Railway mission below.
- BD housekeeping (BD admin, not code): the residual BD `/signup` page shows a BD member-login widget; point it to `bid.advantage.bid/login.html?tab=register` like `/login`.

## 9. Follow-on VS Code mission (only if social sign-in is wanted)

**AUTH-2: Social sign-in on the canonical Advantage.Bid account (Google + Facebook).** Scope: `GET /api/auth/oauth/:provider/start` (state + PKCE where supported) and `/callback` (server-side exchange, `appsecret_proof`, `debug_token`); `external_identities` providers `facebook`/`google` with `provider_email`, `email_verified_by_provider`; create-or-link rules (new user → buyer with `auth_source=<provider>`, `password_hash NULL`; existing email → explicit link via password or emailed confirmation; never silent merge); null-password guard + generic 500 message in login; account page "Connected sign-in methods" (link/unlink, cannot unlink last method without setting a password); mint the same JWT + `aap_session`; login.html "Continue with Google / Facebook" buttons (Smart-Tools language rules apply; no vendor names beyond the provider button itself); BD CTAs unchanged (already route to Railway); dedicated "Advantage.Bid Login" Meta app with secret only in Railway; tests for state mismatch, redirect-URI mismatch, collision/link, unlink-last-method, bridge users; feature flag `SOCIAL_LOGIN_ENABLED` default off.
