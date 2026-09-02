-- 124_demo_account_hardening.sql — mark the dedicated sales-demo EXPLORATION accounts as is_demo so the
-- server-authoritative demo guards apply (blockDemoSideEffects + is_demo auction isolation), make the demo
-- seller a professional so the demo shows the Professional experience, and isolate all demo-seller content
-- from the public marketplace. Idempotent; scoped strictly to the two known demo emails. Non-destructive.

-- 1) Flag the exploration accounts as demo (activates blockDemoSideEffects + create-auction is_demo tagging).
UPDATE users SET is_demo = true
 WHERE email IN ('demo-seller@advantage.bid', 'demo-buyer@advantage.bid')
   AND is_demo IS DISTINCT FROM true;

-- 2) The demo seller's profile: is_demo + a professional type so the demo demonstrates the Professional
--    Seller experience (auto-publish, storefront, widget). is_demo keeps all its content out of public.
UPDATE seller_profiles sp
   SET is_demo = true, seller_type = 'estate_sale_company'
 WHERE sp.user_id = (SELECT id FROM users WHERE email = 'demo-seller@advantage.bid');

-- 3) Isolate every auction owned by the demo seller from the public marketplace/feed/widget
--    (activeNativeAuctionSql excludes is_demo). Prospect-created demo auctions are tagged the same way
--    server-side (auctionService.createAuction).
UPDATE auctions a
   SET is_demo = true, marketplace_status = 'hidden', updated_at = now()
 WHERE a.seller_id IN (
         SELECT sp.id FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
          WHERE u.email = 'demo-seller@advantage.bid')
   AND (a.is_demo IS DISTINCT FROM true OR a.marketplace_status <> 'hidden');
