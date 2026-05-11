# BD Integration Architecture

**Status:** Planning — no implementation exists yet  
**Scope:** Advantage Auction Platform (Railway) ↔ Advantage.bid (BD)  
**Date:** 2026-05-10

---

## 1. Architecture Overview

### System Roles

| Layer | System | Responsibility |
|---|---|---|
| Operations backend | Railway (Node/Express/PostgreSQL) | Source of truth for all auction data, bidding, payments, invoices, notifications, and access control |
| Discovery / SEO layer | Advantage.bid (BD) | Public-facing marketing site, SEO pages, geographic discovery, widgets that consume sanitized Railway data |

BD is a read-only consumer of public-safe Railway data. It has no write path into Railway's database and no privileged access to any Railway resource. BD is disposable: the platform must remain fully operational if BD goes offline, is replaced, or is disconnected.

### Data Flow Direction

```
Railway (PostgreSQL)
    │
    │  sanitized, public-safe JSON payloads only
    ▼
Railway Public API  (/api/public/*)
    │
    │  HTTPS GET, no auth token required, CDN-cacheable
    ▼
BD widgets / BD pages
    │
    │  embeds or links
    ▼
End user browser
    │
    │  auction participation (bid, register, pay)
    ▼
Railway auction platform UI (auctions.advantage.bid)
```

No reverse arrows exist in this diagram. BD never pushes auction data into Railway. BD never holds a Railway session or API key.

### Domain Split (Recommended)

| Domain | Owner | Purpose |
|---|---|---|
| `advantage.bid` | BD | Marketing, SEO, discovery, city/state pages, blog |
| `auctions.advantage.bid` | Railway | Full auction platform: bidding, accounts, payments, admin |

---

## 2. Security Model

### What BD Can Access

- The `/api/public/*` endpoint family, with no authentication header required
- Responses are pre-sanitized by Railway before delivery
- BD may cache responses at its CDN layer within the TTL specified per endpoint

### What BD Cannot Access

- Railway's PostgreSQL database (no connection string, no read replica, no tunnel)
- Any Railway admin, seller, or buyer session token
- Any endpoint outside `/api/public/*` without explicit future planning and a signed token handoff (see auth handoff section below)
- Raw internal UUIDs that expose relational structure (seller_id FK, user_id, internal mapping IDs)
- Financial fields: payment amounts, card data, refund records, verification charge results
- PII: full buyer/seller names beyond public display names, email addresses, phone numbers, full street addresses
- Admin-only flags: review_status internal values, seller capability flags, consignor financial data, admin billing notes

### Token Policy

BD widgets require no auth token for public feed consumption. No Railway secret, API key, or privileged credential is ever stored in BD's environment, codebase, or CDN configuration.

If a future auth handoff (e.g., BD SSO into Railway) is implemented, it must use:
- Signed short-lived tokens (JWT, HS256 minimum, RS256 preferred)
- Expiration of ≤ 5 minutes
- Nonce to prevent replay
- HTTPS only
- Railway must be able to disable the handoff endpoint independently without affecting native login

### Payload Sanitization Rules

The following fields are **always excluded** from any public API response, regardless of endpoint:

| Category | Excluded Fields |
|---|---|
| Relational FKs | `seller_id`, `user_id`, `consignor_id`, `created_by`, `updated_by` |
| Internal UUIDs | Any UUID that exposes a join relationship not otherwise surfaced publicly |
| Payment data | Card tokens, payment_method_id, stripe_customer_id, verification charge amounts or results, refund records |
| PII | Buyer email, seller email, phone numbers, full street address (pre-payment), paddle numbers, bid amounts attributed to a bidder identity |
| Admin flags | `review_status` raw enum, `admin_notes`, seller capability flags (`shipping_enabled`, `reserve_enabled`), `featured_for_marketing` internal flag, invoice data |
| Financial internals | `seller_commission_pct`, `buyer_premium_pct` stored values, consignor settlement fields |

Fields that are **safe to expose publicly** after sanitization:

- Auction: `id` (public-safe slug or numeric ID), `title`, `teaser_description`, `city`, `state`, `zip`, `auction_type`, `start_time`, `end_time`, `timezone`, `pickup_window_start` (date only, not full address), `package_type`, `state` (published only)
- Lot: `id`, `auction_id`, `lot_number`, `title`, `description`, `size_category`, `current_bid_cents`, `bid_increment_cents`, `starting_bid_cents`, `primary_image_url`, `state` (open/closed)
- Seller profile: `display_name`, `seller_type` (label only), `bio`, `location_label`, `logo_url`
- Walkthrough video: `video_url`, `thumbnail_url`, `caption`, `auction_id` (if safe to surface)

