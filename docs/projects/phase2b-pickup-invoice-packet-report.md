# Phase 2B — Pickup-Day Bulk Invoice Packet — Staging Report

**Status:** Implemented and validated on **staging only**. No production deployment. No Stripe LIVE, no buyer-premium activation, no tax-collection change, no seller-settlement implementation, no charging/payout change.
**Date:** 2026-06-24
**Branch / commit:** `feat/phase2-invoice-system` (Phase 2B commit on top of the Phase 2 system).
**Staging:** Railway service `advantage-staging` (Neon `ep-royal-dawn-anarou3f`), URL `https://advantage-staging-production.up.railway.app`. Deployed via `railway up --service advantage-staging` (the git-push auto-deploy for this service is unreliable — see Open Issues).

> Operator workflow: before pickup day, AAC staff download **one combined PDF** of every buyer invoice for an auction, ordered the way they work the line — **unpaid first** (so items are withheld until payment), then paid, each group alphabetized by buyer last name for quick lookup as buyers arrive.

---

## 1. Architecture summary

- **`src/services/pickupPacketService.js`** (new):
  - `getPacketData(auctionId)` — one query over `invoices` for the auction joined to `users` (buyer name/email/phone), `payments` (status/date), `lots` (number/title), `pickup_assignments` (per-buyer slot), `auctions` (title + address + pickup window), and the first `lot_images` row. Derives `isPaid` (`invoice.status='paid' OR payment.status='paid'`), parses `full_name` → `{first,last}` (last whitespace token = last name; falls back to email local part), and resolves pickup location + date/time (buyer slot if present, else auction window).
  - **Sort:** unpaid group first, then paid; within each group `Intl.Collator` by **last name → first name → invoice number**.
  - `buildPacketPdf(packet)` — a single PDF, **one sheet per invoice** (`addPage` between). Thumbnails are prefetched (raster http(s) only) and embedded, with a "No image" placeholder fallback.
  - Built entirely on the Phase 2 **`documentService`** foundation (`renderPdf`, brand, `fetchImageBuffer`, `money`). Read-only over existing data.
- **Per-sheet layout** (`drawPickupSheet`):
  - **Status indicator** — *unpaid:* a full-width **red** banner with a **3.5pt black border** + white inner border and huge bold **`UNPAID`** + **`DO NOT RELEASE ITEMS UNTIL PAYMENT IS CONFIRMED`**. The red prints as a dark band on a B&W printer, and the heavy black border + 38pt text keep it unmistakable in monochrome. *Paid:* a small green **`PAID`** badge (+ "Paid <date>"), deliberately less aggressive.
  - **Pickup header** — buyer "Last, First" (bold), email, phone (if available); invoice number, auction, payment status, pickup location, pickup date/time.
  - **Lot row** — thumbnail | lot # | title | hammer.
  - **Summary** — hammer / buyer premium / sales tax / shipping / **Total** (premium/tax/shipping render "—" at 0 today).
  - **Item release / signature block** — Buyer signature · Staff initials · Pickup date · Notes lines. **Unpaid sheets repeat** "Payment must be confirmed before items are released." in bold (red on color, black-underlined so it stays obvious in B&W).

---

## 2. Endpoint / UI locations

- **API:** `GET /api/admin/auctions/:auctionId/pickup-packet` — `src/routes/admin.js` (`auth, role(['admin'])`). Streams `application/pdf` (`Content-Disposition: attachment; filename="pickup-packet-<auction>.pdf"`) and an `X-Packet-Counts: unpaid=..;paid=..;total=..` header. Returns 404 if the auction does not exist.
- **Admin UI:** `public/admin/moderation.html` → **Auctions** tab → each auction card has a **"Pickup Invoice Packet"** button (`downloadPacket()` — authenticated blob fetch → client download, no token in the URL).

---

## 3. Validation Results

### 3.1 Data + ordering + PDF (in-process against staging DB) — PASS
`scripts/stg-validate-phase2b.js` seeded a test auction (`7e000000-…-b1`) with **3 unpaid + 3 paid** invoices across distinct last names and lots, **two lots with a real Cloudinary thumbnail**, then asserted the packet:

