# BD → Advantage.Bid Seamless Login — Feasibility Proof (Option B)

**Status:** Narrowly-scoped feasibility proof. **No full bridge, no production auth change, PR #83
untouched.** The only new code is a **standalone, non-production** test server
(`scripts/poc/bd-bridge-poc-server.js`) that is not imported by the app.
**Date:** 2026-07-22

> **Division of labor (important):** I built **both code sides** (the Railway test endpoint and the
> BD Developer Hub snippets) and the **per-capability probe**. I cannot log into your BD Developer
> Hub, so **you run the one ~15-minute BD-side test** and read off PASS/FAIL. Below each capability I
> state exactly what PASS looks like and my engineering assessment of the likely result.

**Chosen architecture: Option B (server-minted opaque code)** — matches your preferred diagram and is
the safer design: the secret and all security-critical minting/verification live on **Railway** (fully
controlled); **BD only makes one authenticated outbound call.** (Option A comparison in §6.)

---

## 0. Live probe results — 2026-07-22 (BD Widget Manager PHP widget)

Ran `CAP2_PROBE_TEMP` (inline PHP in a **Widget Manager** HTML widget) rendered via a **"Custom Widget
as Web Page"** page (`/cap2-probe-temp`, access **"Only Allow Members"**), opened while logged in as a
**normal member (id `367`), not an admin**. Editor note observed on the widget's HTML box: *"supports
HTML, CSS, Javascript and PHP; you can not create php functions."* — the probe complies (built-in calls
only, no custom function declarations).

| Capability | Result |
|---|---|
| CAP 1 — logged-in member id read **server-side** | **PASS** (printed `367`) |
| CAP 2 — **server-side PHP execution** | **PASS** (printed `42`) |
| CAP 2 — **cURL available** | **PASS** (`yes`) |
| CAP 3 — **outbound HTTPS POST** from BD | **PASS** (HTTP `200`) |
| CAP 4 — **secret/source protection** (secret + PHP absent from View Source) | **PASS** (all 4 strings `PROBE-DUMMY-SECRET-DELETE-ME`, `PROBE-DUMMY-SECRET`, `<?php`, `curl_init` NOT found in View Source) |

### ✅ COMPLETE CAPABILITY PROBE PASSED — 2026-07-22

**Final feasibility conclusion:**
- BD **Widget Manager can execute trusted server-side PHP.**
- The widget can **identify the logged-in BD member** server-side (proven as normal member `367`, not admin).
- **cURL is available.**
- BD can make **outbound HTTPS POST** requests (received HTTP `200`).
- **PHP source and server-side secrets remain absent from the browser source.**
- **Therefore the trusted BD side of the Option B identity bridge is technically feasible using
  existing BD tools** — with no new authentication platform or recurring software required on the BD side.

(Minor, non-blocking: `\n` rendered as literal `n` in the probe output — a BD editor escaping quirk;
the bridge widget uses `<br>` / JS redirect, not `\n`. Does not affect any capability result.)

## 1. What the proof demonstrates (the flow)

```
BD logged-in launch page  (custom page/widget, server-side)
   │  reads authenticated member id server-side
   ▼
BD server → HTTPS POST  →  Railway PoC /auth/bd/exchange   (auth: X-Bridge-Key secret, server-only)
   │                          Railway mints a 256-bit, single-use, ~120s opaque code
   ◄── { redirect_url } ──    tied server-side to { bd_user_id, dest, exp, nonce }
   │
   ▼  server-side redirect (browser carries ONLY the opaque code)
Railway PoC /auth/bd/return?code=…   consumes once, verifies single-use + unexpired
   → (full bridge would then: fetch BD member via API, verify status/subscription, link/create user,
      apply tier, set session, redirect to the allowlisted destination — the PoC stops at "verified".)
```

## 2. Railway side (already built — standalone, non-production)

`scripts/poc/bd-bridge-poc-server.js`. Deploy it to a **throwaway/non-prod host** (a scratch Railway
service, or run locally + expose via a tunnel). It uses **no database, creates no session, touches no
user record.** Start it with:

```
POC_BRIDGE_SECRET="<a long random string, 24+ chars>"  POC_PUBLIC_URL="https://<this-host>"  node scripts/poc/bd-bridge-poc-server.js
```

