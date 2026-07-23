# BD ↔ Advantage.Bid Identity Bridge — Investigation & Options Memo

**Status:** Investigation + design only. **No implementation. PR #83 not merged/deployed.**
**Date:** 2026-07-21
**Question:** How does a logged-in Brilliant Directories (BD) member become the same, authorized user
on bid.advantage.bid (Railway) — connected to the right organization and membership tier —
automatically, with no password sync and no manual admin work?

> **Confidence labels:** **[VERIFIED-RAILWAY]** = confirmed from the codebase. **[VERIFIED-BD-API]** =
> confirmed by probing BD's live read-only API. **[NEEDS BD CONFIRMATION]** = a BD-platform capability
> that only the BD admin panel or BD support can confirm (not visible from code or the read API).

---

## 0. Executive summary

- **The join key already exists.** BD's unique member id (`user_id`) is *already* stored on every
  imported organization as `bd_listing_id`. A logged-in BD member can be matched to their Advantage
  organization by `bd_listing_id = BD user_id` today — **[VERIFIED-RAILWAY]**.
- **BD exposes member identity + membership level** via read-only API (`user_id`, `email`,
  `subscription_id`, `subscription_name`, `is_subscription_active`) — **[VERIFIED-BD-API]**.
- **Nothing links a BD *member* to a Railway *user* today, and no tier is derived from BD.** Imports
  link the *company listing*, not the person; `plan_tier` always defaults to `free` and is only ever
  set by an admin. There is no SSO/OAuth/handoff/identity code anywhere — **[VERIFIED-RAILWAY]**.
- **One capability decides everything:** can BD **securely sign a short-lived token** for its
  logged-in member (server-side), **or** fire **webhooks** on membership events, **or** offer a
  native **SSO/OAuth** add-on? None of these are exposed on the read API — **[NEEDS BD CONFIRMATION]**.
- **Recommendation:** confirm that one BD capability first (§4 has the exact questions). If BD can
  sign server-side (or provide a webhook/SSO), build **Option B (signed handoff)** — it meets your
  end state exactly. If BD cannot, fall back to **Option A+C hybrid** (verified-email auto-link +
  passwordless login + subscription→tier automation) — one login step, still zero manual admin.
- **PR #83 can merge now, independently of this bridge** (§7).

---

## 1. Current identity flow (verified)

### Railway (bid.advantage.bid) — **[VERIFIED-RAILWAY]**
- Login issues a **stateless JWT** (`{id, role}`, HS256, 24h) returned in the JSON body; the browser
  holds it in `localStorage` and sends `Authorization: Bearer`. **No cookies, no SSO, no BD session.**
- **Org ownership** = a row in `organization_members` with `role='owner' AND status='active'`
  (`assertOwner`). The table supports multiple members (`owner|admin|editor|member`).
- **Acting org** is chosen by an `X-Acting-Org-Id` header, validated against active membership
  (admins bypass), else falls back to the user's one primary org.
- **One org per user** in Phase 1: created automatically on a user's first event, *or* claimed from a
  BD-import shell (`organizationLifecycleService.claim` → the claimer becomes `owner`).

### Brilliant Directories — **[VERIFIED-BD-API]**
- Separate hosted platform, separate member accounts, separate login. Advantage calls BD's
  **read-only** API (`GET https://www.advantage.bid/api/v2/user/get`, `X-Api-Key`) once a day.
- BD "members" are directory listings; for a business, the member account *is* the company listing.

### The sync that exists today — **[VERIFIED-RAILWAY]**
- A daily (production-gated) job pulls BD members and upserts each into `organizations` with
  `source='bd_import'` and **`bd_listing_id = BD user_id`**. Matching order: `bd_listing_id` →
  `google_place_id` → `match_key` (`normalize(name)+':'+state`, unambiguous only). BD-owned public
  fields overwrite *unclaimed* shells; *claimed* orgs are preserved; vanished listings are soft-flagged.
