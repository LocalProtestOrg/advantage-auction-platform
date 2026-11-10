'use strict';

/** Professional Seller business categories (owner 2026-11-10; src/constants/businessCategories.js, migration 229). */

const fs = require('fs');
const path = require('path');
const bc = require('../src/constants/businessCategories');
const { PROFESSIONAL_SELLER_TYPES } = require('../src/constants/sellerTypes');

describe('validation', () => {
  test('known values only, de-duplicated, canonical order; at least one required', () => {
    expect(bc.normalizeCategories(['retail_resale', 'auction_house', 'retail_resale'])).toEqual({ ok: true, categories: ['auction_house', 'retail_resale'], invalid: [] });
    expect(bc.normalizeCategories([' Gallery_Studio '])).toMatchObject({ ok: true, categories: ['gallery_studio'] });
    expect(bc.normalizeCategories([])).toMatchObject({ ok: false, invalid: [] });
    expect(bc.normalizeCategories(undefined)).toMatchObject({ ok: false });
    expect(bc.normalizeCategories(['admin', 'auction_house'])).toMatchObject({ ok: false, invalid: ['admin'] });
    expect(bc.normalizeCategories('estate_sale_company')).toMatchObject({ ok: true, categories: ['estate_sale_company'] });
  });
});

describe('classification', () => {
  test('every category maps to a Professional seller type (categories never make an account Individual)', () => {
    for (const c of bc.BUSINESS_CATEGORIES) expect(PROFESSIONAL_SELLER_TYPES).toContain(bc.primarySellerTypeFor([c]));
    expect(bc.primarySellerTypeFor([])).toBeNull();
  });
  test('the recorded type follows a fixed order, so a combination is predictable', () => {
    expect(bc.primarySellerTypeFor(['retail_resale', 'estate_sale_company', 'auction_house'])).toBe('auction_house');
    expect(bc.primarySellerTypeFor(['retail_resale', 'estate_sale_company'])).toBe('estate_sale_company');
    expect(bc.primarySellerTypeFor(['gallery_studio', 'other_professional'])).toBe('retail_gallery_studio');
  });
  test('existing sellers without stored categories are described by their type; Individuals have none', () => {
    expect(bc.categoriesFor({ seller_type: 'estate_sale_company', business_categories: [] })).toEqual(['estate_sale_company']);
    expect(bc.categoriesFor({ seller_type: 'professional_liquidator' })).toEqual(['professional_liquidator']);
    expect(bc.categoriesFor({ seller_type: 'retail_gallery_studio', business_categories: null })).toEqual(['retail_resale']);
    expect(bc.categoriesFor({ seller_type: 'business' })).toEqual([]);
    expect(bc.categoriesFor({ seller_type: 'auction_house', business_categories: ['retail_resale'] })).toEqual(['retail_resale']);
  });
  test('labels are the owner\'s wording', () => {
    expect(bc.labelsFor(bc.BUSINESS_CATEGORIES)).toEqual(['Auction House', 'Estate Sale Company', 'Professional Liquidator',
      'Retail Shop or Resale Business', 'Gallery or Studio', 'Other Professional Selling Business']);
  });
});

describe('the database rule matches the list', () => {
  test('migration 229 allows exactly these values and changes no existing row', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '229_seller_business_categories.sql'), 'utf8');
    for (const c of bc.BUSINESS_CATEGORIES) expect(sql).toContain(`'${c}'`);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS business_categories text\[\] NOT NULL DEFAULT '\{\}'/);
    expect(sql).not.toMatch(/\bUPDATE\s+seller_profiles\b/i);
    expect(sql).not.toMatch(/seller_type/i.test(sql.replace(/--.*$/gm, '')) ? /DROP CONSTRAINT seller_profiles_seller_type_check/ : /$^/);
  });
});
