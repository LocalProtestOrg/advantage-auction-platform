'use strict';

/**
 * Navigation & Session Stabilization Sprint (OAT #4) — regression coverage.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

describe('Issue 4 — resilient session (central 401 guard)', () => {
  const ar = read('public', 'widgets', 'shared', 'auth-refresh.js');
  test('a 401 re-verifies via /api/auth/me before any logout', () => {
    expect(ar).toContain('/api/auth/me');
    expect(ar).toContain('stillAuthed');
    expect(ar).toMatch(/if \(!ok\) \{ doLogout/); // logout ONLY when re-verify fails
  });
  test('transient/scoped 401 on GET/HEAD is retried, not a logout', () => {
    expect(ar).toMatch(/m === 'GET' \|\| m === 'HEAD'/);
    expect(ar).toContain('retry');
  });
  test('logout is centralized + single-shot, and still slides the token', () => {
    expect(ar).toContain('loggingOut');
    expect(ar).toContain("removeItem('token')");
    expect(ar).toContain('X-Refreshed-Token');
  });
  test('admin pages now load the shared guard (via admin-nav)', () => {
    expect(read('public', 'widgets', 'shared', 'admin-nav.js')).toContain('/widgets/shared/auth-refresh.js');
  });
});

describe('Issue 5 — watchlist/my-bids images fall back to lot_images', () => {
  test('watchlist coalesces thumbnail_url to the first lot_images row', () => {
    const w = read('src', 'routes', 'watchlist.js');
    expect(w).toMatch(/COALESCE\(l\.thumbnail_url,[\s\S]*image_url FROM lot_images/);
  });
  test('my-bids uses the same fallback (no duplicated image logic)', () => {
    const l = read('src', 'routes', 'lots.js');
    expect(l).toMatch(/COALESCE\(l\.thumbnail_url,[\s\S]*image_url FROM lot_images/);
  });
});

describe('Issue 7 — My Auctions renders real content (not a stub)', () => {
  const shell = read('public', 'widgets', 'shared', 'member-shell.js');
  test('auctions section mounts live + dispatches loadMyAuctions', () => {
    expect(shell).toMatch(/case 'auctions':\s*return '<div id="adv-sec-live">/);
    expect(shell).toMatch(/item === 'auctions'\)\s*loadMyAuctions/);
    expect(shell).toContain('function loadMyAuctions');
  });
  test('built from existing APIs grouped by auction_id, enriched via /summary', () => {
    expect(shell).toContain('/api/lots/my-bids');
    expect(shell).toContain('/api/invoices/mine/combined');
    expect(shell).toContain("'/api/auctions/' + a.id + '/summary'");
    expect(shell).toContain('byAuction');
  });
});

describe('Issue 3 — shell refreshes the active section on tab focus', () => {
  test('visibilitychange re-runs the current route', () => {
    const shell = read('public', 'widgets', 'shared', 'member-shell.js');
    expect(shell).toContain("addEventListener('visibilitychange'");
    expect(shell).toMatch(/visibilityState === 'visible'.*setRoute\(state\.route\)/);
  });
});

describe('Issue 6 — persistent Return-to-Auction anchor', () => {
  const rta = read('public', 'widgets', 'shared', 'return-to-auction.js');
  test('module stores/clears the active auction and renders a fixed button', () => {
    expect(rta).toContain('ab_active_auction');
    expect(rta).toContain('Return to auction');
    expect(rta).toContain('position:fixed');
    expect(rta).toContain('RTA_SUPPRESS'); // suppressed on the auction/lot pages themselves
  });
  test('auction/lot pages set the active auction; other pages render the button', () => {
    expect(read('public', 'auction-view.html')).toContain('window.ReturnToAuction.set');
    expect(read('public', 'lot.html')).toContain('window.ReturnToAuction.set');
    expect(read('public', 'widgets', 'shared', 'buyer-nav.js')).toContain('return-to-auction.js');
    expect(read('public', 'app.html')).toContain('return-to-auction.js');
  });
});

describe('Issue 1 — map pin opens an Auction Card with a View Auction CTA', () => {
  const idx = read('public', 'index.html');
  test('pin click opens a card popup instead of navigating', () => {
    expect(idx).toContain('openAuctionCard(d)');
    expect(idx).not.toMatch(/click',function\(\)\{ hidePreview\(\); location\.href=d\.href; \}/);
  });
  test('the card has a View Auction button', () => {
    expect(idx).toContain('View Auction');
    expect(idx).toContain('closeButton:true');
  });
});

describe('Issue 2 — seller Home stays in-shell for auction management', () => {
  test('Manage/Active/Drafts point to the in-shell #sell workspace, not the legacy page', () => {
    const shell = read('public', 'widgets', 'shared', 'member-shell.js');
    const sellerHome = shell.slice(shell.indexOf('function loadSellerHome'), shell.indexOf('function loadSellerHome') + 6000);
    expect(sellerHome).toContain("statLink('#sell'");
    expect(sellerHome).toContain('href="#sell">🗂️ Manage auctions');
    expect(sellerHome).not.toContain('/dashboard/seller.html');
  });
});
