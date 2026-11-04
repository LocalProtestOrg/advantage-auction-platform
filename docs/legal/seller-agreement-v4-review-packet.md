# Seller Agreement version 4: review packet (prepared 2026-11-04; NOT published)

Status: awaiting owner approval of the wording and counsel review of the flagged sentence. Nothing is published until the
owner approves.

## What changes
Compared with production version 3 (read-only comparison, 2026-11-04), **only Section 6.9 changes**. Every other section,
including the auction fees in 6.7, is word-for-word the same.

| | Version 3 (in force) | Version 4 (proposed) |
|---|---|---|
| Storefront commission | flat 11% of the item price | 5% Website Sale / 9% Marketplace Sale, on the item price |
| Card processing | included | included (no separate Processing Fee) |
| Shipping and sales tax | excluded from the fee base | excluded from the fee base |
| Monthly or listing fee | none | none |
| Auction fees (6.7) | unchanged | unchanged |
| Classification | n/a | recorded on each order from Advantage's systems; no manipulation |
| Review and correction | n/a | review on request within 60 days after the payout; verified errors corrected by an adjustment on the next payout statement, with a record kept |

## Effect when published
- Version 4 applies to agreements sent from then on. Versions 1 to 3 and every signed agreement stay exactly as they are.
- Every professional seller, including waived ones, must sign version 4 before publishing NEW storefront items (owner
  decision 2026-11-03). Their dashboards, auctions, settings, drafts, imports and items already on sale are not affected.
  The first time such a seller publishes, version 4 is sent to them automatically (or send it from Admin > Agreements).
- The Lewis & Maese administrator verification override is separate from the agreement rule and is not changed.
- The commission-correction mechanism the text promises is built (migration 217, Admin > Storefront Orders > Correct
  commission; PR #84). Deploy PR #84 before or together with publishing version 4.

## Proposed Section 6.9 (complete text)

6.9 **Professional sellers — Storefront fixed-price commission.** Fixed-price items that a professional Seller sells through its Advantage.Bid Professional Storefront (not by auction) are subject to a commission on the item selling price (the "Storefront Fee"), which depends on where the sale originates:

- **5% of the item selling price** for a sale that originates on the Seller's own website through the Advantage.Bid embedded storefront, where the shopper continues from that embedded storefront to Advantage.Bid checkout (a "Website Sale"); and
- **9% of the item selling price** for every other sale, including a sale that originates on the Advantage.Bid marketplace or website, a search engine, or a direct or shared link (a "Marketplace Sale").

The Storefront Fee includes standard card and payment processing; no separate Processing Fee applies to Storefront fixed-price sales. Shipping charges and sales tax are not included in the amount on which the Storefront Fee is calculated. There is no monthly storefront subscription and no listing fee. The Storefront Fee is charged only when an item sells through Advantage.Bid checkout. The Storefront Fee is separate from, and does not change, the auction Platform Fee and Processing Fee in Section 6.7 or any other auction fee, which apply only to auction (hammer-price) sales.

Advantage determines whether a sale is a Website Sale or a Marketplace Sale from the information its systems record when the order is created, and records the classification and the applicable rate on each order. The Seller must not attempt to cause a sale to be classified other than as it originated, including by manipulating links, codes or the embedded storefront. If the Seller believes a sale was classified in error, the Seller may request a review by contacting Advantage within 60 days after the payout that included the sale. If Advantage verifies an error, it will correct the Storefront Fee for that sale by an adjustment shown on the Seller's next payout statement, and will keep a record of the correction. Advantage's decision after review is final for the purposes of the Storefront Fee, without limiting any other right either party has under this Agreement or applicable law.

## For counsel (flagged)
1. **"Advantage's decision after review is final for the purposes of the Storefront Fee"**: is this enforceable as
   written, and does it need to sit with the agreement's dispute-resolution clause (or reference it)? The trailing words
   ("without limiting any other right either party has...") are meant to avoid waiving statutory rights; confirm they do.
2. **The 60-day review window**: reasonable and enforceable for a commission-classification dispute?
3. **Manipulation**: the clause prohibits it but states no remedy. Should it reference termination, fee recovery or
   another existing remedy in the agreement?
4. Confirm the defined terms ("Storefront Fee", "Website Sale", "Marketplace Sale") do not collide with other defined
   terms in the agreement.

## Publish procedure (owner approval required; not done)
1. `railway run node scripts/prod-publish-seller-agreement-version.js` (dry run; 2026-11-04 it reported
   "publish Seller Agreement version 4 (current 3); new body md5 05628d5b9703fdd9cc5e2dcfb641b00a").
2. If the text changes after counsel, the md5 changes; dry run again and compare.
3. `railway run node scripts/prod-publish-seller-agreement-version.js --apply --reason="Storefront commission 5% / 9%"`, then confirm version 4 is current and
   marked with the storefront terms (migration 216 marks it from its own text).
