# Claimed Listing: BD Agent Handoff

Prepared by VS Code, 24 Sep 2026, for the agent that edits the Brilliant Directories site at www.advantage.bid.

**Nothing in this file has been applied to BD.** Railway reads BD only through its read-only API, so it cannot make these changes. Each item needs the Owner decision named on it, and each has a verification step. Do not report an item as live until its verification passes.

Railway side (already deployed with the Claimed Listing release):
- the token-first claim page `https://bid.advantage.bid/claim/<token>`;
- the directory landing page `https://bid.advantage.bid/claim-listing.html?org=<org id>`;
- the lookup `GET https://bid.advantage.bid/api/public/listings/by-bd/<bd user_id>`. It returns `{ "orgId": "<uuid>" }` for an unclaimed, visible listing. It returns 404 when the listing is claimed, hidden, removed or unknown.

---

## 1. "Claim this listing" button: keep the company context (blueprint G2)

> **Current version: `bd-head-claim-listing-v3.html`** (site-wide HEAD custom code, replacing the v2 "Safe Claim Listing redirect" block). Verified root cause of the v2 failure (2026-09-25): the BD HEAD editor strips backslashes, so v2's `/^d+$/` became `/^d+$/` and the script exited before touching the link. v3 contains no backslash, needs no cross-origin lookup (it links to `claim-listing.html?bd=<user_id>`, which Railway resolves itself), and uses a capture-phase click handler so no click can reach `/join?claim=`. Browser-tested against the live page HTML with BD's own scripts loaded. **Rule for every future BD snippet: no backslash characters.**

**Today.** The button links to `https://www.advantage.bid/join?claim=<hash>`. That is the generic Join page, and the company context is lost.

**Change.** Point the button at the Railway landing page for that listing:

```
https://bid.advantage.bid/claim-listing.html?org=<railway org id>&utm_source=directory&utm_medium=listing&utm_campaign=claim_button
```

The org id comes from `GET https://bid.advantage.bid/api/public/listings/by-bd/<user_id>` (BD `user_id` = Railway `organizations.bd_listing_id`). Two ways to wire it:

- **Widget (preferred, no per-listing data):** a small script in the listing template calls the lookup with the listing's `user_id`. On 200 it sets the button `href`; on 404 it hides the button (listing already claimed or hidden). The lookup is public, cached for 5 minutes, and returns only the id.
- **Template field:** store the org id on the listing and render the link directly.

**Decision.** None needed; this is a fix. It must still be verified.

**Verify.** On 3 unclaimed listing pages, the button opens the Railway page showing that company's name. On a claimed listing (Lewis & Maese), the button is hidden or points to the dispute path.

## 2. Paid plan badges on imported, never-joined listings (blueprint G6, Owner decision O3)

Verified on 24 Sep 2026 with `scripts/claimed-listing-badge-audit.js`, read-only, against the live directory API and Railway. Full evidence is in `reports/badge-verification-2026-09-24.json`.

A record was preserved when any of these existed: a real directory login, a directory order, invoice, product or transaction, a Railway organization owner, a Railway professional membership, a negotiated pricing agreement, a linked professional seller, a self sign-up, or Advantage's own listing.

**Move these 41 records to the Claim Listing plan (subscription_id 7). Change nothing else on them.**

| From plan | BD user_id |
|---|---|
| Gold Retailers (subscription 1), 7 records | 21 Simpson Galleries, 33 Robert A. Siegel Auction Galleries, 34 La Belle Epoque Auction House, 35 Capsule Auctions, 36 Proxibid, 37 Phi Auctions, 39 Auction Advisors |
| Silver Retailers (subscription 2), 1 record | 24 Plant & Machinery Inc |
| Appraiser Listing (subscription 6), 33 records | 22 IAA Houston, and 318 through 349 inclusive |

**Preserve (do NOT change):**
- 350 Lewis & Maese Antiques & Auctions. A genuine paid Gold Retailers member: logs in, has billing records and an active subscription, and owns its Railway organization. Its private agreement is untouched.
- 28 AAC (Advantage's own listing).
- 4 and 365 (Independently Managed Sale, self sign-ups).
- The 7 General User Account records and the Admin / Blog Author record (not business badges).

**Verify.** Re-run `node scripts/claimed-listing-badge-audit.js` (read-only). It must report `correction_candidates: 0`, with the four preserved records unchanged. On listing page 35 (Capsule Auctions), the "Membership Plan - Gold Retailers" badge is gone and the claim button shows. Railway keeps these listings in data-quality review until the audit passes (`claimed_listings.paid_badge_bd_listing_ids`); after it passes, empty that list in platform config.

## 3. Imported "About" texts (blueprint G7, Owner decision O4)

174 of 335 imported descriptions state business terms we never verified (for example "no upfront fees", "fair commission rates", years in business). The replacement text says only what the record supports:

> {Name} is {an estate sale company | an auction house | an appraiser} in {City}, {ST}. This listing was created from public business information. The business can claim it to add details.

Every listing and its exact replacement is in `reports/about-replacements-2026-09-24.json`. Pilot candidates come first, then the listings whose current text contains unverified claims.

**Order.** The 23 pilot candidates first, then everyone else. Replace only on **unclaimed** listings; a claimed listing's text belongs to its owner.

**Railway copy.** After O4 is approved, run `node scripts/claimed-listing-about-replacements.js --pilot-only --apply --confirm=REPLACE-ABOUT-TEXTS`. It updates only listings that are still unclaimed.

**Verify.** Open 5 replaced listing pages on BD and in the Railway claim preview. The text matches the report exactly, and no business-term claim remains.

## 4. Structured data image URL (blueprint G8)

The BD listing template emits `LocalBusiness` JSON-LD with a relative `image` (for example `/logos/profile/limage-19.webp`).

**Change.** Make it absolute: `https://www.advantage.bid/logos/profile/limage-19.webp`.

**Verify.** Run the Rich Results Test on 2 listing pages. `image` must be an absolute https URL.

(Railway's own company profile already emits an absolute image URL, and its canonical tag points at the BD listing page whenever a listing exists: one canonical per company, as decided in blueprint section 22.)

## 5. Removal requests (the "Please remove this listing" option)

When a recipient chooses "Please remove this listing", Railway does three things:
- suppresses the address and stops outreach immediately;
- marks the listing `removal_requested_at` (so it leaves outreach and the directory lookup);
- opens a `remove_listing` task, due in 2 business days.

**Staff procedure (within 2 business days):**
1. In the Toolbox (Claimed Listings), open the company and choose **Hide (removal request)**. This hides it on every Railway surface through the one canonical visibility rule. It is reversible.
2. BD agent: unpublish the BD listing (set it inactive; do not delete it, so the action can be reversed).
3. Mark the task done with a note.

**Verify.** The listing no longer appears on the BD directory or the Railway marketplace map, and `GET /api/public/listings/by-bd/<id>` returns 404.

## 6. Not in scope for the BD agent

- No email is sent from BD for the Claimed Listing programme.
- Do not create, merge or delete listings. Do not change plans other than the 41 above. Do not touch any pricing, membership or agreement data.
- Do not mention Professional Seller fees on listing pages.