---

## 3. Public API Endpoint Contract

All endpoints are read-only (GET). No authentication is required. All responses are JSON. All dollar amounts are in cents (integer). All timestamps are ISO 8601 UTC strings.

---

### 3.1 `GET /api/public/auctions`

**Purpose:** Paginated discovery feed of published auctions for BD homepage, city pages, and search.

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `page` | integer | No | 1-indexed page number, default 1 |
| `per_page` | integer | No | Results per page, default 20, max 50 |
| `state` | string | No | Filter by US state abbreviation (e.g. `TX`) |
| `city` | string | No | Filter by city name (case-insensitive, partial match) |
| `auction_type` | string | No | Filter by public auction type label |
| `sort` | string | No | `start_time_asc` (default), `end_time_asc`, `created_desc` |

**Response Shape:**

```json
{
  "data": [
    {
      "id": "string",
      "title": "string",
      "teaser_description": "string | null",
      "auction_type": "string",
      "city": "string",
      "state": "string",
      "zip": "string",
      "start_time": "ISO8601",
      "end_time": "ISO8601",
      "timezone": "string",
      "pickup_window_start": "ISO8601 | null",
      "pickup_window_end": "ISO8601 | null",
      "primary_image_url": "string | null",
      "lot_count": "integer",
      "platform_url": "string"
    }
  ],
  "meta": {
    "page": "integer",
    "per_page": "integer",
    "total": "integer",
    "total_pages": "integer"
  }
}
```

**Excluded fields:** `seller_id`, `seller_email`, `full_address`, `buyer_premium_pct`, `seller_commission_pct`, `admin_notes`, `review_status`, any draft/submitted auctions

**Cache TTL:** 60 seconds (CDN), 30 seconds (Railway edge cache)

---

### 3.2 `GET /api/public/auctions/:id`

**Purpose:** Single auction detail page for BD auction landing pages.

**Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | string | Public auction ID or slug |

**Query Parameters:** None

**Response Shape:**

```json
{
  "id": "string",
  "title": "string",
  "teaser_description": "string | null",
  "description": "string | null",
  "auction_type": "string",
  "city": "string",
  "state": "string",
  "zip": "string",
  "start_time": "ISO8601",
  "end_time": "ISO8601",
  "timezone": "string",
  "pickup_window_start": "ISO8601 | null",
  "pickup_window_end": "ISO8601 | null",
  "package_type": "string | null",
  "primary_image_url": "string | null",
  "gallery_image_urls": ["string"],
  "lot_count": "integer",
  "featured_lots": [
    {
      "id": "string",
      "lot_number": "integer",
      "title": "string",
      "primary_image_url": "string | null",
      "current_bid_cents": "integer",
      "platform_url": "string"
    }
  ],
  "seller": {
    "display_name": "string",
    "seller_type_label": "string",
    "logo_url": "string | null"
  },
  "terms_summary": "string | null",
  "platform_url": "string"
}
```

**Excluded fields:** `seller_id`, `seller_email`, `full_address`, `street_address`, `consignor_id`, `buyer_premium_pct`, `seller_commission_pct`, `admin_notes`, `review_status`, any internal workflow flags

**Cache TTL:** 60 seconds (CDN)

---

### 3.3 `GET /api/public/auctions/:id/lots`

**Purpose:** Lot listing for a published auction, for BD auction detail embeds.

**Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `id` | string | Public auction ID or slug |

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `page` | integer | No | 1-indexed, default 1 |
| `per_page` | integer | No | Default 50, max 100 |
| `size_category` | string | No | Filter by size category label |

**Response Shape:**

```json
{
  "data": [
    {
      "id": "string",
      "lot_number": "integer",
      "title": "string",
      "description": "string | null",
      "size_category": "string",
      "current_bid_cents": "integer",
      "starting_bid_cents": "integer",
      "bid_increment_cents": "integer",
      "state": "open | closed | withdrawn",
      "primary_image_url": "string | null",
      "image_urls": ["string"],
      "is_shippable": "boolean",
      "platform_url": "string"
    }
  ],
  "meta": {
    "page": "integer",
    "per_page": "integer",
    "total": "integer",
    "total_pages": "integer"
  }
}
```

**Excluded fields:** `auction_id` FK (present only as context, not surfaced as raw FK), `seller_id`, reserve price, `shipping_cost_cents` (amount hidden; only `is_shippable` boolean exposed), bid history, winning bidder identity

**Cache TTL:** 30 seconds (CDN). Note: live bidding data (current_bid_cents) ages quickly — BD widgets displaying bid amounts should show a "live on platform" call-to-action rather than treating this as real-time.

