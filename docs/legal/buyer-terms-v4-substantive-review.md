# Buyer Terms v4: substantive provisions for the owner's approval (2026-11-08)

**Status: NOT published** (owner decision 2026-11-08). Buyers today accept buyer_terms **version 3**, an 11-point
summary (1 acceptance; 45 on version 1). Version 4 would make buyers explicitly accept the full "Advantage.Bid Terms of
Service - General and Buyers" (`docs/legal/terms-of-service-v4.md`, 29,914 characters). The same text has been on the
public /terms.html page, but **no buyer has ever clicked to accept it**, so each provision below would bind buyers for
the first time. Nothing here has been reviewed by counsel.

| # | Provision (v4 section) | What it says | Version 3 today | Decision needed |
|---|---|---|---|---|
| 1 | **Governing law and venue** (§45) | Texas law; suits only in state or federal courts in Harris County, Texas; buyer consents to that jurisdiction | Nothing | Conflicts with the Seller Agreement (§16.1: Michigan law) and the business address (Adrian, Michigan). Choose one state for both, and the county |
| 2 | **Limitation of liability** (§39) | No indirect, consequential or punitive damages; total liability capped at the amount the buyer paid Advantage.Bid for the specific item | Nothing (items sold "as-is") | Approve the cap as written, or set a different cap |
| 3 | **Indemnification** (§40) | Buyer defends and indemnifies Advantage.Bid, its people, affiliates **and sellers** for 10 categories (use, bids, breach, law, pickup conduct, property damage, injury, resale, chargebacks, third-party rights) | Nothing | Approve; note it also protects sellers |
| 4 | **No class actions** (§43) | Disputes only individually, never as part of a class, collective or representative action | Nothing | Approve or remove |
| 5 | **Jury-trial waiver** (§44) | Both sides waive a jury trial | Nothing | Approve or remove |
| 6 | **Chargebacks** (§19) | Contact Advantage.Bid before any chargeback; improper chargebacks can lead to suspension, and the buyer may owe chargeback fees, collection costs, **attorney fees** and court costs | Non-payment may suspend the account | Approve the fee shifting, or limit it |
| 7 | **Refunds** (§25) | All sales final; refund only for a material misdescription, at Advantage.Bid's **sole discretion**, asked before leaving pickup if no other deadline; return may be required; processing fees may apply | "As-is, where-is" | Approve; consider the "sole discretion" wording (the Seller Agreement's §6.9 review moved away from final, one-sided decisions) |
| 8 | **Abandoned items** (§22) | Items not picked up may be forfeited without refund and disposed of; the buyer still owes the invoice, storage, disposal costs and damages | "Uncollected lots may be subject to fees or forfeiture" | Approve |
| 9 | **Schedule A fees** | Processing fee for an approved refund, failed pickup, administrative processing or account issue: **$20 or 30% of the winning bid, whichever is greater, up to the winning bid**; alternative pickup $20 per change; failed payment: actual cost plus an administrative fee; chargeback: processor or bank fee plus collection costs; storage as disclosed or reasonably assessed; disposal: actual cost plus an administrative fee. Advantage.Bid may update the schedule | "Fees" mentioned, no amounts | Approve each amount. Today the code charges none of them automatically, but an administrator can apply a missed-pickup storage penalty that defaults to **$50 per day** (`pickupScheduleService.applyPenalty`); align that default with whatever storage fee is approved |

Factual corrections already in v4 (no decision needed; already approved): debit and credit cards only, no prepaid, card
verified with the bank with no charge to verify; maximum bids; the Sales Near You paragraph carried over from version 3;
contact address 2205 Ogden Hwy, Adrian, MI 49221.

**How to approve:** reply with approve or change for each row. Changes are made in `docs/legal/terms-of-service-v4.md`,
then published with `scripts/prod-publish-buyer-terms-version.js` (dry run first). Buyers then accept at their next
registration, bid or purchase; no announcement is sent; earlier acceptances stay on record.
