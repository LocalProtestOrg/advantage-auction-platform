# Seller Agreement v1 - Content & Variable Schema

**Purpose:** canonical body for `agreement_template_versions.body_markdown`, authored (per `seller_type`) through the existing admin agreements UI. Placeholders `{{key}}` are resolved by `agreementVariableService` from `seller_terms` + `seller_identity` + per-send `overrides`. Original Advantage.Bid language; structured after a standard consignment/auction seller agreement; not copied from any third-party sample. Customer-facing, so written em-dash-free per the content SOP.

> **Not legal advice.** This template is a business draft for the platform and must be reviewed and approved by qualified counsel before it is used as a binding agreement.

---

## Variable schema (author into `variable_schema` JSONB)

| key | type | source | required | notes |
|---|---|---|---|---|
| `legal_name` | text | seller_identity.legal_name | yes | seller's legal name |
| `company_name` | text | seller_identity.company_name | no | if a business/entity |
| `signatory_name` | text | seller_identity.signatory_name | yes | person signing |
| `signatory_title` | text | seller_identity.signatory_title | no | title if signing for an entity |
| `seller_address` | text | seller_identity.address_line1/2 + city/state/postal | yes | composed display |
| `seller_phone` | text | seller_identity.phone | no | |
| `seller_type` | text | seller_profiles.seller_type | yes | drives which template |
| `commission_pct` | percent | seller_terms.commission_pct | yes | seller commission to AAC |
| `buyer_premium_pct` | percent | seller_terms.buyer_premium_pct | no | descriptive only; meaningful only if a buyer premium is enabled+disclosed for the auction (not active by default) |
| `credit_card_fee_pct` | percent | seller_terms.credit_card_fee_pct | no | card processing pass-through |
| `marketing_fee_cents` | currency_cents | seller_terms.marketing_fee_cents | no | optional flat marketing fee |
| `settlement_terms` | text | seller_terms.settlement_terms | yes | e.g. "net proceeds within 14 days of buyer payment" |
| `payout_schedule` | text | seller_terms.payout_schedule | yes | e.g. "14 days after auction close" |
| `effective_date` | date | override (send-time) | yes | agreement effective date |
| `governing_state` | text | override (default "Tennessee") | yes | governing law |

Unknown placeholders are left intact by the renderer; `missingRequired` blocks send (422) until resolved, so every required variable above must be present in `seller_terms`/`seller_identity` or supplied as an override before an agreement can be sent.

---

## Agreement body (`body_markdown`)

# Advantage.Bid Seller Consignment and Auction Services Agreement

**Advantage Auction Company, LLC d/b/a Advantage.Bid** ("Advantage," "AAC," "we," "us," or "our")

**Seller:** {{legal_name}}{{company_name}} ("Seller," "you," or "your")

**Effective Date:** {{effective_date}}

This Seller Consignment and Auction Services Agreement (this "Agreement") governs the consignment and sale of property by the Seller through the Advantage.Bid online auction platform (the "Platform"). By signing electronically, the Seller agrees to the terms below.

---

## 1. Appointment and Scope

1.1 For each item the Seller submits and that Advantage accepts into an auction (the "Consigned Property"), the Seller appoints Advantage as its selling agent to market, list, and sell that item through the Platform. Advantage's rights are exclusive only as to those submitted and accepted items, and only for the duration of the applicable auction event and any related re-offer period. Once an item has been committed to an auction during that period, the Seller will not privately sell it, remove it, relist it elsewhere, or redirect it. This Agreement does not give Advantage exclusive rights to all of the Seller's property or to any of the Seller's future property.

1.2 Advantage provides auction services including cataloging support, listing, bid management, buyer payment processing, and settlement of net proceeds. Advantage does not purchase the Consigned Property and acts solely as the Seller's selling agent unless a separate written purchase arrangement is executed.

1.3 Advantage, not the Seller, controls publication. Advantage reviews and approves each auction before it goes live, and may decline, edit, reschedule, or withdraw any listing in its reasonable discretion. Submitting items for sale does not guarantee that any item will be listed or sold.

## 2. Seller Eligibility and Identity

2.1 The Seller represents that the identity information provided (legal name, signatory, address, and contact details) is accurate and current. The Seller's registered details are: {{legal_name}}, {{seller_address}}, {{seller_phone}}.

2.2 The Seller is classified on the Platform as a {{seller_type}} seller. Certain Platform features, scheduling rules, and obligations vary by seller classification, and Advantage may adjust a Seller's classification where the facts warrant.

2.3 The Seller must complete required onboarding, including execution of this Agreement, before the Seller's account is activated for setting up and submitting auctions.

2.4 Execution of this Agreement enables the Seller's onboarding and seller dashboard access, but does not by itself grant full selling privileges. Seller account privileges remain subject to Advantage's approval. No auction or lot becomes public without Advantage's human review and approval, and Advantage may suspend or limit the Seller's privileges at any time for risk, noncompliance, or suspected fraud.

## 3. Title, Authenticity, and Condition

3.1 The Seller represents and warrants that it holds clear and marketable title to each item of Consigned Property, free of liens, security interests, and competing ownership claims, and has full authority to consign and sell each item.

