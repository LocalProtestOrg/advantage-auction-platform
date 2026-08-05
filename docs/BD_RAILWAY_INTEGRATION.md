# Brilliant Directories ↔ Railway Integration — Operating Manual

> **Authoritative reference** for the BD ↔ Railway login, account, bridge, and logout integration.
> Status at time of writing: audited read-only, no code/BD/secret/deploy changes made.
> Scope: authentication surface only (login, account, bridge, logout). Not maps/imports/sellers/bidding.

---

## 1. Purpose

Advantage.Bid is delivered as **one product across two platforms**:

- **Brilliant Directories (BD)** — the hosted public marketing / directory / CMS layer (SEO, articles, city & state pages, company directory, public navigation).
- **Railway** — the application layer (authentication, dashboards, buyers, sellers, auctions, estate sales, marketplace, payments, watchlists, notifications, application workflows).

The integration lets a member move seamlessly from BD's public pages into the Railway application and back, with a single authenticated identity, without BD ever holding Railway's session or Railway ever owning BD's content.

---

## 2. Architecture

**BD owns:** public marketing, SEO, CMS, articles, city/state pages, company directory, public navigation, the BD member account/dropdown UI.

**Railway owns:** authentication, dashboards, buyers, sellers, auctions, estate sales, marketplace, payments, watchlists, messaging, notifications, analytics, application workflows.

**Principle:** Railway is the source of truth for identity and application state. BD *reflects* the Railway session in its header; it does not hold one. A real BD session (when it exists) is BD's own, created only by BD's own login — it is never minted by Railway.

---

## 3. Domains

| Host | Role | Notes |
|---|---|---|
| `https://advantage.bid` | **Canonical marketing destination** | Apex. Where the app's upper-left brand/logo links. Returns a 301 (marketing site handles its own canonicalization). |
| `https://www.advantage.bid` | BD marketing / directory site | The public BD pages, header, and Custom CSS Head auth script live here. |
| `https://bid.advantage.bid` | Railway application (canonical app host) | Login, dashboard, APIs, bridge, logout, the `aap_session` cookie. |

`www.advantage.bid` and `bid.advantage.bid` share the registrable domain `advantage.bid`, so they are **same-site** (cross-origin). This is why a `SameSite=Lax` cookie on `bid.` is sent on a credentialed fetch from `www.` — no `SameSite=None` is required.

**Canonical marketing destination = `https://advantage.bid`.**

---

## 4. Login Flow

1. A visitor clicks **Login** in BD's public header → BD's Login link points at `https://bid.advantage.bid/login.html`.
2. Railway login (`login.html` → `POST /api/auth/login`) authenticates and issues the JWT. It is stored in `localStorage.token` **and** mirrored into the `aap_session` HttpOnly cookie (Railway origin).
3. On subsequent BD page loads, BD's sitewide script calls `GET https://bid.advantage.bid/api/auth/session-status` with credentials. If `{ authenticated: true }`, BD's public **Login** control is converted to **My Account** → `https://bid.advantage.bid/app.html#home`.
4. If the visitor also has a **BD** session, BD's *logged-in header menu* ("Top Header Mini Menu when Logged In") already renders the native member thumbnail/dropdown and hides the public Login item — so no duplicate "My Account" appears.

The four header states:

| BD session | Railway session | Header shows |
|---|---|---|
| no | no | **Login** (unchanged) |
| no | yes | **My Account** → `app.html#home` |
| yes | no | native BD dropdown (public Login hidden by the logged-in menu) |
| yes | yes | native BD dropdown (public Login hidden by the logged-in menu) |

---

## 5. Auth Bridge Flow

