'use strict';

/**
 * The unified Advantage.Bid header, the approved item page layout and the approved storefront layout (owner 2026-11-20).
 * Source-level checks (the codebase's pattern for page markup and wiring); the pages are also driven in a real browser in
 * tests/browser.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const nav = read('public', 'widgets', 'shared', 'public-nav.js');

describe('one header for the public platform', () => {
  test('the approved navigation, in order, each to an existing destination', () => {
    const labels = [...nav.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    expect(labels.slice(0, 5)).toEqual(['Auctions Near You', 'Estate Sales Near You', 'Buy Now Marketplace', 'Find Professionals', 'Start Selling']);
    expect(nav).toContain("href: '/?show=auctions'");
    expect(nav).toContain("href: '/?show=estate-sales'");
    expect(nav).toContain("href: '/shop'");
    expect(nav).toContain("href: '/?show=professionals'");
    expect(nav).toContain("href: '/start-selling.html'");
    // the logo goes home; search uses the existing search page
    expect(nav).toMatch(/<a href="\/" class="brand abn-brand" aria-label="Advantage\.Bid home">/);
    expect(nav).toMatch(/<form class="abn-search" role="search" action="\/search\.html" method="get">/);
    expect(fs.existsSync(path.join(ROOT, 'public', 'img', 'brand', 'advantage-bid-logo.png'))).toBe(true);
  });
  test('account access: sign in when signed out; the member pages and Log Out when signed in; the dashboard by role', () => {
    for (const href of ['/app.html', '/marketplace-purchases.html', '/my-bids.html', '/watchlist.html', '/seller-dashboard.html', '/how-it-works.html', '/faq.html']) {
      expect(nav).toContain("href: '" + href + "'");
      expect(fs.existsSync(path.join(ROOT, 'public', href.slice(1)))).toBe(true);
    }
    expect(nav).toMatch(/me\.role === 'seller' \|\| me\.role === 'admin'\) acct\.push\(\{ href: '\/seller-dashboard\.html'/);
    expect(nav).toMatch(/href="\/logout">Log Out</);
    expect(nav).toContain("'/login.html?next=' + next");
    expect(nav).toContain("'/login.html?tab=register&next=' + next");
  });
  test('only features that exist are offered (no shopping cart), and no banned wording', () => {
    expect(nav).not.toMatch(/cart/i);
    expect(nav).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|utm_|[–—]/);
  });
  test.each([
    ['public/item.html'], ['public/storefront.html'], ['public/events.html'], ['public/event.html'], ['public/search.html'],
    ['public/browse-categories.html'], ['public/browse-locations.html'], ['public/ending-soon.html'], ['public/featured-auctions.html'],
    ['public/past-auctions.html'], ['public/start-selling.html'], ['src/services/shopPageService.js'], ['src/services/policyPageService.js'],
  ])('%s carries the shared header (and no second one)', (f) => {
    const s = read(...f.split('/'));
    expect(s).toMatch(/data-adv-public-nav/);
    expect(s).toContain('/widgets/shared/public-nav.js');
    expect(s).not.toContain('/widgets/shared/buyer-nav.js');
  });
  test('the header is never loaded inside a seller website widget: embedded storefronts stay seller-branded', () => {
    const dir = path.join(ROOT, 'public', 'embed');
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/public-nav|data-adv-public-nav/);
    const widgets = path.join(ROOT, 'public', 'widgets');
    for (const f of fs.readdirSync(widgets).filter((x) => /\.js$/.test(x))) expect(fs.readFileSync(path.join(widgets, f), 'utf8')).not.toMatch(/public-nav\.js/);
    expect(read('src', 'routes', 'embedStorefrontPage.js')).not.toMatch(/public-nav/);
  });
  test('a buyer who arrives from a seller website sees the logo and account only, not the marketplace navigation', () => {
    expect(read('public', 'item.html')).toMatch(/get\('ref'\)==='widget'\)window\.ADV_PUBLIC_NAV_VARIANT='minimal'/);
    expect(nav).toMatch(/var minimal = variant === 'minimal';/);
    expect(nav).toMatch(/\(minimal \? '' :\s*'<div class="abn-bar">/);
  });
  test('the map opens on one kind of listing from a navigation link, using the same switches a visitor can change', () => {
    const index = read('public', 'index.html');
    expect(index).toContain("auctions:['live','ending','coming','event_auction'], 'estate-sales':['event_estate_sale']");
    expect(index).toContain("professionals:['estate_sale_companies','auction_houses','appraisers']");
    expect(index).toMatch(/if\(!any\) return;/);                       // nothing of that kind listed: never an empty map
    expect(index).toMatch(/MP_PRESET_TOUCHED=true/);                    // the visitor's own choice wins afterwards
    for (const l of ['<a href="/?show=auctions">', '<a href="/?show=estate-sales">', '<a href="/?show=professionals">', '<a href="/shop">']) expect(index).toContain(l);
  });
});

describe('the approved item page', () => {
  const item = read('public', 'item.html');
  const ssr = read('src', 'services', 'productPageService.js');
  test('sections: gallery, title and seller, status, details, About the Seller, and the historical note', () => {
    for (const s of [item, ssr]) {
      expect(s).toContain('Item Description');
      expect(s).toContain('Item Details');
      expect(s).toContain('id="aboutSeller"');
      expect(s).toContain('Visit Seller Storefront');
      expect(s).toContain('Why am I seeing this item?');
    }
    expect(item).toContain('id="sellerContactBtn"');
    expect(item).toMatch(/sc\.addEventListener\('click',\(CFG\.messaging_enabled\|\|it\.questions_enabled\)\?openAsk:openContact\)/);   // the existing secure workflows
    expect(item).toContain('/widgets/shared/local-alerts.js');          // the sale-alert signup stays
  });
  test('a sold or unavailable item never gets a checkout control or a price', () => {
    const sold = item.slice(item.indexOf("if(status==='sold'){"), item.indexOf("} else if(status==='pending_purchase')"));
    expect(sold).toContain('This item has been sold.');
    expect(sold).toContain('This item is no longer available for purchase.');
    expect(sold).not.toMatch(/buyNow|Buy Now|money\(/);
    expect(item).toMatch(/status==='sold'\?'<span class="pill pill-sold">SOLD<\/span>':\(status==='unavailable'\?'<span class="pill pill-sold">No longer available<\/span>':money\(it\.price_cents\)\)/);
    expect(item).not.toMatch(/realized_price_cents/);
  });
  test('the seller logo is shown only for a seller whose branding is visible', () => {
    const { publicItem } = require('../src/services/marketplaceItemService');
    const row = { id: 'i', title: 'T', status: 'active', price_cents: 100, seller_name: 'Shop', storefront_slug: 'shop', storefront_published: true,
      seller_logo_url: 'https://cdn.example/logo.png' };
    expect(publicItem({ ...row, seller_type: 'retail_gallery_studio', show_branding_to_buyers: true }).seller_logo_url).toBe('https://cdn.example/logo.png');
    expect(publicItem({ ...row, seller_type: 'private', show_branding_to_buyers: false }).seller_logo_url).toBe(null);
    expect(publicItem({ ...row, seller_type: 'retail_gallery_studio', show_branding_to_buyers: true, seller_logo_url: 'javascript:alert(1)' }).seller_logo_url).toBe(null);
  });
});

describe('the approved storefront page', () => {
  const sf = read('public', 'storefront.html');
  test('the seller keeps its own banner, logo, name, description, contact details and policies', () => {
    expect(sf).toMatch(/cfg\.hero_image\?'<img src="'\+esc\(cfg\.hero_image\)/);
    expect(sf).toMatch(/s\.logo_url\?\('<div class="sf-logo hero-logo"/);
    for (const t of ["'<a href=\"#shop\">Shop</a>'", "'<a href=\"#about\">About</a>'", "'<a href=\"#services\">Services</a>'", "'<a href=\"#policies\">Policies</a>'", "'<a href=\"#sold\">Previously Sold</a>'"]) expect(sf).toContain(t);
    expect(sf).toContain("'+base+'/terms\">Store Terms &amp; Conditions");
    expect(sf).toContain("'+base+'/shipping-pickup\">Shipping &amp; Pickup Policy");
    expect(sf).toContain('id="followBtn"');
    expect(sf).toContain('id="inqForm"');
  });
  test('only real inventory is rendered: categories come from the items, and an empty shop says so', () => {
    expect(sf).toMatch(/items\.forEach\(function\(m\)\{var c=\(m\.category\|\|''\)\.trim\(\); if\(!c\)return;/);
    expect(sf).toMatch(/if\(order\.length>1\)\{/);
    expect(sf).toContain('No items for sale right now');
    expect(sf).not.toMatch(/Ginger Jar|Opera Glasses|\$48\.00|\$125\.00/);   // nothing from the illustrative reference image
  });
  test('Previously Sold shows a photo and a title only: the query selects no price, date, buyer or order', () => {
    const svc = read('src', 'services', 'marketplaceItemService.js');
    const fn = svc.slice(svc.indexOf('async function listSoldForSeller'), svc.indexOf('// Public active listings for a seller (storefront + feed).'));
    expect(fn).toMatch(/SELECT mi\.id, mi\.title, mi\.thumbnail_url, mi\.images, mi\.category\s+FROM marketplace_items mi/);
    expect(fn).toMatch(/mi\.status = 'sold' AND mi\.moderation_status = 'none'/);
    expect(fn.slice(fn.indexOf('SELECT'), fn.indexOf('FROM marketplace_items'))).not.toMatch(/price|sold_at|updated_at|buyer|order/i);
    expect(fn).toMatch(/return rows\.map\(\(r\) => \(\{ id: r\.id, title: r\.title, thumbnail_url: [^}]*, category: r\.category \|\| null \}\)\);/);
    const block = sf.slice(sf.indexOf('// Previously Sold:'), sf.indexOf('// Gallery'));
    expect(block).not.toMatch(/money\(|price_cents/);
    expect(read('src', 'services', 'storefrontService.js')).toMatch(/section_visibility\.past === false\) \? \[\] : await marketplaceItems\.listSoldForSeller/);
  });
});
