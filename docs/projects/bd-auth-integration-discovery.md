# BD ↔ Advantage.Bid Authentication Integration — Step 1 Discovery Report

**Status:** Discovery only. **No production changes, no implementation.** PR #83 untouched.
**Date:** 2026-07-22
**Scope:** Authentication + identity association only (no unrelated Marketplace/auction/payment work).
**Inputs:** Verified from code (Railway); BD's official written response; BD's webhook API reference
(fetched); the BD read-only API probe from the prior investigation.

> **Confidence labels:** **[VERIFIED-CODE]** confirmed in this repo · **[BD-OFFICIAL]** stated by BD in
> writing · **[BD-DOC]** from BD's webhook API reference · **[NEEDS BD CONFIRMATION]** a BD capability
> only BD support / Developer Hub can confirm.

---

## 1. Existing Railway authentication architecture **[VERIFIED-CODE]**

- **Model:** purely **stateless JWT**. Login/register issue a signed JWT (`{id, role}`, HS256 via
  `JWT_SECRET`, `JWT_EXPIRES_IN` default `24h`) **in the JSON body only**. The browser holds it
  (localStorage) and sends `Authorization: Bearer`. **No cookies, no server-side sessions anywhere**
  (no `express-session`/`cookie-parser`/`res.cookie`; Socket.IO reads the token from its handshake).
- **`users` columns:** `id, email, role('seller'|'buyer'|'admin'), created_at, last_login, is_active,
  password_hash, stripe_customer_id, full_name, phone, email_verified, email_verified_at`. Passwords
  are bcrypt (cost 10) in `password_hash`.
- **Routes** (`/api/auth`): `register`, `login`, `me`, `PATCH /me`, `verify-email`, `forgot-password`,
  `reset-password`. **No `/logout`, no `/refresh`** (nothing to revoke — a stateless JWT is valid until
  it expires).
- **Registration** → role `'buyer'`, **immediately usable — no email-verification gate**. buyer→seller
  is **self-serve** (`POST /api/sellers/enroll` creates a `seller_profile` and flips the role). **admin
  is script-only** (`provision-admin.js`); there is **no in-app admin-promotion route**.
- **Email-verification primitive EXISTS but is non-gating:** migration 082 added `email_verified`/
  `email_verified_at` + an `email_verification_tokens` table + `emailVerificationService`
  (32-byte token, SHA-256 hash stored, single-use, TTL). A near-identical `password_reset_tokens`
  flow exists. **This is directly reusable as the secure "confirm this is you" step for account
  linking.**
- **Org authorization:** `organization_members` (`role owner|admin|editor|member`, `status`), owner gate
  = `role='owner' AND status='active'`; acting org selected by `X-Acting-Org-Id`, validated against
  active membership (admins bypass); one-org-per-user; auto-create on first event or claim a BD shell.
- **CORS:** bearer-token only, **no credentials** (`Access-Control-Allow-Credentials` is never set).
  Public/widget paths get `*`; other paths echo an allow-list (`FRONTEND_URL` + `ALLOWED_ORIGINS`).

**No external-identity infrastructure exists:** no `external_identities` table, no
`provider`/`oauth`/`sso`/`external_id` columns, and **no user↔BD-member link of any kind**.

## 2. Existing BD API integration **[VERIFIED-CODE + BD-API probe]**

- Client `bdRestTransport.js`: base `https://www.advantage.bid/api/v2`, header `X-Api-Key`
  (`BD_API_KEY`), **read-only, GET-only**. Only endpoint used: `GET /user/get` (bulk, paged). **No
  single-member-by-`user_id` fetch exists in code** (would be added).
- Daily `directorySyncWorker` (production-gated) pulls BD members and upserts each as an
  `organizations` row with `source='bd_import'` and **`bd_listing_id = BD user_id`**. `bd_metadata`
  captures `profession_id`, `subscription_name` (unused), etc.
- **BD `/user/get` exposes per member:** `user_id` (stable id), `email`, name, `company`,
  `member_type`/`listing_type`, `subscription_id`, `subscription_name`, `is_subscription_active`,
  `verified`, `status`. **The join key already exists** — a BD member's `user_id` is already the
  `bd_listing_id` on their imported org.

## 3. BD Developer Hub / SSO capabilities **[BD-OFFICIAL]**

