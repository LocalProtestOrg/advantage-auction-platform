// Seller onboarding defect fixes (Issue 1 routing + Issue 2 frontend error handling).
const fs = require('fs');
const read = f => fs.readFileSync(f, 'utf8');

// A "primary registration CTA" = a link with a button/CTA class OR the visible text
// "Start Selling"/"Create Seller Account"/"List Your Items"; excludes header nav tabs.
function ctaLinesToStartSelling(html) {
  return html.split(/\r?\n/).filter(l =>
    l.includes('/start-selling.html') &&
    !l.includes('nav-link') && !/^\s*<li>/.test(l) && !l.includes('Go to') &&
    (/class="[^"]*(btn|se-btn|se-who-card)/.test(l) || />Start [Ss]elling/.test(l) || /Create Seller Account/.test(l) || /List Your Items/.test(l))
  );
}

describe('Issue 1: Start Selling CTAs route to /become-seller.html', () => {
  const pages = ['public/how-it-works.html', 'public/start-selling.html', 'public/after-estate-sale.html',
    'public/downsizing-liquidation.html', 'public/how-sellers-get-paid.html', 'public/browse-categories.html',
    'public/browse-locations.html', 'public/seller-faq.html', 'public/seller-pilot.html', 'public/shipping-available.html'];

  test('no registration CTA on any seller page loops back to /start-selling.html', () => {
    const offenders = [];
    pages.forEach(p => { const bad = ctaLinesToStartSelling(read(p)); if (bad.length) offenders.push(p + ' -> ' + bad.length); });
    expect(offenders).toEqual([]);
  });

  test('how-it-works "Start Selling" buttons point to /become-seller.html', () => {
    const h = read('public/how-it-works.html');
    // every se-btn-primary Start Selling now targets become-seller
    expect(h).toMatch(/href="\/become-seller\.html"[^>]*class="se-btn se-btn-primary"|class="se-btn se-btn-primary"[^>]*href="\/become-seller\.html"/);
    expect(ctaLinesToStartSelling(h)).toEqual([]);
  });

  test('start-selling.html primary CTAs already target /become-seller.html', () => {
    const h = read('public/start-selling.html');
    expect(h).toContain('href="/become-seller.html"');
    expect(ctaLinesToStartSelling(h)).toEqual([]);
  });
});

describe('Issue 2: become-seller.html frontend error handling', () => {
  const h = read('public/become-seller.html');
  test('a 401 re-authenticates and preserves the /become-seller.html destination', () => {
    expect(h).toContain('res.status === 401');
    expect(h).toContain("'/login.html?next=' + encodeURIComponent('/become-seller.html')");
  });
  test('reads the specific server error (message OR error), not only message', () => {
    expect(h).toContain('json.message || json.error');
    expect(h).not.toContain("json.message || 'Could not enable selling");
  });
  test('routes to the correct seller destination on success', () => {
    expect(h).toContain("location.href = '/seller-dashboard.html'");
    expect(h).toContain('/sign-agreement.html?onboarding=1');
  });
  test('validates the phone number before submitting', () => {
    expect(h).toContain('Please enter a valid phone number');
  });
});