- `POST /auth/bd/exchange` — requires header `X-Bridge-Key: <POC_BRIDGE_SECRET>` (constant-time
  compare); body `{ bd_user_id, dest }`; validates numeric id + allowlisted dest; returns
  `{ redirect_url }` with a 256-bit single-use code (120s TTL).
- `GET /auth/bd/return?code=…` — consumes the code once; rejects unknown/replayed/expired; shows a
  harmless success page. **No session, no user records.**

## 3. BD side (you paste this into Developer Hub — templates to adapt to BD's exact API)

Two artifacts: **(A) a capability probe** (proves caps 1–4 with a clear readout) and **(B) the full
Option-B launch page** (proves caps 5–7). Store the bridge secret using **BD's server-side
configuration** (a constant/setting), **never** echoed into page HTML.

### 3A. Capability probe — a Developer Hub custom page (server-side), require login

```php
<?php
// --- BD Developer Hub: custom PAGE with server-side code, gated to logged-in members. ---
// Goal: prove (1) we can read the authenticated member id server-side, (2) code runs server-side,
// (3) outbound HTTPS works, (4) the secret never appears in page source.

// (1) Authenticated member id. Prefer BD's server-side member accessor if one exists in your build;
//     otherwise the [me=user_id] shortcode. The probe reveals which resolves to a real number.
$member_id = trim('[me=user_id]');                 // BD resolves this for the logged-in member
if ($member_id === '' || $member_id === '[me=user_id]' || !ctype_digit($member_id)) {
    // (6) anonymous / unresolved → send to BD login, preserving return
    header('Location: /login/?return=' . urlencode('/bridge-probe'));
    exit;
}

// (4) Secret comes from BD server-side config, NOT from the page. Adapt to your BD secret store.
$bridge_secret = getenv('BD_BRIDGE_SECRET');        // or a BD server-side constant/setting
$railway = 'https://<your-nonprod-host>/auth/bd/exchange';

// (3) server-side outbound HTTPS POST
$ch = curl_init($railway);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 8,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Bridge-Key: ' . $bridge_secret],
    CURLOPT_POSTFIELDS => json_encode(['bd_user_id' => $member_id, 'dest' => 'dashboard']),
]);
$resp = curl_exec($ch);
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err  = curl_error($ch);
curl_close($ch);

// Readout — NEVER print $bridge_secret.
header('Content-Type: text/plain');
echo "CAP 1 (member id server-side): " . (ctype_digit($member_id) ? "PASS (id length " . strlen($member_id) . ")" : "FAIL") . "\n";
echo "CAP 2 (server-side execution): " . (function_exists('curl_init') ? "PASS (php+curl ran)" : "FAIL (no server PHP)") . "\n";
echo "CAP 3 (outbound HTTPS POST):   " . ($http === 200 ? "PASS (Railway 200)" : "CHECK (http=$http err=$err)") . "\n";
echo "CAP 4 (secret hidden):         verify by View Source of this page — the secret must NOT appear.\n";
echo "Railway response: " . $resp . "\n";
```

### 3B. Full Option-B launch page — the real handoff (proves caps 5–7)

```php
<?php
// --- BD Developer Hub: the "/launch" custom page. Same login gate + secret handling as 3A. ---
$member_id = trim('[me=user_id]');
if ($member_id === '' || $member_id === '[me=user_id]' || !ctype_digit($member_id)) {
    header('Location: /login/?return=' . urlencode('/launch?to=' . urlencode($_GET['to'] ?? 'dashboard')));
    exit;
}
// (7) preserve the intended destination as an allowlisted ROUTE KEY (never a URL)
$allowed = ['dashboard','create-event','manage-events','create-auction','manage-auctions'];
$dest = in_array(($_GET['to'] ?? 'dashboard'), $allowed, true) ? ($_GET['to'] ?? 'dashboard') : 'dashboard';

$bridge_secret = getenv('BD_BRIDGE_SECRET');
$ch = curl_init('https://<your-nonprod-host>/auth/bd/exchange');
curl_setopt_array($ch, [CURLOPT_POST=>true, CURLOPT_RETURNTRANSFER=>true, CURLOPT_TIMEOUT=>8,
  CURLOPT_HTTPHEADER=>['Content-Type: application/json','X-Bridge-Key: '.$bridge_secret],
  CURLOPT_POSTFIELDS=>json_encode(['bd_user_id'=>$member_id,'dest'=>$dest])]);
$resp = json_decode(curl_exec($ch), true); curl_close($ch);

// (5) redirect the browser using ONLY the opaque code returned by Railway
if (!empty($resp['redirect_url'])) { header('Location: ' . $resp['redirect_url']); exit; }
http_response_code(502); echo 'Bridge unavailable — please try again.';
```

