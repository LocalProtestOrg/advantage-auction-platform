'use strict';
// Marketing Agency Phase 4H — behavioral fuel + platform-fact audiences + baselines + watcher
// transactional repair + targeted lot catalog landing. No Google/Meta/A7, no send, no spend, no import.

const fs = require('fs');
const vm = require('vm');

const intent = require('../src/lib/pageIntentRegistry');
const audiences = require('../src/lib/behavioralAudiences');
const onsite = require('../src/services/onsiteService');
const marketDx = require('../src/services/marketDiagnosisService');
const crm = require('../src/services/crmRankingService');
const brand = require('../src/lib/marketingBrandMetadata');
const baseline = require('../src/services/baselineReportService');

// ── 1. Page-intent corrections against REAL routes (3J fixes) ────────────────
describe('pageIntentRegistry (real routes)', () => {
  test('become-seller.html → individual seller intent (3J fix)', () => {
    expect(intent.classify('/become-seller.html').intent).toBe('seller_intent_high');
    expect(intent.classify('/start-selling.html').intent).toBe('seller_intent_high');
  });
  test('estate-sale-welcome → seller post-conversion, NOT buyer estate-sale interest (3J fix)', () => {
    expect(intent.classify('/estate-sale-welcome.html').intent).toBe('seller_post_conversion');
    expect(intent.classify('/my-estate-sales.html').intent).toBe('seller_post_conversion');
  });
  test('marketplace-purchases → account, NOT marketplace discovery (3J fix)', () => {
    expect(intent.classify('/marketplace-purchases.html').intent).toBe('account');
  });
  test('professional + buyer routes classify correctly', () => {
    expect(intent.classify('/become-professional-seller.html').intent).toBe('professional_seller_intent');
    expect(intent.classify('/professional-sellers.html').intent).toBe('professional_seller_intent');
    expect(intent.classify('/auction-view.html?auctionId=1').intent).toBe('event_interest');
    expect(intent.classify('/event.html?slug=x').intent).toBe('estate_sale_interest');
  });
  test('stale nonexistent routes are gone (no false intent)', () => {
    // These routes do not exist in production; they must not resolve to seller/buyer intent.
    expect(intent.classify('/sell-with-us.html')).toBeNull();
    expect(intent.classify('/seller-pricing.html')).toBeNull();
    expect(intent.classify('/upcoming-auctions.html')).toBeNull();
  });
});

// ── 2. Behavioral emitter fuel (static wiring) ───────────────────────────────
describe('behavioral emitter fuel', () => {
  test('behavior-tracker bootstraps consent-banner + analytics + click-id + page_view', () => {
    const t = fs.readFileSync('public/widgets/shared/behavior-tracker.js', 'utf8');
    expect(t).toMatch(/consent-banner\.js/);
    expect(t).toMatch(/analytics\.js/);
    expect(t).toMatch(/click-id/);
    expect(t).toMatch(/AAPAnalytics\.page/);
  });
  test('key seller/buyer pages now include the tracker', () => {
    ['become-seller', 'become-professional-seller', 'how-to-buy', 'index', 'start-selling', 'search', 'events', 'auction-view'].forEach((p) => {
      expect(fs.readFileSync('public/' + p + '.html', 'utf8')).toMatch(/behavior-tracker\.js/);
    });
  });
  test('client stamps consent + durable visitor id on every event', () => {
    const a = fs.readFileSync('public/widgets/shared/analytics.js', 'utf8');
    expect(a).toMatch(/consent:\s*_consent\(\)/);
    expect(a).toMatch(/aap_visitor_id/);
  });
});

// ── 3. Identity linkage wired on login/register ──────────────────────────────
describe('identity linkage wiring', () => {
  test('login.html calls /api/analytics/identify once with the first-party visitor_id', () => {
    const l = fs.readFileSync('public/login.html', 'utf8');
    expect(l).toMatch(/\/api\/analytics\/identify/);
    expect(l).toMatch(/aap_visitor_id/);
    expect(l).toMatch(/aap_identified/);   // once-guard
  });
});

