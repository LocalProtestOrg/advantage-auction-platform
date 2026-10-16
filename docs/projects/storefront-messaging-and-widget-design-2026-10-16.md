# Professional Storefront: item questions, on-platform messaging, anti-circumvention, widget header, search and filters

Owner requirements of 2026-10-16. Design only — **messaging stays off, and no buyer contact is exposed, until security and
privacy testing pass and the owner approves.** Canonical TODO: `professional-storefront-roadmap.md` §9–§10.

## 1. What exists today (reviewed in code)

| Component | What it does | Reuse? |
|---|---|---|
| Storefront "Contact" form (`POST /api/public/storefront/:slug/inquiry`, `seller_inquiries`) | Collects the visitor's **name, email and phone** and shows them to the seller in the inquiry inbox ("The company will contact you directly"). Rate-limited (IP hash: 5/hour, 3 per seller/day). Not tied to an item. The item page's "Contact Seller" button links to it while checkout is off. | Keep for **service consultations** (estate-sale/appraisal requests), clearly labelled as such. For items it is exactly the off-platform channel to replace: item pages move to on-platform questions. Reuse its rate-limit and IP-hash pattern. |
| Buyer issues (`marketplace_order_issues`, migration 197) | Order-bound, buyer↔seller↔admin, composite key to the order's real seller, append-only history, one seller response, admin resolution. | Reuse the **integrity pattern** (composite keys, guard triggers, events) and the seller issue panel UI style. |
| Seller permission checkpoint + roles (`company.*`) | Company from session, staff roles. | Add `company.messages.view` / `company.messages.respond` (Owner, Fulfillment; Inventory Manager view+respond for item questions is a decision). |
| `notifications_queue` + `notificationWorker` (lease, retry, back-off) | Auction notifications. | Same worker pattern for the storefront notification outbox (sale notices and message notices as **different event types**). |
| Moderation dashboard (milestone 2) | Admin review of listings, reports, issues. | Add a "Flagged conversations" tab for human review. |
| Owner alerts, email service, audit log | — | Reuse. |

## 2. Item questions and on-platform conversations (migration; feature flag, off)

- `storefront_conversations`: `id, seller_id, item_id, buyer_user_id` (or `guest_identity_id`), `subject_snapshot`
  (item title, inventory number, thumbnail at the time), `status` (open / closed / flagged / blocked), timestamps.
  Composite FK (item_id, seller_id) → marketplace_items, so a conversation always belongs to the item's real seller.
  UNIQUE (item_id, buyer_user_id) for open conversations (one thread per buyer per item).
- `storefront_messages`: append-only (`id, conversation_id, seller_id, sender_role` buyer/seller/support,
  `sender_user_id, body, created_at, flags jsonb, hidden_by_support`), composite FK to the conversation's seller; edits
  and deletes refused by trigger (support may hide with a reason, never rewrite).
- `storefront_message_flags`: detection results and human review outcome (reviewer, decision, note, time), append-only.
- Access: the buyer, the seller organisation's authorised people (owner + permitted staff), and Advantage.Bid support
  with a platform permission (`messages.review`); every support read is logged.
