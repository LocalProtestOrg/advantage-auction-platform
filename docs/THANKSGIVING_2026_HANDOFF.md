# Advantage.Bid: Thanksgiving 2026 handoff

Written 2026-11-20. Development is paused for Thanksgiving travel. This document is everything needed to resume without
reconstructing progress. It contains no credentials, keys or customer personal information.

## 1. Production status at shutdown

| Item | State |
|---|---|
| Production site | https://bid.advantage.bid |
| Production commit | `a074d7a` on `main` (unified header, item page and storefront redesign) |
| Deployed | 2026-11-20 18:17 UTC, health check `ok`, database reachable |
| CI | "Tests" green on `a074d7a` (business-rule suites and all real-browser journeys); "Site Watchdog" green |
| Payments | Live mode. Storefront checkout enabled. 0 failed webhooks, 0 orphaned payments |
| Database | Migrations through `232_item_unavailable_history.sql` applied |
| Orders | One: MO-001025 (pilot purchase, fully refunded, not payout-eligible) |
| Tax | Ledger nets to zero for the pilot (sale and refund reversal). Latest reconciliation run: clean |
| Background workers | No advisory locks held (the two pooled-lock repairs are live) |

Pushing to `main` deploys to production automatically. This document lives on the branch
`docs/thanksgiving-2026-handoff` so that saving it did not trigger a deployment; merge it with the next approved release.

## 2. What was completed (most recent first)

**2026-11-20**
- Unified public header (`public/widgets/shared/public-nav.js`): logo, search, account menu; Auctions Near You, Estate
  Sales Near You, Buy Now Marketplace, Find Professionals, Start Selling. Live on item pages, storefronts and policy pages,
  the shop, events, search, browse pages and the marketing pages.
- Item page redesign: gallery, status badge, detail chips, Item Details, About the Seller with Contact Seller, and a note on
  historical listings.
- Storefront redesign: seller banner and logo, Follow and Contact, section tabs, category tiles built from real inventory,
  empty-shop panel, Policies, Previously Sold (photo and title only).
- Map links: `/?show=auctions`, `/?show=estate-sales`, `/?show=professionals`, `/?show=marketplace` pre-set the map key.
- Approved commission statement on Start Selling and the professional seller pages (exact wording, section 5).

**2026-11-19**
- First live storefront purchase and full refund (the pilot), reconciled end to end.
- Repaired two background jobs whose locks could strand on the pooled database connection: the tax worker and the seller
  check-in job.
- Order emails: the standard refund sentence, professional seller contact block, storefront links, shipment email with
  carrier and tracking number.
- Historical item pages (migration 232): a refunded item keeps its page as "No longer available"; never relisted.
- Storefront selling prices are private from everyone, including signed-in members.
- Start Selling: three ways to sell (Open an Online Storefront, Conduct Online Auctions, Promote Estate Sales).

**Earlier in November**: centralized sales tax (migration 231, New Jersey registration recorded), storefront launch,
Buyer Terms v4, Seller Agreement v4 (5% and 9% storefront commission).

## 3. Known limitations and open issues

No critical production errors are known. Nothing needs attention during the break.

1. **No purchasable item exists.** The pilot shop's only item was the refunded lamp; the other 11 active items belong to
   sellers who are not yet cleared to accept orders. Checkout has not been exercised on production since the pilot.
2. **`www.bid.advantage.bid` shows an HTTPS warning.** The DNS record points at the wrong target, so its certificate
   never issued. `bid.advantage.bid` is unaffected. Fix is in section 4, item 3.
3. **Estate Sales Near You** opens the full map while no estate sales are listed (deliberate: never an empty map).
4. **Previously Sold** does not appear on Timeless Treasures: it has no completed, unrefunded sale yet.
5. **Header search** covers auctions and lots only (the existing search page). It does not search sellers or estate sales.
6. **No cart and no Save button** on item pages: neither feature exists, so neither is shown.
7. **Auction refund emails do not exist.** Only storefront refunds email the buyer. The shared sentence is ready in
   `src/lib/refundCopy.js`.
8. **`/sell-online` is switched off** in production by `SELL_ONLINE_PAGE_ENABLED`. Its copy is current.
9. **Six old migration files were never applied** to production (008, 017, 032, 082, 090, 106). This is long-standing
   and predates this work; 090 (auction geocoding) is known to wait on a map token. Do not apply them without review.
10. **One test fails on the development computer only** (`tests/buyerLifecycleSalesNearYou.test.js`); it passes in CI.
11. **The main working folder has uncommitted files** (section 7). They are the owner's own drafts and were left untouched.

## 4. Next tasks, in priority order

1. **Brilliant Directories marketing and seller onboarding updates** (manual; the marketing site is not in this
   repository). Put the approved commission statement (section 5) and the three ways to sell on every advantage.bid page
   that mentions selling or seller pricing; remove any older figures (a flat 11%, "8% + 3%", processing shown as a
   separate charge). Link to `https://bid.advantage.bid/start-selling.html#ways-to-sell`.
2. **Finish the unified header** on the pages that still use the older ones: the bidding pages (`lot.html`,
   `auction-view.html`) and the signed-in account pages (member shell, `buyer-nav.js`). Bidding pages carry bid-sound and
   back-button behavior that must be preserved. Also decide the logo destination (section 6).
