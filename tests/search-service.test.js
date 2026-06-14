// Phase 2 — buyer lot-search clause builder.
const { buildLotSearch, buildBuyerSearch, clampInt } = require('../src/services/searchService');

describe('Phase 3 buildBuyerSearch', () => {
  test('always scopes to role=buyer', () => {
    expect(buildBuyerSearch({}).where).toContain("u.role = 'buyer'");
  });
  test('q matches email (bound param)', () => {
    const r = buildBuyerSearch({ q: 'jane@' });
    expect(r.params).toContain('%jane@%');
    expect(r.where.some(w => /u\.email ILIKE \$\d+/.test(w))).toBe(true);
  });
  test('active filter', () => {
    expect(buildBuyerSearch({ active: 'false' }).where).toContain('u.is_active = false');
    expect(buildBuyerSearch({ active: 'true' }).where).toContain('u.is_active IS NOT FALSE');
  });
});

const whereStr = q => buildLotSearch(q).where.join(' AND ');

describe('Phase 2 buildLotSearch', () => {
  test('base clauses always present (no withdrawn, no archived)', () => {
    const s = whereStr({});
    expect(s).toContain("l.state != 'withdrawn'");
    expect(s).toContain('a.is_archived IS NOT TRUE');
    expect(s).toContain("a.state IN ('published','active')"); // default status
  });

  test('status filters', () => {
    expect(whereStr({ status: 'active' })).toContain("a.state = 'active' AND l.state = 'open'");
    expect(whereStr({ status: 'upcoming' })).toContain("a.state = 'published'");
    expect(whereStr({ status: 'closed' })).toContain("(a.state = 'closed' OR l.state = 'closed')");
  });

  test('free-text q binds one param across title/description/category/maker', () => {
    const r = buildLotSearch({ q: 'Fenton' });
    expect(r.params).toContain('%Fenton%');
    const i = r.params.indexOf('%Fenton%') + 1;
    expect(r.where.join(' ')).toContain(`l.title ILIKE $${i} OR l.description ILIKE $${i} OR l.category ILIKE $${i} OR l.maker_artist ILIKE $${i}`);
  });

  test('category is an exact bound param', () => {
    const r = buildLotSearch({ category: 'Furniture' });
    expect(r.params).toContain('Furniture');
    expect(r.where.some(w => /l\.category = \$\d+/.test(w))).toBe(true);
  });

  test('location: address_state uppercased, city ILIKE', () => {
    const r = buildLotSearch({ address_state: 'tx', city: 'Dallas' });
    expect(r.params).toContain('TX');
    expect(r.params).toContain('%Dallas%');
  });

  test('shippable + ending_soon clauses', () => {
    const s = whereStr({ shippable: 'true', ending_soon: 'true' });
    expect(s).toContain('l.shippable = true');
    expect(s).toContain("l.closes_at <= NOW() + INTERVAL '48 hours'");
  });

  test('sort → orderBy', () => {
    expect(buildLotSearch({ sort: 'ending_soon' }).orderBy).toMatch(/closes_at ASC/);
    expect(buildLotSearch({ sort: 'newest' }).orderBy).toMatch(/created_at DESC/);
    expect(buildLotSearch({ sort: 'most_bids' }).orderBy).toMatch(/bid_count DESC/);
    expect(buildLotSearch({}).orderBy).toMatch(/closes_at ASC/); // default
  });

  test('param placeholders are sequential & match params length', () => {
    const r = buildLotSearch({ q: 'x', category: 'Art', address_state: 'NY', city: 'NYC' });
    // highest $N referenced equals params.length
    const max = Math.max(...r.where.join(' ').match(/\$(\d+)/g).map(m => +m.slice(1)));
    expect(max).toBe(r.params.length);
  });

  test('clampInt', () => {
    expect(clampInt('5', 24, 1, 50)).toBe(5);
    expect(clampInt('999', 24, 1, 50)).toBe(50);
    expect(clampInt('0', 24, 1, 50)).toBe(1);
    expect(clampInt(undefined, 24, 1, 50)).toBe(24);
  });
});