- Guests: email verified by a one-time link before the first message is delivered (no anonymous messages to sellers).
- Notifications (outbox, event types `message_to_seller` / `message_to_buyer`): email says "You have a new question about
  {item} (#{inventory number})" with thumbnail and a secure link to reply **on Advantage.Bid**; the message text may be
  excerpted; replying by email is not supported initially. **No email address or phone number of the other party is ever
  included.** Data model is channel-neutral so in-app and push notifications can be added later.
- Item page: "Ask the seller a question" on every eligible Professional item (signed in, or verified guest). The existing
  storefront consultation form remains for services, not items.

## 3. Anti-circumvention (professional, human-reviewed)

- Messaging UI never shows email addresses or phone numbers of either side; the reply form shows a short, polite note:
  "For your protection, please keep questions and purchases on Advantage.Bid."
- Seller agreement: a clause prohibiting diversion of Advantage.Bid-generated buyers or transactions to avoid fees
  (**legal wording for owner/legal approval** — not drafted as binding text by engineering).
- Detection (deterministic rules, no model calls by default): phone-number and email patterns (including obfuscated
  forms like "five five five", "at gmail dot com"), payment-app and off-platform payment terms (cash discount, Venmo,
  Zelle, Cash App, PayPal friends-and-family, wire, "pay me directly", "avoid the fee", "outside the site"), external
  links. Outcomes: a matched contact detail is **masked in the delivered message** (sender is told it was hidden for
  safety); a matched off-platform payment solicitation is delivered with a buyer-safety notice **and** flagged for human
  review. Normal shipping, pickup, condition and inspection discussion is never blocked.
- Human review only: flags appear in the moderation dashboard; an authorised reviewer records a decision with a note.
  **No automatic suspension, penalty, order cancellation or accusation**; any action follows the documented review and
  appeal process (seller can respond; decisions audited).
- Spam and abuse: per-buyer, per-seller and per-IP rate limits; duplicate-message suppression; block/report controls;
  attachments not supported initially (when added: type/size limits, malware scan, private storage, no hot-linking).
- Retention: conversations kept for the order/dispute window plus a policy period (owner decision), then archived.
- We do not claim circumvention can be prevented completely; the goal is to make on-platform the easy, safe path and to
  surface obvious diversion for human review.

## 4. Sale notification content correction (applies now)
The paid-sale seller email must **not** contain buyer contact details or the ship-to address; fulfilment details stay
behind the authenticated seller dashboard (role-shaped, migration 199). Implemented in `marketplaceOrderNotifier.sendPaid`
(branch `feat/storefront-messaging-plan`): the seller email now carries the item, order number, price, fulfilment method,
next action and a secure link only.

## 5. Branded website widget: header and navigation
- Seller chooses **Compact** (no header; sits under their own site header) or **Branded** (optional header with logo,
  company name and navigation links). Stored per seller organisation (`storefront_widget_settings`: mode, colours,
  layout, logo display, `nav_links` JSON) under the seller checkpoint (`company.storefront.manage`).
- Navigation editor: link title (≤ 40 chars), URL, order, visible/hidden; add, edit, delete, reorder; responsive (links
  collapse into a menu on narrow widths). Logo links to the seller's verified website (from the storefront profile).
- URL safety: `https:` only (http upgraded or refused), no `javascript:`/`data:`/`vbscript:`/`file:`; parsed with the
  URL parser, credentials and control characters refused, length ≤ 500; links rendered with `rel="noopener"` and
  `target="_top"`; titles escaped as text. Destinations: the seller's own verified domain(s) or Advantage.Bid pages;
  other domains need owner-approved allow rules (prevents redirect abuse and impersonation).
- Required Advantage.Bid attribution and links to canonical Advantage.Bid product pages cannot be removed; navigation
  cannot imitate Advantage.Bid checkout or account controls (reserved labels refused, e.g. "Checkout", "Sign in to
  Advantage.Bid").
- Isolation: the widget key is issued by the server and bound to one seller; settings are read by key, never by a
  browser-supplied seller id.

## 6. Search, filters and sorting (shared by marketplace and widget)
- One server search API over the authoritative inventory, used by the marketplace, per-storefront pages and the widget
  (the widget passes its server-bound key; the API scopes results to that seller).
- Filters (about ten): keyword + seller inventory number; category; price range; condition (new/used/refurbished +
  grade); material; colour; dimensions/size class; seller and location (marketplace only); availability (available /
  include sold); shipping or pickup eligibility (from `storefrontShipping`).
- Sorting: newest, price low→high, price high→low, A–Z, relevance (when a keyword is present).
- Facet counts come from the same query; filters with no data or zero applicable choices are hidden. Mobile: filters in
  a slide-over panel; narrow embeds use a compact filter bar.
- Needs new item fields: `colour`, structured dimensions (width/depth/height + unit) — migration, optional, never invented.
- Indexing: Postgres full-text (`tsvector` on title, description, brand, material, inventory number) + btree/GIN indexes;
  no external search service needed at current scale.
- SEO: widget results link to canonical `/shop/item/<id>/<slug>`; widget frames are noindex; availability always live.

## 7. Milestones and acceptance tests
| # | Milestone | Acceptance tests |
|---|---|---|
| Q1 | Item questions + conversations (flag off) | only buyer, the item's seller org (permitted roles) and logged support can read; thread tied to item's real seller (DB); no contact details in UI, emails or API; guests verified first; rate limits; append-only messages. |
| Q2 | Anti-circumvention detection + human review | contact details masked; payment solicitation flagged, never auto-penalised; legitimate shipping/pickup/condition talk passes; review decisions audited; appeal path. |
| W1 | Widget settings + header/nav editor | unsafe schemes refused; only allowed domains; reserved labels refused; per-seller isolation; attribution always present. |
| S1 | Search API + filters + sort | same results for marketplace/widget scopes; never another seller's items in a widget; sold/removed/taken-down excluded unless "include sold"; zero-data facets hidden; canonical links. |
