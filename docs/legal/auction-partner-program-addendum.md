# Advantage.Bid Auction Partner Program Addendum (source of truth)

This file is the single source for the Auction Partner Program Addendum:

- The text between the BEGIN and END markers is published, unchanged, as the online agreement version that invited
  partners review and sign (`src/services/auctionPartnerAgreementService.js` loads it; a content change publishes a
  new immutable agreement version automatically, so every signature pins the exact text the partner accepted).
- The email copy (`auction-partner-program-addendum.pdf`, built by `scripts/build-auction-partner-addendum-pdf.js`)
  is rendered from the same text.

`{{legal_name}}`, `{{signatory_name}}` and `{{effective_date}}` are filled in for each partner when the addendum is
issued. In the email copy they read as blanks to be completed online.

Status: final proposed text, revised 2026-10-06 (Owner review: seller publishing, attribution, processing wording, term wording). Owner and counsel items are listed in
`docs/legal/auction-partner-program-addendum-counsel-notes.md`.

<!-- BEGIN ADDENDUM BODY -->
# Advantage.Bid Auction Partner Program Addendum

**Advantage Auction Company, LLC d/b/a Advantage.Bid** ("Advantage.Bid," "we," "us," or "our")

**Auction Partner:** {{legal_name}} ("Auction Partner," "you," or "your")

**Date issued:** {{effective_date}}

This Auction Partner Program Addendum (this "Addendum") supplements the Advantage.Bid Seller Consignment and Auction Services Agreement between you and Advantage.Bid (the "Seller Agreement"). It applies only to a professional seller that Advantage.Bid has invited into the Advantage.Bid Auction Partner Program (the "Program"). Capitalized terms not defined in this Addendum have the meanings given in the Seller Agreement. Except as stated in this Addendum, the Seller Agreement continues to apply in full. If this Addendum conflicts with the Seller Agreement for a Qualifying Auction, this Addendum controls for that auction.

---

## 1. Program Term

1.1 The Program term begins on the date you sign this Addendum and ends one year later (the "Term").

1.2 This Addendum does not renew automatically. Any extension of the Term, and any new Program terms, require a new written addendum accepted by you and Advantage.Bid. Advantage.Bid does not promise that the Program, or these terms, will be offered after the Term.

1.3 This Addendum forms part of the Seller Agreement and ends if the Seller Agreement ends. The provisions of the Seller Agreement on termination, and on the suspension or limitation of seller privileges and access, apply to this Addendum and to the Program.

## 2. Qualifying Auctions

2.1 A "Qualifying Auction" is an auction that you publish through Advantage.Bid during the Term while you are eligible for the Program.

2.2 Every auction keeps the economic terms in effect when it was published, for that auction's whole life, even if the Term later ends or the Program or its terms change or end.

2.3 Auctions published outside the Term, or while you are not eligible for the Program, are governed by the Seller Agreement and your terms of record in effect when each is published.

2.4 You publish your auctions using the tools Advantage.Bid makes available to professional sellers, subject to the Platform's rules and controls, including business verification.

## 3. Platform Fee

3.1 For Qualifying Auctions, Advantage.Bid charges a **0% Advantage.Bid auction platform/software fee**. This replaces, for Qualifying Auctions only, the professional-seller Platform Fee described in the Seller Agreement.

3.2 The Program applies to auctions only. Professional Storefront fixed-price sales are not included and remain subject to the Storefront Fee described in the Seller Agreement.

## 4. Payment Processing

4.1 Payment processing remains your responsibility. For each Qualifying Auction, the payment-processing charges that Advantage.Bid's payment processor actually assesses on the buyer payments collected for that auction are deducted from your proceeds. This replaces, for Qualifying Auctions only, the percentage Processing Fee described in the Seller Agreement.

4.2 Payment-processing charges are based on the amount processed for the buyer's payment, which may include the hammer price, buyer's premium, and applicable sales tax. They are not a fixed percentage and can vary by transaction.

4.3 Advantage.Bid does not mark up these charges for Qualifying Auctions. If the processor returns any part of a charge when a payment is refunded, only the amount the processor actually retains is deducted.

4.4 Advantage.Bid may hold the settlement of a Qualifying Auction until the actual processing charges for its buyer payments have been recorded.

## 5. Buyer's Premium and Auction Settings

5.1 You set and keep the buyer's premium on your Qualifying Auctions, under the professional-seller buyer's premium terms of the Seller Agreement.

5.2 Using the tools Advantage.Bid makes available to professional sellers, you may set starting bids, reserves, custom bid increments, and your buyer's premium for your Qualifying Auctions, subject to Platform policies and any configured limits.

## 6. Responsibilities

6.1 You are responsible for selecting the inventory you offer, the photographs and descriptions of your items, your auction settings, buyer pickup or fulfillment, and compliance with the Seller Agreement and the Platform's marketplace rules.

6.2 Advantage.Bid provides the online auction platform, listing on the Advantage.Bid marketplace, bidding, buyer invoicing, buyer payment collection, and processing of eligible payouts. Advantage.Bid maintains the Platform's rules and controls and may review, moderate, edit, or withdraw listings as described in the Seller Agreement.

## 7. Display and Attribution

7.1 Qualifying Auctions are listed on the Advantage.Bid marketplace and, where an integration is in place, may also be displayed through your own website or business presence. Advantage.Bid attribution remains on every display.

## 8. Sales Tax

8.1 Sales tax that applies to a sale is collected from the buyer and handled separately. Sales tax is not part of your proceeds.

## 9. Payouts

9.1 Advantage.Bid processes eligible seller payouts every Thursday. Auction sales become eligible for the first Thursday after pickup or fulfillment is completed and the transaction is otherwise eligible for payout. Processing on a Thursday does not guarantee the date funds arrive in your bank account. The payout conditions in the Seller Agreement continue to apply.

## 10. No Guarantees

10.1 Advantage.Bid does not guarantee bidder counts, prices, sell-through, or any other result, and does not promise that any category of item will be accepted. The Platform's policies on prohibited and restricted items continue to apply.

10.2 The 0% platform fee applies only to Qualifying Auctions published during the Term. This Addendum does not set a minimum number of auctions for either party.

## 11. Electronic Acceptance

11.1 You agree that your electronic acceptance of this Addendum, which the Platform records with the Addendum version, the date and time, and signer details, has the same effect as a handwritten signature, as described in the Seller Agreement.

---

## Signature

By signing below, the Auction Partner acknowledges that it has read, understood, and agrees to this Addendum.

**Auction Partner:** {{signatory_name}}
on behalf of {{legal_name}}

Signature, date, and authentication details are captured electronically by the Platform at the time of signing.
<!-- END ADDENDUM BODY -->