---

### 3.4 `GET /api/public/featured-lots`

**Purpose:** Cross-auction featured lot showcase for BD homepage widget.

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | No | Max results, default 12, max 24 |
| `state` | string | No | Filter by US state abbreviation |

**Response Shape:**

```json
{
  "data": [
    {
      "id": "string",
      "lot_number": "integer",
      "title": "string",
      "primary_image_url": "string | null",
      "current_bid_cents": "integer",
      "size_category": "string",
      "auction": {
        "id": "string",
        "title": "string",
        "city": "string",
        "state": "string",
        "end_time": "ISO8601",
        "timezone": "string"
      },
      "platform_url": "string"
    }
  ]
}
```

**Excluded fields:** All fields listed in section 2 sanitization rules. `featured_for_marketing` internal flag is never exposed — selection is an internal admin operation; only its output (inclusion in this feed) is public.

**Cache TTL:** 120 seconds (CDN)

---

### 3.5 `GET /api/public/featured-videos`

**Purpose:** Approved and publicly visible walkthrough videos for BD marketing embeds.

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | No | Max results, default 6, max 12 |

**Response Shape:**

```json
{
  "data": [
    {
      "id": "string",
      "video_url": "string",
      "thumbnail_url": "string | null",
      "caption": "string | null",
      "auction": {
        "id": "string",
        "title": "string",
        "city": "string",
        "state": "string",
        "platform_url": "string"
      }
    }
  ]
}
```

**Inclusion criteria (enforced server-side):** `review_status = approved` AND `visible_public = true`. The `featured_for_marketing` flag may additionally filter this list at admin discretion but is never exposed in the response.

**Excluded fields:** `review_status` raw value, `featured_for_marketing` flag, `seller_id`, internal video processing metadata

**Cache TTL:** 300 seconds (CDN). Changes to visibility or approval status must bust this cache (see section 5).

---

### 3.6 `GET /api/public/auctions/by-location`

**Purpose:** Geographic discovery for BD city and state landing pages.

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `city` | string | No | City name filter (case-insensitive, exact or partial) |
| `state` | string | No | US state abbreviation |
| `page` | integer | No | Default 1 |
| `per_page` | integer | No | Default 20, max 50 |

At least one of `city` or `state` must be provided; Railway returns a 400 if both are absent.

**Response Shape:** Identical to `GET /api/public/auctions` response shape, filtered by location.

**Excluded fields:** Same as `/api/public/auctions`

**Cache TTL:** 60 seconds (CDN)

---

### 3.7 `GET /api/public/sellers/:sellerId/profile`

**Purpose:** Public seller bio page for BD seller directory listings.

**Path Parameters:**

| Param | Type | Description |
|---|---|---|
| `sellerId` | string | Public seller profile ID (not the internal `seller_id` FK) |

**Query Parameters:** None

**Response Shape:**

```json
{
  "id": "string",
  "display_name": "string",
  "seller_type_label": "string",
  "bio": "string | null",
  "location_label": "string",
  "logo_url": "string | null",
  "active_auction_count": "integer",
  "upcoming_auctions": [
    {
      "id": "string",
      "title": "string",
      "start_time": "ISO8601",
      "city": "string",
      "state": "string",
      "primary_image_url": "string | null",
      "platform_url": "string"
    }
  ]
}
```

**Excluded fields:** `seller_id` internal FK, email, phone, full street address, `seller_type` raw enum (only `seller_type_label` is safe), `shipping_enabled`, `reserve_enabled`, commission rates, consignor data, BD member ID

**Cache TTL:** 300 seconds (CDN)

---

## 4. Payload Sanitization Rules

Sanitization is applied in Railway's public API controller layer before any response is serialized. BD never receives unsanitized data.

### Always-Excluded Field Categories

| Category | Rule |
|---|---|
| Relational foreign keys | `seller_id`, `user_id`, `consignor_id`, `created_by`, `updated_by`, `payment_method_id`, `stripe_customer_id` — never in any public response |
| Full addresses | `street_address`, `address_line_2` — only `city`, `state`, `zip` are public |
| Financial internals | `buyer_premium_pct`, `seller_commission_pct`, `reserve_price_cents`, `shipping_cost_cents`, `payout_amount_cents`, `verification_charge_cents` |
| Payment records | Card tokens, payment events, refund records, invoice line items, verification results |
| Admin workflow flags | `review_status`, `admin_notes`, `featured_for_marketing`, `shipping_enabled`, `reserve_enabled`, `visibility_override` |
| Bidder identity | Paddle numbers, bid amounts attributed to a bidder, bid histories that identify a buyer |
| PII | Buyer and seller email, phone, any government ID fields |

