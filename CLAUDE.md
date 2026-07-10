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
- No public-facing surface may expose "AI" terminology. This includes any customer-visible page, feature name, workflow, button, tooltip, help text, dialog, notification, toast, email, marketing/FAQ/legal page, metadata, accessibility label, or API message returned to the user.
- Banned public terms include (non-exhaustive): AI, A.I., Artificial Intelligence, AI Assistant/Generator/Writer/Enhancement/Detection/Recognition/Suggestions, "AI-powered", "powered by AI", "AI-generated", and any phrasing that frames a feature as artificial intelligence. Also avoid exposing model/vendor terms publicly (OpenAI, GPT, LLM, Copilot).
- Present these capabilities to customers as helpful tooling instead: "Smart Tools", "Smart Catalog Tools", "Smart Description Tools", "Smart Photo Tools", "Smart Suggestions", "Smart Detection", "Smart Enhancement", "Automatic Suggestions/Enhancement", "Breeze" (the listing/catalog assistant). Language should feel natural and never make the user think about the technology.
- This applies ONLY to user-facing language. Internal variables, APIs, database columns, feature flags, environment variables, service/file names, and code comments keep their existing names. Admin-only provenance/audit labels that must accurately record what an automated tool produced (e.g. the immutable "Original AI description" verification record) are internal staff tooling and are exempt.
- Introducing any new public AI-facing wording requires explicit owner approval. When in doubt, default to Smart Tools language.

## Coding Expectations
- Write maintainable code
- Add tests for business rules
- Do not claim completion without evidence
- If uncertain, ask for clarification inside the task notes rather than silently assuming