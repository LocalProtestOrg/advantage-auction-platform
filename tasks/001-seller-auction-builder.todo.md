# Task ID: 001
# Title: Seller Auction Builder (Mobile-First)

## Problem
Sellers currently have no structured way to create auctions with lots, images, pickup times, shipping flags, reserve options, featured lots, marketing selections, and required metadata in a controlled, mobile-friendly workflow.

We need a seller-facing system where users can:
- create an auction from their phone
- add lots with images taken directly from their phone
- assign required metadata per lot
- define pickup timing rules
- choose featured lots
- optionally use shipping and reserve options only when enabled by admin
- submit the auction ONCE for review

## Why This Matters
This is the entry point of all inventory into the Advantage Auction Platform.

If this is weak:
- auctions will be inconsistent
- pickup will be chaotic
- admin workload will explode
- scaling will fail
- privacy and seller capability rules will break
- marketing upsells will be missed

## Users Affected
- Seller (primary)
- Admin (secondary)

## Core Requirements
- Seller can create auction from mobile
- Seller can save draft progress
- Seller can create auction title, description, city, zip, start time, end time
- Full address is stored but not publicly shown before verified payment
- Seller can define pickup window
- Pickup start must be at least 36 hours after auction end
- Seller can add unlimited lots
- Each lot requires:
  - title
  - description
  - size category (A / B / C)
  - at least 1 image
- Dimensions are optional but encouraged
- Seller can assign lot numbers and order
- Seller must select exactly 3 featured lots before final submission
- Seller can complete auction terms and standard seller-allowed auction fields
- Seller can complete consignor information fields for recordkeeping
- Shipping options appear only if shipping is enabled for that seller by admin
- Reserve options appear only if reserve capability is enabled for that seller by admin
- Seller can select a marketing package during auction setup if enabled
- Seller can submit the auction only once
- After submission, seller loses edit access
- Admin retains full edit control at all times

## Dependencies
- Authentication system
- Image upload handling
- Auction data model
- Lot data model
- Seller capability flags
- Admin permission model

## Priority
HIGH

## State
todo