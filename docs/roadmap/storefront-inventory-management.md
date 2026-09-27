# Roadmap: Professional Storefront Inventory Management

**Status:** PLANNED. Not scheduled, not built. Do not advertise any capability on this page as live.
**Recorded:** 2026-09-27, from an Owner request and an audit of the code at ce363a5.
**Owner:** Advantage.Bid. Every item below needs Owner approval before it is built.

## Why

Estate sale companies, auction houses and retail dealers hold hundreds or thousands of items, usually already
tracked in a spreadsheet with their own inventory numbers. Today a seller can only add storefront items one at
a time. The storefront is a real reason for a professional to join Advantage.Bid, but not at that scale until
sellers can move their existing inventory in quickly and manage it afterwards.

## What exists today (audited 2026-09-27; reuse it, do not rebuild it)

| Area | Today | Where |
|---|---|---|
| Add an item | One at a time. Title, whole-dollar price, free-text category and condition, description, city/state, shippable plus a flat shipping price | `public/seller-storefront.html`, `marketplaceItemService.createDirectListing` |
| Photos | Several files per item, uploaded one after another. 10 MB each, max 24 per item | `POST /api/uploads/image`, `src/routes/uploads.js` |
| Statuses | `draft`, `active`, `sold`, `removed`, `pending_purchase` (checkout only). The UI creates items as active and offers only Remove | `db/migrations/119`, `121` |
| Edit | `PATCH /api/seller-storefront/items/:id` exists. **No edit screen** | `marketplaceItemService.updateItem` |
| Relist | `POST /api/marketplace/seller/items/:id/relist` (removed or draft items). **No button** | `marketplaceOrderService.relistItem` |
| Unsold auction lots | One-button conversion, idempotent per lot, never changes auction history. `POST /unsold-lots/convert-batch` (up to 100) exists but has **no button** | `marketplaceItemService.convertLotToListing` |
| Quantity | One of each only. No quantity column | — |
| Search, filters, SKU, bulk edit, import, duplicate, sold elsewhere | **None** | — |
| Admin view of storefronts, items, orders, refunds | **None** (refund is API-only) | — |

Pieces that can be reused:
- a CSV parser with no dependencies: `src/services/eventImport/connectors/csvConnector.js` (no Excel library is installed);
- multi-photo upload and background removal: `public/dashboard/lots.html`, `/api/image-processing/jobs`;
- Smart Descriptions for items: `/api/ai/generate-description` (internal route; never shown as "AI" to users);
- automatic next number: the lot-numbering logic in `public/dashboard/lots.html`.

## Prerequisites: fix before any bulk tooling

These are gaps in today's storefront, found by the same audit. Bulk import would make each one worse, so they come first.

1. **Edit screen.** Sellers can't correct an item after they list it.
2. **Price review for converted lots.** A lot with no bids and no reserve converts to a live $1 listing. Open a price box before publishing.
3. **Status rules on the server.** A seller can set a sold or pending item back to active through the API, and the next purchase then fails.
4. **Checkout hold cleanup** (needed before `MARKETPLACE_CHECKOUT_ENABLED` is turned on):
   - release expired `pending_purchase` holds on a schedule and cancel the abandoned PaymentIntent;
   - make `markOrderPaid` refuse an order already marked failed, so a late payment cannot sell the item twice.
5. **Who may sell.**
   - Today any self-declared professional (including `business`) can publish a storefront and list items, with no verification, agreement or payout check.
   - Owner decision: which checks are required before storefront selling, and whether `business` counts as professional.
6. **Admin override.** An admin page for storefronts, items and marketplace orders, including refunds (required by CLAUDE.md).

## The project: scope

### 1. Spreadsheet import (CSV and Excel)
- Upload `.csv` or `.xlsx`. Excel needs a vetted parsing library; pin the version and check its security record.
- **Column mapping.** Match the seller's own headers to our fields: title, description, price, quantity, category, condition, inventory number/SKU, dimensions, weight, shipping price, pickup-only, photo file names, notes.
  - Mappings are remembered per seller, so the next import is one click.
