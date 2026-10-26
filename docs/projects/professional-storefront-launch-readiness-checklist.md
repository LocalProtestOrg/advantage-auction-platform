# Professional Storefront — launch-readiness checklist (2026-10-26)

Companion to `professional-storefront-roadmap.md` (canonical TODO, §11 lists every deferred requirement). Production
checkpoint: main = `2ff6bf9`, migrations through 205 (item messaging deployed, OFF). Live checkout (`MARKETPLACE_CHECKOUT_ENABLED`), payouts, external
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

## 2. Deployed 2026-10-26 but switched OFF (previously "built but not deployed")
- `c80dcfc` — clearer "estimated proceeds are not your final deposit" wording in the sale email; known-issues log;
  `prod-verify-204.js`.
- Milestone Q — item questions between signed-in buyers and the seller company, contact details hidden, diversion and
  off-platform-payment requests held for human review, review queue, message notices (migration 205). Flag
  `STOREFRONT_MESSAGING_ENABLED` unset = every route 404s and item pages are unchanged.

## 2a. Built 2026-10-26, NOT committed or deployed: Milestone 206 (roadmap §9.1, §12.3)
- Migration 206 (additive, idempotent; not applied anywhere in production).
- Sold-item price privacy: once an item is sold, the public JSON API, page, meta tags and structured data carry no price
  or shipping charge (SOLD + `SoldOut`). Per-item "show the sale price to signed-in members" setting, default OFF,
  company owner only; members recognised only by a server-confirmed current session.
- Message reporting (recipient only, review work only, its own admin alert) and moderator hiding (once, with a reason,
  record kept; stops any notice not yet sent, but cannot retract an email already delivered).
- Pilot checks on every messaging path (including buyer inbox, withdraw, appeal and report); item pages (sold ones
  included, which list other items' prices), unsold item answers and the storefront item list are revalidated on every
  view, so a cached copy never shows a price after a sale.
- Controlled pilot: `STOREFRONT_MESSAGING_PILOT_SELLER_IDS` / `STOREFRONT_MESSAGING_PILOT_USER_IDS`, both empty, general
  switch unset, so messaging stays OFF for everyone (documented in `.env.example`).
- Remaining before deploy: owner review, commit, independent review, gate green, owner approval, then
  `prod-migrate-206.js --check`, apply, `prod-verify-206.js` (rolled back).

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
   hands the buyer's contact details to the seller. Recommended: deploy Milestone 206, run the controlled messaging
   pilot (demo seller and named test accounts, then the first real seller), and turn messaging on before (or with)
   checkout so item questions stay on Advantage.Bid.
7. **Sold-page price privacy** (roadmap §12.3 P0): DECIDED 2026-10-26 (a sold item's price is never public) and built in
   Milestone 206. Still required: deploy and verify 206 in production before the first real sale (production today
   still shows the listed price on a sold page; there are no real storefront sales yet).
8. Owner approval to set `MARKETPLACE_CHECKOUT_ENABLED=true` (production deploy rules apply).

## 4. Can safely stay on the post-launch TODO list
Staff accounts rollout and staff notification recipients; notification preferences and other notice types; search,
filters and sorting; storefront website widget and branded header; bulk import and image migration; shopping-feed
builder and any network submission; full settlement statements and reconciliation automation (if a manual procedure is
approved for launch); tax-time reports; compliance-profile fields (only if a requirement is verified); guest questions,
attachments and cross-conversation scoring; consultation-form relabelling; category pages; public Professional Seller
marketing (launch only once the above is genuinely ready); red SOLD banner on sold item images (roadmap §12.1, P1); Past Merchandise tab (§12.2, P2); Phone Sasha timing test (MI-1).
Roadmap-only Professional Seller requirements recorded 2026-10-26 (roadmap §13, not part of 206): self-serve setup
before approval with a verification gate for checkout, payments and payouts (§13.A; note the storefront checkout path
does not yet check seller verification itself, so this gate must exist before checkout is switched on for an
unverified seller); owner/staff registration and verification notifications (§13.B); secure seller document upload
and staff review (§13.C); item percentage discount editor (§13.D); storewide Sales & Promotions (§13.E); search and
answer-engine discoverability that respects sold-price privacy (§13.F).

## 5. Decisions and approvals needed from the owner
1. (Done 2026-10-26) Milestone Q deployed; messaging stays OFF.
1a. (Decided 2026-10-26) Sold-item price privacy, recipient reports and moderator hiding, controlled pilot: built in
    Milestone 206. Next: owner review of 206, then commit and deploy approval.
2. When to start the messaging pilot and which company / test accounts (suggested: demo seller and named test accounts
   first, then the first real seller), and later when to turn the general switch on.
3. Message retention period; which staff roles may read and answer item questions once staff are on.
4. Seller-agreement clause against diverting Advantage.Bid sales (legal wording to approve).
5. Which Professional Seller is the first real storefront seller (also the staff pilot account, if the same).
6. Buyer Terms coverage of storefront purchases (approve wording; the draft is never deployed without approval).
7. Sales-tax remitting-party conclusion (with an advisor) and the storefront settlement / payout procedure.
8. Approval and budget for one live, refunded checkout test.
9. Final approval to switch on checkout; later, payouts, shopping feeds and marketing, each separately.
10. Still open from earlier: sold-item index retention; staff pilot phone verification (owner-initiated).
