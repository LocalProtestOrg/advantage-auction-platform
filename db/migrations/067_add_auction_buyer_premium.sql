-- Migration: 067_add_auction_buyer_premium.sql
-- Phase 4 (admin auction controls): per-auction buyer-premium INFRASTRUCTURE only.
-- Additive + idempotent. Stored basis points (0–2500 = 0–25%); admin-editable.
-- NOT yet charged: paymentService still charges the hammer price only. Wiring the
-- premium into charges/invoices/live-display/Buyer-Terms is a separate,
-- Stripe-LIVE-gated workstream (see buyer-premium-audit-and-plan.md). This column
-- lets admins configure the value safely ahead of that activation.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS buyer_premium_bps INTEGER;
