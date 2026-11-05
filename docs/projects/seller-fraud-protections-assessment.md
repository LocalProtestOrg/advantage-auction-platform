# Seller Fraud and Platform Protections: Assessment Before Auction Shipping

Read-only code audit, 2026-11-05, of the production code (main@855e258, audited from the PR #85 branch, which changes no payment, payout or account code). It describes the platform BEFORE auction shipping Phase 1 (this branch); see docs/projects/auction-shipping-spec.md for what Phase 1 adds. No files were changed during the audit, no migrations were run and production was not contacted. Line numbers refer to that code.

Scope note: "exists" means found in code. "Not found" means a targeted search did not locate it, not proof of absence. Nothing here can guarantee that a determined fraudster is identified; the goal is to make fraud costly, slow the money, and preserve evidence.

## Summary table

| # | Area | Exists today | Gap | Proposed (smallest change, reusing existing pieces) | Priority before auction shipping |
|---|------|--------------|-----|------------------------------------------------------|------|
| 1 | Stripe Connect identity / business verification | Stripe-hosted Express onboarding (v2 recipient, transfers only); status mirrored from Stripe; transfers require `stripe_transfers` and `payouts` both active; business verification gate (`publicationGate`) for professionals; storefront checkout refuses sellers who cannot be paid | Connect account id / status changes are not written to `audit_log`; manual "Mark Paid" (check/ACH) path does not require Connect at all, so a check-paid seller has only self-reported identity | Audit every Connect status/account-id change in `stripeConnectService.syncAccountById` / `ensureConnectAccount`; for shipping-enabled sellers require Connect ready (reuse `connectPayoutReady`) before the shipping capability can be used | Required (audit), Recommended (Connect required for shipping sellers) |
| 2 | Risk-based seller approval and shipping permission | `sellerTypeRules.shippingAllowed` enforced server-side on auction create/update and lot create/update; admin-only, audited `capabilities` endpoint and admin UI toggle; `risk_level` and `verification_required_before_publication` admin controls | `risk_level` is advisory only (stored and displayed, never enforced); shipping capability is a single on/off switch with no value cap or review trigger | Make `risk_level='high'` hold settlements by default (one check in the two pay guards); optionally a `shipping_max_lot_cents` capability key read by the same `shippingAllowed` call sites | Recommended |
| 3 | Payout holds and disputes | Admin-only money movement; `charge.dispute.*` recorded, payout held, audited, owner alerted; open dispute blocks every pay path; storefront per-order hold, buyer-issue hold, refund-after-payout recovery ledger; transfer reversal webhook alert | Auction settlements have no admin "place hold" / "release hold" route (only the dispute webhook can set `on_hold`, and nothing releases it); no time-based hold after fulfillment; no recovery ledger for auction refunds after payout; suspended seller payouts are not blocked | Add admin hold/release for `seller_payouts` mirroring `storefrontSettlementService.setHold`; add `users.is_active` to both pay guards; for shipped lots, payout eligible only N days after "shipped" with no open buyer issue | Required (hold/release, suspension guard), Required for shipping (delay) |
| 4 | Tracking and delivery evidence | Storefront: carrier + tracking required to mark shipped; tracking immutable once recorded (DB trigger); ship-to address frozen on the order; append-only order history | Auction lots: no ship-to capture, no fulfillment status, no tracking fields; storefront "complete" (delivered) is seller-declared with no buyer confirmation or carrier check | Reuse the storefront `FULFILL` model for auction lots (shipped requires carrier+tracking, immutable; delivered/complete step); payout gate reads it | Required (auction shipping cannot launch safely without it) |
| 5 | Signature requirements | E-signature for agreements only | Delivery signature: not found | Policy text plus a seller-attested "signature required" flag above a value threshold, recorded on the shipment; no carrier integration yet | Later (Recommended for high value) |
| 6 | Audit trail for address and payout-detail changes | Audited: seller identity (field names only), admin contact edits, seller capabilities/type/fee, suspensions, card saves, prepaid refusals; storefront ship-to immutable | Payout preference changes (method switch, check payee/mailing address, ACH last4) are not audited and nobody is notified; Connect account replacement not audited; buyer tax address edit not audited | One `writeAuditLog` call with before/after field names in `payoutPreferenceService.upsertSellerPayoutPreference` and `payoutProfileService.upsert`; seller email "your payout details changed"; flag settlement for review if details changed within 7 days of payment | Required |
| 7 | Suspicious account / transaction patterns | Prepaid card refusal at save and at storefront pay; SetupIntent card verification; card required to bid; self-bid guard; passive duplicate warnings (phone, email, name+address); message screening for off-platform payment; per-account login throttle | No transaction velocity or value rules; watchdog is site health only; self-bid guard covers only the owner's own user id (not seller staff); no shared-card linking | Extend self-bid guard to active `seller_staff_members`; admin-surfaced (never blocking) "new seller, high value, shipping" review flag at settlement; on-demand card fingerprint comparison for admins | Recommended |
| 8 | Suspension and related accounts | Suspension sets `is_active=false`, ends all sessions (`session_version`), blocks all state-changing requests, blocks login, registration and storefront sales; audited; admin can end sessions | Suspension does not hold payouts or pause the seller's live auctions; related-account linking limited to `duplicateWarnings` | Payout guard on `is_active` (see 3); admin view listing the seller's live auctions on suspend; extend `duplicateWarnings` with Connect account reuse and staff overlap | Required (payout guard), Recommended (rest) |
| 9 | IP / device signals and rate limits | `express-rate-limit` global and strict tiers, per-route limiters; per-account login lockout; HMAC-hashed IP for messaging and analytics; `trust proxy` set; agreement signing stores IP + user agent | No login history (IP/time/user agent) for investigations; no device fingerprinting (consistent with policy); rate limits only active in production | Optional `login_events` (user, time, hashed IP, coarse user agent, short retention) for investigation only, never for bans or identity | Later |
| 10 | Evidence preservation | `audit_log` (no FKs, survives deletes); storefront orders, order events, issues, messages, staff events, commission adjustments protected by DB triggers; settlement snapshots with immutable final; webhook events stored | `audit_log` and `bids` have no DB-level immutability; `bids` cascade on lot/user/auction delete; admin hard delete allowed for auctions with bids but no payments; no Stripe dispute evidence submission | Append-only trigger on `audit_log` (same pattern as migration 217); add "has bids and is not draft" as a hard-delete blocker; dispute evidence pack (export of existing records) for admins | Recommended (trigger, blocker), Later (evidence pack) |

## Cross-cutting: seller isolation and admin-only high-risk actions

Exists:
- Lot and image mutations require auction ownership (fix 2026-10-12, regression test `tests/lot-ownership-enforcement.test.js:1-12`; ownership joins at `src/routes/lots.js:28-91`, 403 at `src/routes/lots.js:342`, `src/routes/lots.js:467`).
- Auction update restricts by seller ownership and field lists; admin-only fields at `src/services/auctionService.js:245-248`.
- Seller deletion limited to drafts, money-guarded (`src/routes/auctions.js:542-569`, `src/services/auctionService.js:587-606`).
- Storefront: order belongs to the item's real seller; fulfillment checks `o.seller_id !== seller.id` (`src/services/marketplaceOrderService.js:1121`); adversarial test `tests/storefront-ownership-adversarial.test.js`; DB refuses a seller buying their own item (`db/migrations/197_storefront_order_integrity.sql:38-50`).
- Seller staff RBAC with per-permission checks and recorded staff actions (`src/middleware/requireSellerPermission.js:21-53`), one company per person (`db/migrations/199_seller_staff_accounts.sql:29-30`).

Admin-only (role `admin`, most with idempotency and audit):
- Suspend / unsuspend seller (`src/routes/admin.js:248`, `src/routes/admin.js:283`), member status and end sessions (`src/routes/adminUsers.js:132`, `src/routes/adminUsers.js:139`).
- Seller capabilities incl. `shipping_enabled` (`src/routes/admin.js:322-358`), seller type (`src/routes/admin.js:364`), platform fee (`src/routes/admin.js:415`).
- Verification review and risk (`src/routes/adminVerification.js:21` router-wide admin; risk `:41`, duplicates `:50`).
- Auction refunds (`src/routes/admin.js:1014`), storefront refunds and payout holds (`src/routes/marketplaceOrders.js` admin routes near lines 172 and 197).
- Settlement mark paid and Direct Deposit (`src/routes/adminSettlements.js:73`, `:90`), storefront payout hold / release / pay (`src/routes/adminStorefrontPayouts.js:17`, `:32-35`).

## 1. Stripe Connect identity and business verification

Exists:
- One Express connected account per seller, Accounts v2 recipient configuration, requests only the transfers capability; platform is merchant of record and losses collector (`src/services/stripeConnectService.js:104-121`). Stripe-hosted onboarding via Account Links (`:141-153`). Advantage stores only account id, status flags and bank display fields, never routing or full account numbers (`:6-11`). This matches data minimization: Stripe holds identity and taxpayer data.
- Status mapping: `stripe_transfers.status === 'active'` and `payouts.status === 'active'`, `requirements.summary.minimum_deadline.status` (past_due / currently_due) for details-submitted, first `status_details.code` as disabled reason (`src/services/stripeConnectService.js:29-58`). Readiness = transfers active AND payouts active (`:61-63`).
- Status is re-read from Stripe (never trusted from the payload) on `account.updated` (`src/services/paymentService.js:1857-1859`, `src/services/stripeConnectService.js:157-190`); `payout.failed` records a disabled reason (`:194-205`).
- Payout gating: Direct Deposit refuses unless `connectPayoutReady` (`src/services/settlementEngine.js:495-497`, `:513`); storefront payouts use the same readiness (`src/services/storefrontSettlementService.js:9-10`); storefront checkout refuses a seller who cannot be paid, plus suspended, unverified, or without the signed storefront agreement (`src/services/sellerSaleEligibility.js:23-45`).
- TEST-mode accounts are masked under LIVE keys and superseded ids kept for history (`src/services/stripeConnectService.js:65-72`, `:122-136`; `db/migrations/173_payment_mode_isolation_disputes.sql:26`).
- Advantage business verification: `publicationGate` blocks only when `verification_required_before_publication` is set and no approved `verification_requests` row exists (`src/services/verificationService.js:349-360`). Assigning a professional type sets the flag automatically and audits it (`src/services/verificationService.js:388-404`, called from `src/routes/admin.js:404`). Enforced at publish (`src/services/auctionService.js:801-806`) and professional self-publish eligibility (`src/services/auctionService.js:1296-1306`).

Gaps:
- Connect status and account-id changes are persisted without any `audit_log` entry (`src/services/stripeConnectService.js:75-97`, `:122-136`, `:162-169`). An investigator cannot see when a seller's payout account became ready, was restricted, or was replaced.
- `connect_bank_name` / `connect_bank_last4` are always null in v1 (`src/services/stripeConnectService.js:54-56`), so bank changes made inside the Stripe Express dashboard are invisible to Advantage. Stripe notifies the account holder; that is acceptable, but Advantage should at least record the account.updated event.
- The manual "Mark Paid" path (check or out-of-platform ACH) needs only `payoutPreferenceComplete` (`src/services/settlementEngine.js:375-380`); no Connect identity verification is involved. For check payees, identity is self-reported `seller_identity`.
- Not found: any check of specific Connect requirement categories (identity document, TIN verification). Readiness relies on Stripe enabling the capabilities, which Stripe only does when its requirements are met. That is the right dependency; no duplication is proposed.

Proposal (smallest): in `syncAccountById` and `ensureConnectAccount`, read the previous row and write `writeAuditLog({event_type:'seller_connect_status_changed', metadata:{before, after}})` only when status, flags or account id differ. For sellers with `shipping_enabled`, require Connect ready for payout (no check payouts) by adding one condition in the pay guard. No new data collected.

## 2. Risk-based seller approval and shipping permissions

Exists:
- `shippingAllowed`: admin always; professionals always; individuals only when `capabilities.shipping_enabled === true` (`src/services/sellerTypeRules.js:41-50`).
- Enforced server-side at auction create (`src/services/auctionService.js:129-136`), auction update, dropping `shipping_available` silently for non-permitted individuals (`src/services/auctionService.js:271-282`), auction route (`src/routes/auctions.js:219`), lot create and update (`src/routes/lots.js:50-70`, `:312`, `:615`). Seller profile exposes only the boolean, not the capability map (`src/routes/sellers.js:45-47`).
- Admin edit path: audited capabilities endpoint with before/after (`src/routes/admin.js:322-358`) and an admin toggle (`public/admin/moderation.html:2046-2053`).
- Risk controls: `setRisk` (risk_level low/medium/high, notes, verification required), audited (`src/services/verificationService.js:335-347`); admin route `src/routes/adminVerification.js:41`.
- Note: CLAUDE.md still says "shipping toggles are not yet gated by seller type or admin approval (production gap as of 2026-10-12)". The code on this branch does gate them (citations above). The doc line appears stale; confirm what is deployed before relying on either.

Gaps:
- `risk_level` is never enforced; it is only read for display (`src/services/adminMemberService.js:70`, `:89`). Not found: any code path that changes behavior for `high`.
- Shipping is an unlimited switch: no per-lot value cap, no first-sale review, no requirement that the seller be Connect-verified.
- Professionals get shipping automatically, including an unapproved professional before their first sale is approved (publication is gated, so they cannot sell yet, which limits exposure).

Proposal: (a) in `assertMarkPaidAllowed` / `assertPaySellerAllowed` and storefront `payPayout`, refuse when the seller's `risk_level = 'high'` unless the admin passes an explicit override reason (audited). (b) Optional capability key `shipping_max_lot_cents` checked where `shippingAllowed` is already called. Both reuse existing fields and the existing admin endpoint.

## 3. Payout holds and dispute handling

Exists:
- Money moves only on admin action: Direct Deposit (`src/services/settlementEngine.js:524-531`), manual mark-paid records only (`:420-490`), storefront pay (`src/services/storefrontSettlementService.js:226-243`).
- Pay guards refuse when paid, void, on hold, an open dispute exists, processing cost unverified, payout preference incomplete, amount mismatch, or (Direct Deposit) Connect not ready (`src/services/settlementEngine.js:400-424`, `:503-521`). Open-dispute check fails closed (`:388-398`).
- Disputes: `charge.dispute.created/updated/closed` routed through the signature-verified idempotent pipeline (`src/services/paymentService.js:1814-1819`) to `disputeService.handleDisputeEvent`: upsert into `payment_disputes`, hold the auction `seller_payouts` row unless paid or void, hold storefront orders, audit, owner SMS alert, closed never auto-releases (`src/services/disputeService.js:1-196`). A dispute after payment is recorded with the note that recovery is a manual owner decision (`:129-130`).
- Storefront: per-order `payout_hold` (admin, audited) (`src/services/marketplaceOrderService.js:1274-1293`); dispute hold (`:1295-1305`); buyer issue in not_received / not_as_described / damaged / refund_request holds the payout until an admin resolves it (`src/services/marketplaceOrderIssueService.js:15-19`, `:28`, `:74-77`); eligibility SQL excludes held, refunded, reviewed or disputed orders (`src/services/storefrontSettlementService.js:59-64`); payout-level hold/void (`:182-224`); refund after payout creates a recovery deducted from the next payout (`:299-320`), seller-fault processing-cost recovery behind a flag (`:325-336`).
- Transfer reversal triggers an owner alert (`src/services/settlementEngine.js:616-660`).

Gaps:
- Auction settlements: no admin route to place or release a hold. `settlement_status = 'on_hold'` is only set by the dispute webhook (`src/services/disputeService.js:134`), and no code path found sets it back (search for `settlement_status` updates found only the dispute hold and the paid/void transitions). After a dispute is won, the settlement cannot be paid without a direct database edit. Routes in `src/routes/adminSettlements.js:34-90` have recalculate, adjustments, mark-paid and pay-seller only.
- No time-based payout delay after fulfillment for auctions or storefront. Storefront orders become eligible the moment the seller marks `picked_up` or `complete` (`src/services/marketplaceOrderService.js:1106-1111`, `:1139-1140`) and are included in the next Thursday batch.
- Auction refund after payout: not found any recovery ledger (`processRefund` at `src/services/paymentService.js:1302` does not touch `seller_payouts`). Storefront has one; auctions do not.
- Suspended sellers: neither auction nor storefront pay paths check `users.is_active` (no match in `settlementEngine.js` or `storefrontSettlementService.js`).
- Not found: Stripe early fraud warning (`radar.early_fraud_warning.*`) handling.

Proposal:
- Add `POST /api/admin/settlements/:auctionId/hold` and `/release` (reason required, audited with `SETTLEMENT_AUDIT_EVENTS.SETTLEMENT_ON_HOLD` and a new released event), copying `storefrontSettlementService.setHold`. Release refuses while an open dispute exists.
- Add `sellerActive` to both pay-guard state objects and to storefront `payPayout`; message "Seller account is suspended. Review before paying."
- For shipped auction lots and shipped storefront orders: payout eligibility = shipped with tracking, plus N days (owner-set, for example 7 to 14) with no open buyer issue, or buyer confirmation. Implemented as one more condition in the existing eligibility SQL and pay guard.
- Later: reuse `storefront_payout_recoveries` semantics for auction refunds after payout; handle `radar.early_fraud_warning.created` by calling the same hold path as disputes.

## 4. Tracking and delivery evidence

Exists (storefront only):
- Marking shipped requires carrier and tracking number (`src/services/marketplaceOrderService.js:1128-1132`); recorded in `marketplace_orders` and in append-only order events (`:1134-1149`).
- DB trigger: tracking details cannot change once recorded, fulfillment only moves forward and only when paid (`db/migrations/197_storefront_order_integrity.sql`, trigger body at lines 112-128); ship-to address is frozen on the order (same trigger, `NEW.ship_to IS DISTINCT FROM OLD.ship_to` check).
- Purchase snapshot fixes shipping terms at purchase (`src/services/marketplaceOrderService.js:211-221`).

Gaps:
- Auction shipping: `auctions.shipping_available` and `lots.shippable` exist (`src/services/lotService.js:29-61`), but not found: any auction ship-to address capture, auction lot fulfillment status, tracking fields, or a "shipped" step. The auction payout guard asks only for an admin's `confirmedCompleted` (`src/services/settlementEngine.js:514`).
- Auction pickup completion exists but is admin-marked and not linked to payout (`db/migrations/083_pickup_completion.sql:7-10`; no pickup reference in `settlementEngine.js`).
- Storefront "complete" (delivered) is seller-declared; no buyer confirmation, no carrier status check.

Proposal (required before enabling auction shipping): reuse the storefront design rather than building a new one. Per winning lot (or per combined invoice): a buyer ship-to snapshot taken at payment (from the address the buyer enters for tax/shipping, already collected as tax address in `src/routes/payments.js:81`), fulfillment status with the same `FULFILL` transitions, carrier + tracking required and immutable by trigger, and the payout guard reading it. Carrier API tracking verification is later.

## 5. Signature requirements

- Exists: e-signature for seller agreements with IP, user agent and content hash (`src/services/agreementService.js:225-231`).
- Not found: delivery signature requirements, signature confirmation fields, or value thresholds.
- Proposal (later, recommended for high-value lots): an owner-set value threshold above which the seller must attest "signature required" when entering tracking; stored with the shipment record from section 4. No carrier integration and no new buyer data.

## 6. Audit trails for address and payout-detail changes

Exists:
- `audit_log` table (`db/migrations/013_create_audit_log.sql:5-16`) written through `src/lib/auditLog.js` (non-blocking by design, `:10-12`) and `src/services/auditService.js:5-20` (transactional).
- Seller identity changes audited by changed field name only, no values (`src/services/sellerIdentityService.js:43-48`).
- Admin contact edits with before/after (`src/routes/adminUsers.js:161-185`); phone verification start/fail/confirm audited (`src/services/accountPhoneService.js:105`, `:127`).
- Card saved / prepaid refused audited (`src/services/cardService.js:81-97`).
- Storefront default pickup location confirmation audited (`src/services/storefrontService.js:144`).
- Storefront ship-to immutable after order creation (section 4).

Gaps:
- Seller payout details: `PUT /api/payout-preferences/me` (`src/routes/payoutPreferences.js:30-32`) and `PUT /api/payout-profile/me` (`src/routes/payoutProfile.js:65-71`) write `seller_payout_preferences` with no audit entry and no notification (`src/services/payoutPreferenceService.js:11-49`, `src/services/payoutProfileService.js:21-57`). A takeover of a seller account could switch payout to check and change the mailing address shortly before an admin marks the settlement paid, with no trace.
- `payoutPreferenceComplete` accepts a seller-entered `ach_account_last4` as "complete" for the manual ACH path (`src/services/settlementEngine.js:378`), and `ach_account_last4` is writable by the seller (`src/services/payoutPreferenceService.js:6`).
- Connect account changes: not audited (section 1).
- Buyer tax address update (`src/routes/payments.js:81`): no audit found.

Proposal (required): one `writeAuditLog` call in each of the two upsert functions with `changed_fields` (names only, same pattern as `sellerIdentityService`), a seller notification email using the existing email service, and in the pay guards a "payout details changed in the last 7 days" condition that requires an admin override reason. No new fields collected.

## 7. Suspicious account and transaction patterns

Exists:
- Card verification via SetupIntent, no charge (`src/services/cardService.js:55-66`); prepaid refused only on explicit `funding === 'prepaid'`, unknown allowed (`src/services/cardService.js:15-18`, `:76-84`), route returns 422 (`src/routes/payments.js:112-113`); storefront pay refuses non-card (`src/services/marketplaceOrderService.js:662`).
- Card on file required to register and bid (`src/services/auctionRegistrationService.js:49`, `:159`); suspended accounts cannot register (`:34-36`).
- Self-bid guard inside the locked bid transaction (`src/services/bidService.js:241-258`).
- Passive duplicate warnings for sellers: same phone, same email, same legal name + address; admin-surfaced, never blocking (`src/services/verificationService.js:406-438`; route `src/routes/adminVerification.js:50`).
- Message screening: contact details hidden, off-platform payment and diversion requests held for review; hashed-IP and per-party limits (`src/services/storefrontMessagingService.js:17-20`, `:37-45`, `:139-140`).
- Login per-account throttle (`src/lib/loginThrottle.js:1-20`), phone code throttles (`src/services/accountPhoneService.js:18`).

Gaps:
- Not found: transaction velocity or value rules (for example a new seller's first high-value shipped sale, many wins by new buyer accounts, repeated failed payments).
- Watchdog (`src/services/watchdog/*`, migration 210) checks site health only, not fraud.
- Self-bid guard compares only the auction owner's user id; seller staff members (`seller_staff_members`) of that company can bid.
- Not found: card fingerprint storage or linking (`card_verifications` stores only the PaymentMethod id, `src/services/cardService.js:87-90`).

Proposal (recommended, proportionate): extend the self-bid query to also refuse active staff of the auction's seller (one `OR EXISTS` on `seller_staff_members`). Add an admin-only, non-blocking review flag at settlement time ("first sale, shipped, above $X", "payout details changed recently"), shown in the settlement workbench. For related accounts, let an admin compare Stripe card fingerprints on demand (retrieve PaymentMethods) instead of storing them; if storage is later justified, store only the opaque fingerprint. No automated accusations or blocks.

## 8. Account suspension and related-account controls

Exists:
- Suspension = `users.is_active = false` (migration 046), sessions ended everywhere via `session_version` (`src/routes/admin.js:248-281`, `src/services/adminMemberService.js:355-370`, `db/migrations/194_session_revocation.sql:1-21`).
- Every state-changing request from a suspended account refused, reads allowed, fail-closed when status is unknown (`src/middleware/authMiddleware.js:44-84`); login refused (`src/routes/auth.js:135-141`); storefront sales refused with a neutral message (`src/services/sellerSaleEligibility.js:28-31`).
- Admin "end sessions" (`src/services/adminMemberService.js:373-380`); last-admin and self-lockout protection (`:361-362`).
- Tests: `tests/suspended-account-session.test.js`.

Gaps:
- Suspension does not block payouts (section 3) and does not pause or flag the seller's published auctions (no `is_active` reference in `src/lib/marketplaceVisibility.js`); a suspended seller's live auction keeps running and settling.
- Related accounts: only `duplicateWarnings` (phone, email, name+address). Not found: linking by Connect account, payout check address, shared card, or device.

Proposal: payout guard (required); on suspend, return the list of the seller's live auctions to the admin so they can decide to hold or unpublish using existing admin actions (recommended); add "same check payout address" and "same Connect account id" to `duplicateWarnings` (recommended, reads existing columns only).

## 9. IP / device signals and rate limiting

Exists:
- Global `normalLimiter` (60/min) on the API router, `strictLimiter` (10/min) on payments and bids (`src/routes/index.js:13-17`, `src/middleware/rateLimit.js:9-21`); login, forgot and reset password strict (`src/routes/auth.js:110`, `:297`, `:312`); register normal (`:35`); bids (`src/routes/bids.js:8`); payments (`src/routes/payments.js:148`, `:173`, `:206`). Many public endpoints have their own limiters (for example `src/routes/sashaChat.js:21`, `src/routes/eventIntake.js:26-31`, `src/routes/publicConsent.js:13`).
- `trust proxy` set to 1 so `req.ip` is the proxy-seen address (`server.js:89`).
- Per-account login lockout independent of IP: 8 failures in 15 minutes locks 15 minutes, same response for unknown emails (`src/lib/loginThrottle.js:1-20`; `src/routes/auth.js:116-131`). State is in memory per instance.
- IP storage: HMAC-hashed for messaging rate limits (`src/services/storefrontMessagingService.js:65-71`, `db/migrations/205_storefront_item_messaging.sql:43`) and analytics (`src/services/analyticsService.js:67`, `db/migrations/044_create_analytics_events.sql:41`); hashed for SMS consent (`db/migrations/189_bidder_phone_sms_paylinks.sql:42`); plaintext IP + user agent on agreement signatures as signing evidence (`db/migrations/056_create_agreements.sql:44`, `src/services/agreementService.js:225-231`); password reset requests store the IP (`src/services/passwordResetService.js:88`).
- Device fingerprinting: not found; `src/services/behavioralIdentityService.js:9` states no fingerprint-based identity.

Gaps:
- `strictLimiter` and `normalLimiter` are skipped outside production (`src/middleware/rateLimit.js:7`, `:12`, `:19`), so they are never exercised in staging.
- Not found: a login history (time, hashed IP, user agent) for account-takeover investigations; only `last_login_at` (`src/routes/auth.js:145`).

Proposal (later): a small `login_events` record (user id, time, HMAC-hashed IP, coarse user agent, success/failure) with a fixed retention window, readable by admins only, used to support an investigation and never to ban an address or identify a person. No device fingerprinting and no IP bans.

## 10. Evidence preservation

Exists:
- `audit_log` has no foreign keys so rows survive entity deletion (`db/migrations/013_create_audit_log.sql:1-3`); admin hard delete writes a snapshot before deleting (`src/services/auctionService.js:621-637`).
- DB-enforced permanence: storefront orders cannot be deleted and key fields cannot change (`db/migrations/197_storefront_order_integrity.sql:38-50`, guard trigger at `:144`); order events append-only and issues keep their parties and words (`:189-217`); messages kept permanently and never rewritten (`db/migrations/205_storefront_item_messaging.sql:115-130`); moderation events and reports (`db/migrations/198_storefront_moderation_reports.sql:59-82`); staff events (`db/migrations/199_seller_staff_accounts.sql:89-94`); commission adjustments append-only (`db/migrations/217_storefront_commission_adjustments.sql:60`).
- Settlement snapshots versioned, final snapshot unique and immutable (`src/services/settlementEngine.js:454-458`); paid settlements frozen (`:333`).
- Disputes stored with evidence due date and event ids (`src/services/disputeService.js:92-122`); Stripe webhook events stored for idempotency.
- Reviewer access to messages is logged (`src/services/storefrontMessagingService.js:11`).
- No retention purge found for `audit_log`, `bids`, `payments` or `payment_disputes` (searches for retention/purge found only marketing and transcript data).

Gaps:
- `audit_log` immutability is by convention only; no trigger found preventing UPDATE or DELETE.
- `bids`: no immutability trigger; `ON DELETE CASCADE` from lots and users (`db/migrations/011_create_bids.sql:3-4`); admin hard delete of an auction with bids but no payments is permitted and removes the bids, keeping only counts in the audit snapshot (`src/services/auctionService.js:587-606`, `:615-619`).
- Not found: Stripe dispute evidence submission or an admin export assembling evidence (bids, invoice, payment, tracking, messages) for one sale.

Proposal (recommended): append-only trigger on `audit_log` using the migration 217 pattern; make "non-draft auction with bids" a hard-delete blocker (archive instead). Later: an admin "evidence pack" export that assembles existing records for a disputed sale; no new data collection.

## Suggested order before enabling auction shipping

1. Auction lot shipment record reusing the storefront fulfillment model (tracking required, immutable), plus payout eligibility delay after shipping with no open buyer issue (sections 3, 4).
2. Admin hold/release for auction settlements; suspension and recent payout-detail change checks in all pay guards (sections 3, 6, 8).
3. Audit entries for payout preference and Connect account changes, with seller notification (sections 1, 6).
4. Then recommended items: risk_level enforcement, staff self-bid guard, audit_log trigger, hard-delete blocker, review flags.