BD confirmed in writing:
- **No native OAuth, OpenID Connect, SAML, signed-JWT, or HMAC login handoff.**
- **Custom SSO-style integrations are possible only via custom development.**
- REST API uses **API-key** auth (system-to-system).
- The shortcode **`[me=user_id]`** exposes the logged-in BD member id **inside logged-in content**
  (browser-visible → not trustworthy on its own).
- BD **recommends a custom API-based integration**, not an editable query-string identity.
- Member→company/listing ownership association is **possible via custom development**.
- Webhooks are documented; **Developer Hub access is required**.

**[NEEDS BD CONFIRMATION] — the one capability that decides the seamless option:** can Developer Hub
custom code run **trusted server-side** logic that (a) **stores a shared secret** and (b) **computes an
HMAC / signs a payload**, *or* (c) makes an **authenticated outbound HTTPS call** to a Railway
endpoint? BD says "custom development" can do SSO-style — but whether that is **self-serve custom code**
or **BD's paid professional-services**, and its exact server-side abilities + cost, must be confirmed.

## 4. Available BD webhook events **[BD-DOC]**

From BD's webhook API reference: webhooks are **outbound "POST-to-a-URL" hooks** (Zapier/Pabbly-style),
created/managed via the API as records with a `webhook_category`, a trigger, a destination `url`, and
an optional `webhook_form`. Visible categories in the doc: **`members`** and **`reviews`**; example
triggers include *"Fires when a new free member registers"* and *"Fires when a member receives a new
review."*

- **No outbound-payload signature/HMAC verification is documented** → BD webhooks appear **unsigned**.
- The **full member-lifecycle trigger set** (activation, upgrade, downgrade, cancellation, expiration,
  email/profile update, deletion) is **not shown in the doc** — **[NEEDS BD CONFIRMATION]**.
- **Design consequence:** webhooks can only be **untrusted notifications**. Per your own rule, every
  webhook must trigger an **API re-fetch of the member** before any authorization change; never
  authorize from a webhook payload alone.

## 5. Security limitations & constraints (current state)

- **Stateless JWT is not revocable** before expiry (no logout/refresh/session). Fine for APIs; for a
  browser web session it means a compromised/last-issued token stays valid up to 24h. Your stated
  requirements (HTTP-only cookies, rotation, fixation prevention, revocation) imply **introducing a
  cookie-backed session** for the authenticated web app — a scoped upgrade.
- **No cookies today** → `advantage.bid` and `bid.advantage.bid` cannot share a session; and we should
  **not** broaden cookie domains to force it (the integration contract requires distinct sessions).
- **`[me=user_id]` is browser-visible and BD ids are small sequential integers** (e.g. `4`) → the raw
  value is **guessable and forgeable**; it may only be trusted once wrapped in a **server-signed
  assertion** or replaced by a **server-minted opaque code**.
- **BD webhooks unsigned** → notifications only.
- **No email-verification gate** on registration today (the primitive exists but isn't enforced).

## 6. Best viable architecture

**Identity authority = Railway; BD = directory/marketing + member/subscription data source.** Railway
is already a complete auth system, passwords stay only in Railway, and — with essentially **no active
users to migrate** — this is the cleanest long-term design and is **guaranteed buildable with zero new
recurring cost**. It also matches the governing architecture (`bid.advantage.bid` is the canonical
transactional home; BD displays via API-fed widgets).

**Login handoff — a security-ladder chosen by BD's confirmed capability (item 3):**
1. **Preferred — Option A (BD-signed one-time HMAC assertion).** BD custom code reads `[me=user_id]`
   server-side, builds a short-lived one-time assertion (`bd_user_id, iat, exp, nonce, audience,
   allowed-redirect`), signs it with a secret stored only server-side, and redirects to Railway.
   Railway verifies signature+expiry+audience+nonce (single-use) → fetches the member via the BD API →
   verifies status/subscription → links/creates the user → issues its **own** session. Seamless,
   secure, no recurring cost. **Conditional on [NEEDS BD CONFIRMATION] item 3 (server-side signing).**
2. **Alternative — Option B (BD calls Railway to mint a one-time code).** If BD can make an
   authenticated outbound call but not sign, BD's server calls a private Railway endpoint (API
   credential) to mint a random, single-use, short-lived, **opaque** code (no member id in it), then
   redirects with that code; Railway consumes it once and re-verifies via the API.
