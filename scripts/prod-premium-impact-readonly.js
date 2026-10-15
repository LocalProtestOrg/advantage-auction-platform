#!/usr/bin/env node
/* prod-premium-impact-readonly.js — READ-ONLY: which Professional Seller auctions the proposed buyer's-premium policy would
   affect (explicit premium vs the silent 18% fallback; any rate above 25%). Nothing is changed. Counts and auction
   states only. Usage: railway run node scripts/prod-premium-impact-readonly.js */
const { withProdReadOnly } = require('./lib/prodReadOnly');
if (!String(process.env.DATABASE_URL || '').includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: PRODUCTION endpoint only.'); process.exit(2); }
withProdReadOnly(async (q) => {
  const rows = await q(`
    SELECT a.state, coalesce(a.is_archived, false) archived, coalesce(a.is_demo, false) demo,
           (a.buyer_premium_bps IS NOT NULL) has_auction_rate,
           (SELECT st.buyer_premium_pct IS NOT NULL FROM seller_terms st WHERE st.seller_profile_id = sp.id ORDER BY st.created_at DESC LIMIT 1) has_seller_rate,
           a.buyer_premium_bps
      FROM auctions a JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE sp.seller_type IN ('auction_house','estate_sale_company','professional_liquidator')`);
  const key = (r) => `${r.state}${r.archived ? ' (archived)' : ''}${r.demo ? ' (demo)' : ''} | ${r.has_auction_rate ? 'auction rate' : r.has_seller_rate ? 'seller default rate' : 'SILENT 18% FALLBACK'}`;
  const agg = {}; for (const r of rows) agg[key(r)] = (agg[key(r)] || 0) + 1;
  console.log('Professional auctions:', rows.length); console.log(JSON.stringify(agg, null, 1));
  console.log('auction rates in use (bps):', JSON.stringify([...new Set(rows.filter((r) => r.buyer_premium_bps != null).map((r) => r.buyer_premium_bps))].sort((a, b) => a - b)));
  const st = await q(`SELECT buyer_premium_pct, count(*)::int n FROM seller_terms st JOIN seller_profiles sp ON sp.id = st.seller_profile_id
    WHERE sp.seller_type IN ('auction_house','estate_sale_company','professional_liquidator') GROUP BY 1 ORDER BY 1`);
  console.log('professional seller_terms premium pct:', JSON.stringify(st));
  console.log('professional sellers:', JSON.stringify(await q(`SELECT count(*)::int n, count(*) FILTER (WHERE coalesce(is_demo,false))::int demo FROM seller_profiles WHERE seller_type IN ('auction_house','estate_sale_company','professional_liquidator')`)));
}).catch((e) => { console.error('ERR', e.message); process.exit(1); });