// ── 4. Platform-fact audiences ───────────────────────────────────────────────
describe('platform-fact audiences', () => {
  test('registered_non_bidder / watcher_no_bid / local_event_interest are defined as platform_fact', () => {
    ['registered_non_bidder', 'watcher_no_bid', 'local_event_interest'].forEach((k) => {
      const d = audiences.get(k);
      expect(d).toBeTruthy();
      expect(d.platform_fact).toBe(true);
    });
  });
  test('service derives them from AUTHORITATIVE platform state (not page events)', () => {
    const s = fs.readFileSync('src/services/platformFactAudienceService.js', 'utf8');
    expect(s).toMatch(/NOT EXISTS \(SELECT 1 FROM bids/);            // registered non-bidder / watcher no-bid
    expect(s).toMatch(/FROM watchlists w JOIN lots l/);              // watcher/no-bid
    expect(s).toMatch(/agreements a WHERE a\.seller_profile_id/);    // abandoned seller = no signed agreement
    expect(s).toMatch(/sp\.user_id IS NOT NULL/);                    // never write a null scope (org-linked profile)
    expect(s).toMatch(/SELLER_SIGNUP_ABANDONMENT/);                  // authoritative abandonment signal
  });
});

// ── 5. Live inventory context for onsite ─────────────────────────────────────
describe('onsite live-inventory guard', () => {
  const S = (...a) => new Set(a);
  test('category treatment requires live category inventory', () => {
    expect(onsite.chooseTreatment({ pagePath: '/x', signals: S('CATEGORY_INTEREST'), hasCategoryInventory: false })).toBeNull();
    expect(onsite.chooseTreatment({ pagePath: '/x', signals: S('CATEGORY_INTEREST'), hasCategoryInventory: true }).playbook_key).toBe('category_relevance');
  });
  test('estate treatment requires a current event', () => {
    expect(onsite.chooseTreatment({ pagePath: '/x', signals: S('ESTATE_SALE_INTEREST'), hasEventInventory: false })).toBeNull();
    expect(onsite.chooseTreatment({ pagePath: '/x', signals: S('ESTATE_SALE_INTEREST'), hasEventInventory: true }).playbook_key).toBe('estate_local_event');
  });
  test('treatmentFor computes inventory server-side (queries lots/events)', () => {
    const s = fs.readFileSync('src/services/onsiteService.js', 'utf8');
    expect(s).toMatch(/hasCategoryInventory/);
    expect(s).toMatch(/FROM lots WHERE state IN \('open','active'\)/);
    expect(s).toMatch(/FROM events WHERE status='published'/);
  });
});

// ── 6. Baselines ─────────────────────────────────────────────────────────────
describe('baselineReportService', () => {
  test('metric set covers seller/buyer/subscriber/auction/behavioral', () => {
    const keys = baseline.metricDefs().map((m) => m.key);
    ['seller_profiles_total', 'seller_signups_completed', 'registered_non_bidders', 'watchers_no_bid',
      'subscribers_total', 'active_auctions', 'behavioral_events_with_visitor', 'identity_links'].forEach((k) => expect(keys).toContain(k));
  });
  test('snapshots are immutable (insert-only; no UPDATE of baseline rows)', () => {
    const s = fs.readFileSync('src/services/baselineReportService.js', 'utf8');
    expect(s).toMatch(/INSERT INTO marketing_baselines/);
    expect(s).not.toMatch(/UPDATE marketing_baselines/);
  });
  test('subscriber placement is 90-day downstream, marked honestly', () => {
    const s = fs.readFileSync('src/services/baselineReportService.js', 'utf8');
    expect(s).toMatch(/90 days/);
    expect(s).toMatch(/not vanity signup count/i);
  });
});

// ── 7. Market diagnosis (pure) ───────────────────────────────────────────────
describe('marketDiagnosisService.classify', () => {
  test('supply/demand/balanced/unknown distinguished with evidence', () => {
    expect(marketDx.classify({ supply_events: 0, supply_auctions: 0, subscribers: 0 }).classification).toBe('unknown');
    expect(marketDx.classify({ supply_events: 0, supply_auctions: 0, subscribers: 10 }).classification).toBe('supply_shortage');
    expect(marketDx.classify({ supply_events: 5, supply_auctions: 0, subscribers: 0 }).classification).toBe('demand_shortage');
    expect(marketDx.classify({ supply_events: 2, supply_auctions: 1, subscribers: 3 }).classification).toBe('balanced');
  });
});

// ── 8. Live auction diagnosis (source) ───────────────────────────────────────
describe('liveAuctionDiagnosisService', () => {
  test('reuses deterministic diagnoseAuction over real evidence', () => {
    const s = fs.readFileSync('src/services/liveAuctionDiagnosisService.js', 'utf8');
    expect(s).toMatch(/diagnoseAuction/);
    expect(s).toMatch(/auction_buyers/);
    expect(s).toMatch(/watchlists/);
    expect(s).toMatch(/time_critical/);
  });
});

// ── 9. Watcher ENDING_SOON transactional repair ──────────────────────────────
describe('watcher ENDING_SOON transactional repair', () => {
  const w = fs.readFileSync('src/workers/notificationWorker.js', 'utf8');
  test('producer is re-enabled (no unconditional return), config-gated, soft-close aware, one-per-lot', () => {
    expect(w).not.toMatch(/Batch A: ENDING_SOON disabled/);
    expect(w).toMatch(/marketing\.watcher_ending_soon\.enabled/);
    expect(w).toMatch(/COALESCE\(l\.extended_until, l\.closes_at\)/);   // soft-close aware
    expect(w).toMatch(/setInterval\(enqueueEndingSoon/);               // scheduler wired
  });
  test('it is TRANSACTIONAL, not marketing (not routed through A7 / not newsletter-gated)', () => {
    // The producer must not depend on a7 send or email marketing suppression.
    const region = w.slice(w.indexOf('async function enqueueEndingSoon'), w.indexOf('async function enqueueEndingSoon') + 1600);
    expect(region).not.toMatch(/a7_send_enabled|email_suppressions|follower_emails_enabled/);
    expect(region).toMatch(/TRANSACTIONAL/);
  });
});

// ── 10. CRM ranking (pure tiers) ─────────────────────────────────────────────
describe('crmRankingService.tierFor', () => {
  test('estate-sale + no online auction = top tier', () => {
    expect(crm.tierFor({ estate_sales_offered: 'yes', online_auctions_offered: 'no' }).tier).toBe(1);
  });
  test('weak/absent website = tier 2', () => {
    expect(crm.tierFor({ estate_sales_offered: 'no', website_status: 'none' }).tier).toBe(2);
    expect(crm.tierFor({ website: null }).tier).toBe(2);
  });
  test('ranking filters exclude converted + recently-contacted (source)', () => {
    const s = fs.readFileSync('src/services/crmRankingService.js', 'utf8');
    expect(s).toMatch(/converted_seller_profile_id IS NULL/);
    expect(s).toMatch(/next_follow_up_at IS NULL OR next_follow_up_at <= now/);
    expect(s).toMatch(/No autonomous outreach/);
  });
});

// ── 11. Targeted lot catalog landing ─────────────────────────────────────────
describe('targeted lot catalog landing', () => {
  const a = fs.readFileSync('public/auction-view.html', 'utf8');
  test('lands on the auction catalog positioned at the advertised lot; neighbors remain; graceful invalid', () => {
    expect(a).toMatch(/focusTargetLot/);
    expect(a).toMatch(/params\.get\('lot'\)/);
    expect(a).toMatch(/adv-highlight/);
    expect(a).toMatch(/scrollIntoView/);
    expect(a).toMatch(/if \(!card\) return;/);   // invalid/withdrawn lot → normal catalog
  });
  test('no tracking parameters are re-emitted into links', () => {
    expect(a).not.toMatch(/utm_source|gclid=|fbclid=|chatgpt|openai/i);
  });
});

// ── 12. Brand metadata (owner copy pref + attribution) ───────────────────────
describe('marketingBrandMetadata', () => {
  test('title-style relationship phrase matches owner preference', () => {
    expect(brand.titleStyle('in conjunction with advantage.bid')).toBe('In Conjunction with Advantage.Bid');
  });
  test('campaign attribution distinguishes advantage/individual/professional/brand', () => {
    ['advantage_general', 'individual_seller_event', 'professional_seller_campaign', 'seller_brand', 'advantage_relationship']
      .forEach((t) => expect(brand.CAMPAIGN_ATTRIBUTION_TYPES).toContain(t));
  });
});

// ── 13. Migration 136 + auto-refresh worker + gates ──────────────────────────
describe('migration 136 + refresh worker + gates', () => {
  const SQL = fs.readFileSync('db/migrations/136_behavioral_fuel_baselines_4h.sql', 'utf8');
  const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  test('additive; baselines table; watcher config; no provider/A7 flip', () => {
    expect(code).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(code).toMatch(/marketing_baselines/);
    expect(code).toMatch(/marketing\.watcher_ending_soon\.enabled'?,?\s*'true'/);
    ['a7_send_enabled', 'google_ads_enabled', 'meta_enabled'].forEach((k) => expect(code).not.toMatch(new RegExp(k + "'\\s*,\\s*'true'")));
  });
  test('auto-refresh worker self-gates on behavioral.enabled + is spawned', () => {
    const wk = fs.readFileSync('src/workers/marketingRefreshWorker.js', 'utf8');
    expect(wk).toMatch(/marketing\.behavioral\.enabled/);
    expect(wk).toMatch(/platformFacts\.refreshAll/);
    expect(fs.readFileSync('server.js', 'utf8')).toMatch(/marketingRefreshWorker\.js/);
  });
  test('no 4H source enables Google, Meta, or A7', () => {
    ['db/migrations/136_behavioral_fuel_baselines_4h.sql', 'src/workers/marketingRefreshWorker.js',
      'src/services/platformFactAudienceService.js', 'src/services/baselineReportService.js', 'src/routes/adminDirector.js'].forEach((f) => {
      const s = fs.readFileSync(f, 'utf8');
      ['a7_send_enabled', 'google_ads_enabled', 'meta_enabled'].forEach((k) => expect(s).not.toMatch(new RegExp(k + "'\\s*,\\s*'true'")));
    });
  });
});

// ── 14. Director daily readiness endpoint ────────────────────────────────────
describe('director daily readiness', () => {
  test('exposes engine-alive + actionable-today aggregate (no raw clickstream)', () => {
    const r = fs.readFileSync('src/routes/adminDirector.js', 'utf8');
    expect(r).toMatch(/\/daily/);
    expect(r).toMatch(/engine_receiving_input/);
    expect(r).toMatch(/registered_non_bidder/);
    const rc = r.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(rc).not.toMatch(/SELECT \* FROM analytics_events/i);
  });
});
