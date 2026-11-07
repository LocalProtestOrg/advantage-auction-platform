# Documents published before external counsel review (owner direction 2026-11-06)

The owner directed that corrected agreements and policies that implement already-approved business decisions, or that
accurately describe existing functionality, be published **without waiting for outside legal review**. Counsel review
follows; any change counsel recommends is made as a NEW version (history is never overwritten). This file records every
such publication so counsel's recommendations can be tracked against it.

Rules the owner set for these publications: no new contractual obligations, no material change to liability or dispute
rights, no new financial commitments, no unresolved legal-policy decision made on the owner's behalf. Anything that would
need one is listed under "Owner decisions" instead of being published.

## 1. Seller Agreement version 4 (template "Seller Agreement", `ab000000-0000-4000-8000-000000000001`)

Source text: `docs/seller-agreement-v1-content.md` (body between "## Agreement body" and "### Authoring notes").
Published with `scripts/prod-publish-seller-agreement-version.js` (new immutable version; versions 1 to 3, every issued or
signed agreement, signature and seller record are unchanged; verified by the script's before/after fingerprints).

Changes from version 3 (paragraph-level comparison against production, 2026-11-06; nothing else differs):

| Section | Version 3 | Version 4 | Basis |
|---|---|---|---|
| 6.9 Storefront fee | flat 11% of the item price | 5% Website Sale / 9% Marketplace Sale, card processing included, no monthly or listing fee | Owner-approved pricing (2026-11-03, reconfirmed 2026-11-06); matches `storefrontChannelService.FEE_BPS` |
| 6.9 Classification | n/a | Classified from what the systems record when the order is created; includes a purchase completed in the same browser within 24 hours after visiting the embedded storefront | Describes existing code (`storefrontChannelService.js`, website pass valid 24 hours) |
| 6.9 Review | n/a | Seller may ask for a review within 60 days after the payout; verified errors corrected on the next payout statement with a record kept; Advantage tells the Seller the result; disagreement goes to Section 16 | Owner asked for a fairer process than the draft's "Advantage's decision after review is final" (removed). Correction mechanism exists (migration 217) |
| 6.4 Marketing fees | not charged upfront; deducted from settlement | no marketing fee unless the Seller chooses an optional package; price, contents and payment shown before choosing; paid as shown | Describes how optional packages actually work (prepaid at checkout) |
| Professional preamble, 6.7 | three professional types | adds "retail shop, gallery or studio" | Existing professional seller type (migration 211) |
| 7.4 | "the Seller's current commission is 0%" (all sellers) | 0% stated for individual Sellers; professional Sellers' net proceeds reduced by Section 6.7 fees | Matches 6.1 and 6.7 |
| Headings and preamble | long dashes; internal note "(added 2026-08-07, H-1)" | colons; internal note removed | Content standard; no meaning change |

### Questions for counsel (Seller Agreement)
1. Section 6.9 review process: is the 60-day window reasonable, and is routing disagreements to Section 16 adequate?
2. Section 6.9 manipulation: the clause prohibits it but names no specific remedy (the agreement's existing remedies apply).
3. Defined terms "Storefront Fee", "Website Sale", "Marketplace Sale": confirm no collision with other defined terms.
4. Section 6.4 now says optional packages are paid as shown at purchase: confirm this is adequate disclosure.

### Owner decisions found during the review (NOT changed in version 4)
1. **Section 7.6 says payouts are made "only by direct deposit (ACH)"**, but the seller payout page offers a mailed check
   (`public/payout-profile.html`, `payoutPreferenceService` VALID_METHODS ach and check). Either remove the check option or
   publish a version that allows checks. Business decision.
2. **Section 11.2 caps Advantage's liability at "the total commission actually earned by Advantage on the Seller's items"**.
   For individual Sellers the seller commission is 0% (Advantage's revenue is the buyer's premium), so the cap may be $0.
   Liability terms are a legal-policy decision; unchanged.
3. Agreements already **sent but not signed** stay pinned to the version they were sent with (versions 1 and 3 state 11%).
   They can be reissued on version 4 from Admin > Agreements if the owner wants.

## 2. Terms of Service and Buyer Terms, version 4 (prepared; publishes with the baseline release)

Source text: `docs/legal/terms-of-service-v4.md` (built from the production `public/terms.html`). Published with
`scripts/prod-publish-buyer-terms-version.js --apply` as buyer_terms version 4. Versions 1 to 3 and every acceptance stay
exactly as they are; buyers accept version 4 at their next account registration, auction registration or storefront
purchase (re-acceptance is recorded with its own timestamp).

What changes: buyers now accept the **full** "Terms of Service: General and Buyers" (previously the shorter buyer terms),
with version tracking. Factual corrections in the text:

| Section | Change | Basis |
|---|---|---|
| Header | Version 4, Last Updated November 6, 2026 | Version tracking |
| 5 Payment | Debit and credit cards only; prepaid cards refused; the card is verified with the bank when saved; Advantage.Bid never charges to verify; the bank may briefly show a temporary authorization | Owner decision 3 (2026-09-27); CLAUDE.md card rules; existing code |
| 6 Sales Near You | The Sales Near You paragraph from buyer terms version 3 §11, word for word | Keeps an already-accepted term in the full document |
| 10 and 11 Bidding | Every bid is a maximum bid; the platform bids on the buyer's behalf only as high as needed | Describes the existing bidding engine |

Not included (owner decision): the owner's own uncommitted edits to `public/terms.html` (chargeback and pickup
enforcement, and `docs/legal/terms-pickup-dispute-enforcement-draft-2026-10-12.md`). Those change dispute and liability
terms, so they wait for the owner and counsel.

## 3. Privacy Policy (updated November 6, 2026; ships with the baseline release)

Describes existing functionality only:
- Sasha conversations: chat and email transcripts; phone calls keep a written transcript, no audio; the spoken parts are
  removed after 90 days and a summary is kept.
- Cookie notice and the consent choice.
- New "Advertising and Measurement" section: Google Analytics, the Meta pixel and Conversions API. Data goes to Meta
  only with advertising consent (hashed email or account ID, IP address, browser user agent, cookie IDs).
- Sales Near You.
- Service providers list adds the provider behind Sasha and advertising measurement providers (by category, no vendor
  names on the page).

## 4. Pricing references corrected (no fee calculation changed)

The flat 11% storefront fee was replaced by 5% / 9% in Seller Agreement v4. Corrected: FAQ, Professional Sellers page,
Seller Demo, website storefront widget, admin storefront payouts page, Sasha knowledge, CLAUDE.md, business rules and
internal documents and comments. Every storefront mention says online purchasing through Advantage.Bid checkout is not
open yet. Migration 226 removes four unused settings that stated retired rates (`pricing.storefront.seller_fee_bps` =
1100 and three retired 0% `business.*_pct` values); nothing read them.

## 5. Questions for counsel (Terms, Privacy, email)

1. Privacy: whether sending hashed identifiers to Meta with advertising consent is a "sale" or "sharing" under CCPA/CPRA
   and other state laws, and whether a "Do Not Sell or Share" link is needed.
2. Phone: whether Sasha's call notice (transcription, automated assistant) is adequate in two-party-consent states.
3. Storefront purchase terms: buyer-facing terms for fixed-price purchases must be ready before checkout opens.
4. Commercial email footers now carry the postal address (Advantage.Bid, 300 Communipaw Ave. #137, Jersey City, NJ
   07304). Follower announcements are sent by Advantage.Bid on a Professional Seller's behalf: confirm Advantage.Bid's
   address is the right one, or whether the seller's must also appear.
