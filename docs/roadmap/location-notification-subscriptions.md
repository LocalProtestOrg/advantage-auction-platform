# Roadmap — Location-Based Notification Subscriptions

**Status:** DESIGN ONLY — not scheduled, not built. Captured during the Phase 6A onboarding pass.

## Summary
Let buyers subscribe to new inventory that matches a place + interest, and receive it on a cadence
they choose. Increases return visits and gives the discovery marketplace a retention loop.

## What a user can subscribe to
- **Location:** ZIP, City, or a Radius (miles) around a point (reuse the existing map geocode + radius).
- **Categories:** the platform's existing event categories.
- **Product families** (the locked vocabulary — reuse `marketplaceVocabulary.js`):
  Auction Partner Events · Advantage.Bid Auctions · Estate Sales · Marketplace.
- **Favorite companies:** follow specific verified professional companies.

## Cadence
- **Instant** (as matching inventory publishes), **Daily** digest, or **Weekly** digest.

## Design notes (for when it is built)
- **Canonical source only:** matches are computed from the canonical DB / public APIs
  (`marketplaceVisibility.canonicalCounts` + feed queries) — never a second retrieval path (per the
  Marketplace Integrity Standard).
- **Privacy:** subscriptions are private to the user; never expose a subscriber list. Email/SMS honor
  the existing opt-in + unsubscribe rules; SMS stays opt-in only.
- **Delivery:** reuse the existing `notificationWorker` on Railway; digests are scheduled jobs.
- **Data model (sketch):** `notification_subscriptions(user_id, location_kind, zip|city|lat/lng/radius,
  categories[], families[], company_ids[], cadence, channels[], created_at, last_sent_at)`.
- **Onboarding tie-in:** offer a subscribe prompt at the end of buyer onboarding and on event/company
  pages ("Notify me about new estate sales near <city>").
- **SEO/AI:** none (authenticated feature); no public surface.

## Explicitly out of scope for now
No implementation. This entry exists so the requirement is recorded and consistent with the platform's
canonical-data and privacy standards.
