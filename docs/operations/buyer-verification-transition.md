# Buyer safeguards: terms acceptance, confirmed email, bid rate limit

Owner direction 2026-11-06 (branch `fix/buyer-safeguards`). No migration: the email switch lives in `platform_config`
and reads as OFF when its rows are absent.

## What changes on deploy

| Safeguard | State on deploy | Where |
|---|---|---|
| New accounts must tick "I have read and agree to the Terms of Service and Buyer Terms"; the acceptance of the current `buyer_terms` version is recorded in `terms_acceptances` (ip, user agent) in the same transaction as the account | ON | `POST /api/auth/register`, `public/login.html` |
| Accepting the terms (terms page, storefront checkout, registration) records exactly the version shown; a newer version published meanwhile gives 409 `TERMS_CHANGED` and nothing is recorded | ON | `termsService.assertExpectedVersion` |
| Storefront checkout records a `terms_acceptances` row for the current version when the buyer ticks the policies box (the order already stored the version) | ON | `marketplaceOrderService.createOrder` |
| "Our terms have been updated: Review and Accept" notice in the member dashboard for accounts that have not accepted the current version (dismissible, never blocks) | ON | `public/widgets/shared/account-notices.js` in `/app.html` |
| `/terms.html` and `/buyer-terms.html` both render the current `buyer_terms` version from `/api/terms/current` with one safe renderer (headings with anchors, contents list, tables; raw HTML is shown as text; only http(s), mailto, tel, site paths and #anchors become links) | ON | `md-render.js`, `terms-page.js` |
| Bid rate limit per account: 20 bids / 10 s and 120 bids / min; admins exempt; 429 `BID_RATE_LIMITED` | ON in production | `src/middleware/rateLimit.js` (`bidRateLimit`) on `POST /api/lots/:lotId/bids` |
| Confirmed email required to register for an auction or bid | **OFF** (switch) | `buyers.require_verified_email_to_bid`, `src/services/buyerEmailGate.js` |

Existing acceptance rows are never modified. Auction registration and bidding already require acceptance of the
CURRENT version (`termsService.hasAcceptedCurrentTerms`, `tv.is_current = true`), so publishing a new version makes
every buyer re-accept before their next registration or bid; nobody is cut off mid-auction until they next bid, at
which point the lot page shows "Review & Accept Terms" and returns them to the lot after accepting.

### Publishing the full terms (owner)

1. Insert the new `terms_versions` row (`kind = 'buyer_terms'`, next `version_int`, full `body_markdown`).
2. In one transaction: set the old current row `is_current = false`, the new row `is_current = true` (the partial
   unique index allows only one current version).
3. Everyone then sees the update notice in the member area, and the gates ask for acceptance at the next auction
   registration, bid or storefront purchase.

Note: until the full text is published, `/terms.html` shows the current version (v3, the short summary). The long
static text that the page used to show stays in the file only as the labelled fallback for when the current version
cannot be loaded. Make sure the published version keeps the text-message (SMS) program section, because the text
consent wording links to `/terms.html`.

## Bid rate limit

- Key: the signed-in account (`req.user.id`), not the address; households and offices are never limited together.
- 20 bids per 10 seconds is two bids a second, which no person sustains by hand even while racing several lots
  through the final soft-close minutes. 120 per minute keeps that pace for a full minute. Only scripted floods hit it.
- Only bid requests count. Proxy (maximum) bids are resolved inside one request, so automatic bidding, anti-sniping
  extensions and staggered closing are unchanged.
- Skipped outside production like the other limiters (`NODE_ENV !== 'production'`), unless `BID_RATE_LIMIT_ENABLED=true`
  (tests). `BID_RATE_LIMIT_ENABLED=false` turns it off in production without a deploy of code (env change + restart).
- In-memory store per server instance.

## Confirmed email: transition plan (switch ships OFF)

Production at the time of writing: 64 buyer accounts; confirmation was optional until now, so most are unconfirmed.

Who is affected when the switch is turned ON:

- **Established buyers**: accounts created before the switch was turned on that had placed a bid, had an auction
  invoice, or a paid storefront order before then. They keep bidding for the **grace period** (default **30 days**,
  `buyers.verified_email_grace_days`, 0 to 365) and see "Please confirm your email address. You can keep bidding
  until (date)" in the member area with a **Resend Confirmation Email** button. After the grace period they must
  confirm, like everyone else.
- **Everyone else** (new accounts, and existing accounts that never bid or bought): must confirm before registering
  for an auction or bidding. The lot page shows "Confirm Your Email" and `/verify-email.html` offers a one-click
  resend (throttled to one a minute and five an hour per account).
- **Administrators** are exempt.
- Accounts that already confirmed are never affected.

Why 30 days: long enough to span at least one full auction cycle (listing, bidding, close, pickup), so no active
bidder is blocked during an auction they are already in, and short enough that the requirement takes effect within a
month.

Steps:

1. Before turning it on: check the Buyer Management page panel "Terms and Email Confirmation" (unconfirmed buyers
   with bids). Confirm email delivery is healthy (SES DKIM / MAIL FROM; confirmation emails must not land in spam),
   because blocked buyers depend on receiving the link.
2. Optional: email established buyers that confirmation is coming, with the resend link (`/verify-email.html`).
3. Turn on from Admin, Buyer Management, "Turn On Requirement" (audited `buyers.email_verification_config_changed`).
   This records `buyers.require_verified_email_since` and starts the grace period. Turning it off and on again
   starts a new grace period.
4. Watch support contacts and the panel counts during the grace period; extend `grace_days` if needed (it applies
   immediately, counted from the "since" date).
5. Rollback: "Turn Off Requirement". Nothing else changes; no data is altered by the switch.

Welcome email copy follows the switch: optional wording while OFF, "please confirm before you register or bid" while ON.