3.2 The Seller represents that all descriptions, provenance, attributions, and condition information it supplies are accurate to the best of its knowledge, and that the Seller will promptly disclose known defects, damage, repairs, or reproductions.

3.3 The Seller is responsible for reviewing and approving each item's title, description, photographs, condition notes, quantities, pickup details, and any known defects before submission and before publication. Advantage may add, correct, or standardize catalog information for clarity or policy compliance but is not obligated to verify authenticity or condition, and the Seller remains responsible for the accuracy of the information it provides.

## 4. Prohibited and Restricted Items

4.1 The Seller may not consign items whose sale is unlawful or restricted, including stolen property, recalled goods, hazardous materials, firearms or ammunition except where expressly permitted and lawfully handled, live animals, human remains, counterfeit or infringing goods, and any item the sale of which would violate applicable law.

4.2 Advantage may remove any item that it believes violates this Section or Platform policy, at any time and without liability to the Seller.

## 5. Pricing, Starting Bids, and Reserves

5.1 Unless Advantage approves an override, each lot opens at the Platform default starting bid. Bid increments follow the Platform's published increment ladder.

5.2 Reserve prices and similar advanced options are available only when enabled by Advantage for the Seller's account. Where reserves are not enabled, items sell to the highest valid bid at auction close.

5.3 Each auction uses per-lot timed closings with anti-sniping extensions as described in the Platform's buyer-facing rules. The Seller acknowledges that final hammer prices are determined by competitive bidding and are not guaranteed.

5.4 The Seller may not bid on its own lots, arrange for or ask any other person to bid on the Seller's behalf, or otherwise manipulate or artificially influence bidding. Any such activity is a material breach and may result in cancellation of affected sales, forfeiture of related proceeds, and suspension of the Seller's account.

## 6. Fees, Commission, and Buyer Premium

6.1 **Seller commission.** Advantage's commission is {{commission_pct}} of the hammer price for each item sold, retained from sale proceeds at settlement.

6.2 **Buyer premium.** A buyer premium may be charged only if it is enabled and disclosed for the applicable auction. If charged, the buyer premium is added to the hammer price, is paid by the buyer, and is retained and allocated according to Advantage's then-current terms, and does not increase the commission stated in Section 6.1 unless separately agreed in writing. Where a buyer premium is enabled for the Seller's account, the configured rate is {{buyer_premium_pct}}. This Agreement does not by itself activate or impose a buyer premium.

6.3 **Payment processing.** Where applicable, a card processing fee of {{credit_card_fee_pct}} may be applied as described in the Seller's terms of record. Buyers pay by debit or credit card only.

6.4 **Marketing fees.** Marketing package fees are not charged upfront unless separately agreed in writing. If the Seller selects or Advantage approves a marketing package, the associated fees are deducted from the Seller's settlement and itemized on the Seller's statement. Where a flat marketing fee is configured for the Seller's account, it is {{marketing_fee_cents}}.

6.5 The fees in this Section reflect the Seller's terms of record at the Effective Date. Advantage maintains the Seller's financial terms in a versioned, history-preserving record; changes apply prospectively and do not alter terms for an auction already approved and live.

6.6 **Recovery of costs on withdrawal or cancellation.** If, after Advantage has performed work on an auction or item, the Seller cancels an auction, withdraws items committed to an auction, fails to provide committed items, or materially misrepresents items, Advantage may deduct from amounts otherwise owed to the Seller, or invoice the Seller for, its reasonable costs and losses arising from that conduct. These may include buyer refunds and chargebacks, marketing costs, labor, transportation and handling, and platform and administrative expenses. Such amounts are itemized on the Seller's statement.

## 7. Buyer Payment, Settlement, and Payout

7.1 Advantage collects buyer payments through its payment processor. Sales proceeds are held by Advantage until settlement.

7.2 **Settlement.** {{settlement_terms}}

7.3 **Payout schedule.** {{payout_schedule}}

