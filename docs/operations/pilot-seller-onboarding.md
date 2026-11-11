# Pilot seller: the owner's personal Professional Seller account

Owner decision 2026-11-10: the first controlled storefront pilot uses a **new personal Professional Seller account that
the owner registers through the normal seller signup**, with a **separate buyer account** for the purchases. The pilot
proves that a brand-new professional seller can register, launch a storefront, sell and be paid, before Advantage.Bid
opens to more sellers.

**Lewis & Maese are not part of the pilot.** Their account, inventory, auctions, agreements, policies and financial
records are left exactly as they are: no pilot setting, purchase, refund or payout involves them. (Their readiness and
policy findings from 2026-11-09 stay on record in docs/legal/storefront-terms-review-packet.md for when they launch.)

Nothing here creates an account or changes a production record. The owner registers both accounts.

## Accounts the owner creates

| Account | How | Must not be |
|---|---|---|
| **Pilot seller** | Normal signup, then Become a Professional Seller | Either administrator account (admin@advantage.bid, tylerwitt2015@gmail.com); a business-only "Individual" seller |
| **Pilot buyer** | Normal signup (buyer) | The pilot seller (the database refuses a seller buying its own item) or an administrator account |

Each needs its own email address (one account per address). Record both account ids after signup: they go into the
pilot switch.

## The self-service path (verified in the code, 2026-11-10)

Everything below is done by the seller alone, except **one compliance approval** (business verification).

| # | Step | Where | Who |
|---|---|---|---|
| 1 | Create the account (accepts the Terms of Service and Buyer Terms) | `https://bid.advantage.bid/login.html`, "Create Account" tab | Seller |
| 2 | Confirm the email | link in the welcome email, or `https://bid.advantage.bid/verify-email.html` > Resend Confirmation Email | Seller |
| 3 | Become a Professional Seller: choose a professional type (**Retail Shop, Gallery or Studio** fits a personal shop; Estate Sale Company, Auction House and Professional Liquidator also work), company name, phone | `https://bid.advantage.bid/become-professional-seller.html` | Seller |
| 4 | Sign the Seller Agreement (Version 4, with the storefront terms; issued automatically at step 3) | `https://bid.advantage.bid/sign-agreement.html?current=1` | Seller |
| 5 | Submit business verification | `https://bid.advantage.bid/verify-documents.html` | Seller |
| 6 | **Approve the business verification** | `https://bid.advantage.bid/admin/verification.html` | **Administrator (compliance approval)** |
| 7 | Storefront: slug, branding (logo, banner), tagline, about, publish the storefront page | `https://bid.advantage.bid/seller-storefront.html?tab=store` | Seller |
| 8 | Confirm the storefront pickup location (its state decides the sales tax rule that applies) | same page | Seller |
| 9 | Publish Store Terms and a Shipping & Pickup Policy (both required before anyone can buy) | same page, Store policies | Seller |
| 10 | Set up direct deposit (business details, identity, bank account on the payment processor's secure pages; no password needed the first time) | `https://bid.advantage.bid/payout-profile.html` | Seller |
| 11 | Add items: single items and at least one multi-quantity item; publish | `https://bid.advantage.bid/seller-storefront.html?tab=market` (or the inventory page) | Seller |
| 12 | Website widget: copy the embed code into a page on a website that is not advantage.bid | `https://bid.advantage.bid/seller-storefront.html?tab=widget` | Seller |
| 13 | Check the readiness list: every step done except "Online checkout open" | the Storefront readiness list | Seller |

Facts behind the table: professional signup sets the professional type and the business-verification requirement
(`POST /api/sellers/apply-professional`) and issues the agreement in the app; the first sale is blocked until an
administrator approves verification (`verificationService.publicationGate`). Checkout also requires the signed Version 4
agreement, an active payout account and both published policies; each is self-service.

## Isolation (no effect on other sellers)

- The pilot switch admits ONLY the listed seller AND the listed buyer: both lists must match for checkout to open
  (`launchGuards.marketplaceCheckoutAllowed`). Every other seller and buyer still sees checkout closed.
- Orders, payouts, refunds, problem reports and notifications are tied to the order's own seller (database-enforced).
- **Platform-wide settings to be careful with:** a sales tax rule (Admin > Tax Jurisdictions) applies to every seller in
  that state once checkout is open, and a **Stripe Tax registration applies to auction invoices too** (Stripe Tax is on
  for auctions; today it calculates $0 everywhere because there are no registrations). Adding a registration for a state
  starts tax on that state's auction invoices. The CPA's determination must cover auctions as well as storefront sales.

## What the pilot will test (docs/operations/storefront-first-sale-test-plan.md)

Inventory creation, multi-quantity stock, storefront customization, the website widget, buyer checkout, the 9%
marketplace and 5% website commissions, sales tax per the CPA's determination, refunds, notifications (seller, buyer,
administrator, owner text) and the payout.
