# Storefront purchase terms: review packet (owner and attorney)

Prepared 2026-11-09. **Draft; nothing here is published, and nothing here is legal advice or legally certified.**
Documents in this packet:

| File | What it is |
|---|---|
| `docs/legal/buyer-terms-v4-fixed-price.md` | The exact proposed Buyer Terms Version 4 text (Part A auctions, Part B fixed-price) |
| `docs/legal/storefront-purchase-terms-addendum-draft.md` | The fixed-price terms with implementation notes (source of Part B) |
| This file | Conflict register, recommendation, Terms of Service carve-out, Seller Agreement option, attorney questions |

## 1. Recommendation: the simplest safe approach

**Publish Buyer Terms Version 4 = Version 3 unchanged (Part A, auctions) + the fixed-price terms (Part B).** Add one short
carve-out paragraph to the Terms of Service. Leave the Seller Agreement as signed for the pilot.

Why this is the smallest safe change:

- **Versioned acceptance already works.** The app records each buyer's acceptance of a specific Buyer Terms version
  (`terms_acceptances`). Storefront checkout records acceptance of the current version and refuses an order if the version
  changed while the buyer was reviewing. Auction registration requires the current version. No new acceptance system,
  table or migration is needed.
- **Auction rules do not change.** Part A is Version 3, with only these edits: the title and a two-sentence opening that
  explains Part A and Part B; "including proxy/maximum bids" set off with commas instead of long dashes (punctuation only);
  the closing line "These terms will be expanded in a future version" removed. Each auction clause is otherwise word for
  word.
- **One document for buyers.** Buyers see and accept one Buyer Terms page; checkout already links it.

Effects to expect:

- Every buyer who accepted Version 3 is asked to accept Version 4 at their next auction registration or storefront
  purchase. That is the intended versioned acceptance; it adds one click for returning bidders.
- **Version 4 must be published with `includes_sales_near_you = true`.** Version 3 has it, and Part A keeps the Sales Near
  You clause. Without the flag, buyers who accept Version 4 would silently stop being enrolled in Sales Near You.
- Publishing is a database change on production (insert Version 4; switch the current version in one transaction). It
  needs the owner's approval. A guarded script (check, dry run, apply) will be prepared once the text is final; it is
  not written yet so that no publishing tool exists before approval.

Not recommended for now:

- **Folding in the other drafts.** `docs/legal/buyer-terms-v4-draft.md` (2026-10-12, auction pickup changes) and
  `docs/legal/terms-of-service-v4.md` (full rewrite) change auction rules and are still waiting for legal review. Folding
  them in would change auction rules and delay the storefront. Recommend renaming them to the next version (Version 5)
  when they are ready.
- **A separate fixed-price document.** Checkout records only the Buyer Terms version today, so a separate document would
  need new code to record its acceptance.

## 2. Conflict register (every conflict found)

Legend: **Resolved by** = how the proposal handles it.

### Terms of Service (published /terms.html, Last Updated October 7, 2026)

