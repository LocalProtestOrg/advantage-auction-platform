'use strict';

/**
 * Automatic marketplace categories (storefrontCategoryService, migration 209). One taxonomy (src/constants/lotCategories.js);
 * a spreadsheet category is used when it maps; otherwise the item's own words decide, with a confidence; when unsure the
 * category stays pending rather than guessed. A seller's choice is always a taxonomy category.
 */

const fs = require('fs');
const path = require('path');
const cats = require('../src/services/storefrontCategoryService');
const { VALID_KEYS } = require('../src/constants/lotCategories');
const sheet = require('../src/lib/spreadsheet');

describe('the one taxonomy', () => {
  test('only taxonomy keys are ever produced, and every key has terms or is the broad "general"', () => {
    for (const k of Object.keys(cats.TERMS)) expect(VALID_KEYS.has(k)).toBe(true);
    for (const k of VALID_KEYS) if (k !== 'general') expect(cats.TERMS[k]).toBeDefined();
  });
  test('a seller choice must be a taxonomy category', () => {
    expect(cats.sellerChoice('furniture')).toEqual(expect.objectContaining({ category_key: 'furniture', category: 'Furniture', category_source: 'seller', category_status: 'assigned' }));
    expect(() => cats.sellerChoice('Hijacked')).toThrow(expect.objectContaining({ code: 'CATEGORY_INVALID' }));
  });
});

describe('spreadsheet categories', () => {
  test.each([['Furniture', 'furniture'], ['Jewelry & Watches', 'jewelry'], ['Rugs', 'rugs_textiles'], ['Pottery & Ceramics', 'ceramics_glass'], ['Clocks', 'collectibles']])('"%s" maps to %s', (input, key) => {
    expect(cats.classify({ category: input, title: 'anything' })).toEqual(expect.objectContaining({ key, source: 'spreadsheet', status: 'assigned', input }));
  });
  test('an unknown spreadsheet category is used as evidence, never stored as a second taxonomy', () => {
    const c = cats.classify({ category: 'Seating', title: 'Pair of club chairs' });
    expect(c).toEqual(expect.objectContaining({ key: 'furniture', source: 'automatic', input: 'Seating' }));
  });
});

describe('automatic classification from the item\'s own words', () => {
  test.each([
    ['KARL SPRINGER STYLE HORN INLAID LAMP', 'lighting'],
    ['PAIR OF CONTEMPORARY RECHARGABLE LED TABLE LAMPS', 'lighting'],          // "table lamps" is lighting, not furniture
    ['FRANCOIS RUDE "RUDE"S FATHER" BRONZE SCULPTURE', 'fine_art'],            // the naming noun beats the material
    ['ANTIQUE PERSIAN HERIZ CARPET', 'rugs_textiles'],                         // "antique" describes; "carpet" names it
    ['ROLEX DAY DATE 36MM 18KT WG WATCH', 'jewelry'],
    ['19TH C. MAHOGANY ENGLISH SLANT FRONT BUREAU', 'furniture'],
    ['HAND PAINTED ACRYLIC DOG IN A DRESS AND GRAND HAT', 'fine_art'],         // what it is depicted wearing is not the item
    ['SET OF 8 WATERFORD CRYSTAL LIQUOR GLASSES', 'ceramics_glass'],
    ['GEORGIAN TRIPLE PLATE PARCEL GILT FRAMED MIRROR', 'home_decor'],
  ])('%s → %s', (title, key) => {
    const c = cats.classify({ title });
    expect(c).toEqual(expect.objectContaining({ key, source: 'automatic', status: 'assigned' }));
    expect(c.confidence).toBeGreaterThanOrEqual(cats.AUTO_MIN_CONFIDENCE);
  });
  test.each(['JOE MANCUSO "SPIRAL"', 'VINTAGE TURQUOISE COLORED LION', 'Item 42', ''])('unclear "%s" stays pending (never guessed)', (title) => {
    expect(cats.classify({ title })).toEqual(expect.objectContaining({ key: null, status: 'pending', source: null }));
  });
  test('period words with nothing more specific give the broad Antiques category; one word alone is not enough', () => {
    expect(cats.classify({ title: 'ANTIQUE WOOD CARVED FEMALE POLYCHROME FIGURE', description: 'Antique carved figure, circa 1880, Victorian.' }).key).toBe('antiques');
    expect(cats.classify({ title: 'ANTIQUE WOOD CARVED FEMALE POLYCHROME FIGURE' }).status).toBe('pending');
  });
  test('the real AuctionFlex export: most items are categorised, the rest wait, and every assignment is a taxonomy key', () => {
    const { rows } = sheet.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'auctionflex-unsold-inventory.csv')), 'x.csv');
    const out = rows.slice(1).map((r) => cats.classify({ title: r[2], description: r[3] }));
    const assigned = out.filter((c) => c.status === 'assigned');
    expect(out).toHaveLength(142);
    expect(assigned.length / out.length).toBeGreaterThanOrEqual(0.85);
    expect(assigned.every((c) => VALID_KEYS.has(c.key) && c.confidence >= cats.AUTO_MIN_CONFIDENCE)).toBe(true);
  });
  test('hostile or huge text is handled quickly', () => {
    const t = Date.now();
    cats.classify({ title: 'lamp '.repeat(5000), description: 'table chair rug '.repeat(20000) });
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('the background pass (Smart Catalog Tools text classifier)', () => {
  test('assigns only taxonomy keys above the confidence threshold, never over a seller choice', async () => {
    const updates = [];
    const db = { query: async (sql, p) => {
      if (/^\s*SELECT/i.test(sql)) return { rows: [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }, { id: 'c', title: 'z' }] };
      updates.push({ sql, p }); return { rowCount: 1 };
    } };
    const answers = { x: { key: 'furniture', confidence: 0.9 }, y: { key: 'not_a_category', confidence: 0.99 }, z: { key: 'tools', confidence: 0.3 } };
    const out = await cats.refinePending('seller-1', { db, classifyText: async (f) => answers[f.title] });
    expect(out).toEqual({ examined: 3, assigned: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0].p.slice(0, 3)).toEqual(['a', 'furniture', 'Furniture']);
    expect(updates[0].sql).toMatch(/category_source IS DISTINCT FROM 'seller'/);
  });
  test('without a configured classifier nothing happens', async () => {
    expect(await cats.refinePending('s', { db: { query: async () => ({ rows: [] }) }, classifyText: 'not a function' })).toEqual(expect.objectContaining({ assigned: 0 }));
  });
});

test('a full-size preview (2,000 rows, long descriptions) categorises quickly (security review 2026-10-30)', () => {
  const d = 'Antique mahogany table with carved legs and brass hardware, a fine example of the period. '.repeat(27);
  const t = Date.now();
  for (let i = 0; i < 2000; i++) cats.classify({ title: 'PAIR OF CONTEMPORARY LAMPS ' + i, description: d, material: 'mahogany' });
  expect(Date.now() - t).toBeLessThan(3000);
});
