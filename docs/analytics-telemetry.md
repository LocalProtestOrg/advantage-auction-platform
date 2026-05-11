# Analytics Telemetry — Architecture and Governance

Lightweight event collection infrastructure for Advantage Auction Platform.

---

## Architecture Overview

```
BD Page / Widget
  └── AAPAnalytics.track()              (public/widgets/shared/analytics.js)
        └── POST /api/analytics/events  (src/routes/analytics.js)
              └── analyticsService      (src/services/analyticsService.js)
                    └── analytics_events table  (db/migrations/044_create_analytics_events.sql)
```

**Three design rules that must never be broken:**

1. **Non-blocking.** The HTTP response is sent before the DB write. Callers never await.
2. **Fail-silent.** If the insert fails, nothing visible to the user changes.
3. **No PII.** IP is hashed, session ID is random, no email/payment/auth data stored.

---

## Event Schema

Every event stored in `analytics_events` has this shape:

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | UUID | auto | Primary key |
| `event_type` | TEXT | yes | Snake_case event name (see Event Types below) |
| `event_ver` | SMALLINT | default 1 | Schema version for the event type |
| `session_id` | TEXT | no | Random token, 30-min idle TTL, not user-linked |
| `device_type` | TEXT | no | `desktop` \| `mobile` \| `tablet` |
| `page_url` | TEXT | no | Full URL where the event occurred (max 2048 chars) |
| `referrer` | TEXT | no | HTTP referrer URL |
| `widget_name` | TEXT | no | Widget that emitted the event |
| `auction_id` | UUID | no | Auction context (public ID only) |
| `seller_id` | UUID | no | Seller context (public ID only) |
| `city` | TEXT | no | City context |
| `state_code` | TEXT | no | Two-character state code |
| `metadata` | JSONB | default {} | Event-specific flexible data |
| `received_at` | TIMESTAMPTZ | auto | Server timestamp |
| `client_ts` | TIMESTAMPTZ | no | Client-reported timestamp (use for UI, not for truth) |
| `ip_hash` | TEXT | no | SHA-256(IP) truncated to 16 hex chars — rate analysis only |

---

## Event Types and Metadata Schemas

### `widget_impression`
Widget rendered and visible to the user.

```json
{
  "event_type":  "widget_impression",
  "widget_name": "featured-lots",
  "page_url":    "https://bd-partner.com/auctions",
  "metadata": {
    "result_count": 6,
    "variant": "standalone"
  }
}
```

### `widget_click`
User clicked a card inside a widget.

```json
{
  "event_type":  "widget_click",
  "widget_name": "featured-near-you",
  "auction_id":  "uuid",
  "metadata": {
    "card_position": 2,
    "source": "featured"
  }
}
```

### `auction_view`
User navigated to an auction detail page.

```json
{
  "event_type": "auction_view",
  "auction_id": "uuid",
  "city":       "Dallas",
  "state_code": "TX",
  "metadata": {
    "auction_state": "active",
    "lot_count": 42
  }
}
```

### `featured_auction_click`
User clicked a featured auction card.

```json
{
  "event_type":  "featured_auction_click",
  "widget_name": "featured-near-you",
  "auction_id":  "uuid",
  "city":        "Dallas",
  "state_code":  "TX",
  "metadata": {
    "distance_km": 12.4,
    "source": "featured"
  }
}
```

### `seller_cta_click`
User clicked the "Sell with Advantage" CTA button.

```json
{
  "event_type":  "seller_cta_click",
  "widget_name": "featured-lots",
  "metadata": {
    "cta_url": "https://auctions.advantage.bid/seller-create.html",
    "headline": "Consigning an Estate?"
  }
}
```

### `radius_search`
User changed the geo search radius.

```json
{
  "event_type": "radius_search",
  "city":       "Dallas",
  "state_code": "TX",
  "metadata": {
    "radius_km":   150,
    "result_count": 8,
    "geo_source":  "browser"
  }
}
```

### `shipping_filter_toggle`
User toggled the "ships nationwide" filter.

```json
{
  "event_type": "shipping_filter_toggle",
  "metadata": {
    "enabled": true,
    "result_count_before": 12,
    "result_count_after": 5
  }
}
```

### `city_page_visit`
User landed on a city-specific page.