| Section | Conflict with the fixed-price policies | Resolved by |
|---|---|---|
| 3. Platform | "All purchases are transactions between the buyer and the applicable seller. Advantage.Bid facilitates..." Consistent with Part B section 2, but Advantage.Bid is the payment processor and may be the Texas marketplace provider for tax | Attorney question 6 |
| 9. Condition of Items | "All items are sold as is, where is, with all faults"; no guarantee of authenticity, attribution, age, functionality... "Buyer beware." Conflicts with policy 3 (misdescription protection survives "as is") | Carve-out (section 3 below) + Part B section 7 |
| 5. Card on File | Authorizes charging the card for "storage or abandonment fees", "administrative or processing fees", "chargeback fees" and collection costs. Storefront checkout never charges a saved card for such fees, but the clause would permit it, against policy 5 | Carve-out lists section 5 (fees) |
| 6. Personal Information | Does not say a buyer's details are given to the seller | Part B section 2 discloses it; Privacy Policy amendment (section 3 below) |
| 17. Taxes | Exemptions must be "accepted by Advantage.Bid before invoicing or payment". Storefront checkout honors an administrator-approved buyer exemption the same way (the shared tax calculation) | Consistent; no change |
| 18. Invoicing and Payment | Auction invoices; unpaid invoice penalties (forfeiture, processing fees). Storefront is paid at checkout | Carve-out (auction-only) |
| 19. Chargebacks | "You agree not to initiate a chargeback... without first contacting Advantage.Bid"; chargeback fees, collection costs, attorney fees. Part B section 13 says the buyer keeps chargeback rights and is only asked to report first | Carve-out lists section 19 as yielding to Part B; attorney question 5 |
| 20. Pickup and Removal | Auction pickup window; "Do not bid if you cannot attend..."; "shipping is not offered" unless stated | Carve-out (Part B section 8 and the seller's Shipping & Pickup Policy govern) |
| 22. Failure to Pick Up | Abandoned items "forfeited without refund"; alternative pickup fees; disposal "without further notice". Conflicts with policy 2 (the seller's disclosed policy governs; no platform forfeiture) | Carve-out + Part B section 9 |
| 23. Shipping | "Advantage.Bid is not responsible for carrier delays, shipping damage, lost packages..." Part B treats non-delivery as a refund ground | Carve-out + Part B sections 4 and 10 |
| 24. Inspection and Disputes at Pickup | Leaving with the item = acceptance; no condition claims afterwards. Conflicts with policy 4 (48 hours after pickup) | Carve-out + Part B section 10 |
| 25. Refunds | "All sales are final except as expressly allowed"; refund only for misrepresentation "in its sole discretion"; requests "before leaving the pickup location"; "Processing fees may apply". Conflicts with policies 3, 4 and 5 | Carve-out + Part B sections 7, 10, 12 |
| 38. Disclaimers | "ALL ITEMS ARE SOLD AS IS, WHERE IS, WITH ALL FAULTS"; no warranties of condition, authenticity, accuracy | Carve-out for the item-condition sentence only; the platform disclaimer is unchanged (attorney question 3) |
| 39. Limitation of Liability | Caps liability at the amount paid for the item. Not a direct conflict; a full refund is within the cap | Attorney review |
| Schedule A | Processing Fee $20 or 30% on an approved refund; Alternative Pickup, Storage, Disposal, Failed Payment and Chargeback Fees. Conflicts with policy 5 | Carve-out: Schedule A does not apply to fixed-price purchases |

### Buyer Terms Version 3 (published, current)

| Clause | Conflict | Resolved by |
|---|---|---|
| Opening | "By registering to bid you agree..." Auction-only, yet storefront checkout links and records acceptance of it | Version 4 opening covers both |
| 7. Pickup obligations | "Uncollected lots may be subject to fees or forfeiture" | Part A applies to auctions only |
| 8. As-is sale | "All items are sold AS-IS, WHERE-IS" | Part A applies to auctions only; Part B section 7 |

### Seller Agreement Version 4 (published 2026-11-06)

| Clause | Finding | Resolved by |
|---|---|---|
| 3.2, 3.3 | Seller responsible for accurate descriptions and disclosing known defects | Supports Part B section 7 |
| 6.9 | Storefront Fee 5% Website Sale / 9% Marketplace Sale, card processing included | Unchanged; enforced by the code |
| 7.3 | Storefront payouts "subject to the fulfillment and eligibility rules the platform actually enforces"; holds for disputes and review | Supports the reporting-period payout wait |
| 7.5 | Withhold or offset for chargebacks, refunds, returns, disputed transactions | Supports refunds decided by Advantage.Bid |
| Gap | Nothing says a Professional Seller's Store Terms cannot override Advantage.Bid's misdescription protection, or that Advantage.Bid decides storefront problem reports | Option in section 4 (owner decision) |
| 8.4 | "If a buyer fails to complete pickup... Advantage may re-offer, relist..." Written for auctions; policy 2 says the seller's own policy governs storefront pickup | Option in section 4 (owner decision) |
| 1 | Written around "Consigned Property" and auctions; storefront items are the seller's own stock | Attorney review (low risk; 6.9 names storefront sales expressly) |
| 14.1 | Advantage protects personal information, but the Seller has no express duty to use buyer contact details only to fulfill the order | Option 2 clause (section 4) adds it; attorney question 8 |

### Privacy Policy (published)

| Section | Finding | Resolved by |
|---|---|---|
| Information Shared with Sellers | Lists name, email, telephone, pickup and transaction information "to facilitate auction transactions". Storefront orders also share the shipping address (when the buyer chooses shipping), for fixed-price purchases | Proposed amendment (section 3 below) |

### Seller policies (Lewis & Maese, production, read 2026-11-09)

| Policy | Finding |
|---|---|
| Shipping & Pickup v1 (published) | Written for auction winners ("If you are the winning bidder", "before bidding"). No pickup address, hours, method or deadline beyond "Any Item(s) left after 30 days will be forfeited" (no notice, no refund statement). Mentions shipping firearms (none of their 9 storefront items is a firearm). Needs a storefront version; forfeiture wording for attorney review |
| Store Terms v1 (draft, not published) | "First come first served"; out-of-stock items refunded. Says nothing about returns. Must be completed and published (checkout requires it) |

## 3. Terms of Service carve-out (proposed text, not published)

Add as a new section after section 3 (and a one-line note at the top of Schedule A). `public/terms.html` has the owner's
uncommitted edits in the main checkout, so this text is not applied to the file here; it is applied after approval.

> **3A. Fixed-price purchases.** When you buy an item at a fixed price ("Buy Now") from a Professional Seller's
> storefront, Part B of the Buyer Terms applies to that purchase. Where these Terms conflict with Part B, Part B
> controls. In particular, section 5 (as to fees), section 9 (as to the condition of the item purchased), sections 18,
> 19, 20, 22, 23, 24 and 25, the item-condition sentence of section 38, and Schedule A apply to auction purchases and do
> not limit Part B for fixed-price purchases.

Schedule A note:

> The fees in this Schedule apply to auction purchases. They do not apply to fixed-price purchases from Professional
> Seller storefronts (Buyer Terms, Part B).

Privacy Policy, "Information Shared with Sellers" (proposed replacement of the last two lines):

> * Shipping address, when you choose shipping for a fixed-price purchase
> * Transaction information
>
> Such information is shared only as reasonably necessary to complete auction and fixed-price transactions.

## 4. Seller Agreement: options (owner decision; no seller signs anything until decided)

- **Option 1 (recommended for the pilot): no change.** Rely on 3.2, 3.3, 7.3 and 7.5. Lewis & Maese sign Version 4 as it
  stands (they have only Version 3, and checkout requires Version 4 for storefront sales).
- **Option 2: a short storefront clause in a future version** (for example 6.10), applied when the agreement is next
  revised:

  > 6.10 **Professional Storefront purchases.** For fixed-price storefront sales, the Seller's Store Terms and Shipping &
  > Pickup Policy apply only to the extent consistent with the Advantage.Bid Buyer Terms. Advantage reviews and decides
  > buyer problem reports, including reports that an item is materially different from its listing, and may refund the
  > buyer from funds not yet paid to the Seller or offset the refund against later payouts under Section 7.5. Pickup,
  > storage and forfeiture of items a buyer does not collect follow the Seller's published Shipping & Pickup Policy, which
  > must state them before the sale and comply with applicable law. The Seller uses buyer contact details and shipping
  > addresses it receives only to fulfill the order and communicate with the buyer about it.

## 5. Questions for the attorney

1. Is a new section 3A (above) plus Buyer Terms Version 4 enough to keep the auction-oriented Terms of Service sections
   from applying to fixed-price purchases, or should the Terms of Service be amended more broadly?
2. Seller forfeiture of a paid, uncollected item: what notice and terms make it enforceable in Texas (and other states)?
   Should Advantage.Bid require a minimum (for example written notice and a period after the deadline)?
3. Do the reporting periods (48 hours, 7 days) read as expectations rather than a waiver or limitation period under the
   Texas DTPA and similar laws? How should "as is" language for merchant sellers be handled for fixed-price sales?
4. Is the "materially different from its listing" definition appropriate, and who should bear return shipping?
5. Should any recovery of improper chargeback costs apply to fixed-price purchases (excluded in the draft)?
6. Does "you are buying from the seller" fit Advantage.Bid charging the card and possibly acting as the Texas marketplace
   provider for sales tax?
7. Order of precedence: Part B over seller policies over the Terms of Service. Any issue with buyers who accepted only
   Version 3 before Version 4 existed? (No storefront order exists yet: production has 0 storefront orders.)
8. Buyer contact details: is the Privacy Policy amendment plus the Part B section 2 disclosure enough, and should the
   Seller Agreement add the express seller data-use duty (Option 2) before the pilot rather than later?
9. Seller policy wording to review before the pilot (Lewis & Maese, as published or drafted on 2026-11-09):
   "*Any Item(s) left after 30 days will be forfeited*" (no notice, no refund statement, no storage terms);
   "Shipping for any item(s) is the Buyer's responsibility" (their storefront items are pickup only; fine if stated so);
   firearm shipping via an FFL holder (no storefront item is a firearm; Advantage.Bid's prohibited-items rules apply);
   "If an item is purchased and we do not have it in stock we will refund the purchase" (consistent with Part B
   section 3). Their final storefront versions should be reviewed when published.

## 6. Do the drafts reflect the five approved policies?

| Approved policy | Where in Buyer Terms Version 4, Part B | Accurate? |
|---|---|---|
| Sales final after payment (legal, misdescription, non-delivery and seller-failure remedies kept; refunds and chargebacks kept) | Section 4 (exceptions listed), section 12 (refunds), section 13 (chargebacks) | Yes |
| Uncollected purchases follow the seller's published pickup policy; no Advantage.Bid deadline; disclosed before payment; lawful | Section 9 (and section 5: policies shown before payment and saved with the order) | Yes |
| Returns follow seller policy; materially different items always reportable; not defeated by "all sales final" / "as is"; disclosed condition distinguished | Sections 6 and 7 (definition with examples and exclusions) | Yes |
| Report within 48 hours of pickup / 7 days of delivery, from the recorded event, not a waiver, late reports still reviewed | Section 10 | Yes (matches the deployed system: periods are shown, never used to refuse) |
| No additional refund fee; card costs not deducted; Schedule A not imported | Section 12; section 1 and Terms of Service section 3A exclude Schedule A | Yes |

Missing before publication: section 15 (sales tax) waits for the CPA's written determination; the date and version
header are set at publication.

## 7. Approval checklist (owner)

1. [ ] Attorney has reviewed: Buyer Terms Version 4 (`docs/legal/buyer-terms-v4-fixed-price.md`), Terms of Service
       section 3A and the Schedule A note, the Privacy Policy amendment, and questions 1 to 9.
2. [ ] Section 15 (sales tax) completed to match the CPA's written determination; the bracketed placeholder removed.
3. [ ] Decision: Seller Agreement Option 1 (no change for the pilot) or Option 2 (new version with clause 6.10).
4. [ ] Decision: the other two "version 4" drafts (`terms-of-service-v4.md`, `buyer-terms-v4-draft.md`) become Version 5
       later (recommended), so auction rules do not change now.
5. [ ] Approve publication. Then, in this order: (a) post Terms of Service section 3A, the Schedule A note and the Privacy
       Policy amendment; (b) publish Buyer Terms Version 4 with `includes_sales_near_you = true` through a guarded
       script (check, dry run, apply; to be prepared on approval). Effect: every buyer accepts Version 4 at their next
       auction registration or storefront purchase.
6. [ ] Confirm the checkout "Before you pay" summary (public/item.html) matches the published wording.
7. [ ] Lewis & Maese's published Store Terms and Shipping & Pickup Policy reviewed (question 9).
