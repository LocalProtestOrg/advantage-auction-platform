// Static UI checks for the Admin Settlement Review workbench (Increment 6B).
// Confirms the page renders the required sections, consumes the 6A API (no duplicated
// business logic), follows the copy SOP, and has valid inline JS.
const fs = require('fs');
const vm = require('vm');
const HTML = fs.readFileSync('public/admin/settlement-review.html', 'utf8');

describe('settlement-review.html workbench', () => {
  test('has all required financial sections', () => {
    ['Settlement Formula', 'Buyer Payment Summary', 'Financial Readiness', 'Settlement Adjustments',
     'Marketing Charges', 'Marketing Performance', 'Stripe Processing', 'Payment Information', 'Audit Timeline']
      .forEach(s => expect(HTML).toContain(s));
    // key control ids
    ['ov-net', 'readiness', 'formula', 'add-credit', 'add-debit', 'adjustments', 'mark-paid', 'timeline', 'show-full', 'adj-modal', 'paid-modal', 'finalized', 'offbanner']
      .forEach(id => expect(HTML).toContain('id="' + id + '"'));
  });

  test('consumes the 6A settlement API (does not re-implement business logic)', () => {
    expect(HTML).toContain('/api/admin/settlements/');
    expect(HTML).toContain("'/adjustments'".replace(/'/g, '') === '/adjustments' ? '/adjustments' : '/adjustments'); // adjustments endpoint
    expect(HTML).toContain('/recalculate');
    expect(HTML).toContain('/mark-paid');
    expect(HTML).toContain('/void');
    // renders the API-provided final number; never computes the platform fee or net itself
    expect(HTML).toContain('net_seller_proceeds_cents');
    expect(HTML).not.toMatch(/PLATFORM_FEE|\*\s*0\.1\b|0\.10\b/); // no fee math in the UI
  });

  test('marketing attribution shows Not Available (no fabricated analytics)', () => {
    expect(HTML).toContain('Attributed Buyers');
    expect(HTML).toContain('Not Available');
  });

  test('respects the launch safeguards + locked state', () => {
    expect(HTML).toContain('settlements_enabled');          // reflects the OFF gate
    expect(HTML).toContain('Settlement Finalized');         // locked banner
    expect(HTML).toContain('does not send money');          // accurate Mark Paid wording
  });

  test('platform fee is shown as 0.00%', () => {
    expect(HTML).toContain('0.00%');
  });

  test('copy SOP: no customer-facing AI terminology and no em/en dashes', () => {
    expect(HTML).not.toMatch(/\bAI\b/);
    expect(HTML).not.toMatch(/[—–]/); // em dash / en dash
  });

  test('inline JS parses', () => {
    const scripts = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    scripts.forEach(s => { expect(() => new vm.Script(s)).not.toThrow(); });
  });
});
