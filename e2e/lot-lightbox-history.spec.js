import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Image Lightbox Back Button (Owner Acceptance Phase 2, Task 1).
 * Hermetic: the REAL public/lot.html runs against a controlled fixture (no DB/prod).
 * Proves: open image → Back closes the lightbox and STAYS on the lot → second Back
 * leaves the lot; and that close-button/Esc/backdrop each pop the pushed entry so no
 * duplicate history entry is left behind.
 */
const PUBLIC = path.resolve(process.cwd(), 'public');
const LOT_ID = '11111111-1111-1111-1111-111111111111';
const AUCTION_ID = '22222222-2222-2222-2222-222222222222';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SOCKET_SHIM = `(function(){function S(o){this._h={};this.connected=false;var s=this;setTimeout(function(){s.connected=true;(s._h.connect||[]).forEach(function(c){try{c();}catch(e){}});},0);}S.prototype.on=function(e,c){(this._h[e]=this._h[e]||[]).push(c);return this;};S.prototype.emit=function(){return this;};S.prototype.disconnect=function(){this.connected=false;return this;};S.prototype.connect=function(){this.connected=true;return this;};window.io=function(o){var s=new S(o);window.__lotSocket=s;return s;};})();`;
const CHIME_STUB = `window.BuyerChime={play:function(){},isMuted:function(){return true},toggle:function(){return true}};`;
const lot = { id: LOT_ID, auction_id: AUCTION_ID, auction_title: 'LB Test', auction_public_type: 'standard', title: 'Lightbox Test Lot', lot_number: 1, category: 'Test', description: 'd', size_category: 'A', state: 'open', closes_at: new Date(Date.now() + 3600000).toISOString(), current_bid_cents: 1000, starting_bid_cents: 100, effective_bid_increment_cents: 500, buyer_premium_bps: 1800 };
const CTYPE = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html', '.json': 'application/json' };

async function route(page) {
  await page.route('**/*', async (r) => {
    const url = new URL(r.request().url()); const p = url.pathname; const m = r.request().method();
    const json = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.host.includes('googleapis') || url.host.includes('gstatic')) return r.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (p === '/socket.io/socket.io.js') return r.fulfill({ status: 200, contentType: 'text/javascript', body: SOCKET_SHIM });
    if (p === '/widgets/shared/buyer-chime.js') return r.fulfill({ status: 200, contentType: 'text/javascript', body: CHIME_STUB });
    if (p === '/start') return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>start</title><body>start page</body>' });
    if (p === `/api/lots/${LOT_ID}` && m === 'GET') return json({ success: true, data: lot });
    if (p === `/api/lots/${LOT_ID}/images`) return json({ success: true, data: [{ best_image_url: PNG, processing_status: 'complete', processed_image_url: PNG }, { best_image_url: PNG }, { best_image_url: PNG }] });
    if (p === `/api/lots/${LOT_ID}/bids`) return json({ success: true, data: [] });
    if (p.startsWith('/api/')) return json({ success: true, data: [] });
    if (p === '/lot.html') return r.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(PUBLIC, 'lot.html'), 'utf8') });
    const f = path.join(PUBLIC, p.replace(/^\/+/, ''));
    if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({ status: 200, contentType: CTYPE[path.extname(f)] || 'text/plain', body: fs.readFileSync(f) });
    return r.fulfill({ status: 404, body: 'nf' });
  });
}
const lbOpen = (page) => page.evaluate(() => document.getElementById('lightbox').classList.contains('open'));
const openLb = async (page) => { await page.click('#main-image-wrap'); await expect.poll(() => lbOpen(page)).toBe(true); };
async function gotoLot(page) {
  await route(page);
  await page.goto('http://localhost/start', { waitUntil: 'domcontentloaded' });      // prior history entry
  await page.goto('http://localhost/lot.html?lotId=' + LOT_ID, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const o = document.getElementById('loading-overlay'); return o && getComputedStyle(o).display === 'none'; }, null, { timeout: 15000 });
}

test('Back closes the lightbox and stays on the lot; a second Back leaves the lot', async ({ page }) => {
  await gotoLot(page);
  await openLb(page);
  // First Back → closes the lightbox, still on the lot page (URL unchanged).
  await page.evaluate(() => history.back());
  await expect.poll(() => lbOpen(page)).toBe(false);
  expect(new URL(page.url()).pathname).toBe('/lot.html');
  // Second Back → leaves the lot normally.
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => location.pathname === '/start', null, { timeout: 8000 });
  expect(new URL(page.url()).pathname).toBe('/start');
});

test('close button pops the pushed entry (no duplicate history) — Back then leaves the lot', async ({ page }) => {
  await gotoLot(page);
  await openLb(page);
  await page.click('#lb-close');
  await expect.poll(() => lbOpen(page)).toBe(false);
  expect(new URL(page.url()).pathname).toBe('/lot.html');   // still on the lot after UI close
  await page.evaluate(() => history.back());                  // one Back now leaves (entry was popped)
  await page.waitForFunction(() => location.pathname === '/start', null, { timeout: 8000 });
  expect(new URL(page.url()).pathname).toBe('/start');
});

test('Esc closes the lightbox and keeps the user on the lot', async ({ page }) => {
  await gotoLot(page);
  await openLb(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => lbOpen(page)).toBe(false);
  expect(new URL(page.url()).pathname).toBe('/lot.html');
});

test('backdrop click closes the lightbox and keeps the user on the lot', async ({ page }) => {
  await gotoLot(page);
  await openLb(page);
  await page.click('#lightbox', { position: { x: 5, y: 5 } });  // outside the image = backdrop
  await expect.poll(() => lbOpen(page)).toBe(false);
  expect(new URL(page.url()).pathname).toBe('/lot.html');
});
