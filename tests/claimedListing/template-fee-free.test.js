'use strict';

/**
 * Copy rule (VSCODE-HANDOFF section 13, reconciled 2026-09-30): Claimed Listing outreach (E1 to E4, E2 variants,
 * E4_REFRESH), activation (A1 to A4), CL_SELF_REQUEST and the Professional Seller introduction (P1) carry no fee
 * content. No template may contain a "%" sign or the word "fee" (subject, preheader, body or the listing footer).
 */

const { CATALOGUE, LISTING_FOOTER, render, SAMPLE_VARS } = require('../../src/services/claimedListings/templates');

const FEE = /%|\bfees?\b/i;
const keys = Object.keys(CATALOGUE);

describe('Claimed Listing templates carry no fee content', () => {
  test('the catalogue covers every outreach, activation, self-request and introduction template', () => {
    for (const k of ['E1', 'E2_NOCLICK', 'E2_CLICKED', 'E3', 'E4_REFRESH', 'CL_SELF_REQUEST', 'A1', 'A2', 'A3', 'A4', 'P1']) expect(keys).toContain(k);
  });

  test.each(keys)('%s source copy has no "%" and no "fee"', (k) => {
    const t = CATALOGUE[k];
    for (const part of [t.subject, t.preheader || '', t.text]) expect(part).not.toMatch(FEE);
  });

  test('the listing footer has no fee content', () => { expect(LISTING_FOOTER).not.toMatch(FEE); });

  test.each(keys)('%s rendered copy (both Buy Now states) has no "%" and no "fee"', (k) => {
    const t = CATALOGUE[k];
    for (const buyNow of [false, true]) {
      const r = render({ subject: t.subject, preheader: t.preheader, body_text: t.text, stream: t.stream }, { ...SAMPLE_VARS, buy_now_enabled: buyNow });
      expect([r.subject, r.preheader || '', r.text].join('\n')).not.toMatch(FEE);
    }
  });
});

describe('P1 Professional Seller introduction (draft)', () => {
  const t = CATALOGUE.P1;
  const r = (vars) => render({ subject: t.subject, preheader: t.preheader, body_text: t.text, stream: t.stream }, { ...SAMPLE_VARS, ...vars });

  test('is a transactional draft with the free-listing line and the dual-distribution truth', () => {
    expect(t.stream).toBe('transactional');
    const out = r({ buy_now_enabled: false }).text;
    expect(out).toMatch(/Your listing stays free whether or not you ever use anything else\./);
    expect(out).toMatch(/own website through a small embed/);
    expect(out).toMatch(/Advantage\.Bid marketplace/);
    expect(out).toMatch(/at least 30 lots/);
    expect(out).toMatch(/fixed-price items in your storefront/);
  });

  test('mentions Buy Now only when storefront checkout is on', () => {
    expect(r({ buy_now_enabled: false }).text).not.toMatch(/Buy Now/);
    expect(r({ buy_now_enabled: true }).text).toMatch(/Buy Now/);
  });

  test('defaults Buy Now from production storefront checkout (off unless MARKETPLACE_CHECKOUT_ENABLED)', () => {
    const prev = process.env.MARKETPLACE_CHECKOUT_ENABLED;
    delete process.env.MARKETPLACE_CHECKOUT_ENABLED;
    const vars = { ...SAMPLE_VARS }; delete vars.buy_now_enabled;
    expect(render({ subject: t.subject, preheader: null, body_text: t.text, stream: t.stream }, vars).text).not.toMatch(/Buy Now/);
    if (prev === undefined) delete process.env.MARKETPLACE_CHECKOUT_ENABLED; else process.env.MARKETPLACE_CHECKOUT_ENABLED = prev;
  });

  test('makes no sell-through or results claims and no nationwide claim', () => {
    const out = r({ buy_now_enabled: true }).text;
    expect(out).not.toMatch(/sell[- ]through|guarantee|sell everything|nationwide|\d+\s*(x|times) more/i);
  });
});