Used when a **BD-authenticated** member enters the app (e.g. clicks the native dropdown's **Dashboard**).

1. BD's `default_account_home_url = enter-auctions` routes the native Dashboard link to **`/account/enter-auctions`** (a member-only BD custom page).
2. That page renders the **`[widget=ADVANTAGE_BRIDGE]`** widget (`scripts/bd/bd-bridge-widget-production.php`).
3. The widget reads BD smart tags — `[me=user_id]`, `[me=email]`, `[me=first_name]`, `[me=last_name]` — and makes a **server-to-server** cURL `POST` to `https://bid.advantage.bid/api/auth/bd/exchange` with header `X-Bridge-Key: <BD_BRIDGE_SECRET>`.
4. Railway validates the secret (constant-time), the numeric member id, the email, and the destination key, then **mints a single-use opaque code** (256-bit random; only its SHA-256 is stored, 2-minute TTL) and returns `{ redirect_url: https://bid.advantage.bid/auth/bd/return?code=… }`.
5. The widget validates that `redirect_url` begins with the exact `…/auth/bd/return?code=` prefix, then `location.replace()`s to it. An "Opening your dashboard…" overlay covers BD's shell so the old dashboard never flashes.
6. `GET /auth/bd/return?code=` **atomically** redeems the code and provisions/loads the identity (always a **buyer**), signs the standard login JWT, sets the `aap_session` cookie, and returns a minimal nonce'd seed page that stores the JWT in `localStorage` and `location.replace()`s to the allowlisted destination (`/app.html`).

The JWT never appears in a URL, query string, fragment, `Location` header, or browser history — only inside the seed's nonce'd inline script under a strict CSP.

---

## 6. Dashboard Routing

- **Setting:** `default_account_home_url`
- **Current value:** `enter-auctions`
- **Effect:** BD's native member Dashboard link resolves to `/account/enter-auctions`, which hosts the bridge widget — so the native BD Dashboard action lands the member in the Railway dashboard.
- **Rollback:** set `default_account_home_url` back to BD's default (blank / BD's native member dashboard slug). The native Dashboard link then returns to BD's own member area; the bridge page stops being the account home.

---

## 7. Header Menus

