# Sasha knowledge decisions: Owner rulings on the knowledge-audit contradictions

These are the authoritative answers Sasha may rely on, recorded one decision at a time.
- Nothing here changes production code, settlement, legal documents or public pages by itself. Each follow-up change needs its own approval.
- Legacy terms on previously published auctions are never changed retroactively.

## Decision 1: Seller fees for auctions (approved 2026-09-27)

**Fee schedule (keep what the code already does)**
- **Individual sellers** (private, business, other, untyped):
  - 0% platform fee;
  - 3% payment-processing fee on the hammer price, deducted from the payout;
  - Advantage.Bid receives the 18% buyer's premium.
- **Professional sellers** (auction_house, estate_sale_company, professional_liquidator):
  - platform fee defaults to 4% and is adjustable per seller;
  - 3% payment-processing fee on the hammer price;
  - the seller sets and keeps their own buyer's premium.

**Legacy auctions:** auctions already published under the legacy model keep their legacy settlement terms. There is no retroactive recalculation.

**Public language (a separate, approved-later page change)**
- Remove "at launch" from fee statements.
- State the individual fee precisely: 3% of the hammer price.

**Professional fees, public:** superseded by the Decision 1 update below.

**What Sasha may say**
- Individual seller fees: yes.
- Professional fees: the standard rates in the Decision 1 update below, always adding that the seller's own agreement governs.
- A specific professional seller's rates: only to that seller, after proper identity verification (for example, logged-in chat).

**Decision 1 update (owner approval 2026-11-06)**
- Sasha may state the standard Professional Seller rates: auctions, a 4% platform fee plus 3% payment processing on the hammer price; Professional Storefront fixed-price sales, 5% through the seller's own website and 9% through the Advantage.Bid marketplace, card processing included (Seller Agreement v4).
- She always adds that the seller's own agreement governs, and never reveals another seller's rates.
- Online checkout (Buy Now) for storefront items and shipping for auctions are not enabled: Sasha never presents them as available.
- Selling conversations (owner hard stop): Sasha never recruits buyers or casual individuals into selling, gives individuals who ask about selling their own items factual information only, and keeps benefit-led conversations for commercial businesses that independently express interest. Source: `sellingBoundaries()` in `src/services/sasha/engine.js`.

## Decision 2: Buyer's premium (approved 2026-09-27)

**Policy (keep what the code already does)**
- **Individual-seller auctions:** a fixed 18% buyer's premium, kept by Advantage.Bid.
- **Professional-seller auctions:** the seller configures a premium, any whole percentage from 0% through 100% (the range the code enforces: `auctionService.assertProfessionalPremiumBps`). It defaults to 18% when not configured, and the professional seller keeps it. Sasha never states a minimum, maximum, typical range or default for Professional Sellers; she gives the specific auction's premium.

**Historical terms:** historical auction and invoice terms are preserved.

**Public, buyer-facing wording**
- Stay neutral about who receives the premium.
- Always show the actual premium for the specific auction or lot.

**Worked example:** a $100 winning bid plus an 18% premium equals $118, before any applicable sales tax. Always label it as an example, not a promise that every auction charges 18%.

**What Sasha may say**
- The general explanation above.
- The rate for a specific lot or auction, read from live data only.
- Nothing about who receives the premium, when talking to buyers.

## Public-content corrections applied for Decisions 1 and 2

Branch content/fee-premium-accuracy.
- Seller pages: faq, how-it-works, how-sellers-get-paid (including meta, Open Graph and Twitter descriptions), seller-faq, seller-pilot, start-selling, and seller-create (professional hint).
- Buyer pages: buyer-faq and how-to-buy.

## Decision 3: Card verification and card types (approved 2026-09-27)

**Verification method**
- Keep the existing card-saving verification: a SetupIntent, where the bank checks the card.
- Advantage.Bid does NOT charge customers to verify a card. There is no random under-$1 charge or authorization.
- The customer's bank may briefly show a temporary authorization.

**Card types**
- Credit and debit cards only.
- A card the network reports as prepaid is refused when it is saved, and it is detached, never kept.
- A card reported as unknown is allowed, so a legitimate card is never refused on an uncertain classification.

**Classification check:** verified with official test cards. Stripe reports the funding type as credit, debit, prepaid or unknown, and visa, mastercard, amex and discover were classified correctly.

**Payment provider name:** removed from customer-facing copy ("securely save your payment method"). Exceptions:
- the payout setup page (payout-profile.html), where sellers are sent to the provider to verify their identity;
- the Privacy Policy, which must disclose processors.

**Payments status:** production runs in TEST mode until LIVE activation. Until LIVE payments are verified, Sasha must NOT say that real-card setup or payment collection is available.

**Public corrections:** buyer-faq, how-to-buy, login, add-card, billing, payment, lot, browse-categories, featured-auctions, shipping-available, professional-sellers, the professional upgrade panel and the admin dashboard label. The add-card test-mode hint now appears only on test keys. CLAUDE.md is updated.