- `bd_metadata` stores `profession_id`, `subscription_name` (a free-text hint — **captured but unused**),
  `listing_type`, `zip`, images. **No BD member↔Railway user link. No tier derived from BD.**

---

## 2. What BD exposes (identifiers) — **[VERIFIED-BD-API]**

`GET /user/get` returns paged member records (347 members). Per member, the relevant fields:

| Purpose | BD fields | Notes |
|---|---|---|
| **Unique member id** | `user_id` | Stable primary key (e.g. `"4"`). Already stored as `bd_listing_id`. |
| **Email / name** | `email`, `first_name`, `last_name`, `full_name` | Email is present and usable as a soft match. |
| **Company** | `company`, `member_type`, `listing_type` | `listing_type` e.g. `"Individual"`. `company` is free text. |
| **Membership level** | `subscription_id`, `subscription_name`, `is_subscription_active` | `subscription_id` (e.g. `"3"`) is the reliable key; `subscription_name` can be null; `is_subscription_active` gives active/expired. |
| **Trust / provenance** | `verified`, `status`, `active`, `signup_date`, `last_login`, `google_id`, `facebook_id`, `ref_code` | |
| **Session-ish (do not rely on)** | `sid`, `bd_security`, `form_security_token`, `logged_user` | Present in the record; **not** a documented SSO mechanism — treat as opaque, confirm with BD before using for auth. |

So BD gives us, per person: **a stable id, an email, and their membership level + active status.** That
is enough to identify a member and map their tier — the open question is only *how BD proves who is
currently logged in* (§3–4).

---

## 3. Does BD support SSO / OAuth / webhooks / a login bridge?

Probed the live API for `membership/get`, `subscription/get`, `plan/get`, `webhook(s)/get`,
`sso/get`, `oauth/token`, `login`, `token/get` — **all returned HTTP 200 with an empty body**, i.e.
the "unknown path" response. **[VERIFIED-BD-API]**

What that means, and what it does **not** mean:
- **Not exposed via the read API.** There is no REST endpoint to list memberships, register webhooks,
  or start an OAuth flow with this key. Membership data lives *inside* the `/user/get` record.
- **This is not proof the BD platform lacks these features.** In Brilliant Directories, **webhooks,
  SSO, and custom login flows (if available) are configured in the BD admin panel or via add-ons**,
  not through the read API. So the API probe cannot answer the capability question — the BD admin can.

**[NEEDS BD CONFIRMATION] — the exact questions to ask BD (support or the admin panel):**
1. **Server-side custom code:** Can a BD page/template/widget run **server-side code (PHP)** that (a)
   reads the currently-logged-in member's fields and (b) computes an **HMAC signature** using a secret
   we store in BD? (This is what makes a secure signed handoff possible.) Or is custom code
   **client-side only** (which would expose any secret)?
2. **Member merge tokens:** Which member fields are available as template tokens on a logged-in BD
   page (e.g. `user_id`, `email`, `subscription_id`)?
3. **Webhooks:** Does the plan support outbound **webhooks** for member events — *new member,
   membership upgrade/downgrade, cancellation, expiration, profile update*? If yes, what payload and
   what auth/signature?
4. **Native SSO/OAuth:** Does the plan offer an **SSO or OAuth provider** capability (SAML/OIDC, or a
   "login with BD" flow), via core or an add-on?
5. **Team/sub-accounts:** Can **multiple people** belong to one company listing (team members), or is
   each person a separate `user_id` that merely shares a `company` name?
6. **Subscription catalog:** The list of `subscription_id` → plan name values, so we can map them to
   Gold Retailer / Silver Retailer / Individual / Appraiser.

Questions 1, 3, and 4 are the ones that decide which option below is buildable.

---

## 4. How things work today (answers to your specific questions)

- **4 — How is a BD member matched to an imported org?** Not by *member*; by *company listing*.
  `bd_listing_id = BD user_id`, then `google_place_id`, then `match_key(name+state)` (unambiguous
  only). **[VERIFIED-RAILWAY]**