- **Logged-in menu name:** `Top Header Mini Menu when Logged In` (a clone of BD's top-header mini menu).
- **Why the clone is used:** it lets the public **Login** item be hidden for BD-authenticated members without editing BD core. For a BD member, this menu renders the native thumbnail/dropdown and omits the public Login control — so the sitewide script never finds a Login link to convert, and no duplicate "My Account" is produced.
- **Which Login item is hidden:** the public header Login/Sign In item, in the logged-in menu only.
- **Railway-only behavior:** when BD has *no* session, BD renders the public Login item; the sitewide script (after a positive `session-status`) rewrites it to **My Account** → `app.html#home`.
- **Native controls preserved:** the member thumbnail, dropdown, and its Dashboard/Logout items remain native BD controls; the script never rewrites links inside the native dropdown.

---

## 8. Logout Flow

1. A BD member clicks **Log Out** in the native dropdown → BD clears **its own** session and lands the browser on `https://www.advantage.bid/login?action=loggedout`.
2. The sitewide script (Custom CSS Head) detects `path === /login` and `action=loggedout` and `location.replace()`s to `https://bid.advantage.bid/logout`.
3. Railway `GET /logout` clears the `aap_session` cookie (`Set-Cookie … Expires=1970`), clears `localStorage.token` + `sessionStorage`, and lands on `https://bid.advantage.bid/login.html?loggedout=1`.

- **What each clears:** BD clears the BD session; Railway `/logout` clears the Railway cookie + client token.
- **Final destination:** the Railway login page (`login.html?loggedout=1`).
- **Failure modes:**
  - If JavaScript is disabled / the script fails, BD is logged out but the Railway session persists (misleading but not a cross-user exposure). See §16.
  - **Railway `/logout` does NOT propagate to BD.** Logging out via Railway leaves the BD session intact until BD's own logout runs. Known limitation (§16).
- **Manual test:** log into both → BD Log Out → confirm you land on `login.html?loggedout=1`, the `aap_session` cookie is gone (DevTools → Application → Cookies), and returning to `www.advantage.bid` shows **Login** (not My Account).

---

## 9. BD Custom CSS Head

**Location:** BD Admin → (Toolbox/Settings) → **Custom CSS Head** (the site-wide `<head>` code block).

It contains four labeled sections:

1. **Google site verification** — the `google-site-verification` meta. Do not remove.
2. **Google Analytics** — `gtag.js` loader + config for `G-DBCGKMC9DQ`.
3. **Railway marketplace assets** — `marketplace.css`, `marketplace-components.js`, `bd-auctions-init.js` loaded from `https://advantage-auction-platform-production.up.railway.app`.
4. **BD / Railway login-account-logout script** — the auth integration IIFE (the login/logout handoff + Railway-session→My Account conversion).

**Dependencies:** Section 4 depends on Railway's `/api/auth/session-status`, `/login.html`, `/logout`, and `/app.html#home`. Section 3 depends on the Railway asset host.

**Safe editing:** edit only the intended section; keep each block's labeled boundaries. **Never delete unrelated blocks** (verification/GA/assets). **No secret is ever stored here** — Section 4 contains only public URLs; the bridge secret lives only in the ADVANTAGE_BRIDGE widget (§10).

**Rollback:** keep a copy of the previous Custom CSS Head before editing. To disable the auth integration, remove only Section 4 (the header reverts to BD's native Login; logout reverts to landing on `/login?action=loggedout` with no Railway handoff).

**Change control:** the intended Section-4 source is versioned at `scripts/bd/bd-header-session-aware.js`. **The live block and that file may differ (see §16 / drift).** After any paste, re-compare live vs repo.

---

## 10. ADVANTAGE_BRIDGE Widget

- **Widget name:** `ADVANTAGE_BRIDGE` (referenced as `[widget=ADVANTAGE_BRIDGE]`).
- **Location:** BD Admin → **Widget Manager** → the `ADVANTAGE_BRIDGE` widget (HTML/PHP).
- **Pages used:** the member-only custom page `/account/enter-auctions` (the account-home target).
- **Member-only requirement:** the page must require a logged-in BD member; the widget reads `[me=…]` smart tags that only resolve for an authenticated member.
- **Production secret handling:** the widget holds `BD_BRIDGE_SECRET` in a single PHP variable used only in the server-side cURL `X-Bridge-Key` header. It is **never** echoed to HTML/JS/URL. The repo copy (`scripts/bd/bd-bridge-widget-production.php`) ships a **placeholder** — the real secret is inserted only inside BD.
- **Overlay behavior:** a full-viewport neutral "Opening your dashboard…" overlay (spinner, `prefers-reduced-motion` aware) covers BD's shell before the redirect; on failure it shows a neutral recovery link instead of a blank screen.
- **Permitted destinations:** a fixed allowlist of destination **keys** (`dashboard`, `create-event`, `manage-events`, `create-auction`, `manage-auctions`); the widget forwards only a key, never a URL. Railway resolves keys → internal paths.
- **Rollback:** disable/unpublish the widget (or the `/account/enter-auctions` page). The bridge stops; members no longer hand off. Re-point `default_account_home_url` if needed (§6).

*(Secret value intentionally omitted from this document.)*

---

## 11. Railway Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /login.html` | Railway login page (the BD "Login" target). |
| `POST /api/auth/login` | Authenticates, issues JWT, sets `aap_session` cookie. |
| `GET /api/auth/session-status` | **Minimal** cross-origin session probe → `{ authenticated: bool }` only. Credentialed CORS locked to `https://www.advantage.bid` + `https://advantage.bid`; `no-store`; simple GET (no preflight). |
| `GET /logout` | Clears the cookie + `localStorage.token` + `sessionStorage`; lands on `login.html?loggedout=1`. No `next` param (not an open redirect). |
| `POST /api/auth/logout` | Clears the cookie server-side (used by client logout wrappers). |
| `POST /api/auth/bd/exchange` | Server-to-server (X-Bridge-Key). Validates secret/member-id/email/dest; mints a single-use code; returns the opaque `redirect_url`. Mounted only when `IDENTITY_BRIDGE_ENABLED=true`. |
| `GET /auth/bd/return?code=` | Atomically redeems the code + provisions a buyer identity; sets the cookie; returns the nonce'd seed page. |
| `GET /api/auth/me` | Returns the authenticated user's own id/email/role (Bearer or cookie). |
| HTML auth gate | `htmlAuthGate` runs before static: private HTML pages 302 → login when unauthenticated; sets `Cache-Control: no-store`. |

---

## 12. Cookie and Token Model

- **Cookie:** `aap_session` — carries the **same** signed login JWT.
- **Flags:** `HttpOnly` (no JS access), `Secure` in production, `SameSite=Lax`, `Path=/`, **host-only** to `bid.advantage.bid` (no `Domain`).
- **Lifetime:** `maxAge` 24h (persistent, mirrors `JWT_EXPIRES_IN` default).
- **Legacy Bearer/localStorage compatibility:** API clients may still send `Authorization: Bearer <token>` from `localStorage`. `authMiddleware` verifies the **Bearer first**, then **falls back to the cookie**.
- **Cookie fallback:** a valid cookie authenticates protected APIs even with no/stale `localStorage` token — this is what stopped the false "Session Expired" on the BD → Railway round trip.
- **Sliding renewal:** once a token passes half its lifetime, a fresh JWT is minted and the cookie is refreshed. `X-Refreshed-Token` is emitted **only** for Bearer clients (a cookie-only session slides via the refreshed cookie; no new JWT is handed to JS).
- **Logout:** `/logout` expires the cookie and clears `localStorage.token` + `sessionStorage`.

---

## 13. Member Classification (must read before enabling any seller)

- A **BD member is not automatically a Railway seller.** The bridge provisions **buyer-only** identity and never infers seller/org-owner/admin.
- **BD Gold/Silver/Bronze levels are not evidence of payment or seller status.** They are BD directory tiers, unrelated to Railway seller enablement.
- **Imported/populated company listings may be unclaimed** (directory data), with no verified member behind them.
- **Seller enablement requires** verified member↔organization ownership, a linked seller profile, and acceptance of the required seller agreement — via the seller-enablement workflow, not the bridge.
- **Admin access is never inferred** from BD level, company name, or bridge identity.

---

## 14. Manual BD Configuration Inventory

Every relevant manual BD setting (all live in BD Admin, not the repo):

| Setting | Where | Value / State |
|---|---|---|
| Custom CSS Head (4 sections) | Custom CSS Head | verification + GA + Railway assets + auth script |
| Logged-in header menu | Menus | `Top Header Mini Menu when Logged In` (clone; public Login hidden) |
| `default_account_home_url` | Settings | `enter-auctions` |
| `/enter-auctions` custom page | Pages | hosts the bridge launcher (public) |
| `/account/enter-auctions` custom page | Pages | member-only; hosts `[widget=ADVANTAGE_BRIDGE]` |
| Member-only access | Page access | enforced on `/account/enter-auctions` |
| `ADVANTAGE_BRIDGE` widget | Widget Manager | holds `BD_BRIDGE_SECRET` (server-side only) |
| Hidden Login menu item | logged-in menu | hidden for authenticated members |
| noindex settings | seed/bridge/app | seed page + `app.html` are `noindex,nofollow`; gated pages 302 for anon |

---

## 15. Security Rules

- **Never expose `BD_BRIDGE_SECRET`** — not in HTML, JS, URLs, logs, errors, or page source. It lives only in the ADVANTAGE_BRIDGE widget's server-side PHP.
- **Never put tokens in URLs** — the JWT travels only in the cookie and the nonce'd seed script.
- **Never infer seller/admin privilege** — see §13.
- **Never use unvalidated redirects** — the bridge uses destination **keys**; the widget prefix-checks Railway's `redirect_url`; `/logout` has no `next`.
- **Never duplicate authentication logic casually** — one JWT format, one login, one cookie.
- **Preserve canonical cookie behavior** — HttpOnly + Secure + SameSite=Lax + host-only; do not widen `Domain` or set `SameSite=None`.
- **Test both systems after every auth-related change** — run the §17 matrix.

---

## 16. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "My Account" **and** native BD dropdown both visible | Logged-in header menu is not hiding the public Login item; the script then converts it → duplicate. Fix the BD logged-in menu (hide public Login). |
| Public **Login** visible while BD member dropdown is active | Same menu misconfiguration, or the sitewide script isn't loaded. |
| "Session Expired" after BD → Railway | Historical (fixed): `authMiddleware` ignored the cookie. Confirm the cookie-fallback middleware is deployed and `app.html`/APIs accept the cookie. |
| BD dashboard **flashes** before redirect | The ADVANTAGE_BRIDGE overlay is missing/old; re-paste the overlay widget. |
| Logout stuck on `/login?action=loggedout` | Section-4 auth script missing/broken in Custom CSS Head; the loggedout→`/logout` handoff isn't firing. |
| `Uncaught SyntaxError: Unexpected token 'if'` | A malformed script block in Custom CSS Head (historically a bad regex). Validate the pasted script. |
| Malformed pathname regex | `replace(//+$/, '')` (missing escape). Correct is `replace(/\/+$/, '')` — or the live variant's trailing-slash `while` loop. |
| Repo code differs from live BD | Expected until re-pasted; see the **drift** note below. Always re-compare after editing. |
| Railway session exists but BD session does not | Normal for a direct Railway login; BD reflects it as "My Account". No BD session is created. |
| BD session exists but Railway session does not | Normal before the bridge runs; the native dropdown's Dashboard triggers the bridge. |
| Logged out of Railway but BD still shows member | Known limitation: Railway `/logout` does not propagate to BD. |

**Drift (current):** the **live** Custom CSS Head auth script is a hand-authored variant that does **not** byte-match `scripts/bd/bd-header-session-aware.js`. Both are functionally valid; the live one relies on the BD logged-in menu to hide the public Login (no script-side dropdown detection), uses `URLSearchParams`, and normalizes the path with a trailing-slash `while` loop; the repo artifact uses a regex and an in-script four-state (`bdAuthed`/hide) matrix. Treat the **repo file as the intended source** and reconcile (see §19).

---

## 17. Test Matrix

Run for each auth-related change. Expected result in parentheses.

- Neither logged in (Login shown; no conversion).
- Railway only (Login → My Account → `app.html#home`).
- BD only (native dropdown; no public Login; Dashboard → bridge).
- Both (native dropdown; no duplicate).
- Buyer / Seller / Admin (correct role in the Railway dashboard; bridge always provisions buyer).
- Desktop / Mobile (both menu variants convert/hide correctly).
- Browser refresh (session persists via cookie).
- Browser restart (persists within the 24h cookie lifetime).
- BD logout (both sessions cleared; land on `login.html?loggedout=1`).
- Railway logout (Railway cleared; BD not — known).
- Bridge login (`/account/enter-auctions` → overlay → dashboard, no flash, no "Session Expired").
- Direct Railway login (`login.html` → dashboard).
- Expired cookie (protected APIs 401; user re-auths safely).
- Stale localStorage token + valid cookie (cookie wins; authenticated).
- Railway unavailable (`session-status` fails safe; header stays Login; no page break).
- BD smart-tag failure (bridge widget shows a neutral recovery message; no secret leaked).

---

## 18. Rollback

| Change | Rollback |
|---|---|
| Custom CSS Head | Restore the previous saved block; or remove only Section 4 to disable the auth integration. |
| Header menu | Revert to the prior logged-in menu; the public Login returns. |
| `default_account_home_url` | Set back to BD's default; native Dashboard returns to BD's member area. |
| Bridge widget | Unpublish the widget or the `/account/enter-auctions` page. |
| Railway deployment | Redeploy the previous build (`git revert <sha>` for the specific change). |
| Auth middleware change | Revert the cookie-fallback commit; Bearer-only behavior returns (note: this reintroduces the BD→Railway "Session Expired"). |

---

## 19. Change-Control Rule

Every future BD/Railway authentication change **must**:

1. Update the repository artifact (`scripts/bd/bd-header-session-aware.js`, `scripts/bd/bd-bridge-widget-production.php`, and/or the Railway source).
2. Update this document (`docs/BD_RAILWAY_INTEGRATION.md`).
3. Identify any required **manual BD action** (Custom CSS Head paste, menu, widget, setting).
4. **Compare the live BD source against the repo artifact after the manual paste** (they drift silently otherwise — see §16).
5. Run the full §17 login/logout matrix on desktop and mobile before considering the change complete.

---

## 20. Two-Way Navigation — Business Administration ⇄ Marketplace (Phase 4C)

One Advantage.Bid product; the customer moves between **Business Administration** (BD) and the **Marketplace** (the app) without thinking about platforms. The word "Railway" never appears in any customer-facing surface.

### 20.1 Marketplace → Business Administration (Railway side — implemented in this repo)
- The member shell shows BD members a primary nav item **"Business Administration"** that returns them to their BD member area.
- **Who sees it:** only members with a `brilliant_directories` external identity. `GET /api/auth/me` returns a server-authoritative `bd_member` boolean and, for BD members only, `business_admin_url`. Native-only buyers/sellers/admins never see the item.
- **What it means (scope-locked):** Business Administration = **BD-owned** professional membership, recurring billing, and the company directory listing. Railway never manages professional billing or the customer-facing company listing (see §21).
- **Where:** appended to every experience (Buying / Selling / Admin) in `member-nav-config.js` (`visibleNavFor`); rendered in the desktop rail and, because it is `primaryMobile`, in the mobile bottom nav (the rail is hidden ≤860px). Files: `src/routes/auth.js` (`/me`), `src/lib/bridgeConfig.js` (`bdMemberAdminUrl`), `public/widgets/shared/member-nav-config.js`, `public/widgets/shared/member-shell.js`.
- **Destination:** `BD_MEMBER_ADMIN_URL` (env; default `https://www.advantage.bid/business-administration`).
- **⚠️ Redirect-loop hazard:** this URL **must** be a native BD member-area page. It must **not** be BD's `default_account_home_url` (currently `enter-auctions`, which is the bridge INTO the app — §6); pointing there would loop the member straight back into the Marketplace. Confirm the exact loop-free BD member slug with BD admin before deploy.

### 20.2 Business Administration → Marketplace (BD side — manual BD action, not in this repo)
Add a primary action **"Open Marketplace"** in the BD Member Dashboard linking to:

```
https://bid.advantage.bid/app.html#home
```

- The existing identity bridge (§5) authenticates the member on arrival; no second login. (Today the native BD Dashboard already routes through `enter-auctions` → bridge → app; "Open Marketplace" is the explicit, labeled entry point requested by the Product Owner.)
- Label it **"Open Marketplace"** — never "Railway" or any platform/technology name.
- Placement: BD Member Dashboard primary actions (Widget Manager / member menu). Add to the §14 manual-configuration inventory when pasted.

### 20.3 Verification (run before considering complete)
BD member → BD dashboard → **Open Marketplace** → app dashboard (no second login, no flash) → create/manage events → **Business Administration** → BD member area (no loop, no re-login while the BD session is alive). Desktop and mobile. Plus the full §17 auth matrix.