### Serializer Pattern (Implementation Guidance)

Railway should implement a dedicated public serializer layer (e.g., `PublicAuctionSerializer`, `PublicLotSerializer`) that is the only path through which public endpoint responses are built. No controller may pass a raw DB row to a public response. The serializer allowlist approach (explicit include list) is preferred over a blocklist (explicit exclude list) to prevent accidental field leakage as schema evolves.

---

## 5. Caching Strategy

### Cache Architecture

```
BD CDN (e.g. Cloudflare)
    │  serves cached responses within TTL
    ▼
Railway edge / reverse proxy (e.g. Railway ingress or a lightweight cache)
    │  optional secondary cache
    ▼
Railway application server
    │
    ▼
PostgreSQL
```

BD widgets must set appropriate `Cache-Control` headers received from Railway and must not attempt to strip or override them.

### Per-Endpoint TTL Recommendations

| Endpoint | CDN TTL | Notes |
|---|---|---|
| `GET /api/public/auctions` | 60s | Auction list changes infrequently enough for 60s |
| `GET /api/public/auctions/:id` | 60s | Reduces DB load on auction detail pages |
| `GET /api/public/auctions/:id/lots` | 30s | Shorter due to bid amount included — not a live feed |
| `GET /api/public/featured-lots` | 120s | Low-volatility curated list |
| `GET /api/public/featured-videos` | 300s | Changes only on admin approval action |
| `GET /api/public/auctions/by-location` | 60s | Geographic index is stable |
| `GET /api/public/sellers/:sellerId/profile` | 300s | Seller profiles change rarely |

### Cache-Busting on State Changes

Railway must emit cache invalidation signals on the following events:

| Event | Affected Endpoints |
|---|---|
| Auction published | `/api/public/auctions`, `/api/public/auctions/by-location` |
| Auction state changed to closed | `/api/public/auctions`, `/api/public/auctions/:id`, `/api/public/auctions/:id/lots` |
| Featured lots updated by admin | `/api/public/featured-lots`, `/api/public/auctions/:id` |
| Walkthrough video approval status changed | `/api/public/featured-videos` |
| Seller profile updated | `/api/public/sellers/:sellerId/profile` |

**Implementation approach:** Railway emits a cache purge webhook to BD's CDN provider (e.g., Cloudflare Cache Purge API) using a server-side Railway secret that BD never sees. BD's CDN secret is stored only in Railway's environment. BD does not hold this secret.

---

## 6. Widget Modularity Plan

### Embedding Strategy

BD widgets consume Railway's public API directly from the browser or via BD's server-side rendering. No BD-side business logic should process or transform the data — widgets render Railway responses verbatim.

| Widget | Embed Approach | Description |
|---|---|---|
| Featured auctions (homepage) | JavaScript snippet (async fetch) | Renders a card grid of upcoming published auctions |
| City/state discovery | Server-side render + JS hydration | BD SSR calls `/by-location`, renders SEO-safe HTML |
| Auction detail preview | JavaScript snippet | Renders auction summary card with CTA to Railway |
| Featured lots showcase | JavaScript snippet (async fetch) | Cross-auction lot grid, links to Railway lot pages |
| Walkthrough video gallery | JavaScript snippet | Embeds approved videos from `/featured-videos` |
| Seller profile card | JavaScript snippet or iframe | Public seller bio with upcoming auction list |

**Iframe vs. JS snippet policy:**  
- Prefer JavaScript snippets (fetch + DOM render) for content where SEO visibility is important — search crawlers can index JS-rendered content with appropriate pre-rendering.
- Use iframes only for interactive Railway components (e.g., a live bid display or a bid-entry widget). Any iframe must be served from `auctions.advantage.bid` (Railway), not from BD's domain.
- Never embed a Railway iframe that requires a session token inside BD pages.

### Naming Conventions

Widget script files and CSS classes should follow the prefix `adv-` to namespace them within BD's page environment and prevent collisions:

- Script: `adv-featured-auctions.js`, `adv-lot-grid.js`, `adv-video-gallery.js`
- CSS class namespace: `.adv-widget`, `.adv-auction-card`, `.adv-lot-card`
- Data attribute: `data-adv-auction-id`, `data-adv-widget-type`

Each widget must accept a configuration object at initialization to specify the Railway API base URL, enabling environment switching (staging vs. production) without code changes.

---

## 7. SEO and Discovery Strategy

### Structured Data (JSON-LD)

BD pages should emit JSON-LD structured data populated from Railway's public API payloads. Railway should not generate the JSON-LD itself; BD constructs it from the sanitized fields it receives.