3. **Fallback — redirect to Railway login (allowlisted return).** If BD custom code can do neither
   securely (or only via costly paid custom dev), a BD protected button simply redirects to the Railway
   login with an allowlisted `return` destination. **One login step, fully secure, zero BD dependency,
   zero cost.** Given near-zero users, this is a perfectly acceptable launch baseline and can be
   upgraded to A/B later.

**Account provisioning:** new `external_identities` table (`provider='brilliant_directories'`,
`provider_subject = BD user_id`, unique `(provider, provider_subject)`). On a verified identity:
link by subject → else if a local account shares the verified email, **require an email-verification
confirmation** (reuse `emailVerificationService`) before linking — **never silent-merge** → else create
a minimal `buyer` account stamped with source + BD user_id + email + subscription. **Never** auto-grant
seller/business/admin from BD existence; **never** map a BD admin to a platform admin.

**Company ownership:** new `organization_external_links` (`organization_id, provider,
provider_listing_id, provider_member_id, relationship_type, status, verified_at, verified_by`) with
statuses `admin_created | unclaimed | claim_pending | member_verified | admin_verified | suspended |
revoked`. Because `bd_listing_id` already equals BD `user_id`, a member's own listing links naturally;
**admin-created listings require an explicit claim/verify** — never grant ownership from a
browser-supplied listing id. Every org-scoped route enforces server-side tenant authorization (extend
the existing `resolveActingOrg`/`organization_members` model to require the external link).

**Subscription sync:** a small `subscription_id → plan_tier` map; applied via the existing
`setPlanTier` (auto-reconciles capabilities). Triggers, in order of trust: (1) **re-fetch + re-apply at
each login/handoff** (always current at the security-critical moment); (2) BD **webhooks as unsigned
notifications** → always API-re-fetch before changing anything, idempotent + logged; (3) the existing
**daily reconciliation** as backstop. On cancellation/expiry: **preserve auction/invoice/settlement/
audit records**, restrict only **future** management.

**Session upgrade:** issue an **HTTP-only, Secure, `SameSite=Lax` cookie session** for the authenticated
web app, with rotation-on-login, session-fixation prevention, short expiry, and server-side
revocability. Keep bearer-JWT accepted for programmatic/API use.

## 7. Why it is secure

- Identity is only ever trusted from a **server-signed assertion (A)** or a **server-minted opaque,
  single-use code (B)** — never a raw, browser-editable `user_id`; this defeats id-tampering,
  id-guessing, and forged requests.
- **Short expiry + one-time nonce/code** defeats replay; **audience + redirect allowlist** defeats open
  redirects and token reuse across audiences; **cookie session rotation** defeats fixation.
- Railway **re-verifies the live BD member (status + subscription) via the API** at the moment of
  handoff, so a disabled/expired/suspended/deleted BD account can't get in on a stale assertion.
- **Account linking never trusts email alone** — a matching-email collision requires an emailed
  verification challenge; no silent merges.
- **Ownership is explicit** (claim/verify), so an admin-created listing can't be hijacked from a URL.
- **No passwords are shared or synchronized**; Railway remains the sole password store and issues its
  own session; the BD API key and any signing secret live **only server-side**.

## 8. Why the rejected options are unsafe or unnecessary

- **Raw `?user_id=`, hidden `[me=user_id]` form, or client-JS-submitted member id:** browser-editable +
  BD ids are guessable sequential integers → trivial impersonation. Rejected.
- **Email-only auto-linking:** BD/Railway emails can differ or collide; email is not proof of the same
  person → account takeover risk. Allowed only as a *verified* linking step, never as the login itself.
- **BD API key / signing secret in browser code:** immediate credential compromise. Prohibited.
- **Password sharing / hash sync / shared cookie domain:** violates "passwords never copied," expands
  attack surface, and conflicts with the "distinct sessions" contract. Unnecessary given Railway is
  already the auth system.
- **A paid identity platform (Auth0/Okta/Clerk/WorkOS/Firebase):** unnecessary — Railway already
  provides auth, and the handoff is a small custom endpoint. Avoids a recurring bill.

## 9. New paid service required?

**No.** The design uses **Railway + Neon + the existing email primitive + the BD REST API + BD
webhooks + custom BD code** — all already owned. **One caveat:** if BD confirms that Option A/B custom
code requires **BD's paid professional-services** (not self-serve Developer Hub code), that is a
**one-time BD engagement cost**, not a recurring identity-platform subscription — and the
**redirect-to-Railway-login fallback avoids even that** while remaining fully secure.

