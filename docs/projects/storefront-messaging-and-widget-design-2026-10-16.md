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

## 3. Anti-circumvention (owner-approved 2026-10-16: eBay-style, layered, human-reviewed)

Principle: make on-platform the easy, safe path; hide obvious contact details; send anything ambiguous to a person; never
punish automatically. We do not claim circumvention can be prevented completely.

### 3.1 Layered detection (deterministic rules first; every rule versioned and tested)
| Layer | Catches | Examples (all covered by the specification) | Action |
|---|---|---|---|
| L1 explicit contact details | phone numbers, email addresses, URLs, social handles | "713-555-0199", "bob@gmail.com", "www.myshop.com", "@nora_estate" | **masked** in the delivered message; sender told politely and may rephrase |
| L2 obfuscated contact details | spelled-out or separated digits, disguised emails/links | "seven one three five five five…", "7 1 3 – 5 5 5", "bob at gmail dot com", "b o b [at] gmail", "myshop dot com", digits split across lines or words, homoglyphs | **masked**; flagged if repeated |
| L3 off-platform payment | payment apps and arrangements | Venmo, Zelle, Cash App, PayPal friends-and-family, wire, crypto, "cash only if you come by", "pay me directly" | message **held for human review**; sender sees a polite explanation and can rephrase |
| L4 indirect contact / diversion requests | asking the other party to find contact details elsewhere or to transact off-platform | "Google my business name and call me", "Look up our phone number on our website", "Find me on Facebook and message me", "Contact our store directly and I'll give you a better price", "I'll give you 5% off if you buy in person", "skip the fee", "outside the site", "my own checkout page", a link to an external checkout for the listed item | message **held for human review** (not silently deleted); polite notice to sender with a rephrase option |
| L5 context and behaviour | patterns across a conversation or seller | the same seller repeatedly triggering L3/L4, many conversations ending right after a contact attempt, discount + "in person" combinations | conversation **flagged** for review (no action on the user) |

- Rules use normalisation (lower-casing, digit-word mapping, removing separators, Unicode folding) before matching, so
  "seven-one-three" and "7.1.3" are treated alike; a scoring step combines weak signals (e.g. "call" + "Google" +
  business name) so indirect requests are caught without a basic phone/email filter alone.
- An optional, owner-approved text-classification step may be added later for L4/L5 ranking only; it never acts alone and
  never decides an outcome (and is never named in the interface).

### 3.2 What is never interfered with
Item condition, measurements, photographs and authenticity; shipping costs and destinations; local pickup and delivery
arrangements; approved inspections and viewing appointments; negotiating a price change **completed through
Advantage.Bid** (the seller lowers the listed price with the normal edit controls — different from an off-platform
discount); and, after a confirmed purchase, the fulfilment details authorised staff see in the protected order dashboard.
Lawful post-purchase fulfilment communication is not blocked. Allow-list rules (e.g. "pickup at our warehouse in
Houston", "we can ship freight") are tested so they never trip L3/L4.

### 3.3 Holding, review, appeals and abuse controls
- Held messages are visible to the sender as "awaiting review"; reviewers release, release with masking, or decline with
  a reason; the sender can always rephrase. Nothing legitimate is deleted silently.
- Review queue in the moderation dashboard with full history (rule hit, version, reviewer, decision, note, time),
  append-only; seller can respond and appeal; outcomes audited.
- **No automatic suspension, penalty, order cancellation or accusation** from automated detection. Any account action is
  a separate, human, documented decision under the seller agreement.
- Seller agreement clause against diverting Advantage.Bid-generated buyers or sales (legal wording for owner approval).
- Abuse controls: per-buyer, per-seller, per-IP rate limits; duplicate suppression; block/report; guest email
  verification; attachments off initially. Retention period per owner decision.

### 3.4 Transition from the existing storefront "Contact" form (`seller_inquiries`)
Purpose today: a **service consultation** form on the storefront page (estate-sale / appraisal / clean-out requests:
name, phone/email, city, service, preferred contact, message), shown to the seller in the Inquiries inbox. It is also
reachable from item pages ("Contact Seller" while checkout is off), which makes it an item-question route that hands over
the buyer's contact details.
1. When item questions launch (flag on, after security + privacy testing): every item page's "Contact Seller" becomes
   **"Ask the seller a question"** (on-platform thread). No item page links to the consultation form any more.
2. The storefront form is relabelled **"Request a consultation"** (services such as estate sales, appraisals and
   clean-outs), with a note that questions about items for sale go through "Ask the seller a question". Its submissions
   are checked with the same L1–L4 rules; a submission that is about a specific listed item is redirected to the item
   question flow instead of being delivered.
3. Consultation requests keep working for legitimate service leads (the requester chooses to share contact details for
   a service visit); existing inquiries stay in the seller's inbox. The owner decides whether consultation requests also
   move on-platform later.
4. No new loophole: seller profile pages and notification emails never show buyer contact details; the consultation
   form is not linked from items, widgets or item emails; widget navigation links are the seller's own pages, separate
   from messaging.

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
