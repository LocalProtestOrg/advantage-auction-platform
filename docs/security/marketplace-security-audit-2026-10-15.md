# Advantage.Bid marketplace security audit: 2026-10-15

Read-only review of the codebase across six areas (authorization, authentication/sessions, payments, input handling,
privacy, configuration/webhooks/dependencies), then verification of each high/medium finding against the code before
fixing. No production data was read or changed by the audit. Fixes are in the commit that adds this file; every fix
has regression tests (`tests/security-audit-2026-10-15.test.js`, `tests/payment-intent-orphan.test.js`,
`tests/sasha-phone/*`).

## Fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | Any seller could create an auction directly in `published`/`active` state (`POST /api/auctions` took `state` from the body), skipping review, the 30-lot minimum, verification and compliance. | Non-admins always create in `draft` (`routes/auctions.js`). |
| 2 | High | An Individual Seller with a submitted (locked) auction could self-declare a Professional type and regain editing, reserves, starting bids and increments. | Self-service upgrade refused (409, contact Advantage.Bid) once the seller has any auction past draft (`routes/sellers.js`). |
| 3 | High | Any user could set their organization type to a professional type and have events auto-published with no review (and bypass the estate-sale review path). | Auto-publish only for organizations with `verification_status = 'verified'`; others go to the review queue (`services/eventsService.js`). |
| 4 | High | A buyer could be charged twice for the same lot: per-lot "Pay Now" plus the combined invoice (combined payments have `lot_id` NULL, so the duplicate check never saw them). | Per-lot charges refused (409 `USE_COMBINED_INVOICE`) when combined invoicing is on or a combined invoice exists; the combined total excludes lots already paid on their own (`paymentService.js`, `combinedInvoiceService.js`). |
| 5 | High | Stored XSS in the admin dashboard from any seller's draft auction title (admin token theft). | All values escaped (`public/admin/index.html`). |
| 6 | High | Stored XSS on the public homepage map popups and cards from auction/event titles and cities. | Escaped with `mpEsc` at all sinks (`public/index.html`). |
| 7 | Medium | Phone and website 4-digit code lockout could be bypassed by requesting a new code before the last attempt (about 12 guesses per hour per account, never locked). Live risk since Phone Sasha went public. | Lockout counts wrong guesses across all codes in the window, including superseded and expired ones (`sasha/phone/verification.js`, `accountPhoneService.js`). |
| 8 | Medium | Any user could create image-processing jobs for another seller's lot, replacing its public photo and running processing on the platform account. | Seller/admin only and only for the caller's own lot or auction; job reads scoped the same way (`routes/imageProcessing.js`). |
| 9 | Medium | Bid history and bid responses exposed bidders' account UUIDs (cross-auction tracking, against paddle-number identity). | Responses carry amount/time/`is_mine` / `viewer_is_high_bidder` only; bid log no longer prints ids (`routes/lots.js`, `bidService.js`). |
| 10 | Medium | Stored XSS on the buyer invoice page from the auction title. | Escaped (`public/dashboard/invoice.html`). |
| 11 | Medium | `add-card.html?next=` accepted `javascript:` and off-site URLs; login / verify-phone / sign-agreement checks could be bypassed with a tab character. | One same-origin helper (`safeInternalNext`) on all four pages. |
| 12 | Medium | Registration sent mail to any string, including comma-separated lists (spam from our domain). | Exactly one valid address, max 254 characters (`routes/auth.js`). |
| 13 | Medium | Anonymous Socket.IO path used `engine.io`/`ws`/`socket.io-parser` versions with known memory-exhaustion issues. | `engine.io` 6.6.11 (bundled `ws` 8.21.3), `socket.io-parser` 4.2.7, direct `ws` 8.22.0. |
| 14 | Low | Percent-encoded paths (`/%61dmin/...`) bypassed the private-page gate (page code only; APIs still protected). | Gate decodes and normalizes the path before matching (`middleware/htmlAuthGate.js`). |
| 15 | Low-Med | Organization website/logo/cover URLs accepted `javascript:`. | http(s) only (`services/organizationsService.js`). |

## Needs an owner decision (not changed)

| Finding | Recommendation |
|---|---|
| **Sessions cannot be revoked** (Medium): logout and password reset do not end other sessions; renewal keeps a stolen token alive; a role removed in the database survives in the token; demoting a super admin does not clear `role='admin'`. | Add a per-user token version checked on each request; bump it on password reset, logout-everywhere, suspension and role change; re-read role on renewal; clear `role` on staff demotion. Changes the session/credential model, so it needs your approval. |
| **Sellers receive winning buyers' emails** in auction reports (including Individual Sellers). | Decide whether sellers may see buyer emails; if not, show paddle numbers and keep emails for admin/finance. |
| **Realized prices of closed lots** are visible to signed-out visitors via the public lot APIs and JSON-LD, unlike `/api/lots/*`. | Apply the existing logged-in-only rule to those endpoints if it is still policy. |
| **Content Security Policy is off** and the login token is readable by scripts (localStorage). | Add CSP in report-only mode first, then move to the HttpOnly session cookie only. |
| **nodemailer 8 → 10** (major upgrade; address-parser denial of service). Mitigated now by the single-address registration check. | Schedule the major upgrade with email regression testing. |
| **Professional buyer's premium** 25% cap and 18% default. | See `docs/projects/professional-buyer-premium-policy-proposal.md`. |

## Lower priority (recorded for follow-up)

- Bid close time is not re-checked inside the locked bid transaction (millisecond window at close).
- `GET /api/auctions` lists submitted/under-review auction titles without sign-in; `/api/auctions/:id/summary` exposes a private seller's profile id.
- PII in some logs (emails on auth errors and unpaid-invoice sends).
- Login brute force limited per IP only; emails not case-normalized (case-variant duplicate accounts).
- Public `/api/health` returns operational detail; database TLS does not verify the certificate.
- Event-import fetches follow redirects without blocking private addresses (admin-registered feeds).
- Two seed scripts lack a production guard; 500 MB video uploads are buffered in memory.
- Sasha chat's daily budget can be exhausted by one anonymous visitor (cost is capped; service degrades to staff handoff).
- `socket.io-adapter` still bundles `ws` 8.18.3 (not on the network path).

## Checked and sound (summary)

JWT handling and cookie flags; registration role; password reset and email verification tokens; Stripe webhook
signatures, idempotency and mode checks; server-computed charge amounts; refunds and payouts (admin-only, bounded,
idempotent); Buy Now holds; payment links; SQL (parameterized throughout); server-rendered HTML escaping; widgets;
private document storage; Twilio, SES/SNS and Meta webhook verification; no committed secrets; CORS; Phone Sasha tool
permission guard.
