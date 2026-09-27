'use strict';

/**
 * Sales & Marketing Toolbox: the Owner-approved benefits-first positioning (2026-09-27), for every rep.
 *   - Lead with the seller's business (their brand and website, more estate contracts, more services, more sales).
 *   - Dual distribution BY DESIGN: every professional auction appears on the seller's own website (white-label
 *     widget) AND on the Advantage.Bid marketplace. One auction, two audiences. No website-only option.
 *   - No percentage / sell-through / revenue promises and no "nationwide" claims in pitch or outreach copy.
 */

const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'sales.html'), 'utf8');
const block = (name) => { const a = html.indexOf('const ' + name + ' = ['); return html.slice(a, html.indexOf('\n    ];', a)); };

describe('benefits-first sales playbook', () => {
  test('the inline scripts still parse', () => {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) expect(() => new Function(code)).not.toThrow();
  });

  test('the 15/30/60-second pitches lead with the seller\'s own name and website, then the marketplace as a second audience', () => {
    const p = block('PITCH');
    expect(p).toMatch(/'15-second explanation','Advantage\.Bid lets your company run online auctions under your own name\. Each auction shows on your website and reaches more buyers on the Advantage\.Bid marketplace/);
    expect(p).toMatch(/'30-second pitch','When an estate needs more than an on-site sale/);
    expect(p).toMatch(/one listing, two audiences/);
    expect(p).toMatch(/You keep your clients, your name and your way of working/);
  });

  test('the value list starts with the seller\'s website, then two audiences; no marketplace-first or nationwide items', () => {
    const v = block('VALUEPROP');
    const items = [...v.matchAll(/\n\s+'([^']+)',/g)].map((m) => m[1]);
    expect(items[0]).toBe('Your auctions on your own website, under your company name (white-label embed)');
    expect(items[1]).toBe('One auction, two audiences: the same auction also reaches buyers on the Advantage.Bid marketplace');
    expect(v).not.toMatch(/nationwide|Nationwide marketplace discoverability/i);
  });

  test('"We already have a website" puts their auctions ON their site (widget) and adds the marketplace audience', () => {
    const o = block('OBJECTIONS');
    expect(o).toMatch(/\['We already have a website\.','Perfect, that is where your auctions belong\. Paste one small code snippet/);
    expect(o).toMatch(/The same auctions also reach buyers on the Advantage\.Bid marketplace/);
    expect(o).not.toMatch(/You can link your Advantage\.Bid auctions from your site/);
  });

  test('the has-website outreach template offers auctions on their website plus the marketplace', () => {
    expect(block('OUTREACH')).toMatch(/'Email: has website, no auctions','Subject: Online auctions on \[Company\]\\'s website/);
    expect(block('OUTREACH')).toMatch(/one listing works for your visitors and ours/);
  });

  test('the demo starts on the seller\'s own website, then the marketplace', () => {
    const d = block('DEMO');
    const steps = [...d.matchAll(/\['(\d+)\. ([^']+)'/g)].map((m) => [Number(m[1]), m[2]]);
    expect(steps[0]).toEqual([1, 'Your website (start here, 90s)']);
    expect(steps[1]).toEqual([2, 'One auction, two audiences (60s)']);
    expect(steps.map((s) => s[0])).toEqual(steps.map((_, i) => i + 1));
    expect(d.slice(0, d.indexOf("['2. "))).toMatch(/demo\/example-company-website\.html/);
    expect(d).toMatch(/The demo auction itself is kept off the public marketplace/);
  });

  test('no website-only / marketplace opt-out offer anywhere, and no outcome promises in pitch or outreach copy', () => {
    expect(html).not.toMatch(/website-only|opt out of the marketplace|off the marketplace|without the marketplace/i);
    for (const name of ['PITCH', 'VALUEPROP', 'OUTREACH', 'PHONE']) {
      expect([name, block(name)]).not.toEqual([name, expect.stringMatching(/\d+\s*%|nationwide|guarantee/i)]);
    }
  });

  test('the rule is visible to every rep: playbook callout and onboarding checklist', () => {
    expect(html).toMatch(/<b>Benefits first, for every rep and every seller-acquisition message\.<\/b>/);
    expect(block('CHECKLIST')).toMatch(/Learn the benefits-first rule/);
  });
});
