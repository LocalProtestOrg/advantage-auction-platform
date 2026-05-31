'use strict';

const {
  resolveVariables,
  renderBody,
  formatValue,
  resolveAndRender,
} = require('../src/services/agreementVariableService');

describe('agreementVariableService — pure resolver', () => {
  const schema = [
    { key: 'seller_name',       label: 'Seller',        type: 'string',         required: true,  source: 'identity' },
    { key: 'company',           label: 'Company',       type: 'string',         required: false, source: 'identity' },
    { key: 'commission_pct',    label: 'Commission',    type: 'percent',        required: true,  source: 'terms' },
    { key: 'buyer_premium_pct', label: 'Buyer premium', type: 'percent',        required: true,  source: 'terms' },
    { key: 'marketing_fee',     label: 'Marketing fee', type: 'currency_cents', required: false, source: 'terms' },
    { key: 'effective_date',    label: 'Effective',     type: 'date',           required: false, source: 'manual' },
  ];

  describe('precedence: override > seller data > defaults', () => {
    test('falls back to template defaults when nothing else set', () => {
      const { resolved } = resolveVariables({
        variableSchema: schema,
        termsDefaults: { commission_pct: 15, buyer_premium_pct: 18 },
        sellerTerms: {}, sellerIdentity: { seller_name: 'Acme' },
      });
      expect(resolved.commission_pct).toBe(15);
      expect(resolved.buyer_premium_pct).toBe(18);
    });

    test('seller_terms overrides the template default', () => {
      const { resolved } = resolveVariables({
        variableSchema: schema,
        termsDefaults: { commission_pct: 15 },
        sellerTerms: { commission_pct: 10 },
        sellerIdentity: { seller_name: 'Acme' },
      });
      expect(resolved.commission_pct).toBe(10);
    });

    test('send-time override beats both seller_terms and defaults', () => {
      const { resolved } = resolveVariables({
        variableSchema: schema,
        termsDefaults: { commission_pct: 15 },
        sellerTerms: { commission_pct: 10 },
        sellerIdentity: { seller_name: 'Acme' },
        overrides: { commission_pct: 7.5 },
      });
      expect(resolved.commission_pct).toBe(7.5);
    });

    test('identity-sourced values come from sellerIdentity', () => {
      const { resolved } = resolveVariables({
        variableSchema: schema,
        sellerIdentity: { seller_name: 'Jane Doe', company: 'Doe Estates' },
        termsDefaults: { commission_pct: 15, buyer_premium_pct: 18 },
      });
      expect(resolved.seller_name).toBe('Jane Doe');
      expect(resolved.company).toBe('Doe Estates');
    });
  });

  describe('required-missing detection', () => {
    test('reports required vars with no resolvable value', () => {
      const { missingRequired } = resolveVariables({
        variableSchema: schema,
        sellerIdentity: {}, sellerTerms: {}, termsDefaults: {},
      });
      expect(missingRequired.sort()).toEqual(['buyer_premium_pct', 'commission_pct', 'seller_name'].sort());
    });

    test('no missing when all required resolve', () => {
      const { missingRequired } = resolveVariables({
        variableSchema: schema,
        sellerIdentity: { seller_name: 'Jane' },
        termsDefaults: { commission_pct: 15, buyer_premium_pct: 18 },
      });
      expect(missingRequired).toEqual([]);
    });

    test('blank/whitespace strings count as missing', () => {
      const { missingRequired } = resolveVariables({
        variableSchema: [{ key: 'seller_name', required: true, source: 'identity' }],
        sellerIdentity: { seller_name: '   ' },
      });
      expect(missingRequired).toEqual(['seller_name']);
    });
  });

  describe('formatValue', () => {
    test('percent', () => expect(formatValue(12.5, 'percent')).toBe('12.5%'));
    test('currency_cents', () => expect(formatValue(2500, 'currency_cents')).toBe('$25.00'));
    test('string default', () => expect(formatValue('hello', 'string')).toBe('hello'));
    test('empty stays empty', () => expect(formatValue(null, 'percent')).toBe(''));
  });

  describe('renderBody', () => {
    test('replaces known placeholders with formatted values', () => {
      const body = 'Seller {{seller_name}} agrees to {{commission_pct}} commission.';
      const { renderedBody } = resolveAndRender({
        bodyMarkdown: body,
        variableSchema: schema,
        sellerIdentity: { seller_name: 'Jane Doe' },
        termsDefaults: { commission_pct: 15, buyer_premium_pct: 18 },
      });
      expect(renderedBody).toBe('Seller Jane Doe agrees to 15% commission.');
    });

    test('leaves unresolved placeholders intact (visible gap in preview)', () => {
      expect(renderBody('Hello {{unknown_key}}', {})).toBe('Hello {{unknown_key}}');
    });

    test('tolerates whitespace inside braces', () => {
      expect(renderBody('A {{ x }} B', { x: 'Y' })).toBe('A Y B');
    });
  });
});
