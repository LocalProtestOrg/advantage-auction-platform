// Buyer terms publication script: source extraction and validation only (no database is touched).
const path = require('path');
const { parseArgs, extractBody, validateSource, loadSource, DEFAULT_SOURCE } = require('../scripts/prod-publish-buyer-terms-version');

const REPO = path.join(__dirname, '..');
const BUYER_V4 = path.join(REPO, 'docs', 'legal', 'buyer-terms-v4-fixed-price.md');
const TOS_V4 = path.join(REPO, 'docs', 'legal', 'terms-of-service-v4.md');

describe('prod-publish-buyer-terms-version: arguments', () => {
  test('default source stays the Terms of Service v4 file; dry run by default', () => {
    const o = parseArgs([]);
    expect(o.source).toBe(DEFAULT_SOURCE);
    expect(path.basename(o.source)).toBe('terms-of-service-v4.md');
    expect(o.apply).toBe(false);
    expect(o.title).toBeNull();
  });
  test('--source, --title and --apply are read', () => {
    const o = parseArgs(['--source', 'docs/legal/buyer-terms-v4-fixed-price.md', '--title', 'X Terms', '--apply']);
    expect(o.source).toBe(BUYER_V4);
    expect(o.title).toBe('X Terms');
    expect(o.apply).toBe(true);
  });
  test('a flag without a value is refused', () => {
    expect(() => parseArgs(['--source'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--source', '--apply'])).toThrow(/needs a value/);
  });
});

describe('prod-publish-buyer-terms-version: body extraction', () => {
  test('body is everything below the first --- line, CRLF normalized', () => {
    const { header, body } = extractBody('Header line\r\nmore\r\n---\r\n\r\n# Title\r\nText\r\n');
    expect(header).toBe('Header line\nmore');
    expect(body).toBe('# Title\nText');
  });
  test('missing separator is refused', () => {
    expect(() => extractBody('# no separator here')).toThrow(/separator/);
  });
});

describe('prod-publish-buyer-terms-version: validation', () => {
  test('Buyer Terms v4 (fixed price) passes, gets its own title and includes_sales_near_you = true', () => {
    const src = loadSource(BUYER_V4);
    expect(src.body.startsWith('# Advantage.Bid Buyer Terms & Conditions of Sale (Version 4)')).toBe(true);
    expect(src.body).not.toMatch(/TO BE COMPLETED/);
    expect(src.body).toMatch(/Part B: Fixed-Price Purchases/);
    const v = validateSource(src);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.title).toBe('Advantage.Bid Buyer Terms & Conditions of Sale');
    expect(v.includesSalesNearYou).toBe(true);
  });
  test('the default Terms of Service source still passes (and also discloses Sales Near You)', () => {
    const v = validateSource(loadSource(TOS_V4));
    expect(v.ok).toBe(true);
    expect(v.title).toBe('Advantage.Bid Terms of Service - General and Buyers');
    expect(v.includesSalesNearYou).toBe(true);
  });
  test('--title overrides the default title', () => {
    expect(validateSource(loadSource(BUYER_V4), { title: 'Custom' }).title).toBe('Custom');
  });
  const pad = 'x'.repeat(12000);
  test('an unknown heading is refused', () => {
    const v = validateSource({ header: '', body: '# Some Other Document\n' + pad });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/must start with/);
  });
  test('en and em dashes are refused for either document', () => {
    for (const h of ['# Advantage.Bid Terms of Service', '# Advantage.Bid Buyer Terms & Conditions of Sale (Version 4)']) {
      expect(validateSource({ header: '', body: h + '\nA — B ' + pad }).ok).toBe(false);
      expect(validateSource({ header: '', body: h + '\nA – B ' + pad }).ok).toBe(false);
    }
  });
  test('a leftover placeholder bracket is refused', () => {
    const v = validateSource({ header: '', body: '# Advantage.Bid Buyer Terms & Conditions of Sale\n' + pad + '\n[TO BE COMPLETED LATER]' });
    expect(v.ok).toBe(false);
  });
  test('a too-short body is refused', () => {
    expect(validateSource({ header: '', body: '# Advantage.Bid Buyer Terms & Conditions of Sale\nshort' }).ok).toBe(false);
  });
  test('header requiring Sales Near You without the clause in the body is refused', () => {
    const v = validateSource({ header: 'It must be published with `includes_sales_near_you = true`.', body: '# Advantage.Bid Buyer Terms & Conditions of Sale\n' + pad });
    expect(v.ok).toBe(false);
    expect(v.includesSalesNearYou).toBe(true);
  });
  test('a body without the clause and no header requirement gets includes_sales_near_you = false', () => {
    const v = validateSource({ header: '', body: '# Advantage.Bid Buyer Terms & Conditions of Sale\n' + pad });
    expect(v.ok).toBe(true);
    expect(v.includesSalesNearYou).toBe(false);
  });
});
