# First live storefront transaction: the owner's own new Professional Seller account (owner decision 2026-11-04)

The first live seller is a **new** Professional Seller account for the owner's independent shop, separate from Lewis &
Maese (whose account is not used or changed for this test). Every step is the owner's action unless marked *(Claude)*.
Purchasing stays closed to everyone else throughout: the controlled pilot opens checkout only for the one listed seller
and the one listed buyer (`MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS` + `MARKETPLACE_CHECKOUT_PILOT_USER_IDS`, both required).

## Before the account is created
1. **Seller Agreement version 4 published** (owner approves §6.9 after counsel; *(Claude)* publishes). Do this first, so
   the new account signs version 4 once at registration instead of signing version 3 and then version 4.
2. **Buyer Terms** approved by counsel and published as the current version (recorded on the order).
3. **Sales tax for the shop's state** (the state where the shop's pickup location is, not Texas unless the shop is there):
   the CPA confirms who remits and whether pickup sales are taxed; *(Claude)* enters the rule in Admin > Storefront Tax
   Rules with its source and date. Without a rule, a taxed order is refused before payment, by design.

## Create and prepare the seller account
4. **Two email addresses you control**, both different from the admin accounts and from Lewis & Maese: one for the
   seller account, one for the test buyer account.
5. **Register the seller:** https://bid.advantage.bid/become-professional-seller.html?seller_type=retail_gallery_studio
   (or the type that fits the shop). Sign version 4 when it is shown.
6. **Business verification:** submit what the verification page asks for; then, as administrator, review and approve it
   in Admin > Verification (the same gate every Professional Seller passes). Only what the form requires is collected.
7. **Storefront:** Storefront Settings: shop name, logo, confirm the pickup location (must be the real pickup address in
   the taxed state), publish the storefront page.
8. **Payout account (Stripe, live):** Payout Profile (`/payout-profile.html`) and complete the payment provider's
   onboarding for the shop's business: business details, owner identity and the bank account. Advantage.Bid does not
   store taxpayer numbers; the provider collects them.
9. *(Claude, read-only)* confirm the account is ready: verified, version 4 signed, pickup confirmed, storefront published,
   payout account live with transfers active and payouts enabled. The seller readiness list
   (Storefront Settings) shows the same, except "Online checkout open", which stays off.

## The controlled purchase
10. **List one inexpensive item** (for example $10), quantity 1, **local pickup only**, with a clear photo.
11. **Register the test buyer** with the second email and save a real card in the account.
12. **Open the pilot** *(owner sets two Railway variables; Claude supplies the two ids, read-only)*:
    `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS=<the new seller company id>` and `MARKETPLACE_CHECKOUT_PILOT_USER_IDS=<the
    test buyer user id>`. The service restarts. From a private window, signed out, confirm the item shows no Buy Now.
13. **Buy it** as the test buyer. Check: the receipt email; the seller's sale notice; the admin notice; stock (sold);
    Admin > Storefront Orders shows the Marketplace Sale at 9% (or a Website Sale at 5% if bought through the shop's
    website widget), tax and its remitter, and the actual card processing fee recorded.
14. **Refund it** in Admin > Storefront Orders (reason required; record who caused it). Check: the buyer's refund, the
    refund email, the order history, tax reversed, and that it is excluded from the weekly payout.
15. **Close the pilot:** remove both pilot variables. Checkout is closed to everyone again.
16. *(Optional, later)* a second purchase that is not refunded, picked up, and paid out through Admin > Storefront
    Payouts (Pay Seller), to test the payout transfer end to end.

**Cost of the test:** the card processing fee is not returned by the payment provider when a payment is refunded, so a
$10 test costs roughly $0.59 (2.9% + $0.30 at standard pricing).
**Rollback at any point:** remove the pilot variables (checkout closes at once). Orders, refunds and payouts stay
manageable in Admin.
