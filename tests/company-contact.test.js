'use strict';

/**
 * Official Advantage.Bid business phone — one authoritative source, correct formats, click-to-call,
 * consistent server/client, valid structured data, and no obsolete corporate number left on public pages.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const company = require('../src/lib/companyContact');
const client = require('../public/widgets/shared/company-contact.js');

describe('central config (server)', () => {
  test('display, E.164, tel href, schema formats', () => {
    expect(company.PHONE_DISPLAY).toBe('(551) 655-7050');
    expect(company.PHONE_E164).toBe('+15516557050');
    expect(company.TEL_HREF).toBe('tel:+15516557050');
    expect(company.PHONE_SCHEMA).toBe('+1-551-655-7050');
    expect(company.SUPPORT_EMAIL).toBe('info@advantage.bid');
  });
  test('email contact block carries phone + email + website', () => {
    const lines = company.emailContactLines();
    expect(lines).toContain('(551) 655-7050');
    expect(lines).toContain('info@advantage.bid');
    expect(lines).toContain('https://bid.advantage.bid');
  });
});

describe('server + client agree (single source of truth)', () => {
  test('client widget uses the same number + tel href', () => {
    expect(client.PHONE_DISPLAY).toBe(company.PHONE_DISPLAY);
    expect(client.TEL_HREF).toBe(company.TEL_HREF);
    expect(client.SUPPORT_EMAIL).toBe(company.SUPPORT_EMAIL);
  });
  test('telLinkHTML is a mobile click-to-call link showing the display number', () => {
    const html = client.telLinkHTML('x');
    expect(html).toContain('href="tel:+15516557050"');
    expect(html).toContain('(551) 655-7050');
    expect(html).toContain('aria-label'); // accessible label
  });
});

describe('structured data (SEO)', () => {
  test('homepage Organization JSON-LD is valid and carries the telephone', () => {
    const html = read('public/index.html');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    const data = JSON.parse(m[1]); // throws if invalid JSON-LD
    const org = data['@graph'].find((n) => n['@type'] === 'Organization');
    expect(org.telephone).toBe('+1-551-655-7050');
    expect(org.contactPoint.telephone).toBe('+1-551-655-7050');
  });
});

describe('consistency / no obsolete corporate number', () => {
  test('the old placeholder corporate number is gone from public legal/marketing pages', () => {
    for (const p of ['public/privacy.html', 'public/index.html', 'public/terms.html']) {
      expect(read(p)).not.toContain('346) 889-3944');
      expect(read(p)).not.toContain('833) 223-2443');
    }
  });
  test('privacy policy now shows the official number', () => {
    expect(read('public/privacy.html')).toContain('(551) 655-7050');
  });
  test('seller-acquisition + help pages render the click-to-call placeholder + include the widget', () => {
    for (const p of ['public/become-seller.html', 'public/start-selling.html', 'public/faq.html', 'public/how-it-works.html']) {
      const s = read(p);
      expect(s).toContain('data-adv-tel');
      expect(s).toContain('company-contact.js');
    }
  });
  test('seller storefront contact is NOT overwritten with the corporate number', () => {
    // The seller storefront presentation reads the SELLER's own contact — the corporate helper is not wired
    // into it, so a seller phone can never be replaced by the company number.
    expect(read('public/storefront.html')).not.toContain('551) 655-7050');
    expect(read('public/storefront.html')).not.toContain('company-contact.js');
  });
});
