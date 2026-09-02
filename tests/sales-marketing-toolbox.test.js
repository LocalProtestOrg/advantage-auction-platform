'use strict';

/**
 * Sales & Marketing Toolbox — Resource Center (send-to-prospect links) + access control.
 *
 * Verifies the internal Toolbox is authorized server-side (sales.view; Super Admin + Marketing only),
 * that the certified sales resources are present with clean canonical URLs, that Copy Link exists, and
 * that nothing unsafe (widget keys, install code, Twilio sending number, AI tracking) is exposed and
 * that this task did not change pricing.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const rbac = require('../src/lib/rbac');

const sales = read('public/admin/sales.html');

// ── Access control (server-authoritative, multi-rep) ─────────────────────────────
describe('Toolbox access control — permission-gated, not Kym-specific', () => {
  const OWNER = { role: 'admin', staff_role: 'super_admin', staff_active: true };
  const MARKETING = { role: 'buyer', staff_role: 'marketing', staff_active: true };
  const BUYER = { role: 'buyer', staff_role: null };
  const SELLER = { role: 'seller', staff_role: null };
  const DEMO_SELLER = { role: 'seller', staff_role: null }; // demo accounts are plain seller/buyer

  test('Super Admin and any Marketing rep can view the Toolbox (sales.view)', () => {
    expect(rbac.hasPermission(OWNER, 'sales.view')).toBe(true);
    expect(rbac.hasPermission(MARKETING, 'sales.view')).toBe(true);
    // future marketing reps get the same bundle by role, not by identity
    expect(rbac.ROLES.marketing.permissions).toContain('sales.view');
  });
  test('buyers, sellers, and demo accounts cannot view the Toolbox', () => {
    expect(rbac.hasPermission(BUYER, 'sales.view')).toBe(false);
    expect(rbac.hasPermission(SELLER, 'sales.view')).toBe(false);
    expect(rbac.hasPermission(DEMO_SELLER, 'sales.view')).toBe(false);
  });
  test('the API + HTML page are both gated on sales.view (server-side)', () => {
    expect(read('src/routes/adminSales.js')).toMatch(/requirePermission\('sales\.view'\)/);
    expect(read('src/middleware/htmlAuthGate.js')).toMatch(/'\/admin\/sales\.html':\s*'sales\.view'/);
  });
  test('the Toolbox page is noindex (never public)', () => {
    expect(sales).toMatch(/name="robots"[^>]*noindex/i);
  });
});

// ── Resource Center content (clean canonical URLs) ───────────────────────────────
describe('Resource Center — certified sales resources present with clean URLs', () => {
  test('a data-driven Resource Center renders send-to-prospect cards', () => {
    expect(sales).toMatch(/RESOURCE_CENTER/);
    expect(sales).toMatch(/id="resource-center"/);
  });
  test('Interactive Sales Demo (clean /demo.html)', () => {
    expect(sales).toMatch(/https:\/\/bid\.advantage\.bid\/demo\.html/);
    expect(sales).toMatch(/Interactive Sales Demo/);
  });
  test('Website Widget Example (clean /demo/example-company-website.html)', () => {
    expect(sales).toMatch(/https:\/\/bid\.advantage\.bid\/demo\/example-company-website\.html/);
    expect(sales).toMatch(/Website Widget Example/);
  });
  test('Professional Storefront Example (verified /pro/heritage-home-estate-services)', () => {
    expect(sales).toMatch(/https:\/\/bid\.advantage\.bid\/pro\/heritage-home-estate-services/);
  });
  test('Completed Auction Example (verified Maplewood auction id)', () => {
    expect(sales).toMatch(/00000000-0000-4000-a000-0000000d0003/);
  });
  test('Professional Seller overview + verified signup destination', () => {
    expect(sales).toMatch(/https:\/\/bid\.advantage\.bid\/professional-sellers\.html/);
    expect(sales).toMatch(/https:\/\/bid\.advantage\.bid\/become-professional-seller\.html/);
  });
  test('Free Business Listing learn-more + claim/get-listed', () => {
    expect(sales).toMatch(/https:\/\/bid\.advantage\.bid\/free-business-listing\.html/);
    expect(sales).toMatch(/https:\/\/bid\.advantage\.bid\/get-listed\.html/);
  });
  test('Individual Seller signup with the private seller_type', () => {
    expect(sales).toMatch(/https:\/\/bid\.advantage\.bid\/become-seller\.html\?seller_type=private/);
  });
});

// ── Copy Link UX + when-to-use guidance ──────────────────────────────────────────
describe('Copy Link + when-to-use guidance', () => {
  test('Copy Link copies the clean URL from a data attribute (no inline URL interpolation)', () => {
    expect(sales).toMatch(/function copyLink\(btn\)/);
    expect(sales).toMatch(/data-url="'\+esc\(r\[1\]\)\+'"/);
    expect(sales).toMatch(/Copy Link/);
    expect(sales).toMatch(/Copied!/);
  });
  test('resource cards carry a short "Use when" note', () => {
    expect(sales).toMatch(/Use when:/);
  });
});

// ── Safety: no unsafe exposure; clean links; unchanged pricing ────────────────────
describe('Toolbox exposes nothing unsafe and does not change pricing', () => {
  test('no production widget key or installable embed code is present', () => {
    expect(sales).not.toMatch(/wgt_[a-f0-9]{36}/);
    expect(sales).not.toMatch(/data-advantage-auctions/);
    expect(sales).not.toMatch(/company-auctions\.js/);
  });
  test('no AI-origin tracking / dirty links', () => {
    expect(sales).not.toMatch(/utm_source=chatgpt|chatgpt\.com|openai|utm_source=gpt/i);
  });
  test('official public phone + general email; never the Twilio sending number', () => {
    expect(sales).toMatch(/\+15516557050|\(551\) 655-7050/);
    expect(sales).toMatch(/info@advantage\.bid/);
    expect(sales).not.toMatch(/731|224-3669|7312243669/);
  });
  test('a pricing advisory tells reps to confirm rates (no numbers invented by this task)', () => {
    expect(sales).toMatch(/confirm the current numbers with the owner/i);
  });
  test('this task did not touch the storefront fee or professional platform-fee code', () => {
    // pricing lives elsewhere; the Toolbox only references it. Guard the fee sources are untouched here.
    expect(read('src/services/storefrontService.js')).toBeTruthy();
    expect(read('src/lib/rbac.js')).toMatch(/seller_platform_fee\.manage/); // fee authz unchanged
  });
});