- **5 — Is email matching reliable/safe?** **No, not on its own.** Email is a convenient *soft* match,
  but BD and Railway emails can differ, emails change, and anyone could register a Railway account
  using a BD member's email. Email must never be the security boundary. The **safe** key is a
  **signed BD `user_id`** from a trusted handoff (or an emailed verification code). Use email only to
  *enrich/soft-match*, never to grant org access by itself.
- **6 — How does Railway authorize org management today?** A JWT identifies the user; org access
  requires an active `organization_members` row (owner for writes). Acting org via `X-Acting-Org-Id`.
  **[VERIFIED-RAILWAY]**
- **7 — How do BD levels map to `plan_tier`?** **They don't, yet.** `plan_tier` defaults to `free`;
  the only setter is admin `PUT /api/admin/partners/:orgId/plan`. A mapping table (`subscription_id`
  → `plan_tier`) must be built and applied automatically. **[VERIFIED-RAILWAY]**

---

## 5. Recommended handling of your eight scenarios

These assume the bridge links on a **trusted BD `user_id`** (from a signed handoff or verified email)
and adds a small `bd_identity_links` mapping (`bd_user_id ↔ railway_user_id`) plus a
`bd_subscription_map` (`subscription_id → plan_tier`).

1. **New BD member clicks Create Event (first time).** Verify the handoff → no Railway user yet →
   create a passwordless Railway user, record the identity link, find the org by `bd_listing_id =
   user_id` and make them `owner` (claim the existing BD-import shell; if none exists yet, create one
   or fetch on demand), set `plan_tier` from `subscription_id`, issue a Railway session. **No admin.**
2. **Existing Railway user, same email.** Do **not** create a duplicate. Attach the BD `user_id` to
   the existing Railway user (the signed handoff is the proof), then link to the org. If there is no
   signed handoff and only an email match, require a one-time verification (emailed code) before
   linking.
3. **BD and Railway emails differ.** Link on the **signed BD `user_id`**, not email — email mismatch
   is then a non-issue. In an email-only model (Option A without a handoff), an email mismatch means
   you **cannot** auto-link; fall back to a verification code or admin review. This is the single
   biggest reason not to rely on email alone.
4. **Multiple users in one company.** Railway already supports multi-member orgs (`owner/admin/editor`).
   The primary/paid BD member becomes `owner`; additional BD members mapping to the same company join
   as `editor`. **[NEEDS BD CONFIRMATION]** whether BD models teams (sub-accounts) or just separate
   `user_id`s sharing a `company` name — that determines whether we can auto-group them or must have
   the owner invite staff.
5. **Upgrade / downgrade / cancel / expire.** Re-map `subscription_id → plan_tier` and call the
   existing `setPlanTier` (which auto-reconciles capabilities). **With webhooks:** real-time. **Without
   webhooks:** the daily sync (and/or a re-check at each handoff) applies changes within ~24h.
   Cancellation/expiry (`is_subscription_active=false`) → downgrade to a no-listing tier; **[OWNER
   DECISION]** what happens to already-published events (keep visible, or unpublish/hide).
6. **Two organizations appear to match.** Keep the current conservative rule: **ambiguous → do not
   auto-link; flag for admin review.** Never guess between two orgs for a real person.
7. **Imported org has no linked owner.** This is the normal first-time path: the first BD member whose
   `user_id` matches the shell **claims it** and becomes `owner` (existing claim flow), gaining
   capabilities at that moment.

---

## 6. Options memo

### Option A — Separate logins + secure account/organization linking (no SSO)

- **User experience:** The member still signs in on Railway (once), but the **first** time they do,
  Railway auto-recognizes them — matched by verified email to their BD member record (`user_id`),
  auto-connected to the right org, and their tier set from their BD subscription. No manual admin.
  (Passwordless magic-link makes this feel like one step.)
