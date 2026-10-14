-- 193: Sasha guidance article "professional-storefront-fee" — replace only the obsolete storefront-availability paragraph
-- (owner decision 2026-10-12: Buy Now is a Professional Seller Storefront capability; specific item availability only
-- from current listing data). The 11% fee paragraph is correct and unchanged. Idempotent: applies only while the old
-- paragraph is still present, and bumps the article version.

UPDATE cs_kb_articles
   SET body = replace(body,
         'Storefront checkout is not open to buyers yet; if asked, say fixed-price checkout is coming soon and offer a team member for details.',
         'Storefronts and Buy Now are Professional Seller features. Buy Now is an Advantage.Bid capability for Professional Seller Storefront items. Never say a specific item can be bought online right now unless current listing data shows it; otherwise point the customer to that item''s listing or to the seller. Do not describe how a storefront purchase is paid for.'),
       version = version + 1,
       source = 'Owner decision (2026-09-28); seller agreement §6.9; Buy Now wording owner decision (2026-10-12)',
       updated_at = now()
 WHERE slug = 'professional-storefront-fee'
   AND body LIKE '%Storefront checkout is not open to buyers yet%';