```json
{
  "event_type": "city_page_visit",
  "city":       "Atlanta",
  "state_code": "GA",
  "metadata": {
    "page_slug": "atlanta-estate-auctions"
  }
}
```

### `seller_onboarding_start`
User began the seller onboarding flow.

```json
{
  "event_type": "seller_onboarding_start",
  "metadata": {
    "entry_point": "cta_card",
    "flow_variant": "estate"
  }
}
```

### `seller_onboarding_complete`
User completed the seller onboarding flow.

```json
{
  "event_type": "seller_onboarding_complete",
  "metadata": {
    "steps_completed": 4,
    "time_on_flow_seconds": 187
  }
}
```

---

## Event Naming Discipline

### Format

```
[noun]_[verb or state]
```

All lowercase, snake_case, no hyphens, no dots, no spaces.

### Noun vocabulary

| Noun | Represents |
|---|---|
| `widget` | An embedded Advantage widget |
| `auction` | A specific auction record |
| `lot` | A specific lot within an auction |
| `seller` | A seller account or flow |
| `city` | A geo/city context |
| `radius` | A geo search radius selection |
| `shipping` | The ships-nationwide filter |
| `cta` | A call-to-action button |

### Verb vocabulary

| Verb | Meaning |
|---|---|
| `impression` | Rendered and visible — may or may not be interacted with |
| `view` | Explicit page visit or detail-level engagement |
| `click` | User intentional click/tap |
| `toggle` | User changed a binary state |
| `search` | User triggered a search/filter |
| `start` | User began a multi-step flow |
| `complete` | User finished a multi-step flow |
| `error` | A failure occurred |

### Adding a new event type

1. Choose a name following `[noun]_[verb]`
2. Add it to `KNOWN_EVENT_TYPES` in `src/services/analyticsService.js`
3. Document its metadata schema in this file
4. Update `AAPAnalytics` usage in the relevant widget or page
5. No migration needed — unknown event types are stored as-is

---

## Event Versioning

Each event has an `event_ver` field (default: 1). Version is incremented when the
metadata schema for an existing event type changes in a breaking way.

| Scenario | Action |
|---|---|
| Adding a new optional metadata field | No version bump |
| Renaming a metadata field | Bump `event_ver` to 2; keep reading both in queries |
| Changing a top-level column meaning | Requires a migration and new event type |
| Removing an event type | Deprecate in code; old rows remain queryable |

Queries should always filter by `event_ver` when version matters:
```sql
WHERE event_type = 'widget_impression' AND event_ver = 1
```

---

## Frontend Usage — `AAPAnalytics`

### Script tag

```html
<!-- Load before widget scripts, after shared/config.js -->
<script src="https://auctions.advantage.bid/widgets/shared/analytics.js"></script>
```

### `AAPAnalytics.track(eventType, metadata, context)`

```javascript
// Minimal usage
AAPAnalytics.track('seller_cta_click');

// With metadata (event-specific data)
AAPAnalytics.track('radius_search', { radius_km: 150, result_count: 8 });

// With context (top-level indexed fields)
AAPAnalytics.track('featured_auction_click',
  { distance_km: 12.4, source: 'featured' },
  { widget_name: 'featured-near-you', auction_id: 'uuid', city: 'Dallas', state_code: 'TX' }
);
```

### `AAPAnalytics.trackBatch(events)`

Use for page-unload scenarios (send multiple queued events at once):

```javascript
window.addEventListener('beforeunload', function () {
  AAPAnalytics.trackBatch([
    { event_type: 'page_exit', metadata: { time_on_page_seconds: 45 } },
  ]);
});
```

### Widget integration pattern

Widgets emit analytics by listening to their own custom events:

```javascript
// In a widget or on a BD page — attach to widget container
var el = document.getElementById('aap-featured-lots');
if (el && window.AAPAnalytics) {
  el.addEventListener('aap:widget:loaded', function (e) {
    AAPAnalytics.track('widget_impression',
      { result_count: e.detail.resultCount },
      { widget_name: 'featured-lots' }
    );
  });

  el.addEventListener('aap:lot:click', function (e) {
    AAPAnalytics.track('featured_auction_click',
      { source: 'featured-lots' },
      { widget_name: 'featured-lots', auction_id: e.detail.auctionId }
    );
  });

  el.addEventListener('aap:cta:click', function () {
    AAPAnalytics.track('seller_cta_click',
      {},
      { widget_name: 'featured-lots' }
    );
  });
}
```

