# Governing law and address corrections: counsel-review worksheet (DRAFT, 2026-11-16)

**Status: worksheet for legal review. It changes no legal text.** No agreement, terms page, policy or setting is
altered by this document. Nothing here is legal advice or a legal conclusion, and no wording below is proposed as
final: every replacement is a placeholder for counsel.

## 1. Why this worksheet exists

Business facts from the owner (2026-11-16):

- Advantage.Bid is legally registered in New Jersey and operates out of New Jersey. New Jersey is the principal
  operating location.
- "2205 Ogden Hwy, Adrian, MI 49221" is a legitimate **mailing address only**. It is not the principal operating
  location.

The published legal documents do not match those facts or each other: the Seller Agreement names Michigan law, the
public Terms of Service name Texas law and a Texas venue, the current Buyer Terms name no governing law, and the
address shown is the Adrian mailing address, labelled differently from page to page.

## 2. Rules for any correction (not negotiable)

1. **Signed agreements are never silently modified.** A Seller Agreement a seller has signed stays exactly as signed:
   the stored text, version, signature record and generated PDF are not edited, regenerated or replaced.
2. **Public legal documents change only through the established versioning and acceptance process:** a new version, an
   effective date, publication through the existing publisher, and re-acceptance where the process requires it. No
   in-place edit of a published version.
3. **Legal review comes first.** Counsel reviews the governing law, venue and address wording before any new version
   is published. The owner approves each publication.
4. **The owner decides** which address is published as the legal (business) address and which as the mailing address.
5. Prior versions stay on record with their acceptance history.

## 3. Verified findings (production, 2026-11-16)

