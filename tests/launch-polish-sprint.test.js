'use strict';

/**
 * Regression guards for the final launch-polish sprint. Source-level assertions (the codebase's
 * established pattern for HTML/wiring invariants — see www-bid-redirect / analyticsTag-ordering /
 * marketplace-feed tests) since these span static HTML + a DB-backed route.
 *
 *  Part 1 — buyer's premium + estimated total shown live on the lot page
 *  Part 2 — the primary seller save action persists the lot server-side (not localStorage)
 *  Part 3 — one canonical draft-edit parameter (?edit=) with ?id= accepted as an alias
 *  Part 4 — pickup rule stated as 48 hours everywhere public (no stale 36-hour copy)
 *  Part 7 — stale admin "Coming Soon" cards for shipped features removed
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('Part 1 — buyer\'s premium + estimated total on the lot page', () => {
  const lotsRoute = read('src', 'routes', 'lots.js');
  const lotHtml = read('public', 'lot.html');

  test('GET /api/lots/:lotId resolves the effective buyer_premium_bps (with 1800 fallback)', () => {
    expect(lotsRoute).toMatch(/resolveEffectiveTerms\(lot\.auction_id\)/);
    expect(lotsRoute).toMatch(/lot\.buyer_premium_bps\s*=/);
    expect(lotsRoute).toMatch(/catch[\s\S]{0,60}buyer_premium_bps = 1800/);
  });

  test('lot page renders Current bid, Buyer\'s premium, and Estimated total', () => {
    expect(lotHtml).toContain('id="cost-breakdown"');
    expect(lotHtml).toContain('id="cb-current"');
    expect(lotHtml).toContain('id="cb-premium-pct"');
    expect(lotHtml).toContain('Estimated total if you win');
  });

  test('total is computed as discrete line items, tax-ready (taxCents present, 0 today)', () => {
    expect(lotHtml).toMatch(/function computeTotals/);
    expect(lotHtml).toMatch(/premiumCents/);
    expect(lotHtml).toMatch(/taxCents/);        // structured so sales tax can be added later
    expect(lotHtml).toContain('id="cb-tax-row"');
  });

  test('the estimated total updates on live current-bid change AND on user bid/max input', () => {
    expect(lotHtml).toMatch(/function setCurrentBid/);
    // setCurrentBid (fired by initial render + live refresh/socket) stores the bid and recomputes
    expect(lotHtml).toMatch(/lastCurrentBidCents = c;\s*[\r\n]+\s*updateCostBreakdown\(\)/);
    // typing a bid or max bid recomputes the total
    expect(lotHtml).toMatch(/\['bid-input', 'max-bid-input'\][\s\S]{0,200}updateCostBreakdown/);
  });
});

describe('Part 2 — the primary seller save action truly persists the lot', () => {
  const lots = read('public', 'dashboard', 'lots.html');
  test('the primary button persists server-side via handleAddToAuction', () => {
    expect(lots).toMatch(/class="btn btn-primary" id="add-lot-btn" onclick="handleAddToAuction\(\)"/);
  });
  test('there is no localStorage-only "Save Lot to Draft" primary button', () => {
    expect(lots).not.toMatch(/onclick="handleSaveDraft\(\)"[^>]*>\s*Save Lot to Draft/);
    expect(lots).not.toContain('>Save Lot to Draft<');
  });
  test('the autosave indicator no longer claims the lot is "saved to this auction"', () => {
    expect(lots).not.toContain('Lot saved to this auction');
    expect(lots).toMatch(/Draft autosaved in this browser/);
  });
});

describe('Part 3 — one canonical draft-edit parameter, ?id= accepted as an alias', () => {
  const sellerCreate = read('public', 'seller-create.html');
  const shell = read('public', 'widgets', 'shared', 'member-shell.js');
  test('seller-create reads ?edit= canonically and falls back to ?id=', () => {
    expect(sellerCreate).toMatch(/get\('edit'\)\s*\|\|\s*_createParams\.get\('id'\)/);
  });
  test('the unified member shell emits the canonical ?edit= for draft edit + view', () => {
    expect(shell).toContain('/seller-create.html?edit=');
    expect(shell).not.toContain('/seller-create.html?id=');
  });
});

describe('Part 4 — pickup rule stated as 48 hours (no stale 36-hour public copy)', () => {
  const pubDir = path.join(__dirname, '..', 'public');
  function walk(dir) {
    let out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out = out.concat(walk(full));
      else if (e.name.endsWith('.html')) out.push(full);
    }
    return out;
  }
  test('no public HTML page mentions a 36-hour pickup gap', () => {
    const offenders = walk(pubDir).filter(f => /36[\s-]hour/i.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  test('the create-auction form gives inline 48-hour pickup guidance', () => {
    expect(read('public', 'seller-create.html')).toMatch(/48 hours after the auction closes/);
  });
});

describe('Part 7 — stale admin "Coming Soon" cards for shipped features removed', () => {
  const admin = read('public', 'admin', 'index.html');
  test('Payouts and Walkthrough Video Review are no longer shown as "UI pending"', () => {
    expect(admin).not.toContain('API exists, UI pending');                       // the removed stale tag
    expect(admin).not.toContain('<div class="card-title">Payouts</div>');        // removed placeholder card
    expect(admin).not.toContain('<div class="card-title">Walkthrough Video Review</div>');
  });
  test('the genuinely-unbuilt Seller Capability Management placeholder is kept', () => {
    expect(admin).toContain('Seller Capability Management');
  });
});