---

## What Must Never Be Collected

The service layer strips these at insertion time, but frontend code must not send them either:

- Email addresses
- Passwords or tokens of any kind
- Credit card numbers, CVV, payment data
- Auth JWT tokens or session cookies
- Phone numbers
- Physical addresses
- Social security numbers or government IDs
- Any field that would uniquely identify a non-public user without their consent

**session_id is not a user identifier.** It is a random string generated fresh per browser
session. It cannot be linked back to a user account even with database access.

---

## API Reference

### `POST /api/analytics/events`

No authentication required. Rate-limited to 100 requests per IP per 60-second window.

**Single event:**
```json
{
  "event_type":  "widget_impression",
  "session_id":  "aap_abc123",
  "device_type": "desktop",
  "page_url":    "https://bd-partner.com/auctions",
  "widget_name": "featured-lots",
  "metadata":    { "result_count": 6 },
  "client_ts":   "2026-05-11T14:32:00.000Z"
}
```

**Batch (array of up to 20 events):**
```json
[
  { "event_type": "widget_impression", "widget_name": "featured-lots", ... },
  { "event_type": "seller_cta_click", "widget_name": "featured-lots", ... }
]
```

**Response:** Always `202 Accepted`
```json
{ "accepted": true }
```

The 202 is returned before the DB write completes. The caller must not interpret
202 as "successfully stored" — it means "received for processing."

---

## Indexing Strategy

Current indexes on `analytics_events`:

| Index | Columns | Used for |
|---|---|---|
| `analytics_events_type_ts` | `(event_type, received_at DESC)` | Event counts by type and time period |
| `analytics_events_ts` | `(received_at DESC)` | Full time-range scans |
| `analytics_events_session` | `(session_id)` WHERE NOT NULL | Session funnel analysis |
| `analytics_events_auction` | `(auction_id, received_at DESC)` WHERE NOT NULL | Per-auction engagement |
| `analytics_events_widget` | `(widget_name, received_at DESC)` WHERE NOT NULL | Widget performance |
| `analytics_events_city` | `(state_code, city)` WHERE NOT NULL | Regional reports |
| `analytics_events_metadata_gin` | GIN on `metadata` | Ad-hoc metadata queries |

---

## Sample Queries

### Widget impressions by day (last 30 days)
```sql
SELECT
  date_trunc('day', received_at) AS day,
  widget_name,
  COUNT(*) AS impressions
FROM analytics_events
WHERE event_type = 'widget_impression'
  AND received_at > now() - INTERVAL '30 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;
```

### Click-through rate per widget
```sql
SELECT
  widget_name,
  COUNT(*) FILTER (WHERE event_type = 'widget_impression') AS impressions,
  COUNT(*) FILTER (WHERE event_type = 'widget_click')      AS clicks,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE event_type = 'widget_click')
          / NULLIF(COUNT(*) FILTER (WHERE event_type = 'widget_impression'), 0),
    2
  ) AS ctr_pct
FROM analytics_events
WHERE event_type IN ('widget_impression', 'widget_click')
  AND received_at > now() - INTERVAL '7 days'
  AND widget_name IS NOT NULL
GROUP BY 1
ORDER BY impressions DESC;
```

### Seller CTA clicks by city (last 14 days)
```sql
SELECT
  state_code,
  city,
  COUNT(*) AS cta_clicks
FROM analytics_events
WHERE event_type = 'seller_cta_click'
  AND received_at > now() - INTERVAL '14 days'
  AND city IS NOT NULL
GROUP BY 1, 2
ORDER BY 3 DESC
LIMIT 20;
```

### Onboarding funnel (starts vs. completes)
```sql
SELECT
  date_trunc('week', received_at) AS week,
  COUNT(*) FILTER (WHERE event_type = 'seller_onboarding_start')    AS starts,
  COUNT(*) FILTER (WHERE event_type = 'seller_onboarding_complete') AS completes,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE event_type = 'seller_onboarding_complete')
          / NULLIF(COUNT(*) FILTER (WHERE event_type = 'seller_onboarding_start'), 0),
    1
  ) AS completion_pct
FROM analytics_events
WHERE event_type IN ('seller_onboarding_start', 'seller_onboarding_complete')
  AND received_at > now() - INTERVAL '90 days'
GROUP BY 1
ORDER BY 1 DESC;
```

