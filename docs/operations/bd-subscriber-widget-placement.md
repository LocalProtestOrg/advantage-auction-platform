# Brilliant Directories — Advantage.Bid Subscriber Widget Placement (Phase 4D)

**Status:** Widget built + verified on Railway. BD placement is an **Owner manual action** (do not enable until you paste the snippet on the BD page). Railway remains the single authoritative subscriber backend; BD is a presentation/collection surface only — it does **not** store subscribers.

## What it does
A visitor on any Brilliant Directories page (advantage.bid) can enter **Name + Email + City + State (+ optional ZIP)** and join the exact same first-party audience system as a visitor on bid.advantage.bid. Same endpoint, same dedup, same permission + geography model. No parallel BD newsletter list.

## The snippet
Paste this into a BD page's custom HTML / widget block wherever you want the signup to appear (e.g. sidebar, footer, below content):

```html
<div data-adv-subscribe data-placement="blog" data-variant="card"
     data-endpoint="https://bid.advantage.bid"></div>
<script src="https://bid.advantage.bid/widgets/shared/subscribe-widget.js" defer></script>
```

- `data-endpoint="https://bid.advantage.bid"` — REQUIRED on BD so the cross-origin form posts to the Railway backend.
- `data-placement` — set per page so source attribution is meaningful. Use one of:
  `footer`, `all_events`, `auctions_listing`, `estate_sales_listing`, `auction_detail`,
  `estate_sale_detail`, `marketplace`, `professional_directory`, `blog`, `help_center`, `seller_page`, `other`.
- `data-variant` — `card` (boxed) or `bar` (compact inline).
- Optional: `data-title` / `data-subtitle` to override copy.

## Expected result
- The form renders with Advantage.Bid styling (self-contained; no external CSS/fonts).
- On submit it POSTs to `https://bid.advantage.bid/api/public/subscribers`.
- Success shows: *"You're in! We'll keep you posted about auctions and estate sales near you."*
- The subscriber appears in **Admin → Subscribers** with `source_domain = advantage.bid` and the placement you set.
- No subscriber data is ever exposed back to the BD page (write-only).

## Notes / limits
- The endpoint is rate-limited and honeypot-protected; abusive volume is dropped silently.
- CORS: `/api/public/*` already allows cross-origin reads for public discovery; the subscribe POST is write-only, non-disclosing, and safe to call from advantage.bid. If BD is served from a different origin than expected and the browser blocks the POST, tell the engineer to add the BD origin to the public CORS allow-list (mirror `publicEvents.js`).
- This collects subscribers only. It does **not** send email. Autonomous email (A7) remains OFF.

## Recommended BD placements (owner)
| BD page | data-placement |
|---|---|
| Blog posts / articles | `blog` |
| All Events / directory landing | `all_events` |
| Help / FAQ content | `help_center` |
| Global BD footer (if editable) | `footer` |
