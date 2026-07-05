# Platform Legal Documents — DRAFTS

> ⚠️ **DRAFT — NOT FOR PUBLICATION.** These are engineering drafts to seed the Phase‑2 legal framework
> (`legal_documents` / `_versions`, `organization_id = NULL` = platform default). **Require attorney review
> and explicit owner approval before publishing.** Publishing is a Phase‑3 approval gate. Each section maps
> to a `doc_type`. Business terms reflect current platform rules; confirm before go‑live.

---

## buyer_terms — Buyer Terms & Conditions (DRAFT v1)
By registering to bid on Advantage.Bid you agree to these terms. **Bidding:** bids are binding offers; a
**buyer's premium** is added to the hammer price and is **displayed live** during bidding. **Payment:** only
**debit and credit cards** are accepted; a temporary card‑verification authorization under $1 may be placed at
signup or when you change cards. **Winning & settlement:** winning bids create a payment obligation; applicable
**tax is calculated after the auction closes**. **Pickup/shipping:** lots are collected during the published
pickup window (or shipped where offered); full pickup address is revealed after payment is verified. **Identity:**
public bidding uses auction‑specific paddle numbers. **Conduct:** no shill/self‑bidding; the platform may cancel
bids or suspend accounts for abuse. Advantage.Bid operates the marketplace; individual auctions are run by the
listing organization ("Partner").

## seller_agreement — Seller / Partner Agreement (DRAFT v1)
This agreement governs organizations ("Partners") listing auctions on Advantage.Bid. **Marketplace syndication:**
Partner auctions are **automatically syndicated** to the Advantage.Bid marketplace; only Platform Administrators
control marketplace visibility (feature/hide/remove). **Fees:** commissions/fees, where applicable, are configured
per Partner and disclosed separately; at launch there is no platform commission (payment processing ~3% only).
**Content:** Partners are responsible for accurate listings, lawful items, and honoring winning bids and pickup
commitments. **Final submission** locks seller editing; Advantage publishes auctions. **Platform rights:** Advantage
may moderate, unpublish, or remove listings that violate policy.

## privacy_policy — Privacy Policy (DRAFT v1)
Advantage.Bid collects account, bidding, payment‑method (tokenized via our processor), and usage data to operate the
marketplace, prevent fraud, and communicate with you. **Buyer identity is global to the Advantage.Bid network.** We
do not sell personal data. Full addresses remain hidden until payment is verified. SMS notifications are opt‑in only.
Partners receive only the data necessary to fulfill their auctions. You may request access or deletion subject to
legal/record‑keeping obligations.

## refund_policy — Refund Policy (DRAFT v1)
All sales are final unless otherwise stated in a specific auction's terms. Refunds/adjustments for items materially
not as described are handled case‑by‑case by the listing Partner with platform oversight. Card‑verification
authorizations are released/refunded automatically. Chargebacks and disputes are subject to the processor's rules.

## pickup_policy — Pickup Policy (DRAFT v1)
Lots are collected during the published pickup window at the auction location; the full address is shown after
payment verification. For non‑professional sellers, pickup begins at least **48 hours after auction close**;
professional sellers may configure their own pickup timing (never before close). Bring your confirmation and paddle.
Uncollected lots may be subject to storage fees or forfeiture per the auction's terms.

---
*Publishing procedure (post‑approval): for each section create the platform document + a version + publish via
`POST /api/legal/documents` → `/documents/:id/versions` → `/versions/:id/publish` (`organization_id = null`).*