- **Preview before anything is saved.** Show the first rows as they will appear, plus counts: new, updates, duplicates, errors.
- **Validation.**
  - Required fields; price format; whole-dollar or cents rules; category mapped to the platform category keys (`lots.category_key` taxonomy); text length limits.
  - Banned or unsafe content.
  - No HTML.
- **Error report.** Explain each problem by row and column in plain language, and offer it as a downloadable file. Valid rows can import while invalid rows are held back.
- **Imports land as DRAFTS by default.** The seller publishes them in bulk after review. Nothing goes live straight from a file.
- **Audit trail.** Each import records who, when, the file name, row counts and the created item IDs. An import can be undone while its items are still drafts.
- **Limits.** A maximum file size and row count per import; large files run as a background job with progress.

### 2. Inventory numbers and duplicates
- New fields: `inventory_number` (the seller's own ID or SKU, kept exactly as given) and an optional `external_id`.
  - Unique per seller when present.
- **Duplicate detection.**
  - An exact inventory-number match inside the seller's catalogue is a duplicate.
  - A close title-plus-price match is a "possible duplicate", for the seller to confirm.
  - The seller chooses per row: skip, update the existing item, or create a new one.
- The seller's original identifiers are preserved and shown to them, but never shown to buyers unless the seller opts in.

### 3. Bulk photos
- Drag in many photos, or a `.zip` subject to size and type limits.
- **Automatic matching** to items by inventory number or file name (for example `A-1042.jpg`, `A-1042_2.jpg` and `A-1042-3.jpg` all go to item A-1042, in order).
- **Manual matching screen** for what's left: an unmatched-photo tray and drag onto an item.
- Reuses the existing upload endpoint, file checks and background-removal jobs; photos upload once.

### 4. Seller inventory screen
- Fast search by inventory number, SKU, title and keyword.
- Filters: status (draft, active, sold, sold elsewhere, removed), category, price range, source (direct, converted from auction, imported), has photos, date added.
- Sort, a page size of 50 to 100, and server-side paging so it stays fast with thousands of items.

### 5. Bulk changes
- Select many items, then change price (set, raise or lower by an amount), quantity, category, condition, shipping settings or status, or publish or unpublish.
- A preview of the change before it is applied, and a single undo for the last bulk action.
- Server-side limits and the same status rules as single edits.

### 6. Listing lifecycle
- **Drafts** exposed in the UI (save without publishing).
- **Duplicate listing** ("list another like this").
- **Sold elsewhere:** a new status for items sold outside Advantage.Bid, so they leave the storefront but stay in the seller's records. Kept separate from `sold` so marketplace sales reporting stays accurate.
- **Relist** button for removed and sold-elsewhere items, using the existing relist service.
- **Quantity:** items with more than one unit. This touches checkout's one-item-one-order model (the double-sell index), so it needs its own design review.
- **Unsold-auction conversion:**
  - a bulk "move unsold lots to my storefront" button, using the existing `convert-batch` endpoint, with price review first;
  - converted items keep the lot number as their inventory number.

### 7. Other essentials identified in the audit
- **Structured categories** instead of free text, sharing the auction taxonomy so the marketplace can filter.
- **Export** of the seller's inventory to CSV, so they always own their data.
- **Low-effort item creation from photos** (Smart Descriptions), labelled only in Smart Tools language.
- **Public item pages:**
  - add a server-rendered title, description and image tags for sharing;
  - hide items from unpublished or demo storefronts.
- **Admin:** bulk-hide a seller's items, and see import history.
- **Stale holds** (see prerequisites) and a report of items that have been live for a long time without views.

## Out of scope for this project
- On-platform checkout go-live (a separate Owner gate: `MARKETPLACE_CHECKOUT_ENABLED` and Stripe LIVE).
- Connecting to outside inventory systems (point-of-sale, other marketplaces).
- Any change to auction economics or the storefront fee.

## Marketing rule until this ships
Seller-facing copy may say sellers can list fixed-price items, add photos and move unsold auction lots to their storefront. It must NOT promise spreadsheet import, bulk photo matching, SKU search, bulk editing, quantities or online checkout.
