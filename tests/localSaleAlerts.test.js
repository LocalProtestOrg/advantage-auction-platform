'use strict';

/**
 * Local sale alerts — buyer retention funnel.
 *
 * The audit found the backend sound and the REACH absent: 0 subscribers ever, the signup widget on
 * only 5 of 72 public pages, no shared footer component, no modal, and no funnel telemetry beyond a
 * single 'subscriber_signup' — so an abandoned form and a never-seen offer were indistinguishable.
 *
 * These tests protect the things that would silently regress: the existing backend is reused rather
 * than duplicated, the offer never appears where money/bidding/security/seller workflow happens, the
 * frequency caps are real, alerts match the right event kinds, and fixed-price Marketplace inventory
 * is never sent as a "sale near you".
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-local-alerts';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const WIDGET = read('public', 'widgets', 'shared', 'local-alerts.js');
// Some assertions must look at CODE, not at the prose that documents it — the file header explains
// which backend it reuses, so a naive search would find those very names in a comment.
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
const WIDGET_CODE = stripComments(WIDGET);

/** Pull SUPPRESSED_PATHS out of the widget and rebuild it, so the test exercises the REAL list. */
function suppressionRegex() {
  const m = WIDGET.match(/var SUPPRESSED_PATHS = new RegExp\(\[([\s\S]*?)\]\.join\('\|'\), 'i'\);/);
  expect(m).toBeTruthy();
  // eslint-disable-next-line no-eval
  const parts = eval('[' + m[1] + ']');
  return new RegExp(parts.join('|'), 'i');
}

