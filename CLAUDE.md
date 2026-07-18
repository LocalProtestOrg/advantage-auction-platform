# Project Instructions for All Agents

You are working on the Advantage Auction Platform.

## Product Priorities
1. Full admin control for Advantage
2. Reliable auction creation flow for sellers
3. Transparent bidding experience for buyers
4. Payment automation and accurate invoicing
5. Strict business-rule enforcement
6. Strong privacy, fraud prevention, and seller security
7. Structured marketing and CRM value from platform data
8. Platform independence from BD with secure, limited integration only

## Engineering Priorities
- Build simple, stable, editable systems first
- Prefer clean architecture over flashy UI
- Every important rule must be enforced server-side
- Do not assume a field is immutable unless explicitly required
- Admin override capability must be preserved across all major workflows
- Identity, payment, bidding, and close logic must be treated as critical infrastructure
- The platform must remain operational without BD
- BD integration must be adapter-based, not dependency-based

## Permission Model
- Seller has limited permissions and loses edit rights after final submission
- Admin has unrestricted edit rights at all times
- Buyer has access only to bidding, favorites, account, notification preferences, payment methods, invoices, and purchased-lot details

## Critical Business Constraints
- Pickup-gap rule (governed by seller type; supersedes the prior fixed 36-hour rule): non-professional sellers (private, business, other, untyped) must set pickup to begin at least 48 hours after auction close; professional sellers (auction_house, estate_sale_company, professional_liquidator) are exempt and may configure their own pickup timing; no seller may set pickup before the auction closes. Enforced server-side in `src/services/sellerTypeRules.js`.
- Seller chooses 3 featured lots before final submission
- Advantage can override featured lots
- Dimensions are optional, size category is required
- Buyer premium must be shown live during bidding
- Tax is calculated after auction close
- Only debit and credit cards are accepted
- Buyer card verification uses a temporary random charge under $1 at signup and card change
- Seller final submission is single-use and locks seller editing
- Advantage publishes auctions, not sellers
- Each lot starts at $1 by default unless admin overrides it
- Bid increments must follow the approved editable increment ladder
- Buyers must be able to save favorite lots and view them on a dedicated page
- Auction terms and other standard auction sections must be editable
- Consignor information must be stored for recordkeeping
- Auctions must support per-lot soft close with 1-minute staggered closings
- Bids placed at 2 minutes or less remaining must extend that lot by 2 minutes
- Registration, outbid, and auction reminder notifications are required
- SMS notifications must be opt-in only
- Full address stays hidden until payment is verified
- Public bidding identity uses auction-specific paddle numbers
- Shipping, reserve, and similar advanced options may be seller-visible only when enabled by admin
- Marketing campaign upsells and campaign configuration must remain admin-editable
- BD may display public data but must not own auction operations

## Integration Rules
- Read docs/integration-contract-bd.md before designing any BD-related feature
- Never put core auction logic into BD widgets
- Never depend on BD database tables for core auction operations
- Treat BD as an external presentation and identity adapter only

## Security Rules (Non-Negotiable)
- Never write real credentials, API keys, passwords, tokens, or secrets into any file
- Never paste `.env` file contents into code, docs, tests, scripts, or agent context
- `.env.example` uses placeholders only — never real values
- Test accounts use clearly-labeled seeded passwords, never production credentials
- If a real credential appears anywhere in your output, stop and report it
- Read `docs/security/secret-management.md` for the full credential policy

## Public Language Standard (Non-Negotiable)
- No human-facing interface may expose "AI" terminology. This applies to EVERY rendered surface seen by any person — public pages, seller tools, buyer tools, admin dashboards, staff moderation tools, emails, notifications, toasts, dialogs, tooltips, help text, buttons, metadata, accessibility labels, and any API message displayed to a user. Administrators and staff are included: the standard is consistency across the entire Advantage.Bid experience, not just customer-facing pages.
- Banned visible terms include (non-exhaustive): AI, A.I., Artificial Intelligence, Machine Learning, AI Assistant/Generator/Writer/Enhancement/Detection/Recognition/Suggestions/Verification, "AI-powered", "powered by AI", "AI-generated", and any phrasing that frames a feature as artificial intelligence. Also avoid exposing model/vendor terms in visible text (OpenAI, GPT, LLM, Copilot).
- Present these capabilities as helpful tooling instead: "Smart Tools", "Smart Catalog Tools", "Smart Description Tools", "Smart Photo Tools", "Smart Suggestions", "Smart Detection", "Smart Enhancement", "Smart Verification", "Smart Descriptions", "Automatic Suggestions/Enhancement", "Breeze" (the listing/catalog assistant). Language should feel natural and never make the user think about the technology.
- This applies ONLY to text that is actually rendered to a human. Do NOT rename internal variables, function names, API routes, service/file names, database columns, feature flags, environment variables, internal event names, internal audit data values (e.g. the stored `ai_description` provenance value), or non-rendered code comments. The underlying audit trail and provenance must remain intact — only the visible presentation layer changes. If an internal name is accidentally exposed in the interface, fix the visible text, not the internal name.
- Do not expose third-party vendor or infrastructure names in visible interface messages (e.g. Cloudinary, Railway, Neon, Postmark) unless the vendor identity is genuinely necessary for the user to complete a task. Prefer neutral language such as "Uploading photo…" or "the Advantage platform". Vendor names remain unchanged in internal logs, configuration, code, and documentation.
- Introducing any new visible AI wording, or exposing any new vendor/infrastructure name in the interface, requires explicit owner approval. When in doubt, default to Smart Tools language and neutral, vendor-free wording.

## Coding Expectations
- Write maintainable code
- Add tests for business rules
- Do not claim completion without evidence
- If uncertain, ask for clarification inside the task notes rather than silently assuming

## Canonical Auction Distribution Architecture

Advantage.Bid uses a single-source-of-truth auction architecture.

### Canonical Source
All auction records must live only in the Advantage Auction Platform at https://bid.advantage.bid. The auction platform is authoritative for: auction identity; seller and organization ownership; auction title and description; images; dates and times; auction status; lots and bidding; publication, cancellation, closing, and archival state.

### External Display
Advantage.bid, Brilliant Directories pages, seller websites, estate sale company websites, auction house websites, city pages, and other approved external destinations must display auctions through widgets or API-fed embeds that read live data from bid.advantage.bid. Do not create duplicate native auction or event records on external sites unless the owner explicitly approves a documented exception.

### Main Marketplace Widgets
Advantage.Bid's public auction and event pages may display all eligible public auctions from the platform. Eligibility is based on platform publication and marketplace visibility rules (`state IN ('published','active')`, not archived, `marketplace_status='syndicated'`).

### Company-Specific Widgets
Each individual seller, estate sale company, or auction house website must use a tenant-scoped widget or feed that displays only auctions owned by that organization. Filtering must use a stable organization or seller identifier (UUID) rather than company-name text matching. A company-specific widget must never expose another organization's auctions.

### Lifecycle Behavior
Because widgets read from the platform source of truth, auction changes must flow automatically to every display location, including: publication; title/description edits; image changes; date/time changes; live status; closing; cancellation; unpublishing; past-auction state. External pages must not maintain independent auction copies that can become stale.

### Links
Every externally displayed auction must link to its canonical public auction page on bid.advantage.bid.

### Engineering Rule
Before implementing any auction distribution feature, prefer: (1) live API-fed widgets; (2) stable organization-level filtering; (3) one canonical auction record; (4) no duplicate external storage; (5) idempotent and privacy-safe rendering. Native syndication or copying is prohibited unless explicitly approved by the owner after architectural review.