| Check | Result |
|---|---|
| Counts | unpaid **3**, paid **3**, total **6** ✓ |
| Unpaid group first | first 3 sheets all unpaid, last 3 all paid ✓ |
| Unpaid alphabetical (last name) | **Adams → Patel → Young** ✓ |
| Paid alphabetical (last name) | **Brown → Carter → Zhang** ✓ |
| Sort is by name, not invoice # | e.g. Young = `AAC-000011` sorts **last** among unpaid; Zhang = `AAC-000014` sorts last among paid ✓ |
| Combined PDF generates | valid `%PDF-`, **231,052 bytes** (6 sheets, 2 thumbnails) ✓ |
| Thumbnail embeds | real Cloudinary JPEG fetched + embedded ✓ |

### 3.2 Unpaid-warning visibility (color + black-and-white)
The unpaid banner uses three independent signals so it survives any printer: (1) **red fill** (#c0262d) — vivid in color; (2) a **3.5pt solid black border** + inner white border — high-contrast outline that does not depend on color; (3) **38pt bold `UNPAID`** white text + the bold release warning. On a B&W printer the red renders as a solid dark band with white text inside a heavy black frame — visually distinct at a glance from a paid sheet (which has only a small badge). The release-section warning is additionally **black-underlined** so it reads in monochrome. _Recommend a quick manual B&W print/grayscale-preview confirmation before sign-off (see §4)._

### 3.3 Live access control (deployed staging build) — PASS
Deployed via `railway up --service advantage-staging`; new build confirmed live (route returns 401 unauthenticated, not 404). Run against the deployed endpoint:

| Caller | Expected | Result |
|---|---|---|
| Admin JWT (`role: admin`) | 200 + `application/pdf` | **HTTP 200**, `Content-Type: application/pdf`, `X-Packet-Counts: unpaid=3;paid=3;total=6`, 413,141-byte valid `%PDF` ✓ |
| Buyer JWT (`role: buyer`) | 403 Forbidden | **HTTP 403** `{"error":"Forbidden: insufficient permissions"}` ✓ |
| No token | 401 Unauthorized | **HTTP 401** `{"error":"Authentication required"}` ✓ |

**Admin-only access is enforced; buyer users cannot access the auction-wide packet.**

---

## 4. Screenshots / PDF sample notes
No automated browser screenshots were captured (no headless browser session). Visual confirmation is via the generated artifacts:
- The 231 KB packet PDF (6 sheets) was produced from real staging data; admins can download it live from moderation.html → Auctions → "Pickup Invoice Packet", or via the API with an admin token.
- **Recommended manual checks before sign-off:** (1) open the packet and confirm sheet order (3 unpaid alphabetical, then 3 paid alphabetical); (2) print one page / use the browser's grayscale preview to confirm the UNPAID banner remains unmistakable in black and white; (3) confirm the embedded thumbnail renders on Adams's and Brown's sheets.

---

## 5. Open Issues / Notes
1. **Unpaid invoices today come only from `issued`-status invoice rows.** In the current flow an invoice is created only on payment success (always `paid`). The packet correctly renders any `issued`/unpaid invoice (the validation seeds them), but auto-creating `issued` invoices for won-but-unpaid lots at auction close is a **future enhancement** (out of scope here; no charging/settlement change).
2. **One sheet per lot (not consolidated per buyer).** With the current per-lot invoice model, a buyer who won multiple lots gets multiple adjacent sheets (the sort keeps them together by name). Per-buyer consolidation pairs with the multi-lot-invoice change noted in the Phase 2 report.
3. **Staging deploy mechanism.** The git push to `deploy/seller-studio-1b` does not reliably trigger a staging rebuild; `railway up --service advantage-staging` was used. Standardize the staging deploy path.
4. **Validation fixture rows** (`7e000000-…` auction/buyers/lots, invoices `AAC-0000xx`) remain on staging; clearly labeled, idempotently overwritten on re-run.
5. **Thumbnail formats:** JPEG/PNG embed; SVG/data-URI/WebP/GIF fall back to a placeholder (same as Phase 2).

**No production deployment. Stopping after staging validation, awaiting review.**
