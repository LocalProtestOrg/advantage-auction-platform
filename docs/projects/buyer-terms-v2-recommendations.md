# Buyer Terms & Conditions v2 — Recommendations (planning only)

**Status: RECOMMENDATIONS ONLY. Do not rewrite, activate, or change the live
terms system based on this document.** Buyer Terms **v1** (seeded in
`db/migrations/061_create_terms.sql`) remains the live, accepted version. This
doc captures what a future **v2** should cover and why, so the eventual rewrite
(by/with an attorney) is faster and grounded in how the platform actually works.

> ⚖️ **Attorney review is required before v2 is drafted as binding language and
> activated.** Everything below is operational/product guidance, **not legal
> text and not legal advice.** Clauses marked **[ATTORNEY]** are especially
> sensitive (enforceability, liability, jurisdiction) and must be lawyer-drafted.

## How v2 will ship (no action now)
The platform already has a versioned framework: `terms_versions` (one
`is_current` per kind) + `terms_acceptances` (append-only ledger). Activating v2
later is purely data: insert a new `buyer_terms` version and flip `is_current`;
`hasAcceptedCurrentTerms()` then returns false until each buyer re-accepts, and
the existing bidding gate already blocks bids until the current terms are
accepted. **No code change is needed to introduce v2** — only the new content
(after attorney review) and the `is_current` flip. The buyer-facing flow
(`buyer-terms.html` → return to auction) already handles re-acceptance.

## Priority key
- **Launch-critical** — should be in v2 **before charging real cards (Stripe
  LIVE cutover)**; touches money, authorization, or core enforceability.
- **Soon** — should follow shortly after launch; reduces operational/dispute risk.
- **Future legal review** — refine with counsel; not blocking initial v2.

| # | Clause | Priority | Attorney |
|---|--------|----------|----------|
| 1 | Buyer premium disclosure | Launch-critical | — |
| 2 | Payment timing | Launch-critical | [ATTORNEY] |
| 3 | Stored card / auto-charge authorization | Launch-critical | [ATTORNEY] |
| 4 | Failed payment consequences | Launch-critical | [ATTORNEY] |
| 5 | Pickup obligations | Soon | — |
| 6 | Missed pickup / storage / forfeiture | Soon | [ATTORNEY] |
| 7 | As-is / where-is condition | Launch-critical | [ATTORNEY] |
| 8 | Catalog description & image disclaimer | Launch-critical | — |
| 9 | Authenticity / attribution / condition disclaimer | Soon | [ATTORNEY] |
| 10 | Technical failure / outage / bid transmission | Launch-critical | [ATTORNEY] |
| 11 | Anti-snipe / staggered close explanation | Launch-critical | — |
| 12 | Auctioneer/platform rights (reject/cancel/withdraw/correct/reopen) | Launch-critical | [ATTORNEY] |
| 13 | Taxes, fees, buyer premium & invoices | Launch-critical | [ATTORNEY] |
| 14 | Chargebacks / nonpayment / account suspension | Launch-critical | [ATTORNEY] |
| 15 | Governing law / venue | Soon | [ATTORNEY] |
| 16 | Privacy / paddle / account identity | Soon | — |
| 17 | Dispute window | Soon | [ATTORNEY] |

---

