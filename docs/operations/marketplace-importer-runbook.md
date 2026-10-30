# Marketplace inventory importer, categories, photos and Post to the Market (runbook)

Built 2026-10-30 on `feat/pro-seller-storefront-completion` (migration 209). Seller page: **Inventory & Import**
(`/seller-inventory.html`). Code:
- `src/services/storefrontImportService.js`
- `storefrontImportPhotoService.js`
- `storefrontCategoryService.js`
- `storefrontReadinessService.js`
- `marketplaceItemService.js` (Post to the Market)

## The seller's workflow
1. **Upload Spreadsheet.** CSV or Excel `.xlsx`, up to 2,000 rows and 5 MB. Older `.xls` files are refused with
   instructions to save them as `.xlsx` or CSV.
2. **Match Columns.** Each heading has one destination:
   - the ten fields: Inventory Number, Item Title (required), Description, Sale Price, Quantity, Category, Condition,
     Dimensions, Material, Color;
   - Photo_1..Photo_15;
   - Skip / Ignore.

   Rules:
   - Skip / Ignore is the only destination that may repeat. Uniqueness is enforced in the page (taken choices are
     disabled) and on the server (`MAPPING_DUPLICATE`).
   - Common headings are suggested, e.g. INV#, Inventory Num, Item Number, itemnum, SKU, Lead, Short Description, Qty,
     Price, Photo 1, Image URL.
   - Approved choices are saved per seller and source software (header fingerprint; `storefront_import_mappings`).
   - The seller also chooses photo matching (Inventory Number, Original Auction Lot Number, another column, or none)
     and what happens to items already in their inventory: skip, or update the matching **drafts** only.
3. **Add or Match Photos** (optional). Photos are matched to rows before any item exists (`storefront_import_photos`):
   - **Order of matching:** a manual assignment; then a file name written in a Photo_N cell; then the matching reference
     (`REF.jpg`, `REF_2.jpg`, `REF (2).jpg`, or a ZIP folder `REF/…`).
   - **Not stored:** unmatched and ambiguous files are reported and not stored, and the seller can assign them.
     Duplicates (same checksum) are skipped.
   - **Links:** photo links are fetched through the network guard (below).
   - **Arranging:** the seller reorders photos, chooses the primary, moves a photo to another row or removes it.
4. **Review Inventory.** Shows:
   - total rows, new items and existing items;
   - missing Sale Prices;
   - matched, unmatched and named-but-missing photos;
   - rows with problems, and created, updated and skipped counts.

   A problem list downloads as CSV. Categories are not reviewed here.
5. **Import Drafts.** In chunks of 100, resumable: Continue picks up where it stopped. It is retry-safe (unique batch
   row), and each draft receives its row's photos in order. Nothing is public until the seller publishes.

## Rules that never bend
- **Sale Price is the only marketplace price.**
  - Reserve, estimate, starting bid, bid amount, cost and similar columns are never suggested and can never be mapped
    to Sale Price (`MAPPING_AUCTION_PRICE`).
  - A row without a Sale Price imports as an unpriced draft.
  - Database rule `marketplace_items_priced_when_visible`: only `draft` and `removed` items may be unpriced.
- **Categories use the one taxonomy** (`src/constants/lotCategories.js`), assigned automatically:
  1. the spreadsheet's category when it maps;
  2. otherwise the item's own words, using a weighted, conservative classifier with a confidence;
  3. otherwise **pending**, never guessed.

  Where it came from is recorded (`category_source`: spreadsheet / automatic / seller / auction). A seller's choice is
  final: imports, updates and the background pass never change it. When the text classifier
  (`aiDescriptionService.classifyCategoryText`) is configured, one bounded background pass after each import assigns
  pending items above the confidence threshold. Categories help discovery and SEO; they do not guarantee search
  ranking or shopping approval, and no shopping feed is enabled.
- **Photo links:**
  - only public addresses, with the connection pinned to the checked address;
  - same-site redirects only;
  - 10 MB cap and 20 s timeout;
  - the bytes must be JPEG, PNG, GIF, WebP or HEIC;
  - stored unchanged.

  Private and metadata addresses, other ports, credentials in links and non-web schemes are refused. No photo is ever
  invented, edited or substituted.
- **Seller isolation:** every batch, staged photo and item is resolved from the session's company. Another company gets
  404, the same answer as for something that does not exist.

## Quantity
Items record how many the seller has (0..100,000; blank = 1). Buying more than one at a time online is not built: the
checkout refuses any item whose quantity is not 1 (`QUANTITY_NOT_SUPPORTED`). Multi-quantity purchasing remains a
required milestone before storefront checkout is enabled.

## Post to the Market
"From Auctions" on My Storefront lists the seller's unsold lots from closed auctions. **Post to the Market** creates a
**draft**:
- reuses the lot's title, description, condition, dimensions, material, era, maker and photos;
- keeps the source lot and auction internally, with the original lot number;
- category from the lot's taxonomy category, otherwise automatic;
- Sale Price only if the seller enters one. Reserves, starting bids and bids are never carried over; the old
  reserve-based default price is removed.

It is refused for a lot that is open, withdrawn, sold, in an auction that has not fully closed, or with an active
payment, and it is idempotent: one listing per lot, enforced by the database. Auction lots have no inventory-number
field, so the seller can set one in the draft.

## What stands between inventory and a sale
The **Before buyers can purchase your items** panel (`GET /api/seller-storefront/readiness`) reads the existing gates;
it adds none:
- seller agreement;
- business verification (the one publication gate);
- storefront pickup location;
- published storefront page;
- payout account;
- online checkout (still off by Advantage.Bid).

It also lists item notes: missing Sale Price, quantity 0, more than one in stock, no photo, category pending. The page
also shows the storefront link and website embed code. Published items appear on Advantage.Bid and in the widget
(dual distribution); unpublishing removes them from both.

## Release (needs owner approval)
1. Take a Neon backup branch of production.
2. Run `railway run … node scripts/prod-migrate-209.js --check`, then `--dry-run`, then apply. The read-only check
   passed on 2026-10-30 against 4 production items.
3. Deploy the branch.
4. No switch is needed: the importer and editor are part of the seller pages, and checkout, payouts and shopping feeds
   stay off.

## Rollback
- **Code:** redeploy the previous `main`.
- **Schema:** migration 209's header lists the reverse statements, which are safe only while no item is unpriced, has a
  quantity other than 1, or is categorised.

## Tests
- `tests/storefront-bulk-import.test.js`:
  - the real AuctionFlex export (142 rows, 17 columns);
  - Photo_N names and links;
  - lot-number, column, ambiguous and duplicate matching;
  - reorder and primary;
  - categories and seller choice;
  - update-drafts mode, isolation and readiness.
- `tests/storefront-category.test.js`: the classifier, plus 85% or more of the real file categorised.
- `tests/browser/seller-importer.browser.test.js`: Chromium on the real schema. Covers the full five-step import, edit,
  publish and unpublish across Advantage.Bid and the widget, phone layout, and Post to the Market.