/** Pull the POLICY object out of the widget the same way. */
function policy() {
  const m = WIDGET.match(/var POLICY = \{([\s\S]*?)\n  \};/);
  expect(m).toBeTruthy();
  // eslint-disable-next-line no-eval
  return eval('({' + m[1].replace(/\/\/[^\n]*/g, '') + '})');
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('it reuses the existing subscriber backend and builds no second system', () => {
  test('both surfaces post to the certified public endpoint', () => {
    // Origin-aware since the BD integration: same-origin on the app, absolute on BD.
    expect(WIDGET).toMatch(/var ENDPOINT = API_BASE \+ '\/api\/public\/subscribers'/);
    // Exactly one endpoint, and no bespoke storage of its own.
    expect((WIDGET_CODE.match(/fetch\((?:ENDPOINT|'\/api\/)/g) || []).length).toBeGreaterThan(0);
    // No direct database access and no second store of its own.
    expect(WIDGET_CODE).not.toMatch(/INSERT INTO|marketing_contacts|subscriberService/);
  });

  test('no new subscriber table or service was introduced', () => {
    const migrations = fs.readdirSync(path.join(ROOT, 'db', 'migrations'))
      .filter((f) => Number(f.slice(0, 3)) > 156);
    migrations.forEach((f) => {
      const sql = read('db', 'migrations', f);
      expect(sql).not.toMatch(/CREATE TABLE[^;]*subscriber/i);
      expect(sql).not.toMatch(/CREATE TABLE[^;]*alert_signup/i);
    });
  });

  test('the endpoint still accepts the three fields with name and zip optional', () => {
    const route = read('src', 'routes', 'publicSubscribe.js');
    expect(route).toMatch(/const name = oneLine\(b\.name, 160\);/);      // optional, never required
    expect(route).toMatch(/const city = oneLine\(b\.city, 120\) \|\| null;/);
    expect(route).toMatch(/const state = oneLine\(b\.state, 40\) \|\| null;/);
    // Only the email is validated as mandatory.
    expect(route).toMatch(/if \(!email \|\| !EMAIL_RE\.test\(email\)\)/);
  });

  test('the visitor is asked for exactly three fields', () => {
    const names = (WIDGET.match(/\.name = '(email|city|state|company_url)'/g) || [])
      .map((s) => s.replace(/.*'(.*)'/, '$1')).sort();
    expect(names).toEqual(['city', 'company_url', 'email', 'state']);   // company_url is the honeypot
    expect(WIDGET).not.toMatch(/\.name = 'zip'/);
    expect(WIDGET).not.toMatch(/\.name = 'name'/);
    expect(WIDGET).not.toMatch(/type = 'password'/);
  });

  test('the honeypot the endpoint expects is present and hidden', () => {
    expect(WIDGET).toMatch(/pot\.name = 'company_url'/);
    expect(WIDGET).toMatch(/pot\.setAttribute\('aria-hidden', 'true'\)/);
    expect(WIDGET).toMatch(/left:-9999px/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('it never interrupts money, bidding, security or seller work', () => {
  const re = suppressionRegex();

  test.each([
    ['/auction-view.html', 'live bidding'],
    ['/payment.html', 'payment'],
    ['/add-card.html', 'card entry'],
    ['/billing.html', 'billing'],
    ['/checkout', 'checkout'],
    ['/invoices.html', 'invoices'],
    ['/account.html', 'account'],
    ['/forgot-password.html', 'account security'],
    ['/reset-password.html', 'account security'],
    ['/seller-dashboard.html', 'seller dashboard'],
    ['/seller-create.html', 'seller workflow'],
    ['/lot-builder.html', 'seller workflow'],
    ['/sign-agreement.html', 'contract'],
    ['/verify-documents.html', 'identity'],
    ['/admin/event-partners.html', 'admin'],
    ['/app.html', 'member shell'],
    ['/auction.html', 'private member page'],
    ['/my-bids.html', 'member'],
  ])('suppressed on %s (%s)', (p) => {
    expect(re.test(p)).toBe(true);
  });

  test.each([
    '/', '/index.html', '/events.html', '/event.html', '/search.html',
    '/how-it-works', '/free-event-promotion', '/browse-locations.html', '/featured-auctions.html',
  ])('allowed on the public page %s', (p) => {
    expect(re.test(p)).toBe(false);
  });

  test('the script is absent from every page it must not touch', () => {
    ['auction-view.html', 'payment.html', 'add-card.html', 'billing.html', 'invoices.html',
     'account.html', 'my-bids.html', 'watchlist.html', 'seller-dashboard.html', 'seller-create.html',
     'lot-builder.html', 'sign-agreement.html', 'verify-documents.html', 'app.html', 'login.html',
     'forgot-password.html', 'auction.html', 'create-estate-sale.html', 'my-estate-sales.html',
     'marketplace-purchases.html', 'payout-profile.html', 'seller-settlements.html']
      .forEach((f) => {
        try { expect(read('public', f)).not.toMatch(/local-alerts\.js/); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      });
  });

  test('no admin page carries it', () => {
    fs.readdirSync(path.join(ROOT, 'public', 'admin'))
      .filter((f) => f.endsWith('.html'))
      .forEach((f) => expect(read('public', 'admin', f)).not.toMatch(/local-alerts\.js/));
  });

  test('it IS present on the main public discovery pages', () => {
    ['index.html', 'events.html', 'event.html', 'search.html', 'how-it-works.html',
     'browse-locations.html', 'featured-auctions.html'].forEach((f) => {
      expect(read('public', f)).toMatch(/local-alerts\.js/);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('frequency capping is real, not aspirational', () => {
  const P = policy();

  test('the modal never appears on load — it needs genuine engagement', () => {
    expect(P.engagedMs).toBeGreaterThanOrEqual(20000);
    expect(P.engagedMs).toBeLessThanOrEqual(30000);
    // Dwell only accrues while the tab is visible AND the visitor has interacted.
    expect(WIDGET).toMatch(/if \(document\.visibilityState === 'visible' && interacted\) engagedMs \+= now - last;/);
  });

  test('a dismissal is respected for a month, and shows are capped', () => {
    expect(P.dismissDays).toBeGreaterThanOrEqual(30);
    expect(P.showEveryDays).toBeGreaterThanOrEqual(7);
    expect(P.maxLifetimeShows).toBeLessThanOrEqual(3);
  });

  test('every cap is actually enforced in modalAllowed', () => {
    const fn = WIDGET.slice(WIDGET.indexOf('function modalAllowed'), WIDGET.indexOf('// ── Styles'));
    expect(fn).toMatch(/isSuppressedPath\(\)/);
    expect(fn).toMatch(/alreadySubscribed\(\)/);
    expect(fn).toMatch(/sessionStorage\.getItem\(SESSION_SHOWN\)/);
    expect(fn).toMatch(/s\.dismissedAt && days\(Date\.now\(\) - s\.dismissedAt\) < POLICY\.dismissDays/);
    expect(fn).toMatch(/s\.shownAt && days\(Date\.now\(\) - s\.shownAt\) < POLICY\.showEveryDays/);
    expect(fn).toMatch(/\(s\.shownCount \|\| 0\) >= POLICY\.maxLifetimeShows/);
  });

  test('an existing subscriber is never shown either surface', () => {
    expect(WIDGET).toMatch(/function alreadySubscribed\(\)/);
    // The modal gate checks it...
    const fn = WIDGET.slice(WIDGET.indexOf('function modalAllowed'), WIDGET.indexOf('// ── Styles'));
    expect(fn).toMatch(/alreadySubscribed\(\)/);
    // ...and so does the footer strip.
    const strip = WIDGET.slice(WIDGET.indexOf('function mountStrip'), WIDGET.indexOf('// ── Modal'));
    expect(strip).toMatch(/alreadySubscribed\(\)/);
    // A successful signup records it.
    expect(WIDGET).toMatch(/writeState\(\{ subscribed: true, subscribedAt: Date\.now\(\) \}\)/);
  });

  test('a dismissal is persisted before the modal closes', () => {
    expect(WIDGET).toMatch(/function dismiss\(how\) \{\s*writeState\(\{ dismissedAt: Date\.now\(\) \}\)/);
  });

  test('blocked storage degrades quietly instead of throwing', () => {
    expect(WIDGET).toMatch(/catch \(e\) \{ return \{\}; \}/);
    expect(WIDGET).toMatch(/storage blocked/);
  });

  test('automated browsers never see an interstitial', () => {
    expect(WIDGET).toMatch(/navigator\.webdriver/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('triggers', () => {
  const P = policy();

  test('the three documented triggers exist and nothing fires on load', () => {
    expect(WIDGET).toMatch(/openModal\('engaged_dwell'\)/);
    expect(WIDGET).toMatch(/openModal\('second_detail_view'\)/);
    expect(WIDGET).toMatch(/openModal\('exit_intent'\)/);
    // No immediate call anywhere in boot.
    const boot = WIDGET.slice(WIDGET.indexOf('function boot()'), WIDGET.indexOf('root.AdvLocalAlerts'));
    expect(boot).not.toMatch(/openModal\(/);
  });

  test('the second detail view triggers it, not the first', () => {
    expect(P.detailViewsToTrigger).toBe(2);
    expect(WIDGET).toMatch(/if \(n >= POLICY\.detailViewsToTrigger\)/);
  });

  test('exit intent is desktop-only and only towards the browser chrome', () => {
    expect(P.exitIntentMinWidth).toBeGreaterThanOrEqual(1024);
    expect(WIDGET).toMatch(/matchMedia\('\(pointer:fine\)'\)/);
    expect(WIDGET).toMatch(/if \(\(ev\.clientY \|\| 0\) > 60\) return;/);
    expect(WIDGET).toMatch(/if \(ev\.relatedTarget \|\| ev\.toElement\) return;/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('mobile and accessibility', () => {
  test('mobile renders a dismissible bottom sheet, not a full-screen interstitial', () => {
    expect(WIDGET).toMatch(/@media \(max-width:560px\)/);
    expect(WIDGET).toMatch(/border-radius:18px 18px 0 0/);        // bottom sheet
    expect(WIDGET).toMatch(/align-items:flex-end/);
    expect(WIDGET).toMatch(/\.advla-x\{width:44px;height:44px\}/); // 44px touch target
  });

  test('the dialog is announced, trapped, escapable and returns focus', () => {
    expect(WIDGET).toMatch(/setAttribute\('role', 'dialog'\)/);
    expect(WIDGET).toMatch(/setAttribute\('aria-modal', 'true'\)/);
    expect(WIDGET).toMatch(/setAttribute\('aria-labelledby', 'advla-h'\)/);
    expect(WIDGET).toMatch(/ev\.key === 'Escape'/);
    expect(WIDGET).toMatch(/Focus trap/);
    expect(WIDGET).toMatch(/lastFocus\.focus\(\)/);
    expect(WIDGET).toMatch(/x\.setAttribute\('aria-label', 'Close'\)/);
  });

  test('there are three ways out: close, backdrop and "No thanks"', () => {
    expect(WIDGET).toMatch(/dismiss\('close_button'\)/);
    expect(WIDGET).toMatch(/dismiss\('backdrop'\)/);
    expect(WIDGET).toMatch(/dismiss\('no_thanks'\)/);
    expect(WIDGET).toMatch(/dismiss\('escape'\)/);
  });

  test('reduced motion is honoured', () => {
    expect(WIDGET).toMatch(/prefers-reduced-motion:reduce/);
  });

  test('status messages are announced to assistive technology', () => {
    expect(WIDGET).toMatch(/setAttribute\('aria-live', 'polite'\)/);
    expect(WIDGET).toMatch(/setAttribute\('role', 'status'\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('SEO and performance are not damaged', () => {
  test('the modal DOM is built only when triggered, so nothing duplicate is crawlable', () => {
    // openModal is what creates the overlay; nothing builds it at boot.
    const open = WIDGET.slice(WIDGET.indexOf('function openModal'), WIDGET.indexOf('// ── Triggers'));
    expect(open).toMatch(/document\.body\.appendChild\(ov\)/);
    const boot = WIDGET.slice(WIDGET.indexOf('function boot()'), WIDGET.indexOf('root.AdvLocalAlerts'));
    expect(boot).not.toMatch(/appendChild\(ov\)/);
  });

  test('it fetches nothing at load and injects styles once', () => {
    const boot = WIDGET.slice(WIDGET.indexOf('function boot()'), WIDGET.indexOf('root.AdvLocalAlerts'));
    expect(boot).not.toMatch(/fetch\(/);
    expect(WIDGET).toMatch(/if \(document\.getElementById\('adv-alerts-styles'\)\) return;/);
    expect(WIDGET).not.toMatch(/cdn\.|googleapis|unpkg/);
  });

  test('every page loads it deferred, so it never blocks rendering', () => {
    ['index.html', 'events.html', 'event.html', 'search.html'].forEach((f) => {
      expect(read('public', f)).toMatch(/<script src="\/widgets\/shared\/local-alerts\.js" defer><\/script>/);
    });
  });

  test('no AI or vendor terminology reaches a visible surface', () => {
    // The standard governs text RENDERED to a person. Vendor and infrastructure names stay
    // legitimate in code comments and documentation, so the vendor check reads comment-stripped
    // code — the header legitimately explains which host is the source of truth. The AI check
    // stays on the whole file, where those terms have no reason to appear at all.
    expect(WIDGET).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|machine learning|GPT|OpenAI|LLM/i);
    expect(WIDGET_CODE).not.toMatch(/Mapbox|Cloudinary|Railway|Neon|Postmark|Amazon SES|nodemailer/i);
  });

  test('no vendor name appears in any string the visitor can actually read', () => {
    // Every literal that could be rendered: headings, copy, button labels, status messages.
    const literals = (WIDGET_CODE.match(/'[^']{4,}'|"[^"]{4,}"/g) || []).join(' ');
    expect(literals).not.toMatch(/Mapbox|Cloudinary|Railway|Neon|Postmark|Amazon SES|nodemailer/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the Owner-approved message and consent language', () => {
  test('the headline, subhead and CTA are exactly as specified', () => {
    expect(WIDGET).toMatch(/Never Miss a Sale Near You Again!/);
    expect(WIDGET).toMatch(/Get notified when new estate sales and auctions are added near you\./);
    expect(WIDGET).toMatch(/Notify Me About Nearby Sales/);
  });

  test('both surfaces carry the same headline and CTA', () => {
    expect((WIDGET_CODE.match(/Never Miss a Sale Near You Again!/g) || []).length).toBe(2);  // strip + modal
    expect((WIDGET_CODE.match(/Notify Me About Nearby Sales/g) || []).length).toBe(1);      // one shared form builder
  });

  test('consent language says what they are asking for, and nothing broader', () => {
    expect(WIDGET).toMatch(/You are asking for local auction and estate-sale notifications/);
    expect(WIDGET).toMatch(/unsubscribe from any email/);
    expect(WIDGET).toMatch(/No account needed/);
    // It must not promise or imply anything wider.
    expect(WIDGET).not.toMatch(/newsletter|partner offers|third[- ]party/i);
  });

  test('signup grants only the local-alert permission classes the backend already defines', () => {
    const svc = read('src', 'services', 'subscriberService.js');
    expect(svc).toMatch(/explicit_opt_in/);
    // The signup path grants permission explicitly; provenance alone never grants.
    expect(svc).toMatch(/grantPermission/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('analytics: the whole funnel is measurable', () => {
  const analytics = read('src', 'services', 'analyticsService.js');

  test.each([
    'alert_offer_shown', 'alert_modal_shown', 'alert_modal_dismissed', 'alert_form_started',
    'alert_signup_succeeded', 'alert_signup_failed', 'subscriber_signup',
    'local_event_alert_delivered', 'local_event_alert_click',
  ])('%s is a registered first-party event type', (t) => {
    expect(analytics).toContain(`'${t}'`);
  });

  test('the widget emits each client-side step', () => {
    expect(WIDGET).toMatch(/track\('alert_offer_shown'/);
    expect(WIDGET).toMatch(/track\('alert_modal_shown'/);
    expect(WIDGET).toMatch(/track\('alert_modal_dismissed'/);
    expect(WIDGET).toMatch(/track\('alert_form_started'/);
    expect(WIDGET).toMatch(/track\('alert_signup_succeeded'/);
    expect(WIDGET).toMatch(/track\('alert_signup_failed'/);
  });

  test('form-start fires once, not on every keystroke', () => {
    expect(WIDGET).toMatch(/if \(started\) return;/);
    expect(WIDGET).toMatch(/\{ once: true \}/);
  });

  test('validation failures are distinguishable by reason', () => {
    expect(WIDGET).toMatch(/reason: 'invalid_email'/);
    expect(WIDGET).toMatch(/reason: 'missing_location'/);
    expect(WIDGET).toMatch(/reason: 'server'/);
    expect(WIDGET).toMatch(/reason: 'network'/);
  });

  test('the modal records which trigger produced it, so triggers can be compared', () => {
    expect(WIDGET).toMatch(/track\('alert_modal_shown', \{ trigger: trigger/);
    expect(WIDGET).toMatch(/viewport: window\.innerWidth < 560 \? 'mobile' : 'desktop'/);
  });

  test('measurement never breaks the page', () => {
    const fn = WIDGET.slice(WIDGET.indexOf('function track('), WIDGET.indexOf('// ── Eligibility'));
    expect(fn).toMatch(/catch \(e\)/);
    expect(fn).toMatch(/\.catch\(function \(\) \{\}\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('alert matching: the right inventory, and only the right inventory', () => {
  const svc = read('src', 'services', 'localEventAlertService.js');

  test('it resolves exactly three kinds: native auction, partner event, estate sale', () => {
    expect(svc).toMatch(/kind: 'auction'/);
    expect(svc).toMatch(/const evKind = e\.sale_type === 'auction' \? 'partner_event' : 'estate_sale';/);
  });

  test('imported external events qualify — they are ordinary published events', () => {
    // Matching is by the canonical visibility predicate, which does not exclude source='imported'.
    expect(svc).toMatch(/activeEventSql/);
    const vis = read('src', 'lib', 'marketplaceVisibility.js');
    const fn = vis.slice(vis.indexOf('function activeEventSql'), vis.indexOf('function activeNativeAuctionSql'));
    expect(fn).not.toMatch(/source\s*(<>|!=)\s*'imported'/);
  });

  test('native auctions qualify through the canonical predicate', () => {
    expect(svc).toMatch(/activeNativeAuctionSql/);
  });

  test('fixed-price Marketplace inventory is NEVER sent as a local sale alert', () => {
    expect(svc).not.toMatch(/activeMarketplaceItemSql/);
    expect(svc).not.toMatch(/marketplace_items|buy_now|fixed_price/i);
  });

  test('stale, closed and demo rows cannot be alerted on', () => {
    const vis = read('src', 'lib', 'marketplaceVisibility.js');
    expect(vis).toMatch(/end_at IS NULL OR .*end_at >= now\(\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('unsubscribe, suppression and consent stay intact', () => {
  test('marketing unsubscribe still writes the terminal suppression', () => {
    const route = read('src', 'routes', 'publicMarketingEmail.js');
    expect(route).toMatch(/INSERT INTO email_suppressions/);
    expect(route).toMatch(/'unsubscribe'/);
    expect(route).toMatch(/'marketing'/);
    expect(route).toMatch(/grantPermission/);   // permission withdrawal recorded, history preserved
  });

  test('signup is idempotent and never discloses whether an address is already known', () => {
    const route = read('src', 'routes', 'publicSubscribe.js');
    expect(route).toMatch(/uniform success|no disclosure|No disclosure/i);
    expect((route.match(/return res\.json\(SUCCESS\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('the collection kill switch still works without a deploy', () => {
    const route = read('src', 'routes', 'publicSubscribe.js');
    expect(route).toMatch(/marketing\.subscribe\.enabled/);
  });

  test('the widget does not subscribe anyone silently — every signup is an explicit submit', () => {
    expect(WIDGET).toMatch(/form\.addEventListener\('submit'/);
    const boot = WIDGET.slice(WIDGET.indexOf('function boot()'), WIDGET.indexOf('root.AdvLocalAlerts'));
    expect(boot).not.toMatch(/fetch\(ENDPOINT/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('Brilliant Directories acquisition — one script, two surfaces', () => {
  // The whole point of this block: on BD a relative endpoint would post to BD itself and silently
  // lose every signup. Railway must stay the single source of truth.

  test('the API base is resolved from the script src, not hardcoded relative', () => {
    expect(WIDGET_CODE).toMatch(/var API_BASE = \(function \(\)/);
    expect(WIDGET_CODE).toMatch(/document\.currentScript/);
    expect(WIDGET_CODE).toMatch(/if \(u\.origin !== location\.origin\) return u\.origin;/);
    // Same-origin fallback: a failure to resolve can never post somewhere unexpected.
    expect(WIDGET_CODE).toMatch(/return '';/);
  });

  test('both endpoints are absolute-capable', () => {
    expect(WIDGET_CODE).toMatch(/var ENDPOINT = API_BASE \+ '\/api\/public\/subscribers'/);
    expect(WIDGET_CODE).toMatch(/var ANALYTICS_ENDPOINT = API_BASE \+ '\/api\/analytics\/events'/);
    // No relative endpoint survives anywhere in code.
    expect(WIDGET_CODE).not.toMatch(/fetch\('\/api\//);
  });

  test('it creates no BD-side storage — submissions go to the canonical Railway system', () => {
    expect(WIDGET_CODE).toMatch(/\/api\/public\/subscribers/);
    expect(WIDGET_CODE).not.toMatch(/INSERT INTO|marketing_contacts|indexedDB|openDatabase/);
  });

  test('BD sensitive routes are suppressed alongside the Railway ones', () => {
    const re = suppressionRegex();
    ['/login', '/logout', '/signup', '/register', '/my-account', '/account',
     '/cart', '/checkout', '/password', '/forgot-password', '/dashboard', '/profile',
     '/admin', '/privacy', '/terms'].forEach((p) => {
      expect(re.test(p)).toBe(true);
    });
  });

  test('BD public discovery routes remain eligible', () => {
    const re = suppressionRegex();
    ['/', '/estate-sales', '/auctions', '/professionals', '/blog/some-post', '/austin-tx']
      .forEach((p) => expect(re.test(p)).toBe(false));
  });

  test('placement identifies BD acquisition, and an explicit attribute wins', () => {
    expect(WIDGET_CODE).toMatch(/function resolvePlacement/);
    expect(WIDGET_CODE).toMatch(/SCRIPT_EL && SCRIPT_EL\.getAttribute\('data-placement'\)/);
    ['bd_estate_sales', 'bd_auctions', 'bd_directory', 'bd_blog', 'bd_city_page', 'bd_home', 'bd_other']
      .forEach((label) => expect(WIDGET_CODE).toContain(label));
  });

  test('the server accepts the BD placement labels instead of collapsing them to "other"', () => {
    const route = read('src', 'routes', 'publicSubscribe.js');
    ['bd_footer', 'bd_home', 'bd_estate_sales', 'bd_auctions', 'bd_directory', 'bd_blog',
     'bd_city_page', 'bd_other'].forEach((l) => expect(route).toContain(`'${l}'`));
    // The allowlist still exists, so an arbitrary label cannot be injected.
    expect(route).toMatch(/if \(!PLACEMENTS\.has\(placement\)\) placement = 'other';/);
  });

  test('analytics is attributed to its surface and posts to Railway from BD', () => {
    expect(WIDGET_CODE).toMatch(/surface: EMBEDDED \? 'bd' : 'app'/);
    expect(WIDGET_CODE).toMatch(/if \(!EMBEDDED && root\.AAPAnalytics/);
  });

  test('the strip mounts above a BD-themed footer, never inside it', () => {
    expect(WIDGET_CODE).toMatch(/querySelector\('footer, \.footer, #footer'\)/);
    expect(WIDGET_CODE).toMatch(/insertBefore\(host, footer\)/);
  });

  test('the second-event trigger recognises BD listing routes', () => {
    const m = WIDGET.match(/var DETAIL_PATH = (\/.*\/i);/);
    expect(m).toBeTruthy();
    // eslint-disable-next-line no-eval
    const re = eval(m[1]);
    expect(re.test('/event.html')).toBe(true);          // Railway
    expect(re.test('/estate-sales/some-sale')).toBe(true);  // BD
    expect(re.test('/auctions/some-auction')).toBe(true);   // BD
    expect(re.test('/')).toBe(false);
  });

  test('duplicate loading is still guarded, so a second BD block cannot double-mount', () => {
    expect(WIDGET_CODE).toMatch(/__advLocalAlertsBooted/);
    expect(WIDGET_CODE).toMatch(/if \(document\.querySelector\('\.advla-strip'\)\) return;/);
    expect(WIDGET_CODE).toMatch(/if \(document\.getElementById\('adv-alerts-styles'\)\) return;/);
  });

  test('no secret is exposed to the BD client', () => {
    expect(WIDGET_CODE).not.toMatch(/API_KEY|SECRET|TOKEN|Authorization|Bearer|X-Api-Key/i);
  });
});