| # | Document | Where | What it says today | Who is bound |
|---|---|---|---|---|
| F1 | Seller Agreement template, versions 1, 2, 3 and 4 (v4 is current) | Section 16.1 | "This Agreement is governed by the laws of the State of Michigan" (v1 source: `docs/seller-agreement-v1-content.md`, "without regard to conflict-of-laws principles") | Every seller who signed any version, including v4 |
| F2 | Public Terms of Service | `public/terms.html` and source `docs/legal/terms-of-service-v4.md`, section 45 | Texas governing law; venue in the state or federal courts located in Harris County, Texas | Visitors; buyers who accepted Buyer Terms v4, to the extent v4 incorporates these Terms (question Q5) |
| F3 | Public Terms of Service | Same files, contact block | "Address: 2205 Ogden Hwy, Adrian, MI 49221" (labelled "Address", not "Mailing Address") | Public |
| F4 | Buyer Terms v2 (superseded) | Governing-law clause | Texas law | Buyers who accepted v2 |
| F5 | Buyer Terms v4 (current, published 2026-11-13) | Whole document | No governing-law clause found | Buyers accepting from 2026-11-13 |
| F6 | Privacy Policy | `public/privacy.html`, contact block | "2205 Ogden Hwy, Adrian, MI 49221". Reported from production as unlabelled; the page source in the repository on 2026-11-16 shows it under a "Mailing Address:" heading. Confirm what the served page shows before deciding (item V1) | Public |
| F7 | Data deletion page | `public/data-deletion.html` | "Mailing Address: 2205 Ogden Hwy, Adrian, MI 49221" (labelled) | Public |
| F8 | Commercial email footer | `platform_config` key `company.postal_address` | "Advantage.Bid, 2205 Ogden Hwy, Adrian, MI 49221" (set on the owner's instruction of 2026-11-07; before that it held a Jersey City address) | Recipients of commercial email |

Related internal notes (not published, no action beyond awareness):

- `docs/legal/buyer-terms-v4-substantive-review.md` (2026-11-08), row 1, already flagged the Texas / Michigan conflict
  and asked the owner to choose one state. It described Adrian as "the business address"; a clarification note was
  added on 2026-11-16.
- `docs/legal/seller-caused-refund-cost-recovery-clause-draft.md`, question 1, refers to the Seller Agreement's
  governing law as Michigan. It should follow whatever counsel decides here.

## 4. Correction path for each finding

Placeholders in square brackets are for counsel and the owner. None is settled wording.

### F1. Seller Agreement section 16.1 (Michigan law)

- **Do not touch** versions 1 to 4 or any signed copy.
- **Path:** counsel advises the governing law (and whether a venue or dispute-resolution change belongs in the same
  revision; Section 16 also carries the disagreement process). If a change is advised: draft a new template version
  (version 5) with section 16.1 reading `[governing law per counsel]`, an effective date of `[date]`, published through
  the existing agreement publisher after owner approval.
- **Existing signers:** how sellers who signed v4 (and earlier versions) move to the new version is a counsel question
  (Q3): for example re-signing at the next new listing, as was done for the grandfathered sellers in November 2026, or
  on a fixed date, or not at all for sales already made. Until a seller signs a new version, the version they signed
  governs them as written.
- **Records to keep:** the review packet and publication record, in the same form as
  `docs/legal/seller-agreement-v4-review-packet.md` and `docs/legal/pre-counsel-publication-record.md`.

### F2. Terms of Service section 45 (Texas law, Harris County venue)

- **Path:** counsel advises governing law and venue for a New Jersey business. If a change is advised: a new Terms
  version with section 45 reading `[governing law per counsel]` and `[venue per counsel]`, an effective date, the
  source file and the public page updated together (they must stay identical), published through the Terms publisher.
- **Acceptance:** whether buyers and sellers must re-accept, and how the change is notified, follows the existing
  acceptance process and counsel's advice (Q4).
- **Consistency:** sections 43 (no class actions) and 44 (jury-trial waiver) sit beside section 45 and were listed for
  owner approval on 2026-11-08; counsel may want to review them together under the chosen state's law.

### F3. Terms of Service contact address

- **Path:** the owner decides what the Terms show: `[published legal address]`, the mailing address labelled as
  "Mailing Address", or both. Changed in the same new Terms version as F2, not as an in-place edit.

### F4. Buyer Terms v2 (superseded, Texas law)

- **Path:** no change. It is a superseded version kept on record with its acceptances. Counsel may be asked what law
  governs a dispute with a buyer who accepted only v2 (Q5).

### F5. Buyer Terms v4 (current, no governing-law clause)

- **Path:** counsel advises whether the Buyer Terms should carry their own governing-law and venue clause, or rely on
  the Terms of Service, and whether the absence is a problem today. If a clause is advised: a new Buyer Terms version
  with `[clause per counsel]`, an effective date, published through the Buyer Terms publisher, with acceptance at the
  buyer's next bid registration or purchase as the process already works.
- Publish it together with F2 if possible, so both documents name the same law from the same date.

### F6 and F7. Privacy Policy and data deletion page addresses

- **V1 (verify first):** confirm how the served Privacy Policy labels the address.
- **Path:** once the owner decides the address presentation (section 5), make both pages consistent with each other
  and with the Terms. The Privacy Policy is a published policy: change it as a dated revision with its "last updated"
  date, after counsel confirms whether a privacy contact address must be a physical business address under any law
  that applies (Q6). The data deletion page already says "Mailing Address".

### F8. Commercial email footer address

- **Path:** no change needed if the Adrian address is still a valid postal address where Advantage.Bid receives mail
  (the owner confirms). Counsel confirms that a valid mailing address satisfies the commercial-email postal address
  requirement (Q7). If the owner later prefers the New Jersey address, it is one owner-only, audited setting change.

## 5. Owner decisions needed

1. The **published legal (business) address**: `[New Jersey address, to be supplied by the owner]`, or no street
   address published beyond the mailing address.
2. Whether the Adrian address is labelled **"Mailing Address" everywhere** it appears (Terms, Privacy Policy, data
   deletion page, email footer).
3. Confirmation that the Adrian mailing address is still valid and monitored.
4. After counsel's advice: approval of each new version and its effective date.

## 6. Questions for counsel

- **Q1. Governing law.** For a business legally registered in and operating from New Jersey, what governing law should
  the Seller Agreement, the Terms of Service and the Buyer Terms name? Should all three name the same state?
- **Q2. Venue.** What venue (state, county, court) and dispute-resolution wording is appropriate, and is an exclusive
  venue clause enforceable against consumers (buyers) in other states?
- **Q3. Sellers who signed v4 (and v1 to v3).** What is the correct transition: re-signature of a new version (when,
  and with what notice), or leave existing signers on Michigan law until they next sign? What law governs sales already
  completed under a signed version? Is the Michigan clause a practical problem while it remains?
- **Q4. Re-acceptance of the Terms.** Does a change of governing law and venue in the public Terms require notice and
  affirmative re-acceptance from existing buyers and sellers, or is posting a new version with an effective date
  enough?
- **Q5. Buyers today.** Buyer Terms v4 has no governing-law clause, and the public Terms name Texas. Which law
  currently governs a buyer who accepted v4? A buyer who accepted only v2 (Texas) or v3?
- **Q6. Address labelling.** Should the Adrian address be labelled "Mailing Address" everywhere, and must any document
  (Terms, Privacy Policy, Seller Agreement, receipts or invoices) show a physical business address or the registered
  New Jersey address instead?
- **Q7. Email footer.** Does a valid mailing address in Michigan meet the postal address requirement for commercial
  email sent by a New Jersey business, including follower announcements sent on a Professional Seller's behalf?
- **Q8. Conflicts in the meantime.** Until new versions are published, is there any exposure from the Seller Agreement
  (Michigan), the Terms (Texas) and the business location (New Jersey) pointing to three different states, and should
  anything be done before the first live storefront sale?
- **Q9. Entity name and registration.** Do the documents name the contracting entity exactly as registered in New
  Jersey?

## 7. What is not changed by this worksheet

- No file under `public/`, no agreement template, no Buyer Terms or Terms version, and no `platform_config` value.
- Sales tax is a separate question for the CPA (`docs/operations/storefront-sales-tax-decision-checklist.md`). A
  governing-law clause is a contract term; it is not treated here as evidence of where tax is owed.