- **BD-side requirements:** None beyond the existing read API. (Nice-to-have: webhooks for real-time
  tier changes; otherwise daily sync.)
- **Railway-side requirements:** email-verification/magic-link login; a `bd_identity_links` table; a
  `subscription_id → plan_tier` map; auto-claim of the matching BD-import org; apply tier on link.
- **Security:** Strong *if* linking requires a verified email (a code the user must retrieve) — never
  email string-match alone. No secret shared with BD; nothing to leak on the BD side.
- **Organization ownership:** claimer of the matching shell becomes `owner`; extra staff invited.
- **Membership sync:** daily (or webhook, if BD supports it) → `setPlanTier`.
- **Migration of existing accounts:** on next login, existing Railway users are matched + linked;
  BD-import shells already exist to claim.
- **Failure/recovery:** email undeliverable → user can't self-link → admin can link manually; email
  mismatch → verification required; no single point of auth failure (native login still works).
- **Scope:** **Small–medium.** No BD engineering. Passwordless login + linking + tier map.
- **Meets end state?** Mostly — *correct org + tier + no manual admin*, **but keeps a Railway login
  step** (not true "click-through" SSO).

### Option B — One-way BD→Railway signed SSO handoff *(target end state)*

- **User experience:** Logged into BD, the member clicks **Create Event / Manage Events** and lands on
  Railway **already signed in**, on the right org, with the right tier. No second login, no admin.
- **BD-side requirements:** BD must **securely generate a short-lived signed token** for the logged-in
  member (containing `user_id`, `email`, `subscription_id`, timestamp, nonce) using a **shared secret
  stored on the BD side** — which requires **server-side custom code (PHP) or an equivalent** on BD.
  **[NEEDS BD CONFIRMATION — question 1/3/4 in §4].** If BD can only run client-side code, the secret
  would be exposed and this option is **not safe** as-is (use a webhook or a tiny owner-hosted signer
  instead).
- **Railway-side requirements:** a `POST /api/auth/bd-handoff` endpoint that verifies the signature +
  expiry + nonce (replay protection), upserts the user, links `bd_user_id`, claims/attaches the org,
  applies the tier, and issues a **native Railway JWT**. Independently disable-able. (The integration
  contract already specifies these exact requirements.)
- **Security:** Strong and standard (HMAC-signed, ≤5-min expiry, nonce, HTTPS). **No passwords copied;
  Railway issues its own session; BD never holds a Railway session.** The one risk is secret handling
  on the BD side — hence the capability question.
- **Organization ownership:** the handoff's `user_id` deterministically resolves the org (via
  `bd_listing_id`); first arrival claims → `owner`.
- **Membership sync:** tier is applied at every handoff (always current) + daily sync as backstop;
  webhooks (if available) for instant cancellation handling.
- **Migration of existing accounts:** transparent — first handoff links an existing Railway user by
  `user_id`; email match used only to detect/merge duplicates.
- **Failure/recovery:** bad/expired/replayed token → rejected, fall back to native Railway login;
  handoff endpoint can be disabled without affecting native login; BD outage doesn't lock anyone out.
- **Scope:** **Medium.** Railway: one endpoint + linking + tier map + nonce store. BD: a signing
  snippet (small *if* server-side code is allowed; otherwise needs a webhook or a small signer proxy).
- **Meets end state?** **Yes — exactly.** This is the only option that delivers click-through, no
  second login, correct org + tier, zero admin, Railway-issued session, no password sync.

### Option C — Native BD-supported integration (if one exists) / passwordless hybrid

- **What it is:** Use whatever BD *natively* supports, confirmed in §4: **(c1) webhooks** — BD pushes
  member/membership events; Railway pre-provisions the user, org link, and tier so that by the time
  the member arrives, everything is ready (pair with a light handoff or magic-link for the session);
  or **(c2) a native SSO/OAuth add-on** — use it directly as the identity provider; or **(c3) a
  passwordless email link** (no BD code at all) as the safe universal fallback.
