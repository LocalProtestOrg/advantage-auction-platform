# Lewis & Maese: launch actions (first Professional Storefront seller)

Prepared 2026-11-09 from read-only production checks. Seller company `118458af-6b07-4806-86a4-b927d2b0cbed`
(storefront `lewis-and-maese`, professional liquidator, Houston). Nothing here publishes terms, enters tax rules or
turns on purchasing; those stay with the owner's explicit approval.

## Where they stand (production, 2026-11-09)

| Requirement | Status |
|---|---|
| Business verification | Not required (done) |
| Storefront published, pickup location confirmed (Houston), branding shown | Done |
| 9 live items ($180 to $2,400, all pickup, none restricted) | Done |
| Account sign-in | Password account; last signed in 2026-11-02 |
| **Email verified** | **No** |
| **Seller Agreement Version 4** (the version with the storefront terms) | **Not signed** (they signed Version 3; checkout requires Version 4) |
| **Direct deposit (payout account)** | **None** |
| **Store Terms** | **Draft only, not published; does not cover returns** |
| **Shipping & Pickup Policy** | Version 1 published but written for auction winners (no pickup address, hours or method; "Any Item(s) left after 30 days will be forfeited"); an identical Version 2 draft is saved |
| Website on their storefront profile | Yes (needed only for the 5% Website Sale test) |

Every item on this list is something only Lewis & Maese can do from their own account: the agreement is theirs to sign,
the bank and identity details are theirs to give the payment processor, and the policies are their own terms.

## Owner actions

1. **Verify your own administrator emails** (found 2026-11-09: both administrator accounts are unverified, so the
   Admin/Finance sale notice would reach no one). Sign in as each administrator, open
   `https://bid.advantage.bid/verify-email.html` (sign-in required), choose "Resend Confirmation Email", and click the link in the email.
2. **Send Lewis & Maese the message below** (email or phone). Their steps need no action from Advantage.Bid staff.
3. **Check their progress** on their readiness list or ask for a read-only check (the agreement, payout account and
   both policies show as done on their Storefront readiness list once complete).
4. **Review their two published policies** before the pilot (Admin > Storefront Moderation lists published policies;
   Advantage.Bid can withdraw one with a written reason). Flag any forfeiture, storage or disposal wording for the
   attorney (open question 2 in docs/legal/storefront-terms-review-packet.md).

## Message to send Lewis & Maese (ready to use)

> Subject: Getting your Advantage.Bid storefront ready for online purchases
>
> Hi [name],
>
> We're getting ready to switch on online checkout for your Advantage.Bid storefront, and you'll be our first seller.
> There are five short steps. Please sign in at https://bid.advantage.bid with your usual account first.
>
> **1. Confirm your email address.** Open https://bid.advantage.bid/verify-email.html, choose "Resend Confirmation Email",
> and click the link in the email we send you (check your spam folder).
>
> **2. Review and sign the current Seller Agreement.** Open https://bid.advantage.bid/sign-agreement.html?current=1,
> read it and sign. This version adds the storefront terms (5% for sales that start on your own website, 9% for sales
> on the Advantage.Bid marketplace, card processing included). Your earlier signed agreement stays on record, and your
> auctions are not affected.
>
> **3. Set up direct deposit.** Open https://bid.advantage.bid/payout-profile.html and choose Set Up Direct Deposit. Our
> payment processor's secure pages will ask for your business details, the owner's identity and your bank account.
> Advantage.Bid never sees your full bank account number. When you return, the page shows "Direct Deposit Ready" once
> the account is active (sometimes a few minutes, occasionally longer if they need a document).
>
> **4. Publish your Store Terms.** Open https://bid.advantage.bid/seller-storefront.html?tab=store and scroll to Store
> policies. Your Store Terms are saved as a draft but not published yet. Please add your return and refund rules (for
> example, whether sales are final, and what happens if an item is out of stock), then choose Publish.
>
> **5. Update your Shipping & Pickup Policy for online purchases.** In the same place, please make sure your Shipping &
> Pickup Policy tells an online buyer:
> - where to pick up (address) and your pickup days and hours;
> - how to arrange pickup (call, email or appointment) and what to bring;
> - the pickup deadline after purchase; and
> - what happens to items not collected by then (for example, any storage charge or forfeiture), stated clearly so the
>   buyer sees it before paying.
> Your current policy was written for auction winners, so a short storefront version is best. Then choose Publish.
>
> Optional: to receive the lower 5% rate on sales that start on your own website, add the storefront widget to your
> website. The embed code is at https://bid.advantage.bid/seller-storefront.html?tab=widget.
>
> Buyers will see both policies before they pay, and the policies are your own terms: please write them in your own
> words. Online checkout stays off until everything is ready, and we'll do one test purchase with you before it opens
> to the public. Thank you!

## What happens when each step is done (for the owner)

| Step | How to confirm | Notes |
|---|---|---|
| Email | Their account shows verified (read-only check) | Lets them receive account emails reliably; not a checkout requirement |
| Agreement | Readiness: "Seller agreement signed" done | Issued in the app without an email; signing records the signature permanently |
| Direct deposit | Readiness: "Payout account ready" done | First-time setup asks for no password; any later bank change needs their password |
| Store Terms + Shipping & Pickup | Readiness: "Store Terms and Shipping & Pickup Policy published" done; item pages show both links | Checkout refuses orders until both are published |

## Still with the owner after these steps (unchanged)

- Texas sales tax: CPA answers, then the Texas registration in Stripe and the Texas rule in Admin > Tax Jurisdictions.
  Until a Texas rule exists, every Lewis & Maese order is refused (sales tax safeguard, live since 2026-11-09).
- Buyer Terms Version 4 and the Terms of Service section 3A (attorney review, then publication).
- Live webhook events check in the Stripe Dashboard.
- A fresh backup, the pilot switch (owner's buyer account + Lewis & Maese only) and the first-sale test plan
  (docs/operations/storefront-first-sale-test-plan.md).
