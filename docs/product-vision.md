# Product Vision

## Product Name
Advantage Auction Platform

## Primary Objective
Create a highly automated online auction system that reduces manual work for Advantage while preserving full control over listings, publishing, pricing, bidder management, payments, logistics, marketing, and auction operations.

## User Types
1. Advantage Admin
2. Seller
3. Buyer
4. Marketing Operator or future Marketing Agent

## Seller Experience
- Seller logs in to an account created by Advantage
- Seller creates auctions and lots in a controlled workspace
- Seller can save drafts while building the auction
- Seller must choose 3 featured lots before final submission
- Seller can enter optional dimensions and required size category
- Seller can set pickup dates, but pickup start must be at least 36 hours after auction end
- Seller may see shipping options only if shipping is enabled for that seller by admin
- Seller may see reserve-price options only if reserve capability is enabled by admin
- Seller can opt into a marketing campaign during auction setup using admin-defined tiers
- Seller submits auction once for review
- After final submission, seller can no longer edit the auction

## Advantage Admin Experience
- Advantage has full access to all auctions, lots, settings, media, publishing controls, billing controls, marketing controls, and user records
- Advantage can edit any field at any time
- Advantage can remove lots, add lots, replace images, change featured lots, change pricing logic, set reserves, edit shipping details, and republish updates
- Advantage alone publishes auctions to the website
- Advantage can add miscellaneous charges with descriptions
- Advantage can process partial or full refunds
- Advantage can recover underbidder information for unpaid items
- Advantage can configure marketing packages and campaign pricing

## Buyer Experience
- Buyer registers once for the platform and verifies card on file through a small temporary authentication charge under $1
- Buyer can register for auctions, bid, save favorite lots, use proxy bidding, see bid history, and view invoices
- Buyer receives an auction-specific paddle number for public bidding display
- Buyer sees live bid amount, buyer premium, subtotal before tax, and countdown timer
- Buyer can opt into text notifications
- Buyer should only see city and zip before payment is verified
- After payment is complete, buyer receives full pickup address and instructions

## Auction Mechanics
- Each lot starts at $1 by default
- Bid increment ladder is editable by admin
- Proxy or max bidding is supported
- Soft close is enforced per lot
- Each lot closes 1 minute after the previous lot
- If a bid is placed with more than 2 minutes left, the timer stays the same
- If a bid is placed with 2 minutes or less left, that lot extends by 2 minutes
- Soft-close extensions can repeat until bidding stops in the final window
- Closing order follows lot order

## Privacy + Security
- Full seller or pickup address remains hidden until payment is verified
- Public display before payment is limited to city and zip code
- Public bid history uses paddle numbers, not buyer identity

## Shipping + Logistics
- Shipping capability is enabled per seller by admin
- If enabled, seller can mark items as shippable, enter shipping cost, and add shipping notes
- Pickup-slot logic should support automated scheduling based on lot size groups

## Notifications
- Registration confirmation notifications are required
- Outbid notifications are required each time a bidder is outbid
- Auction reminder notifications are required 3 hours before start
- Email is default for transactional events
- SMS is opt-in only

## Marketing + Data
- System should retain structured data for marketing segmentation and upsell opportunities
- Sellers can purchase optional marketing campaigns during auction setup
- Marketing tiers, pricing, and deliverables are editable by admin
- Future automation may generate campaigns using featured lots and sale metadata