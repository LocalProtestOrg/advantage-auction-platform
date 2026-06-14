# Buyer Domain Cutover Plan — https://bid.advantage.bid

**Status: PLAN ONLY.** No DNS, Railway, env, code, or deploy change has been made.
Audit grounded in the current `fix/stabilization-sprint-1` code.

## Current state (audited)
- **Auth/session:** pure JWT in `localStorage` (`Authorization: Bearer`); **no cookies/sessions** anywhere (`authMiddleware.js`; zero `res.cookie`/`express-session`). → A domain change has **no cookie/session impact**.
- **Buyer app:** all in-page links, `next=` flows, and API calls are **same-origin/relative** (`fetch('/api/...')`, `API=''`). → Follow the serving domain automatically.
- **CORS + socket.io origin:** both driven by **`FRONTEND_URL`** (`server.js:86,90,130`), default `http://localhost:3001`. Public discovery/widgets are `*`. The socket.io `cors.origin` is a **single string** — it cannot allowlist two origins at once.
- **Email links:** built from `SITE_URL = process.env.FRONTEND_URL || 'https://advantageauction.bid'` (`src/lib/notificationContent.js:11`, `src/workers/notificationWorker.js:31`). **Prod `FRONTEND_URL` is currently unset → links fall back to `advantageauction.bid` (wrong domain).**
- **Stripe:** card-setup `return_url` is built from `location.origin` (`add-card.html:80`) → follows the domain with no env needed. Webhook is **dashboard-configured + signature-verified** (`payments.js:88`) → no domain assumption in code.
- **Hardcoded URLs:** admin walkthrough-review email defaults to the Railway URL via `SITE_URL` (`auctions.js:330`, admin-facing, env-overridable). SEO `canonical`/`og:url` tags hardcode `https://advantage.bid/` on a few marketing pages (`index.html`, `how-to-buy.html`, etc.). BD widgets hardcode `auctions.advantage.bid` (separate surface). `vercel.json` proxies to Railway (deploy config).

## Target state
- Buyers reach the app at **https://bid.advantage.bid**, served by the **same origin** as the API (Railway custom domain on the prod web service) so socket.io/CORS stay same-origin.
- `FRONTEND_URL=https://bid.advantage.bid` on prod → CORS + socket.io origin + **all email links** point to the real domain.
- Admin stays on the Railway URL for now (no `admin.advantage.bid` yet — recommended future, not launch).

## Env var matrix
| Var | Today (prod) | Set to | Effect |
|---|---|---|---|
| `FRONTEND_URL` | unset (→ fallback `advantageauction.bid`/`localhost`) | `https://bid.advantage.bid` | CORS + socket.io origin + email links |
| `PUBLIC_BASE_URL` | unset (→ `FRONTEND_URL` fallback) | `https://bid.advantage.bid` (or leave to fallback) | seller-agreement email links |
| `SITE_URL` | unset (→ Railway URL) | optional; admin-facing only | admin walkthrough-review email link |
| `BACKEND_URL`, `APP_URL` | n/a | — | **not used anywhere** (no action) |

## DNS / Railway checklist
- [ ] Railway: add custom domain `bid.advantage.bid` to the **production web service** (`advantage-auction-platform`).
- [ ] DNS: add the **CNAME** Railway provides for `bid` → Railway target (do NOT change apex/other records).
- [ ] Wait for SSL cert issuance + domain "active" in Railway.
- [ ] Set `FRONTEND_URL=https://bid.advantage.bid` (and `PUBLIC_BASE_URL`) on the prod service env.
- [ ] Redeploy/restart so the new env is read.

## Code changes required?
**No — for the buyer cutover it is ENV-ONLY**, with two optional decisions:
1. **Dual-origin transition** (serve both `bid.advantage.bid` and the Railway URL during a window): the single-string socket.io `cors.origin` would need a small change to accept a **list/function**. If you cut over cleanly (same-origin app+API on the new domain), **no code change**.
2. **SEO canonicals** (`index.html` etc. point to apex `advantage.bid`): optional; decide whether buyer pages should canonicalize to `bid.advantage.bid`. Not blocking.

## Risk assessment
- **Low.** No cookies/sessions to break; relative links + `location.origin` carry over; webhook unaffected. Main risk = **forgetting to set `FRONTEND_URL`** (emails would keep pointing at `advantageauction.bid`) or a socket.io origin mismatch if app and API end up on different origins.

## Validation checklist (after cutover, Stripe TEST)
- [ ] App loads at `https://bid.advantage.bid`; login/register works.
- [ ] **socket.io connects** (real-time bid updates work) under the new origin (DevTools: no CORS/handshake errors).
- [ ] A test email (outbid) contains **`https://bid.advantage.bid/lot.html?...`** links (not Railway/advantageauction.bid).
- [ ] Stripe card-setup return lands back on `bid.advantage.bid`; webhook still received (check reconciliation block).
- [ ] No buyer-facing Railway URL remains in emails/pages.

## Rollback
- Remove the custom domain / revert `FRONTEND_URL`; buyers fall back to the Railway URL. No data impact. DNS TTL governs propagation.

## Recommendation on timing
Cut over **at the production promotion** (same maintenance window), after the staging validation passes: add the Railway custom domain + DNS, set `FRONTEND_URL`, deploy, then run the validation checklist. It is **env/config, not code**, so it does not gate the staging code validation and can be sequenced as the final promotion step. (Per constraints, none of this is executed yet.)