**Auction detail page — recommended schema types:**

```json
{
  "@context": "https://schema.org",
  "@type": "Event",
  "name": "{{auction.title}}",
  "startDate": "{{auction.start_time}}",
  "endDate": "{{auction.end_time}}",
  "eventStatus": "https://schema.org/EventScheduled",
  "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode",
  "location": {
    "@type": "Place",
    "name": "{{auction.city}}, {{auction.state}}",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "{{auction.city}}",
      "addressRegion": "{{auction.state}}",
      "postalCode": "{{auction.zip}}",
      "addressCountry": "US"
    }
  },
  "organizer": {
    "@type": "Organization",
    "name": "Advantage Auction",
    "url": "https://advantage.bid"
  },
  "url": "{{auction.platform_url}}"
}
```

Do not include fields that are unavailable in the public payload (full address, seller contact info, financial terms).

**Lot pages (if BD renders individual lot landing pages):**

```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "{{lot.title}}",
  "description": "{{lot.description}}",
  "image": "{{lot.primary_image_url}}",
  "offers": {
    "@type": "Offer",
    "priceCurrency": "USD",
    "price": "{{lot.current_bid_cents / 100}}",
    "availability": "https://schema.org/InStock",
    "url": "{{lot.platform_url}}"
  }
}
```

### OpenGraph Tags

BD must emit OpenGraph meta tags on auction and lot pages, populated from the Railway public API response:

```html
<meta property="og:title" content="{{auction.title}}" />
<meta property="og:description" content="{{auction.teaser_description}}" />
<meta property="og:image" content="{{auction.primary_image_url}}" />
<meta property="og:url" content="{{auction.platform_url}}" />
<meta property="og:type" content="website" />
```

### Sitemap Generation

BD should generate a dynamic XML sitemap from the `/api/public/auctions` feed. Railway does not generate or serve the sitemap — BD owns this because BD owns SEO.

**Recommended sitemap update cadence:** regenerate on a 10-minute schedule using a cron job that polls the Railway public feed. Only `state = published` auctions appear in the sitemap.

**Sitemap entry shape (per auction):**

```xml
<url>
  <loc>https://advantage.bid/auctions/{{auction.id}}</loc>
  <lastmod>{{auction.start_time | date}}</lastmod>
  <changefreq>daily</changefreq>
  <priority>0.8</priority>
</url>
```

**Sitemap entry shape (per seller profile, if BD has seller directory pages):**

```xml
<url>
  <loc>https://advantage.bid/sellers/{{seller.id}}</loc>
  <changefreq>weekly</changefreq>
  <priority>0.5</priority>
</url>
```

---

## 8. Integration Rules (Hard Constraints)

These constraints are binding. They override any convenience or performance rationale that conflicts with them.

1. **BD must never access Railway's PostgreSQL database directly.** No connection string, no read replica, no SSH tunnel, no ORM pointing at Railway's database from a BD process.

2. **BD must never hold Railway secrets or privileged auth tokens.** No Railway API keys, session tokens, admin credentials, or Stripe keys may exist in BD's environment, codebase, version control, or CDN configuration.

3. **BD widgets may only consume public-safe sanitized payloads from Railway's `/api/public/*` endpoints.** BD may not construct its own queries against Railway's internal data shape or rely on undocumented response fields.

4. **All auction operations remain exclusively on Railway.** Bidding, bid validation, soft-close timers, proxy bidding, payment collection, invoice generation, refund processing, address release, and notification delivery must never be delegated to or executed by BD.

5. **Full seller and pickup addresses must never appear in any public API response.** Only city, state, and zip code are permitted in public payloads. Full address disclosure is gated on payment verification and is managed exclusively by Railway.

6. **The auction platform must remain operational without BD.** If BD is offline, unreachable, or replaced, Railway must continue to process bids, collect payments, send notifications, and serve buyers and sellers without interruption.

7. **BD integration must be implemented as an adapter, not a platform dependency.** No Railway code path may fail, degrade, or alter behavior based on whether BD is reachable. BD is one consumer of Railway's public API, not a required component.

8. **Bid history, paddle numbers, and bidder identity must never be included in any public payload.** Public lot responses expose `current_bid_cents` as an aggregate — no bid-level records, bidder paddle numbers, or buyer-attributed amounts may appear in any BD-facing response.

---

## Appendix: Integration Contract Reference

This document is subordinate to `docs/integration-contract-bd.md`. Where this document and the integration contract conflict, the integration contract takes precedence. This document extends the contract with implementation-level API specifications and was authored for planning purposes prior to any implementation work.