### Featured lot engagement per auction (last 7 days)
```sql
SELECT
  auction_id,
  COUNT(*) FILTER (WHERE event_type = 'featured_auction_click') AS clicks,
  AVG((metadata->>'distance_km')::float) FILTER (WHERE event_type = 'featured_auction_click') AS avg_distance_km
FROM analytics_events
WHERE event_type = 'featured_auction_click'
  AND received_at > now() - INTERVAL '7 days'
  AND auction_id IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC
LIMIT 20;
```

### Device distribution
```sql
SELECT
  device_type,
  COUNT(*) AS events,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM analytics_events
WHERE received_at > now() - INTERVAL '7 days'
  AND device_type IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;
```

---

## Retention Policy

| Age | Recommendation |
|---|---|
| 0–90 days | Keep raw rows — used for dashboards, funnels, debugging |
| 90–365 days | Aggregate into daily/weekly summary tables, then delete raw |
| 365+ days | Keep aggregates only; delete raw rows |

**Implementation (when volume warrants):**
1. Add `PARTITION BY RANGE (received_at)` to the table
2. Use `pg_partman` for automated monthly partition creation
3. Drop old partitions instead of DELETE scans

---

## Rate Limiting

- 100 POST requests per IP per 60-second window
- Returns `429 Too Many Requests` when exceeded
- Legitimate BD pages generate 2–5 events per page load — limit is generous
- A batch request (array of 20 events) counts as 1 against the rate limit

---

## Governance Rules for Frontend and Agent Usage

1. **AAPAnalytics is optional.** Widgets work correctly if the script is not loaded.
2. **No blocking awaits.** `track()` returns nothing — do not await it.
3. **No PII in metadata.** Strip before calling `track()` if there is any doubt.
4. **No auth tokens.** Never pass `req.headers.authorization`, JWT, or session cookies.
5. **widget_name is always a static string** — never interpolate user input.
6. **auction_id and seller_id are public UUIDs** — never pass internal admin IDs.
7. **Do not add analytics to payment or bidding flows** — these are critical paths.
8. **Agents must not emit analytics events directly** — only client-side widget code emits events.

---

## Future Scalability Path

### Near-term (when needed)
- **Seller auction report:** Query `analytics_events` by `auction_id` → export lot-level engagement for sellers
- **Widget performance dashboard:** Aggregate `widget_impression` / `widget_click` by day/widget/city
- **Onboarding funnel view:** Session-based funnel across `seller_onboarding_start` → `complete`

### Mid-term
- **Summary tables:** Daily pre-aggregated counts to avoid scanning raw events for dashboards
- **Retention partitioning:** `pg_partman` + monthly partitions + automated old-partition drops
- **Write queue:** If insert throughput becomes a concern, buffer events in Redis or a Node.js queue and batch-insert every 5 seconds

### Long-term (if warranted)
- **Dedicated analytics DB:** Read replica or separate Postgres instance so analytics queries do not compete with transactional queries
- **Stream ingestion:** Replace POST endpoint with Kafka/Kinesis topic if event volume exceeds ~10M/day
- **BI layer:** Export daily aggregates to a data warehouse (BigQuery, Redshift) for SQL-based BI tooling
- **A/B test tagging:** Add `experiment_id` and `variant` to metadata schema without a migration

### How seller reporting could evolve
Today: query `analytics_events WHERE auction_id = $1 AND event_type IN (...)`.
Tomorrow: pre-aggregate nightly into a `seller_auction_stats` table per auction.
Later: surface as a seller-facing "Auction Insights" page in the seller dashboard.

### How marketplace intelligence could evolve
Today: ad-hoc SQL queries against `analytics_events`.
Tomorrow: scheduled aggregation jobs writing to `marketplace_daily_stats (date, state_code, city, event_type, count)`.
Later: admin-facing "Marketplace Intelligence" dashboard using that aggregate table.

*Last updated: 2026-05-11*