3. **`www.bid.advantage.bid` DNS correction** (owner action in the advantage.bid DNS zone; there is no DNS access from
   this project). Replace the CNAME for `www.bid` with `paygkg74.up.railway.app`, and add the TXT record
   `_railway-verify.www.bid` with the verification value shown for that domain in the Railway dashboard (service
   settings, custom domains). Then verify the certificate and that `www.bid` redirects to `bid`. The redirect itself is
   already built (`src/middleware/canonicalHost.js`). Do not weaken HTTPS settings to work around it.
4. **Seller and buyer experience** (each needs owner approval before building):
   - Seller-initiated refunds.
   - Follow Seller and Share improvements; notification preferences and digests.
   - Saved addresses at checkout.
   - Admin transaction search across orders.
   - Auction refund email using the standard sentence.
   - Search that covers sellers and estate sales.
5. **Housekeeping**: turn on `/sell-online` when wanted and link it; merge this handoff branch with the next release;
   decide on `chore/nj-tax-setup-record` (a record-keeping branch, not merged).

## 5. Approved business rules and safeguards (do not change without owner approval)

**Money**
- Do not charge a card, issue a refund or start a seller payout without the owner's explicit approval of that action.
- Do not change payment processing, commission rates, tax handling, payout holds or seller agreements.
- Storefront commission: 5% for sales from the seller's embedded storefront, 9% for marketplace sales, card processing
  included, on the item price only (not shipping or tax). No monthly or listing fees.
- Tax filing and remittance stay manual. Do not turn on the payment processor's paid automatic filing. Do not register
  in more states without owner approval. Tax administration data is never shown publicly, to sellers, or to Sasha.
- Never invent shipment, delivery, payment, refund or payout evidence.

**Exact wording**
- Commission statement, exactly: "One Simple Commission. No Hidden Processing Fees." then "Pay just 5% on sales
  originating from your own embedded storefront or 9% on sales originating from the Advantage.Bid marketplace. Roughly
  3% standard Stripe credit card processing is included. No monthly fees or listing fees." Tests allow the processor
  name and "Roughly 3%" only inside this statement (`tests/helpers/approvedStorefrontCommissionCopy.js`).
- Refund sentence, exactly, right after the email says the refund was issued: "Please allow this refund 3 - 5 business
  days to reflect on your account, depending on your bank." Never say the refund has posted.

**Privacy**
- Storefront selling prices are private from everyone. Previously Sold never shows a price, date or buyer.
- Auction sold-price visibility rules are separate and unchanged.
- Order emails use only a professional seller's published business details; otherwise a Contact Seller link. Never an
  individual seller's email, phone or address.

**Listings**
- Sold items keep their pages. A refunded item shows "No longer available" and is never relisted automatically.
- Seller removals, drafts and moderation takedowns stay hidden.
- Render only real database content: no invented products, prices or seller details.

**Presentation**
- Embedded storefront widgets on sellers' own websites never carry Advantage.Bid navigation.
- No "AI" wording and no long dashes in anything a person sees (full standard in `CLAUDE.md`).
- Approved design reference: `public/images/page-design/AdvantageBid_Approved_Design_Reference.png` (committed on this
  branch). It is a guide to layout and quality, not a list of features to copy.

**Process**
- Production deployments need owner approval. Never bypass a failing test or weaken CI.
- Do not modify Lewis & Maese inventory, the Brilliant Directories site, DNS, or the DMARC record.
- Do not merge the auction shipping branch (draft PR #86).
- Never write credentials into any file. Read production only through `scripts/lib/prodReadOnly.js`.

## 6. Decisions waiting for the owner

1. **Logo destination**: the header logo goes to the platform home (`bid.advantage.bid`). An earlier decision pointed
   the event page logo at `advantage.bid`. Choose one for everywhere.
2. **Auction refund email**: add one, using the standard sentence?
3. **`/sell-online`**: turn it on?
4. **New Jersey**: filing frequency and Certificate of Authority date, when available.

## 7. How to resume after Thanksgiving

1. Open the main folder `C:\Projects\advantage-auction-platform` in VS Code and start Claude Code.
   Preferred development model: **Claude Code Opus 5.5** (check with `/model`).
2. Ask Claude to read this file first: `docs/THANKSGIVING_2026_HANDOFF.md` on branch `docs/thanksgiving-2026-handoff`.
3. Confirm production before any work: `https://bid.advantage.bid/api/health` should report `ok`, and `main` on GitHub
   should still be `a074d7a` unless something was deployed in between.
4. Start new work on a new branch from `origin/main`. The clean working copy used for recent releases is
   `C:\Projects\aap-sasha-mail`.
5. Release steps used all month: run the "Tests" workflow on the branch, wait for green, then fast-forward `main` to the
   branch (which deploys), then confirm the health check shows a new start time. Production migrations are applied by
   hand with a guarded script (`scripts/prod-migrate-NNN.js`: `--check`, `--dry-run`, then apply) before the code that
   needs them.

**Local state left as it was**
- `C:\Projects\advantage-auction-platform` is on branch `fix/baseline-corrections` with uncommitted files: two marketing
  images, `public/terms.html`, two test files, and about thirty untracked drafts under `docs/` and `scripts/`. These
  were not created in this work and were not changed, committed or deleted.
- Older local branches that existed only on this computer were pushed to GitHub as backups on 2026-11-20
  (`docs/sasha-knowledge-decisions`, `docs/seller-growth-2026-09-27`, `feat/pro-premium-policy`,
  `feat/sasha-phone-silence`, `test/live-acceptance`, and `backup/release-phone-sasha-live-local`). None is deployed.
- Open pull requests, all intentionally unmerged: #86 auction shipping (draft), #83 marketplace events, #60 seller
  programs page.