7.4 Advantage remits net proceeds (hammer price less the commission in Section 6.1 and any other fees and adjustments described in this Agreement or the Seller's terms of record). Taxes are calculated after auction close in accordance with applicable law.

7.5 Advantage may withhold or offset amounts reasonably necessary to cover chargebacks, refunds, returns, disputed transactions, or unrecovered amounts attributable to the Seller's items, and may delay payout for items subject to a payment dispute until the dispute is resolved.

## 8. Item Delivery, Pickup, and Risk

8.1 The Seller is responsible for delivering sold items in the described condition and for cooperating with the scheduled buyer pickup or fulfillment window. Pickup timing follows the Platform's scheduling rules for the Seller's classification, and in no case is pickup scheduled before the auction closes.

8.2 Risk of loss or damage to the Consigned Property remains with the Seller until the item is transferred to the buyer or to a carrier or handler designated for fulfillment, except to the extent caused by Advantage's gross negligence or willful misconduct.

8.3 The Seller is responsible for arranging insurance for the Consigned Property as the Seller deems appropriate. Advantage does not insure consigned items unless expressly agreed in writing.

8.4 If a buyer fails to complete pickup or payment, Advantage may re-offer, relist, or otherwise handle the item in a commercially reasonable manner and will coordinate with the Seller regarding unsold or unclaimed property.

8.5 Where Advantage staff or a buyer attends the Seller's premises for preview, pickup, or removal, the Seller must provide safe access, lawful access, adequate parking and loading area where applicable, and reasonable cooperation during the pickup process. The Seller remains responsible for the condition and safety of its premises, except to the extent loss or injury is caused by Advantage's gross negligence or willful misconduct.

## 9. Marketing License and Content

9.1 The Seller grants Advantage a non-exclusive, royalty-free license to use the photographs, descriptions, and related content of the Consigned Property for the purposes of listing, marketing, and promoting the auction and the Platform, including after the auction for recordkeeping and reference.

9.2 The Seller represents that it owns or has the right to provide all such content and that its use by Advantage as contemplated does not infringe the rights of any third party.

## 10. Representations and Warranties; Disclaimer

10.1 Each party represents that it has the authority to enter into this Agreement.

10.2 Except for the express representations in this Agreement, the Platform and auction services are provided on an "as is" and "as available" basis, and Advantage disclaims all other warranties to the maximum extent permitted by law.

10.3 **No guarantee of results.** This is a platform and services agreement. Advantage does not guarantee any auction outcome, including hammer prices, bidder turnout, sell-through rate, or the timing of any payout beyond funds actually collected and settled. Prior results do not predict future results.

## 11. Limitation of Liability

11.1 To the maximum extent permitted by law, neither party is liable for indirect, incidental, special, consequential, or punitive damages.

11.2 Advantage's aggregate liability arising out of or relating to this Agreement will not exceed the total commission actually earned by Advantage on the Seller's items in the auction event giving rise to the claim. **[COUNSEL REVIEW REQUIRED]**

## 12. Indemnification

12.1 The Seller will indemnify and hold harmless Advantage and its officers, employees, and agents from claims, losses, and expenses (including reasonable attorneys' fees) arising out of the Seller's breach of this Agreement, the Seller's items, defects in title or authenticity, or the Seller's violation of law or third-party rights.

## 13. Term and Termination

13.1 This Agreement takes effect on the Effective Date and continues until terminated.

13.2 Either party may terminate on written notice. Termination does not affect auctions already approved and live, obligations for items already sold, or settlement of proceeds for completed sales.

13.3 Advantage may suspend or terminate the Seller's access immediately for breach, suspected fraud, or to comply with law.

## 14. Confidentiality and Privacy

14.1 Each party will protect non-public information received from the other. Advantage handles personal information in accordance with the Advantage.Bid Privacy Policy. Buyer identities during bidding are represented by auction-specific paddle numbers, and full contact details are disclosed only as needed to complete a transaction.

## 15. Independent Relationship

15.1 Advantage acts as the Seller's selling agent for the limited purposes described in this Agreement. Nothing in this Agreement creates a partnership, joint venture, or employment relationship.

## 16. Dispute Resolution and Governing Law

16.1 This Agreement is governed by the laws of the State of {{governing_state}} (default: Tennessee), without regard to conflict-of-laws principles. **[COUNSEL REVIEW REQUIRED]**

16.2 The parties will attempt in good faith to resolve disputes informally before pursuing formal proceedings, in the courts or forum designated by Advantage's then-current policies, to the extent permitted by law.

## 17. Electronic Signature and Consent

17.1 The Seller consents to transact electronically and agrees that the Seller's typed name and electronic acceptance constitute a valid signature with the same effect as a handwritten signature.

17.2 The Seller acknowledges that Advantage records signature metadata (including the signed agreement version, a content integrity hash, the date and time of signing, the signer's IP address, and the signer's browser user agent) for authentication and recordkeeping.

## 18. Entire Agreement; Changes

18.1 This Agreement, together with the Seller's terms of record and the Platform policies it references, is the entire agreement between the parties regarding its subject matter.

18.2 Advantage may issue updated versions of this Agreement. A new version applies to the Seller upon the Seller's execution of that version; the signed version in effect for a given auction governs that auction.

---

## Signature

By signing below, the Seller acknowledges that it has read, understood, and agrees to this Agreement.

**Seller:** {{signatory_name}}{{signatory_title}}
on behalf of {{legal_name}}{{company_name}}

Signature, date, and authentication metadata are captured electronically by the Platform at the time of signing.

---

### Authoring notes (not part of the signed body)
- Compose `{{company_name}}` / `{{signatory_title}}` to render as " (Company Name)" / ", Title" when present and empty otherwise, or pre-format in `agreementVariableService.formatValue` so the sentence reads cleanly when the optional value is blank.
- Maintain one template per `seller_type` (private, business, auction_house, estate_sale_company, professional_liquidator). The professional templates may add classification-specific scheduling/exemption language (e.g. professional pickup-timing autonomy) in Section 8; the body above is the base.
- Keep the content em-dash-free (content SOP); `check-dashes.js` should pass on any HTML surface that renders it.
- Counsel review required before production use (Section disclaimer at top).
