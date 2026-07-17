'use strict';

/**
 * Marketplace Phase 2 — pluggable, config-driven company->seller matcher.
 * Verifies the owner's requirement: rules are advisory by default; deterministic rules
 * can be enabled for auto-link via env WITHOUT code change; name similarity is NEVER
 * auto-linkable; rules whose seller identifiers are absent stay dormant.
 */

const { ruleConfig, suggestForOrg, domainOf } = require('../src/services/marketplace/companySellerMatch');
const { computeMatchKey } = require('../src/services/organizationMatchingService');

const mk = (name, state) => computeMatchKey(name, state);

describe('ruleConfig (env-driven, no redesign to enable auto-link)', () => {
  test('Phase 2 default (no env): all rules advisory (autoLink off)', () => {
    const cfg = ruleConfig({});
    expect(cfg.map(r => r.key)).toEqual(['google_place_id', 'verified_domain', 'name_state']);
    expect(cfg.every(r => r.enabled)).toBe(true);
    expect(cfg.every(r => r.autoLink === false)).toBe(true);
  });

  test('enabling a deterministic rule via env flips only that rule to auto-link', () => {
    const cfg = ruleConfig({ MARKETPLACE_AUTOLINK_RULES: 'google_place_id,verified_domain' });
    expect(cfg.find(r => r.key === 'google_place_id').autoLink).toBe(true);
    expect(cfg.find(r => r.key === 'verified_domain').autoLink).toBe(true);
    // name_state is NOT auto-link-eligible → never turns on even if listed
    expect(ruleConfig({ MARKETPLACE_AUTOLINK_RULES: 'name_state' }).find(r => r.key === 'name_state').autoLink).toBe(false);
  });

  test('a rule can be disabled entirely via env', () => {
    const cfg = ruleConfig({ MARKETPLACE_DISABLED_MATCH_RULES: 'name_state' });
    expect(cfg.find(r => r.key === 'name_state').enabled).toBe(false);
  });
});

describe('domainOf', () => {
  test('normalizes host, strips www + scheme', () => {
    expect(domainOf('https://www.Foo.com/path')).toBe('foo.com');
    expect(domainOf('foo.com')).toBe('foo.com');
    expect(domainOf(null)).toBe(null);
    expect(domainOf('not a url')).toBe(null);
  });
});

describe('suggestForOrg (advisory suggestions)', () => {
  const org = { id: 'o1', name: 'Simpson Galleries LLC', state: 'TX', google_place_id: 'PLACE_1', website_url: 'https://simpsongalleries.com' };

  test('name+state produces an unambiguous, non-auto-linkable suggestion (Phase 2)', () => {
    const sellers = [{ id: 's1', display_name: 'Simpson Galleries LLC', state: 'TX', match_key: mk('Simpson Galleries LLC', 'TX'), website_url: null, google_place_id: null }];
    const out = suggestForOrg(org, sellers, ruleConfig({}));
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('name_state');
    expect(out[0].sellerProfileId).toBe('s1');
    expect(out[0].ambiguous).toBe(false);
    expect(out[0].autoLinkable).toBe(false); // never auto-links on name, even unambiguous
  });

  test('ambiguous name match (2 sellers) is surfaced but never auto-linkable', () => {
    const sellers = [
      { id: 's1', display_name: 'Simpson Galleries LLC', state: 'TX', match_key: mk('Simpson Galleries LLC', 'TX') },
      { id: 's2', display_name: 'Simpson Galleries, LLC', state: 'TX', match_key: mk('Simpson Galleries LLC', 'TX') },
    ];
    const out = suggestForOrg(org, sellers, ruleConfig({}));
    expect(out).toHaveLength(2);
    expect(out.every(s => s.ambiguous === true)).toBe(true);
    expect(out.every(s => s.autoLinkable === false)).toBe(true);
  });

  test('google_place_id / domain rules stay DORMANT while sellers lack those identifiers', () => {
    const sellers = [{ id: 's1', display_name: 'Different Name', state: 'CA', match_key: mk('Different Name', 'CA'), website_url: null, google_place_id: null }];
    expect(suggestForOrg(org, sellers, ruleConfig({})).length).toBe(0); // no name match, no place/domain data → nothing
  });

  test('when seller identifiers exist AND rule enabled for auto-link, an exact place-id match is auto-linkable', () => {
    const sellers = [{ id: 's1', display_name: 'X', state: 'TX', match_key: mk('X', 'TX'), website_url: null, google_place_id: 'PLACE_1' }];
    const cfg = ruleConfig({ MARKETPLACE_AUTOLINK_RULES: 'google_place_id' });
    const out = suggestForOrg(org, sellers, cfg);
    const gp = out.find(s => s.rule === 'google_place_id');
    expect(gp).toBeTruthy();
    expect(gp.confidence).toBe('exact');
    expect(gp.autoLinkable).toBe(true); // future behavior, enabled purely via config
  });
});
