'use strict';

/**
 * Storefront milestone 1 — inventory and checkout safety:
 *   - an item a buyer has reserved (checkout hold / live order) cannot be changed by the seller (409 ITEM_RESERVED);
 *   - a sold item keeps its details and can never be offered again (only removed from view);
 *   - edits run under the same row lock checkout uses;
 *   - a duplicate live order is a clean 409 NOT_AVAILABLE, never a server error;
 *   - storefronts and items are public only for Professional Sellers (and a published storefront).
 */
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');
const items = require('../src/services/marketplaceItemService');
const storefront = require('../src/services/storefrontService');
beforeEach(() => jest.clearAllMocks());

const SELLER = { id: 'sp-1', user_id: 'u-1', seller_type: 'auction_house', is_demo: false,
  // confirmed default storefront pickup location (a live item needs one; existing rule)
  default_pickup_address_line1: '1 Main St', default_pickup_city: 'Houston', default_pickup_state: 'TX', default_pickup_postal_code: '77001',
  default_pickup_country: 'US', default_pickup_confirmed_at: new Date().toISOString() };
function setup(item, { live = 0, paid = 0 } = {}) {
  db.query.mockImplementation(async (sql) => (/FROM seller_profiles WHERE user_id/.test(sql) ? { rows: [SELLER] } : { rows: [] }));
  const calls = [];
  const client = { release: jest.fn(), query: jest.fn(async (sql, p) => {
    calls.push(String(sql));
    if (/FROM marketplace_items WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ id: 'i-1', seller_id: 'sp-1', price_cents: 5000, city: 'Houston', state: 'TX', pickup_location_source: 'default', ...item }] };
    if (/FROM marketplace_orders WHERE marketplace_item_id/.test(sql)) return { rows: [{ live, paid }] };
    if (/^UPDATE marketplace_items/.test(String(sql).trim())) return { rows: [{ id: 'i-1', ...item, updated: true, params: p }] };
    return { rows: [] };
  }) };
  db.connect.mockResolvedValue(client);
  return calls;
}
const wrote = (calls) => calls.some((s) => /^UPDATE marketplace_items/.test(s.trim()));

describe('reserved items', () => {
  test('an item on a checkout hold cannot have its price, title or status changed', async () => {
    for (const patch of [{ price_cents: 1 }, { title: 'x' }, { status: 'active' }, { status: 'removed' }, { shippable: true }]) {
      const calls = setup({ status: 'pending_purchase' });
      await expect(items.updateItem('i-1', 'u-1', patch)).rejects.toMatchObject({ status: 409, code: 'ITEM_RESERVED' });
      expect(wrote(calls)).toBe(false); expect(calls).toContain('ROLLBACK');
    }
  });
  test('a live order also blocks edits even if the item row says active (stale hold)', async () => {
    const calls = setup({ status: 'active' }, { live: 1 });
    await expect(items.updateItem('i-1', 'u-1', { price_cents: 100 })).rejects.toMatchObject({ code: 'ITEM_RESERVED' });
    expect(wrote(calls)).toBe(false);
  });
  test('the edit takes the same row lock checkout uses, before any check', async () => {
    const calls = setup({ status: 'active' });
    await items.updateItem('i-1', 'u-1', { description: 'Updated' });
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toMatch(/FOR UPDATE/);
    expect(wrote(calls)).toBe(true);
  });
  test('a seller can never set pending_purchase', async () => {
    setup({ status: 'active' });
    await expect(items.updateItem('i-1', 'u-1', { status: 'pending_purchase' })).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });
});

describe('sold items', () => {
  test('a sold item cannot be put back on sale or edited; it may be removed from view', async () => {
    for (const patch of [{ status: 'active' }, { status: 'draft' }, { price_cents: 100 }, { title: 'new' }]) {
      const calls = setup({ status: 'sold' }, { paid: 1 });
      await expect(items.updateItem('i-1', 'u-1', patch)).rejects.toMatchObject({ code: 'ITEM_SOLD' });
      expect(wrote(calls)).toBe(false);
    }
    const calls = setup({ status: 'sold' }, { paid: 1 });
    await items.updateItem('i-1', 'u-1', { status: 'removed' });
    expect(wrote(calls)).toBe(true);
  });
  test('an item removed after a paid order cannot be relisted (no double sale)', async () => {
    const calls = setup({ status: 'removed' }, { paid: 1 });
    await expect(items.updateItem('i-1', 'u-1', { status: 'active' })).rejects.toMatchObject({ code: 'ITEM_SOLD' });
    expect(wrote(calls)).toBe(false);
  });
  test('ordinary listings still work: draft → active, active → sold (sold elsewhere), removed → active', async () => {
    for (const [from, to] of [['draft', 'active'], ['active', 'sold'], ['removed', 'active'], ['active', 'draft']]) {
      const calls = setup({ status: from });
      await items.updateItem('i-1', 'u-1', { status: to });
      expect(wrote(calls)).toBe(true);
    }
  });
});

test('a duplicate live order is a 409 NOT_AVAILABLE, not a server error', () => {
  const src = require('fs').readFileSync('src/services/marketplaceOrderService.js', 'utf8');
  expect(src).toMatch(/if \(e && e\.code === '23505' && \/live_item\/\.test\(e\.constraint \|\| e\.message \|\| ''\)\) throw err\(409, 'NOT_AVAILABLE'/);
});

describe('public visibility: Professional Sellers only', () => {
  test('isPublicStorefront requires a published storefront AND a Professional seller', () => {
    expect(storefront.isPublicStorefront({ storefront_published: true, seller_type: 'estate_sale_company' })).toBe(true);
    expect(storefront.isPublicStorefront({ storefront_published: false, seller_type: 'auction_house' })).toBe(false);
    for (const t of ['private', 'business', 'other', null]) expect(storefront.isPublicStorefront({ storefront_published: true, seller_type: t })).toBe(false);
  });
  test('a storefront whose seller is not Professional is not found (data, SEO page)', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'sp-9', storefront_published: true, seller_type: 'business', storefront: {} }] });
    await expect(storefront.getPublicData('x')).rejects.toMatchObject({ code: 'STOREFRONT_NOT_FOUND' });
    await expect(storefront.ssrMeta('x')).resolves.toBeNull();
  });
  test('public item reads and storefront item lists filter to Professional sellers', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await items.getPublicItem('i-1');
    expect(db.query.mock.calls[0][0]).toMatch(/sp\.seller_type = ANY\(\$2::text\[\]\)/);
    expect(db.query.mock.calls[0][1][1]).toEqual(['auction_house', 'estate_sale_company', 'professional_liquidator']);
    await items.listPublicForSeller('sp-1', 10);
    expect(db.query.mock.calls[1][0]).toMatch(/sp\.seller_type = ANY\(\$3::text\[\]\)/);
  });
});
