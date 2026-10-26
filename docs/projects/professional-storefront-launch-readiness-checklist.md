# Professional Storefront — launch-readiness checklist (2026-10-26)

Companion to `professional-storefront-roadmap.md` (canonical TODO, §11 lists every deferred requirement). Production
checkpoint: main = `0c069e6`, migrations through 204. Live checkout (`MARKETPLACE_CHECKOUT_ENABLED`), payouts, external
shopping feeds, tax filing and remittance are **off** and stay off until the owner explicitly approves each one.

## 1. Complete and deployed (production)
- Storefront pages `/pro/:slug`, fixed-price listings, flat 11% seller fee on the item price (no buyer's premium).
- Checkout code with item reservation and double-sale protection (M1, 197) — **switched off**.
- Ownership + order integrity enforced by the database (197); moderation, listing reports, buyer order issues (198).
- Seller staff accounts + one-company pilot framework (199, 010eb01) — **switched off**, no company enabled.
- Product SEO: canonical item URLs, structured data, sitemap (200); existing-item editing (34a547d).
- Shipping controls, pickup-only by default (201); demo items pickup only.
- Taxpayer-ID minimisation: no EINs accepted or stored; Stripe Connect is the source (202).
- Seller Store Terms + Shipping & Pickup Policy, storefront tabs, checkout acknowledgment, immutable order snapshots (203).
- Seller inventory numbers + reliable paid-sale seller notices (queue, retries, failure alert, no buyer data) (204).

## 2. Built but not deployed (branch `feat/item-messaging`)
- `c80dcfc` — clearer "estimated proceeds are not your final deposit" wording in the sale email; known-issues log;
  `prod-verify-204.js`.
- Milestone Q — item questions between signed-in buyers and the seller company, contact details hidden, diversion and
  off-platform-payment requests held for human review, review queue, message notices (migration 205). Flag
  `STOREFRONT_MESSAGING_ENABLED` unset = every route 404s and item pages are unchanged.

## 3. Must be finished before the first real Professional Storefront sale
1. **A real Professional Seller** onboarded and verified (production has none today), with Stripe Connect payout
   details, their own Store Terms and Shipping & Pickup Policy published, and real listings (photos, prices, pickup or
   complete shipping terms).
2. **Buyer Terms that cover fixed-price storefront purchases.** The live Buyer Terms do not mention Buy Now / storefront
   purchases; the v4 draft is unapproved. Needs owner (and legal) approval before checkout opens.
3. **Sales-tax remitting party** for storefront sales determined with a qualified advisor (§8.5), and Stripe Tax
   confirmed for storefront orders in live mode (the auction path is live; storefront orders have not been taxed live).
4. **How the seller gets paid for a storefront sale.** Storefront orders are not in any settlement or payout report yet.
   Minimum: an approved manual settlement procedure (who checks fulfilment, when proceeds are paid, refund/chargeback
   holds) — or Milestone 3 (ledger + statements, transfers still manual).
5. **One authorised live checkout test** on a real item (small amount, refunded), confirming payment, tax, order record,
   seller notice email, fulfilment steps and refund — billable, needs owner approval first.
6. **Item contact path decision.** Today, with checkout on, item pages still link to the storefront contact form, which
   hands the buyer's contact details to the seller. Recommended: deploy milestone Q and turn messaging on for the
   storefront before (or with) checkout so item questions stay on Advantage.Bid.
7. **Sold-page price rule** (roadmap §12.3 P0 decision): today a sold storefront page shows the listed price publicly,
   which reveals the sale price; decide the rule and enforce it server-side before the first real sale.
8. Owner approval to set `MARKETPLACE_CHECKOUT_ENABLED=true` (production deploy rules apply).

## 4. Can safely stay on the post-launch TODO list
Staff accounts rollout and staff notification recipients; notification preferences and other notice types; search,
filters and sorting; storefront website widget and branded header; bulk import and image migration; shopping-feed
builder and any network submission; full settlement statements and reconciliation automation (if a manual procedure is
approved for launch); tax-time reports; compliance-profile fields (only if a requirement is verified); guest questions,
attachments and cross-conversation scoring; consultation-form relabelling; category pages; public Professional Seller
marketing (launch only once the above is genuinely ready); red SOLD banner on sold item images (roadmap §12.1, P1); Past Merchandise tab (§12.2, P2); Phone Sasha timing test (MI-1).

## 5. Decisions and approvals needed from the owner
1. Deploy approval for `feat/item-messaging` (migration 205 + code), after the independent review fixes and gate.
2. When to turn item messaging on (suggested: demo seller check first, then the first real seller).
3. Message retention period; which staff roles may read and answer item questions once staff are on; whether
   reviewers may hide an already-delivered abusive message (append-only "hidden" state).
4. Seller-agreement clause against diverting Advantage.Bid sales (legal wording to approve).
5. Which Professional Seller is the first real storefront seller (also the staff pilot account, if the same).
6. Buyer Terms coverage of storefront purchases (approve wording; the draft is never deployed without approval).
7. Sales-tax remitting-party conclusion (with an advisor) and the storefront settlement / payout procedure.
8. Approval and budget for one live, refunded checkout test.
9. Final approval to switch on checkout; later, payouts, shopping feeds and marketing, each separately.
10. Still open from earlier: sold-item index retention; staff pilot phone verification (owner-initiated).