> **BD-API-surface caveats to confirm during the test** (the probe reveals these):
> - Does `[me=user_id]` resolve **before** the PHP runs, or is there a BD PHP accessor/session global
>   for the member id? (If the shortcode is literal in PHP, use BD's member accessor instead.)
> - Where does BD let you store a **server-side secret** (constant, setting, or env)?
> - Is `curl`/outbound HTTP allowed from custom-page PHP, and are there timeouts/egress limits?

## 4. Test procedure (you run this)

1. Deploy `bd-bridge-poc-server.js` to a non-prod host with a strong `POC_BRIDGE_SECRET` + `POC_PUBLIC_URL`. Hit `/healthz` → `{ok:true}`.
2. In BD Developer Hub, create a **logged-in-only** custom page `/bridge-probe` with snippet **3A**; set `BD_BRIDGE_SECRET` to the same secret via BD's server-side config; set the Railway host.
3. **Logged out**, open `/bridge-probe` → expect redirect to BD login (**cap 6**).
4. **Logged in as a test member**, open `/bridge-probe` → read the CAP 1–3 lines; **View Source** and confirm the secret is absent (**cap 4**). Check the Railway PoC logs show the inbound POST (**cap 3**).
5. Create `/launch` with snippet **3B**. Open `/launch?to=create-event` logged in → you should be redirected to `…/auth/bd/return?code=…` on the Railway host, landing on the ✅ PoC page echoing your member id + the mapped destination (**caps 5, 7**).
6. **Reuse the same `?code=` URL** → expect “Replay blocked” (single-use). Wait >2 min and try a fresh flow’s code late → “Expired” (**replay/expiry**).
7. Edit the `to=` to a non-allowlisted value → server falls back to `dashboard` (**allowlist holds**).

### Success criteria per capability
| # | Capability | PASS looks like |
|---|---|---|
| 1 | Logged-in member id via BD context | CAP 1 = PASS, id is your real numeric BD `user_id` |
| 2 | Truly server-side execution | CAP 2 = PASS (php+curl ran); output is not raw template text |
| 3 | Outbound HTTPS POST to Railway | CAP 3 = PASS (Railway 200); PoC logs show the POST |
| 4 | Secret stays server-only | Secret absent from View Source, page JS, URL, and PoC logs |
| 5 | Redirect with opaque code | Browser lands on `/auth/bd/return?code=…`; no member id in the URL |
| 6 | Anonymous → BD login → continue | Logged-out probe redirects to BD login and returns after |
| 7 | Preserve intended destination | `to=create-event` maps to the allowlisted create-event route |

## 5. Feasibility assessment (the required output points)

- **Exactly where the BD code lives:** a BD **Developer Hub custom page** (e.g. `/launch` and the
  probe `/bridge-probe`), gated to logged-in members; the bridge secret in BD's **server-side config**.
  A custom **widget** works too if it supports server-side code; a custom **page** is the cleanest.
- **Truly server-side?** **This is the one empirical unknown** and the whole proof turns on it. Your
  account has Developer Hub + cron + MySQL, which strongly implies server-side PHP is available; the
  probe's CAP 2 line confirms it definitively. **Assessment: very likely YES.**
- **How the authenticated member id is obtained:** from BD's authenticated context — the `[me=user_id]`
  shortcode or a BD server-side member accessor. The probe confirms which resolves server-side to a
  real number. The value is **never trusted from the browser** — BD reads it from its own session.
- **Outbound HTTPS?** Standard PHP `curl` if server-side execution is available (CAP 3). Confirm no
  egress restriction/timeout on the BD host.
- **Secrets server-only?** Yes by construction — the secret is used only inside server-side PHP and is
  never emitted; CAP 4 verifies it's absent from source/JS/URL/logs. The **BD API key is not involved**
  in the handoff at all (member-fetch happens later, Railway-side, in the full bridge).
- **Redirects?** Yes — a server-side `header('Location: …')` to the Railway host with only the opaque
  code (caps 5, 7). Trivial and reliable.
- **BD caching behavior:** the launch/probe page **must be per-member and uncacheable** (logged-in,
  no full-page CDN cache) so member A never receives member B's response. Defense-in-depth: even if a
  page were cached, the code is minted per-request, single-use, and short-lived, so a stale cached code
  fails safe (already-used/expired). **Action:** mark the page no-cache / logged-in-only and verify two
  different members get different codes.
- **Developer Hub limitations to watch:** (a) whether custom-page code is full PHP vs template-only;
  (b) shortcode-resolution order vs PHP; (c) a server-side place to store a secret; (d) outbound egress
  limits/timeouts; (e) CDN caching of custom pages. The probe surfaces all five.
- **Option A vs B — which is safer with these tools (§6).**
- **New paid service required?** **No.** Uses Developer Hub custom code + Railway + Neon. No Auth0/
  Okta/Clerk/WorkOS/Firebase. (If BD later says custom-page PHP needs their paid custom-dev service,
  that's a one-time BD cost, not a recurring auth bill — and the redirect-to-Railway-login fallback
  avoids even that.)
- **The exact blocker, if any:** **only capability 2** — can BD custom-page code execute server-side
  PHP (curl + a server-only secret)? If CAP 2 = PASS, the whole Option-B bridge is buildable securely
  with no new paid service. If CAP 2 = FAIL (template/client-only), the seamless bridge via a custom
  page is not securely possible; the fallbacks are (i) a **BD form-triggered webhook** POSTing to
  Railway (async — workable but more complex), or (ii) the free, secure **redirect-to-Railway-login**.

## 6. Option A vs Option B — which is safer here

Both need the same capability 2 (server-side execution + a server-only secret). Given that:
- **Option B (recommended):** the secret is a simple **bearer credential** BD sends to Railway; all
  crypto (random code, single-use, expiry, verification) lives on **Railway**. Less security-critical
  logic on the less-controlled BD side; the credential is trivially rotatable; nothing to get wrong in
  BD's HMAC implementation. **Safer + simpler with these tools.**
- **Option A (BD-signed HMAC assertion):** BD must correctly build + HMAC-sign the assertion and
  protect a signing key. More crypto responsibility on BD, more ways to implement it subtly wrong.
  Viable, but no advantage over B here.

**Recommendation: build Option B.**

## 7. If the proof succeeds — what Step 2 will contain (not written yet; contingent on CAP 2 = PASS)

A file-by-file plan for: the production handoff endpoints (`/auth/bd/exchange` server-to-server +
`/auth/bd/return`) with a Neon-backed **hashed, single-use code table**; **account linking**
(`external_identities`, provider=`brilliant_directories`, subject=BD `user_id`, email-verified
confirmation before same-email linking); **organization ownership** (`organization_external_links` +
claim/verify, reusing `bd_listing_id = user_id`); **membership sync** (BD member re-fetch at handoff +
`subscription_id → plan_tier` via `setPlanTier` + unsigned-webhook-as-notification + daily reconcile);
the **unified-dashboard landing** (generic login → the user's own dashboard by role; protected links →
their specific approved destination); the **session upgrade** (HTTP-only Secure SameSite=Lax cookie,
rotation, short expiry); **security tests** (the §4 matrix + the full list from your spec); and a
**rollback plan**. I'll produce it once you confirm the probe's result.

---

*Feasibility proof only. The single new file is a standalone non-production test server, not wired
into the app. No production authentication, cookies, JWTs, user records, memberships, or organizations
were changed; PR #83 and unrelated Marketplace work were not touched. The one empirical gate is BD
custom-page CAP 2 (server-side execution), which only a run in your Developer Hub can confirm.*
