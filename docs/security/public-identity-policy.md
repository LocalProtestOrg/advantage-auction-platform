# Public Identity Policy — how the three authoritative gates relate

Public endpoints must NEVER invent their own identity rules. Every decision about whether a person or
organization may be publicly named routes through ONE of three centralized, fail-closed policies:

| Domain | Authoritative source | Rule | Applied at |
|---|---|---|---|
| **Auction sellers** (auctions, lots, feeds, auction JSON-LD/OG) | `src/lib/sellerBranding.js` | Only a PROFESSIONAL `seller_type` (`auction_house`, `estate_sale_company`, `professional_liquidator`, `business`) with `show_branding_to_buyers` may be named. Private/individual/off → anonymous. | `brandedColSql()` (column NULLed in-query), `brandingVisibleSql()` (WHERE gate → 404), `scrubSellerIdentity()` |
| **Event organizers** (events API, marketplace feed, event JSON-LD/OG, byline, sitemap) | `src/lib/organizerPrivacy.js` | Only a PROFESSIONAL org `type` (`auction_company`, `auction_house`, `estate_sale_company`, `professional_liquidator`, `consignment_company`, `moving_company`, `cleanout_company`) is named as host. Individual/homeowner (type NULL/`individual`) → anonymous. | `isPublicOrganizer()`, `organizerColSql()` |
| **Professional directory profiles** (`/api/public/professionals/:slug`, `/pro.html`) | `src/lib/professionalProfileSchema.js` → `PROFESSIONAL_TYPES` + `professionalTypesFrom(capabilities)` | A public professional profile is served ONLY when the org holds an APPROVED professional TYPE (capability-derived): `appraiser`, `auction_house`, `estate_sale_company`, `professional_liquidator`, `consignment_company`, `moving_company`, `cleanout_company`. No approved type → 404. | route gate: `if (!types.length) 404` |

## Public identity mode (conceptual)
- **PROFESSIONAL_PUBLIC** — a professional business/appraiser whose type + branding/publish settings authorize public attribution. May appear in APIs, JSON-LD, OG, sitemaps, internal links.
- **INDIVIDUAL_PRIVATE** — a private/individual person. Their intentionally published auctions/events/lots/listings stay public, but with **privacy-safe attribution only** (name/logo/location/profile withheld); they have **no** crawlable public profile entity.
- **SYSTEM_INTERNAL** — importer/owner tenant, unclaimed shells, unknown/missing type. Never publicly attributed; fail closed.

We intentionally did NOT add a new abstraction layer: the three functions above already provide clean,
authoritative decisions per domain. The invariant is simply that **no public route re-derives identity
visibility on its own** — it calls the matching policy.

## Fail-closed guarantees
- Unknown/absent seller_type → not visible (auctions).
- Unknown/absent org type → not a public organizer (events).
- No approved professional type → 404 (profiles).
- Hidden values are excluded **at the query layer** (WHERE gate / CASE→NULL), so private identity is
  never even selected into a public response.

## Content vs identity
Public auction, lot, event, and listing **content pages remain discoverable** (SEO/AI) even when the
owner is private — they simply use privacy-safe seller/organizer attribution. We never remove a content
page because its owner is an individual; we only remove the individual's identity from it.

Related fixes: GAP-2 (events organizer, `organizerPrivacy`), GAP-1 (`/sellers/:id/profile` → 404 for
non-professionals), GAP-3 (`/professionals/:slug` type gate). See `docs/projects/phase-4i-membership-aware-dashboard-plan.md`.
