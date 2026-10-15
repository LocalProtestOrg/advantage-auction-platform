# Professional Seller buyer's premium: validation and default (proposal for owner approval)

Prepared 2026-10-15. **No code or data has been changed.** Existing auctions keep the terms frozen at publication.

## Owner policy (2026-10-14)

Individual Seller auctions: fixed 18% buyer's premium. Professional Sellers set their own premium under their seller
agreement and platform permissions. Advantage.Bid imposes no universal 18% minimum or 25% maximum on Professional Sellers.

## What the software does today

| Where | Behaviour |
|---|---|
| `src/services/auctionService.js` ~366–371 (Professional self-service edit) | Rejects a premium above **2500 bps (25%)**: "Buyer premium must be a whole number between 0% and 25%." |
| `src/services/auctionService.js` ~375–378 (admin edit) | Same **25%** ceiling; Individual Seller overrides rejected (correct, keep). |
| `public/seller-create.html:364` | Premium input `max="25"`, placeholder `18`. |
| `src/services/billingTermsService.js` `effectiveBuyerPremiumBps` (lines 23, 33–37) | Professional rate = auction override, else the seller's current `seller_terms.buyer_premium_pct`, else **18% default**. Individual = fixed 18% (correct, keep). |
| Invoices / settlements | Use the effective rate frozen onto the auction at publication (correct, keep). |

Phone Sasha no longer states any Professional range or default (fixed 2026-10-14, commit 92891a7).

## Conflicts with the policy

1. **25% ceiling:** a Professional Seller whose agreement allows more than 25% cannot enter it.
2. **Silent 18% default:** a Professional auction published without a premium is charged 18%, a rate the seller never
   chose.

## Proposed policy

1. **Validation:** replace the 25% business ceiling with a technical sanity bound of **0–100% (0–10000 bps), whole basis
   points**, the same in the Professional and admin paths and in the seller form. This only rejects impossible values
   (negative, over 100%, typos like 1800 entered as a percent). Individual Seller rules are unchanged (fixed 18%, no
   override).
2. **Default:** no silent default for Professional Sellers. A Professional auction cannot be published until it has an
   explicit premium. The seller form pre-fills the seller's current `seller_terms` rate when one exists, and shows an empty
   field otherwise; publish validation explains what is missing. Admins can still set it.
3. **No retroactive change:** auctions already published keep their frozen premium; the new rules apply to drafts and
   future publications only.
4. **Optional:** if you want a ceiling per agreement, store it on the seller's pricing agreement and validate against
   that instead of a platform-wide number.

## Tests to add with the change

- A Professional premium of 30% (3000 bps) is accepted in the Professional and admin paths; 100.01% and negative values
  are rejected; a non-integer bps value is rejected.
- An Individual Seller still cannot set any premium (fixed 18%).
- A Professional auction with no premium cannot be published; one with a premium can; the published premium is frozen.
- An already-published auction's premium is unchanged by the new validation.
- `effectiveBuyerPremiumBps` for a Professional auction never returns the 18% fallback once the publish rule is in force.

**Decision needed:** approve items 1–3 (and say whether you want item 4), and I will implement them with the tests above.
