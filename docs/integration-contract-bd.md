# BD Integration Contract

## Purpose
Define how Brilliant Directories and the Advantage Auction Platform interact while preserving the auction platform as the independent source of truth for all auction operations.

## Architectural Principle
The Advantage Auction Platform must remain operationally and commercially independent from Brilliant Directories.

BD is a presentation, discovery, and account-entry layer.
The auction platform is the source of truth for auctions, lots, bids, payments, bidder verification, invoices, notifications, refunds, seller capability flags, marketing selections, and operational workflows.

## Ownership Boundaries

### BD Owns
- BD member account system
- BD profile and directory content
- SEO pages and city/state discovery pages
- public marketing placement on BD pages
- lead capture and informational content pages

### Auction Platform Owns
- seller dashboards
- buyer auction accounts and bidder records
- auction records
- lot records
- lot order and close sequencing
- bids and proxy bids
- paddle numbers
- favorites and watchlist data
- card verification state
- payment methods and payment events
- invoices and refunds
- shipping, reserve, and seller capability flags
- soft-close logic
- notification preferences and delivery triggers
- marketing upsell selections and CRM data

## Identity and Login
The auction platform must support independent authentication and must not depend on BD to operate.

### Recommended Model
1. The platform supports native login and account management.
2. BD login handoff can be added as an integration layer.
3. The auction platform creates and maintains its own user records even when BD authentication is used.

### Identity Mapping
Store identity links in a dedicated mapping structure such as:
- platform_user_id
- provider_name
- provider_user_id
- provider_email
- linked_at
- last_login_at

This allows BD to be one auth provider among others.

## Sync Direction
Public auction data should flow one-way from the auction platform to BD.

### Allowed Public Sync to BD
- auction_id
- slug
- title
- teaser description
- featured image
- featured lots
- city
- state
- zip
- auction type
- start datetime
- end datetime
- timezone
- public status
- public URL

### Sensitive Data That Must Not Be Synced to BD As Source of Truth
- full address before payment verification
- bids
- paddle numbers
- card data
- refunds
- underbidder recovery data
- consignor financial data
- admin billing notes
- verification charge results

## Public Display Rules
BD may display public auction summaries and route users into the auction platform for auction participation.

The auction platform must remain the only system responsible for:
- bidding
- closing timers
- proxy bidding
- payment verification
- payment collection
- invoice generation
- refund processing
- address release after payment

## API Contract

### Public Endpoints
GET /api/public/auctions
GET /api/public/auctions/{slug}
GET /api/public/auctions/{auction_id}/featured-lots

### Auth Integration Endpoint
POST /api/auth/bd-handoff

### Account Endpoints
GET /api/account/summary
GET /api/account/my-bids
GET /api/account/my-favorites
GET /api/account/my-invoices

## BD Handoff Security
Any BD login handoff must use:
- signed tokens
- short expiration windows
- nonce or replay protection
- secure secret management
- HTTPS only

The auction platform must be able to disable BD handoff without breaking its own native login.

## Widget / Presentation Strategy
BD widgets should consume public auction summaries via API and should not execute auction business logic.

Examples:
- homepage featured auctions widget
- city page upcoming auctions widget
- featured lots widget
- account-area links into the auction platform

## URL Strategy
Recommended split:
- BD marketing site on advantage.bid
- auction platform on auctions.advantage.bid

This preserves brand continuity while maintaining operational separation.

## Security Principles
- Platform must follow least-privilege access design
- Admin and seller permissions must be separated clearly
- Sensitive financial and identity operations must be server-side only
- Address privacy rules must be enforced server-side
- Payment and bidder verification events must be logged
- Session boundaries between BD and the auction platform must remain distinct
- Core business logic must never depend on BD widgets or BD database tables

## Portability Requirement
The auction platform must remain licensable and deployable without BD.
Any BD integration must be implemented as an adapter, not a platform dependency.