## 10. Remaining questions only BD Support / Developer Hub can answer

1. Can Developer Hub custom code run **trusted server-side** (store a secret + HMAC-sign a payload,
   **or** make an authenticated outbound HTTPS POST to our endpoint)? Self-serve or **paid custom
   dev**? What is the cost?
2. Can `[me=user_id]` be consumed **server-side inside custom code** (so it's signed before it ever
   reaches the browser), not just rendered into client HTML?
3. Full **member-lifecycle webhook catalog**: registration, subscription activate/upgrade/downgrade/
   cancel/expire, email/profile update, account suspend/delete — which exist?
4. Are outbound **webhook payloads signed** (secret/HMAC), and how do we verify? (Doc suggests
   unsigned.)
5. **Multiple members/sub-accounts per company listing** — supported? How represented?
6. Official API method to **associate a logged-in member with the company/listing they own**, and to
   **claim/assign an admin-created listing** to a member.
7. Stable **subscription catalog** (`subscription_id` → plan name) to map to Gold/Silver/Individual/
   Appraiser.

*(Items 1–2 decide A vs B vs the login-redirect fallback; item 1's cost answer decides whether the
seamless handoff is worth it over the free redirect fallback.)*

---

## Required final recommendation

```
Recommended identity authority:      Railway (bid.advantage.bid). Passwords + sessions live only in
                                     Railway; BD is the directory/marketing layer and a read-only
                                     source of member + subscription data.

Recommended login handoff:           Security ladder gated on one BD capability answer:
                                     • If BD custom code can server-side SIGN → Option A
                                       (BD-signed, short-lived, one-time HMAC assertion). PREFERRED.
                                     • Else if BD can make an authenticated OUTBOUND call → Option B
                                       (BD asks Railway to mint a single-use opaque code).
                                     • Else → redirect to Railway login with an allowlisted return
                                       (one login step, secure, zero BD dependency, zero cost).
                                     Raw user_id / query-string identity is PROHIBITED in all cases.

Recommended account-provisioning:    external_identities (provider='brilliant_directories',
                                     provider_subject=BD user_id, UNIQUE(provider,provider_subject)).
                                     Link-by-subject → else email-verified confirmation before linking
                                     (reuse emailVerificationService) → else create a minimal buyer.
                                     Never auto-grant seller/business/admin; never map BD admin→admin.

Recommended company-ownership:       organization_external_links (org_id, provider, provider_listing_id,
                                     provider_member_id, relationship_type, status, verified_at,
                                     verified_by); statuses admin_created→claim_pending→member_verified/
                                     admin_verified/suspended/revoked. bd_listing_id already = BD
                                     user_id; admin-created listings require explicit claim/verify.
                                     Server-side tenant authz on every org-scoped route.

Recommended subscription-sync:       subscription_id→plan_tier map applied via setPlanTier. Re-fetch +
                                     re-apply at each login/handoff (primary, trusted); BD webhooks as
                                     UNSIGNED notifications that trigger an API re-fetch (idempotent,
                                     logged); daily reconciliation as backstop. Preserve financial/
                                     audit records on cancel; restrict only future management.

New paid software required:          No. (Possible one-time BD custom-dev cost for Option A/B only;
                                     the login-redirect fallback avoids even that.)

BD Support clarification still req'd: (1) server-side custom-code signing/outbound-call capability +
                                     cost; (2) [me=user_id] usable server-side pre-signature;
                                     (3) full member-lifecycle webhook catalog; (4) are webhooks
                                     signed; (5) multi-member/company + admin-listing claim via API;
                                     (6) subscription_id→plan catalog.

Security risks remaining:            Stateless-JWT non-revocability (mitigate with an HTTP-only cookie
                                     session + rotation + short expiry) · unsigned BD webhooks (never
                                     authorize without an API re-fetch) · BD secret handling (server-
                                     side only) · email-collision linking (verify, never silent-merge)
                                     · admin-created-listing ownership (explicit claim only) · guessable
                                     BD member ids (only ever trust the signed assertion / opaque code).
```

---

*Discovery only — nothing was implemented and production was not modified. The pivotal open item is BD
Support question 1 (server-side custom-code signing/outbound capability + cost), which selects Option A
vs B vs the login-redirect fallback. Recommend confirming that before the Step 2 file-by-file plan is
finalized, since it changes the BD-side work and a few Railway endpoints.*