## 1. Buyer premium disclosure — *Launch-critical*
**Recommendation:** State that a buyer's premium of **X%** is added to the
hammer price on every winning lot, that it is **shown live during bidding**, and
that it is part of the total the buyer authorizes. Define how it combines with
taxes and fees (premium applied to hammer; tax applied after close).
**Why operationally:** CLAUDE.md mandates the premium be shown live; the terms
must make the charge contractually disclosed so the auto-charge total is
defensible. Without an explicit rate, the displayed premium has no contractual
anchor. *(Fill the actual rate; coordinate with #13.)*

## 2. Payment timing — *Launch-critical* **[ATTORNEY]**
**Recommendation:** State **when** winning buyers are charged (e.g., "your card
on file is automatically charged within N hours of auction close"), the order of
operations (close → tax computed → invoice → charge), and that bids are binding
offers due on that schedule.
**Why operationally:** The platform auto-charges the stored card after close
(tax is computed post-close per CLAUDE.md). Buyers must be told the timing so the
charge isn't a surprise (reduces chargebacks/disputes — see #14).

## 3. Stored card / auto-charge authorization — *Launch-critical* **[ATTORNEY]**
**Recommendation:** Explicit authorization that the card saved at
registration/verification **may be charged automatically** for the hammer price,
buyer premium, taxes, and fees on lots the buyer wins, **without further action**,
and that keeping a valid card on file is a condition of bidding.
**Why operationally:** Registration uses a Stripe SetupIntent (card saved, not
charged) and the win charge is `off_session`. U.S. card-network/Stripe rules
require clear stored-credential + merchant-initiated-charge consent; this clause
is that consent. This is the single most important money clause for LIVE.

## 4. Failed payment consequences — *Launch-critical* **[ATTORNEY]**
**Recommendation:** Define what happens on a declined/failed charge: retry
window, the buyer remaining liable for the full amount, possible cancellation/
re-sale of the lot, late/collection fees if any, and account consequences
(suspension, loss of bidding privileges).
**Why operationally:** The payment pipeline retries and can leave a lot unpaid;
ops needs contractual backing to suspend, re-sell, or pursue the balance. Ties to
#14.

## 5. Pickup obligations — *Soon*
**Recommendation:** State that lots are **pickup-only** within the scheduled
window, that buyers acknowledge the pickup window at registration, and the
seller-type timing rule (non-professional sellers' pickup begins **≥48h after
close**; professional sellers set their own; never before close).
**Why operationally:** Registration already requires a pickup acknowledgement,
and `sellerTypeRules.js` enforces the 48h gap server-side. Terms should mirror
the rule buyers are agreeing to.

## 6. Missed pickup / storage / forfeiture — *Soon* **[ATTORNEY]**
**Recommendation:** Define consequences for uncollected lots: storage fees after
the window, deadlines, and forfeiture/abandonment (resale or disposal) terms;
clarify **risk of loss transfers** to the buyer at a defined point.
**Why operationally:** Without this, uncollected paid lots become an open-ended
liability for Advantage/sellers. Forfeiture/abandonment language must be
lawyer-drafted to be enforceable.

## 7. As-is / where-is condition — *Launch-critical* **[ATTORNEY]**
**Recommendation:** All items sold **AS-IS, WHERE-IS**, with no warranties of
merchantability or fitness except as required by law; buyer is responsible for
inspection/due diligence; all sales final except where law provides otherwise.
**Why operationally:** v1 has a basic AS-IS line (§8); v2 should strengthen it as
the core disclaimer that limits returns/warranty disputes on estate/secondhand
goods. Foundational for a secondhand marketplace.

## 8. Catalog description & image disclaimer — *Launch-critical*
**Recommendation:** Descriptions, dimensions, categories, and **images are
provided in good faith but not warranted**; images may not reflect exact
condition/scale; the buyer relies on their own inspection; estimates are not
guarantees.
**Why operationally:** Lots are seller-described with optional dimensions and
AI-assisted/enhanced images (background removal, enhancement). The disclaimer
protects against "the photo looked better"/"the description was wrong" disputes.

## 9. Authenticity / attribution / condition disclaimer — *Soon* **[ATTORNEY]**
**Recommendation:** No guarantee of authenticity, authorship, age, provenance, or
attribution unless explicitly stated in writing for a specific lot; opinions of
maker/era are not warranties.
**Why operationally:** Estate/antique lots carry maker/era/attribution fields
that are seller-supplied. Attribution claims are a classic auction liability;
counsel should scope any limited guarantee.

## 10. Technical failure / outage / bid transmission — *Launch-critical* **[ATTORNEY]**
**Recommendation:** The platform is not liable for failed/lost/late bids due to
connectivity, device, or platform outages; the platform may, at its discretion,
**extend, reopen, void, or re-run** a lot or auction affected by a technical
problem; server records are the authoritative record of bids and timing.
**Why operationally:** Real-time bidding + timed close + anti-snipe means
connectivity/timing disputes will happen. This clause + #12 give ops the right to
remediate (the close/anti-snipe code can extend/reopen) and limits liability for
missed bids.

## 11. Anti-snipe / staggered close explanation — *Launch-critical*
**Recommendation:** Plainly explain the timed model: lots close on a **staggered
schedule (≈1 minute apart)**; a bid in the **final 2 minutes extends that lot by
2 minutes** (anti-snipe); closing times are approximate and may be extended;
extensions are uncapped.
**Why operationally:** This is exactly how `auctionService` (staggered
`closes_at`) and `bidService.applyAntiSnipe` behave. Buyers disputing "it said it
closed at X" need this disclosed. v1 §4 touches it; v2 should be precise.

## 12. Auctioneer/platform rights — *Launch-critical* **[ATTORNEY]**
**Recommendation:** Reserve the right to **reject or cancel any bid, withdraw any
lot before close, correct errors (including pricing, description, or closing
errors), and reopen/extend/re-run lots**; refuse or suspend bidders; and
administer the auction at the platform's discretion to protect integrity.
**Why operationally:** Admin already has override capability (publish, archive,
close, withdraw) and error-correction needs (e.g., a mis-priced $1 vs $100 lot).
These rights must be contractually reserved to be exercised without breach.

## 13. Taxes, fees, buyer premium & invoices — *Launch-critical* **[ATTORNEY]**
**Recommendation:** State that **applicable sales tax is calculated after close**
and added to the invoice; itemize hammer + buyer premium + taxes + any fees;
buyer is responsible for all such amounts; an invoice/receipt is issued per won
lot.
**Why operationally:** Tax is computed post-close (CLAUDE.md) and invoices are
generated on payment (`invoiceService`). The total charged must match disclosed
components. Sales-tax obligations are jurisdiction-specific — **[ATTORNEY]/tax
advisor**.

## 14. Chargebacks / nonpayment / account suspension — *Launch-critical* **[ATTORNEY]**
**Recommendation:** Bids are binding; initiating an unwarranted chargeback or
failing to pay is a breach; consequences include account suspension, loss of
bidding privileges, liability for the balance plus costs, and possible referral
to collections.
**Why operationally:** Protects revenue and gives ops grounds to suspend
(`is_active=false`) abusive accounts. Pairs with #3/#4.

## 15. Governing law / venue — *Soon* **[ATTORNEY]**
**Recommendation:** Specify governing law, venue/jurisdiction, and a
dispute-resolution path (e.g., informal resolution → arbitration or specified
courts). **Currently absent in v1.**
**Why operationally:** Without a venue/governing-law clause, dispute handling is
unpredictable. Arbitration/class-waiver choices are legal-strategy decisions —
must be counsel-drafted.

## 16. Privacy / paddle / account identity — *Soon*
**Recommendation:** Explain that public bidding identity is an **auction-specific
paddle number** (real identity not shown publicly), that **realized/sold prices
are visible only to logged-in account holders**, and that the buyer's **full
address stays hidden until payment is verified**. Reference the privacy policy.
**Why operationally:** These are implemented behaviors (paddle numbers,
realized-price gating, address reveal after payment). Disclosing them sets
expectations and supports the privacy posture in CLAUDE.md.

## 17. Dispute window — *Soon* **[ATTORNEY]**
**Recommendation:** Define a short window (e.g., N hours/days from pickup) to
raise a "not as described"/condition dispute, the required evidence, and that
absent a timely claim the sale is final; clarify this does not override #7's
as-is baseline.
**Why operationally:** Bounds the window for post-sale claims so liability isn't
open-ended; gives support a clear SLA. Interacts with as-is (#7) and authenticity
(#9) — counsel should reconcile.

---

## Cross-cutting recommendations
- **Whole-document attorney review before activation.** v2 becomes a binding
  contract; the marked **[ATTORNEY]** clauses (money authorization, liability
  limits, forfeiture, jurisdiction, arbitration) must be lawyer-drafted.
- **Keep it readable.** Pair plain-language summaries with the binding text so
  first-time bidders understand premium, auto-charge, pickup, and anti-snipe.
- **Version + re-acceptance.** Ship as a new `buyer_terms` version; the
  `is_current` flip forces re-acceptance — no buyer is silently bound to v2.
- **Disclose live numbers.** Buyer-premium rate (#1/#13) and payment-timing
  window (#2) must match what the UI/charge logic actually does; keep them in
  sync if the configuration changes.

## Suggested activation sequence (future, not now)
1. Counsel drafts v2 from these recommendations.
2. Product fills in concrete numbers (premium %, payment-timing window, storage
   fees, dispute window, governing law/venue).
3. Insert the v2 `terms_versions` row; QA acceptance + re-acceptance flow on
   staging.
4. Flip `is_current` to v2 — ideally aligned with the Stripe LIVE cutover so the
   money clauses (#1–#4, #13–#14) are in force before real charges occur.