- **User experience:** c1/c2 ≈ Option B (seamless); c3 ≈ Option A (one magic-link step).
- **BD-side requirements:** entirely dependent on **[NEEDS BD CONFIRMATION]**. c3 needs nothing from BD.
- **Railway-side requirements:** webhook receiver (c1) / OAuth client (c2) / magic-link (c3) + the same
  linking + tier map.
- **Security:** c2 (native SSO) is the cleanest if it exists; c1 webhooks need signature verification;
  c3 is safe by construction (verified email, no shared secret).
- **Everything else** (ownership, sync, migration, recovery): as Option A/B depending on the variant.
- **Scope:** c1 medium, c2 small–medium (if the add-on exists), c3 small.
- **Meets end state?** c1/c2 **yes**; c3 mostly (keeps one login step, like A).

---

## 7. Recommendation

1. **Confirm BD capabilities first** (the six questions in §3) — specifically whether BD can
   **server-side-sign a token**, fire **webhooks**, or offer **native SSO**. This one answer selects
   the option; building before confirming risks a dead end.
2. **If BD can sign server-side (or webhook/SSO exists): build Option B** (signed handoff) — it is the
   only path that fully meets your end state (click-through, no second login, correct org + tier, zero
   admin, Railway session, no password sync). It also reuses everything already true: `bd_listing_id`
   is the org key, `setPlanTier` applies tiers, `organization_members` handles ownership.
3. **If BD cannot sign securely: build the Option A + C3 hybrid** — verified-email auto-link +
   passwordless magic-link + subscription→tier automation. It still delivers *correct org, correct
   tier, no manual admin*; it just keeps a single (passwordless) login step on Railway. This needs
   nothing from BD and is a safe universal baseline you can ship regardless.
4. **Regardless of option, build two small shared pieces now-ish (post-confirmation):** a
   `bd_identity_links` table (`bd_user_id ↔ railway_user_id`, with how it was verified) and a
   `bd_subscription_map` (`subscription_id → plan_tier`) applied automatically at link/sync — these are
   identical work for A, B, and C.

**My recommendation:** pursue **Option B**, gated on BD confirming server-side signing (or a webhook).
Ship **A+C3** as the safe fallback/baseline if BD can't. Do not rely on email alone for linking under
any option.

---

## 8. Should this block PR #83?

**No — PR #83 can merge independently, and the identity bridge should be its own subsequent PR.**

- PR #83 is **additive and inert**: it changes no auth code, adds no BD member-facing entry point, and
  does nothing until (a) migration 093 is applied, (b) orgs are assigned tiers, and (c) you embed the
  BD widgets. Merging it does **not** expose Events to BD members.
- The identity bridge is **net-new, separate work** (a new endpoint + linking tables + tier map +
  BD-side signing) that touches none of PR #83's files. It does not belong inside PR #83.
- **The one coupling to manage is placement, not code:** do **not** publish the BD member-facing
  "Create Event / Manage Events" link until the bridge exists — otherwise a BD member who clicks it
  lands on a Railway login they can't satisfy. **Read-only public browsing widgets** (the unified feed,
  city/company event lists) are safe to embed anytime, because browsing needs no login.

**Recommended sequence:** (1) merge PR #83 when you're ready (behind the scenes; still gated by migration
+ tier assignment + embed). (2) Embed only the **read-only** discovery widgets publicly. (3) Confirm BD
capabilities (§3). (4) Build the identity bridge as its own PR (Option B or A+C3). (5) Only then publish
the BD member-facing "Create Event" entry point. Marketplace Events stays fully usable by *admins and
directly-onboarded organizers* throughout; it simply isn't offered to BD members until step 5.

---

*Investigation only. Railway facts verified from code; BD identifiers verified from the live read API;
BD SSO/webhook/server-side-signing capabilities are flagged [NEEDS BD CONFIRMATION] and must be verified
with BD before any option is chosen or built. Nothing was implemented.*
