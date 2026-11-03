'use strict';

/**
 * Smart Catalog Tools for storefront items (owner request 2026-11-03): POST /api/seller-storefront/items/smart-catalog
 * reuses the auction lot builders' photo description service (aiDescriptionService.generateDescriptionFromImage); it
 * returns suggestions only (title, description, a storefront category), saves nothing, never substitutes sample text
 * when the service is unavailable, and is limited to people allowed to edit the company's inventory.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-smart-catalog'; // test value, never a real secret

jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => { req.user = { id: 'u-1', role: 'seller' }; next(); });
jest.mock('../src/middleware/requireSellerPermission', () => {
  const gate = (perm) => (req, res, next) => {
    if (req.get('x-test-no-permission')) return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Not allowed.' });
    req.sellerCtx = { sellerId: 'sp-1', userId: 'u-1', role: 'owner', staff: false, perm };
    return next();
  };
  gate.optionalSellerPermission = gate;
  return gate;
});
jest.mock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() }));
jest.mock('../src/services/aiDescriptionService', () => {
  class AIUnavailableError extends Error {}
  return { AIUnavailableError, generateDescriptionFromImage: jest.fn() };
});
const svc = require('../src/services/aiDescriptionService');
const db = require('../src/db');

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/seller-storefront', require('../src/routes/sellerStorefront'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });
beforeEach(() => { svc.generateDescriptionFromImage.mockReset(); db.query.mockClear(); });

const post = async (body, headers = {}) => {
  const r = await fetch(base + '/api/seller-storefront/items/smart-catalog', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const PHOTO = 'https://images.example/upload/walnut-desk.jpg';

test('suggestions from the photo: title, description and a category from the storefront taxonomy, nothing else', async () => {
  svc.generateDescriptionFromImage.mockResolvedValue({ title: 'Walnut Writing Desk', description: 'A walnut writing desk with three drawers.',
    category: 'Furniture', pickup_category: 'C', clarification_schema: [{ group: 'x' }], maker_artist: 'Invented Maker' });
  const r = await post({ image_url: PHOTO });
  expect(r.status).toBe(200);
  expect(r.body.data).toEqual({ title: 'Walnut Writing Desk', description: 'A walnut writing desk with three drawers.', category_key: 'furniture', category_label: 'Furniture' });
  expect(svc.generateDescriptionFromImage).toHaveBeenCalledWith(PHOTO);   // the one shared service
  expect(db.query).not.toHaveBeenCalled();                                 // nothing is saved
});

test('a category outside the storefront taxonomy is left for the automatic categories (never guessed)', async () => {
  svc.generateDescriptionFromImage.mockResolvedValue({ title: 'Something', description: 'Something.', category: 'Unknowable Category Name' });
  const r = await post({ image_url: PHOTO });
  expect(r.body.data).toMatchObject({ category_key: null, category_label: null });
});

test('unavailable: a plain message, no sample text, no technology or vendor names', async () => {
  svc.generateDescriptionFromImage.mockRejectedValue(new svc.AIUnavailableError('provider down'));
  const r = await post({ image_url: PHOTO });
  expect(r.status).toBe(503);
  expect(r.body).toMatchObject({ success: false, code: 'SMART_TOOLS_UNAVAILABLE' });
  expect(r.body.message).toMatch(/Smart Catalog Tools are temporarily unavailable/);
  expect(JSON.stringify(r.body)).not.toMatch(/\bAI\b|artificial|anthropic|claude|model/i);
  expect(r.body.data).toBeUndefined();
});

test('needs a photo address on the web (https); never a local or made-up one', async () => {
  for (const u of ['', 'blob:http://x/1', 'http://images.example/a.jpg', 'javascript:alert(1)', 'https://x y']) {
    expect((await post({ image_url: u })).status).toBe(422);
  }
  expect(svc.generateDescriptionFromImage).not.toHaveBeenCalled();
});

test('only people allowed to edit the company inventory', async () => {
  const r = await post({ image_url: PHOTO }, { 'x-test-no-permission': '1' });
  expect(r.status).toBe(403);
  expect(svc.generateDescriptionFromImage).not.toHaveBeenCalled();
});

test('the Add Item form: the Smart Catalog Tools box, human review before saving, Save as Draft; plain wording', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'seller-storefront.html'), 'utf8');
  expect(html).toContain('<b>Smart Catalog Tools</b>');
  expect(html).toContain('>Suggest Details from Photo</button>');
  expect(html).toMatch(/api\('POST','\/api\/seller-storefront\/items\/smart-catalog',\{image_url:UPLOADED\[0\]\}\)/);
  expect(html).toMatch(/Replace the title and description you have typed with the suggestions\?/);
  expect(html).toContain("onclick=\"addItem(this,'draft')\">Save as Draft</button>");
  expect(html).toMatch(/if\(draft\)body\.status='draft';/);
  const box = html.slice(html.indexOf('<div id="m-smart"'), html.indexOf('<label>Title</label>'));
  expect(box).toMatch(/add the maker, age, history and condition yourself, and only if you know them/);
  expect(box).not.toMatch(/\bA\.?I\b|artificial intelligence|machine learning|[–—]/i);
});
