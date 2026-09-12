'use strict';

/**
 * Event Partner Authorization Foundation — Phase 1 regression suite (migration 153).
 *
 * Covers the promises this phase makes: authorization is explicit and evidenced, links are single-use
 * and expiring, claiming can no longer be won by whoever arrives first, a company source cannot
 * collect until it is validated and the Owner's gate is on, host identity is separate from importer
 * ownership, analytics can attribute a view and an outbound click without the browser being able to
 * name the company, the >=100 rule never flatters a weak number, and nothing in Phase 1 can send.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-event-partners';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// ── A tiny stateful stand-in for pg. Routes are [regex, handler] and share one mutable store, so a
//    single-use token genuinely stops being usable after the first consume. ─────────────────────────
jest.mock('../../src/db', () => {
  const state = { routes: [], calls: [] };
  const query = async (sql, params) => {
    const text = String(sql);
    state.calls.push({ sql: text, params });
    for (const [re, handler] of state.routes) {
      if (re.test(text)) {
        const out = typeof handler === 'function' ? await handler(text, params) : handler;
        return Array.isArray(out) ? { rows: out, rowCount: out.length } : out;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    connect: async () => ({ query, release() {} }),
    pool: { end: async () => {} },
    __state: state,
  };
});
const db = require('../../src/db');
const setRoutes = (routes) => { db.__state.routes = routes; db.__state.calls = []; };
const calls = () => db.__state.calls;

const tokens = require('../../src/services/eventPartners/tokens');
const statement = require('../../src/services/eventPartners/authorizationStatement');
const authorization = require('../../src/services/eventPartners/authorizationService');
const partnerSource = require('../../src/services/eventPartners/partnerSourceService');
const performance = require('../../src/services/eventPartners/performanceStatsService');
const claimSecurity = require('../../src/services/organizationClaimSecurityService');
const analytics = require('../../src/services/analyticsService');
const agents = require('../../src/constants/marketingAgents');
const rbac = require('../../src/lib/rbac');
const configService = require('../../src/services/configService');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

// Config is read through configService in several services; stub it per-test.
let cfgValues = {};
beforeEach(() => {
  cfgValues = {};
  jest.spyOn(configService, 'get').mockImplementation(async (_org, key) => cfgValues[key]);
  setRoutes([]);
});
afterEach(() => { jest.restoreAllMocks(); });

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('token primitives', () => {
  test('a raw token is 43 base64url chars, unguessable, and never equals its stored form', () => {
    const raw = tokens.mintToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.isWellFormed(raw)).toBe(true);
    const hash = tokens.hashToken(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(raw);
    // Distinct tokens, every time.
    const many = new Set(Array.from({ length: 200 }, () => tokens.mintToken()));
    expect(many.size).toBe(200);
  });

  test('malformed tokens are rejected before any lookup can happen', () => {
    ['', null, undefined, 'short', 'x'.repeat(44), 'has spaces here ok!!', "' OR 1=1 --"].forEach((bad) => {
      expect(tokens.isWellFormed(bad)).toBe(false);
    });
  });

  test('secret comparison is length-safe and value-correct', () => {
    expect(tokens.safeEqual('abc', 'abc')).toBe(true);
    expect(tokens.safeEqual('abc', 'abd')).toBe(false);
    expect(tokens.safeEqual('abc', 'abcd')).toBe(false);   // different lengths must not throw
    expect(tokens.safeEqual(null, undefined)).toBe(true);  // both empty
  });

  test('IP evidence is one-way and drops loopback; only the first forwarded address is used', () => {
    const h = tokens.hashIp('198.51.100.7, 10.0.0.1');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).not.toMatch(/198/);
    expect(tokens.hashIp('198.51.100.7')).toBe(h);
    expect(tokens.hashIp('127.0.0.1')).toBeNull();
    expect(tokens.hashIp('::1')).toBeNull();
    expect(tokens.hashIp('')).toBeNull();
  });

  test('expiry is in the future and honours the requested window', () => {
    const d = tokens.expiresInDays(30);
    expect(d.getTime()).toBeGreaterThan(Date.now());
    expect(Math.round((d.getTime() - Date.now()) / 86400000)).toBe(30);
    expect(tokens.expiresInDays(0).getTime()).toBeGreaterThan(Date.now());   // bad input → safe default
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the authorization statement claims no more than it needs', () => {
  const s = statement.build({ companyName: 'ABC Estate Sales', domain: 'abcestatesales.com' });

  test('it states the grant, the company and the website plainly', () => {
    expect(s.version).toBe(statement.CURRENT_VERSION);
    expect(s.lead).toContain('ABC Estate Sales');
    expect(s.website_line).toContain('abcestatesales.com');
    expect(s.grant.join(' ')).toMatch(/publicly/i);
    expect(s.grant.join(' ')).toMatch(/no charge/i);
  });

  test('it disclaims an account, marketing email and any agency over the company', () => {
    const limits = s.limits.join(' ').toLowerCase();
    expect(limits).toMatch(/does not create an account/);
    expect(limits).toMatch(/marketing email/);
    expect(limits).toMatch(/withdraw/);
  });

  test('it never claims exclusivity, a content licence or ownership', () => {
    const all = [s.lead, s.summary].concat(s.grant, s.limits).join(' ').toLowerCase();
    ['exclusive', 'perpetual', 'irrevocable', 'licence to', 'license to', 'all rights', 'assign'].forEach((banned) => {
      expect(all).not.toContain(banned);
    });
  });

  test('the evidence snapshot preserves the literal words shown, not just a version number', () => {
    const snap = statement.evidenceSnapshot({ companyName: 'ABC Estate Sales', domain: 'abcestatesales.com' });
    expect(snap.statement_version).toBe(statement.CURRENT_VERSION);
    expect(snap.grant).toEqual(s.grant);
    expect(snap.limits).toEqual(s.limits);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('domain normalisation — the domain IS the unit of permission', () => {
  test('scheme, www, port, path and case all collapse to the registrable host', () => {
    ['abcestates.com', 'ABCEstates.com', 'https://abcestates.com', 'http://www.abcestates.com',
     'https://www.abcestates.com:8443/sales?x=1', 'www.abcestates.com/'].forEach((v) => {
      expect(authorization.normalizeDomain(v)).toBe('abcestates.com');
    });
  });

  test('a subdomain is preserved — it is a different host and a different permission', () => {
    expect(authorization.normalizeDomain('https://sales.abcestates.com')).toBe('sales.abcestates.com');
  });

  test('nothing usable returns null; a domain is never invented', () => {
    [null, '', '   ', 'not a domain', 'localhost', 'https://', 'javascript:alert(1)'].forEach((v) => {
      expect(authorization.normalizeDomain(v)).toBeNull();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the nine-state authorization lifecycle', () => {
  test('exactly the nine documented states exist', () => {
    expect(authorization.STATES.slice().sort()).toEqual([
      'authorized', 'collecting', 'declined', 'expired', 'invited',
      'paused', 'prospective', 'revoked', 'source_configured',
    ]);
    expect(authorization.STATES).toHaveLength(9);
  });

  test('revoked and declined are terminal — nothing moves out of them', () => {
    authorization.STATES.forEach((to) => {
      expect(authorization.canTransition('revoked', to)).toBe(false);
      expect(authorization.canTransition('declined', to)).toBe(false);
    });
  });

  test('a company can only be re-engaged from expired by a fresh invitation', () => {
    expect(authorization.canTransition('expired', 'invited')).toBe(true);
    expect(authorization.canTransition('expired', 'authorized')).toBe(false);
    expect(authorization.canTransition('expired', 'collecting')).toBe(false);
  });

  test('collection can never be reached without passing through configuration', () => {
    expect(authorization.canTransition('authorized', 'collecting')).toBe(false);
    expect(authorization.canTransition('invited', 'collecting')).toBe(false);
    expect(authorization.canTransition('source_configured', 'collecting')).toBe(true);
  });

  test('every state is revocable while live, and pausing is reversible', () => {
    ['prospective', 'invited', 'authorized', 'source_configured', 'collecting', 'paused'].forEach((s) => {
      expect(authorization.canTransition(s, 'revoked')).toBe(true);
    });
    expect(authorization.canTransition('collecting', 'paused')).toBe(true);
    expect(authorization.canTransition('paused', 'collecting')).toBe(true);
  });

  test('only the four states where permission actually exists count as authorized', () => {
    expect(authorization.AUTHORIZED_STATES.slice().sort())
      .toEqual(['authorized', 'collecting', 'paused', 'source_configured']);
    ['prospective', 'invited', 'declined', 'expired', 'revoked'].forEach((s) => {
      expect(authorization.AUTHORIZED_STATES).not.toContain(s);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('authorization link: preview is read-only, grant is single-use', () => {
  const raw = tokens.mintToken();
  const hash = tokens.hashToken(raw);

  function tokenStore(overrides) {
    const row = Object.assign({
      id: 'tok-1', authorization_id: 'auth-1', organization_id: UUID_A, token_hash: hash,
      recipient_email_normalized: 'owner@abcestates.com', purpose: 'authorize',
      expires_at: new Date(Date.now() + 86400000).toISOString(), used_at: null, attempts: 0,
      company_name: 'ABC Estate Sales', authorized_domain: 'abcestates.com', auth_status: 'invited',
    }, overrides || {});
    return row;
  }

  test('GET-style preview returns the statement and changes no state', async () => {
    const row = tokenStore();
    setRoutes([
      [/FROM event_partner_authorization_tokens t/, () => [row]],
      [/UPDATE event_partner_authorization_tokens SET attempts/, () => []],
    ]);
    const view = await authorization.previewToken(raw);
    expect(view.ok).toBe(true);
    expect(view.companyName).toBe('ABC Estate Sales');
    expect(view.statement.version).toBe(statement.CURRENT_VERSION);
    // Nothing but the attempt counter was written — no status change, no authorization row touched.
    const writes = calls().filter((c) => /UPDATE authorized_event_sources|INSERT INTO/.test(c.sql));
    expect(writes).toHaveLength(0);
  });

  test('preview never reaches the database for a malformed token', async () => {
    setRoutes([[/.*/, () => { throw new Error('should not query'); }]]);
    const view = await authorization.previewToken('not-a-valid-token');
    expect(view).toEqual({ ok: false, reason: 'invalid' });
    expect(calls()).toHaveLength(0);
  });

  test('preview reports used, expired and already-authorized distinctly', async () => {
    for (const [override, reason] of [
      [{ used_at: new Date().toISOString() }, 'already_used'],
      [{ expires_at: new Date(Date.now() - 1000).toISOString() }, 'expired'],
      [{ auth_status: 'collecting' }, 'already_authorized'],
      [{ auth_status: 'revoked' }, 'not_available'],
    ]) {
      setRoutes([
        [/FROM event_partner_authorization_tokens t/, () => [tokenStore(override)]],
        [/UPDATE event_partner_authorization_tokens SET attempts/, () => []],
      ]);
      const view = await authorization.previewToken(raw);
      expect(view.ok).toBe(false);
      expect(view.reason).toBe(reason);
    }
  });

  test('every presentation increments attempts, so probing is visible', async () => {
    setRoutes([
      [/FROM event_partner_authorization_tokens t/, () => [tokenStore()]],
      [/UPDATE event_partner_authorization_tokens SET attempts/, () => []],
    ]);
    await authorization.previewToken(raw);
    expect(calls().some((c) => /SET attempts = attempts \+ 1/.test(c.sql))).toBe(true);
  });

  test('the grant requires an explicit confirmation — a bare POST authorizes nothing', async () => {
    setRoutes([[/.*/, () => { throw new Error('should not query'); }]]);
    await expect(authorization.authorizeWithToken(raw, { agreed: false }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(authorization.authorizeWithToken(raw, {}))
      .rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });

  test('granting consumes the link atomically and records the statement as evidence', async () => {
    const store = { used: false };
    let updated = null;
    setRoutes([
      [/UPDATE event_partner_authorization_tokens\s+SET used_at = now\(\), used_ip_hash/, () => {
        if (store.used) return [];                 // the conditional UPDATE matches zero rows the 2nd time
        store.used = true;
        return [tokenStore()];
      }],
      [/SELECT used_at, expires_at FROM event_partner_authorization_tokens/, () => [{ used_at: new Date().toISOString(), expires_at: tokenStore().expires_at }]],
      [/SELECT \* FROM authorized_event_sources WHERE id = \$1 FOR UPDATE/, () => [{
        id: 'auth-1', organization_id: UUID_A, company_name: 'ABC Estate Sales',
        authorized_domain: 'abcestates.com', status: 'invited',
      }]],
      [/UPDATE authorized_event_sources\s+SET status = 'authorized'/, (sql, params) => {
        updated = params;
        return [{ id: 'auth-1', company_name: 'ABC Estate Sales', authorized_domain: 'abcestates.com',
                  status: 'authorized', authorized_at: new Date().toISOString() }];
      }],
      [/INSERT INTO audit_log/, () => []],
    ]);

    const row = await authorization.authorizeWithToken(raw, {
      agreed: true, ip: '198.51.100.7', userAgent: 'Mozilla/5.0', origin: 'https://bid.advantage.bid',
    });
    expect(row.status).toBe('authorized');

    // Evidence: the literal statement, the token consumed, the recipient binding, a hashed IP.
    const evidence = JSON.parse(updated[4]);
    expect(evidence.statement.statement_version).toBe(statement.CURRENT_VERSION);
    expect(evidence.statement.grant.length).toBeGreaterThan(0);
    expect(evidence.token_id).toBe('tok-1');
    expect(evidence.recipient_bound).toBe(true);
    expect(evidence.confirmed_via).toBe('post_confirmation');
    expect(evidence.request.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    // The raw IP and the raw token never reach storage.
    const everything = JSON.stringify(calls());
    expect(everything).not.toContain('198.51.100.7');
    expect(everything).not.toContain(raw);
  });

  test('replaying the same link is refused — the second attempt cannot grant', async () => {
    const store = { used: true };   // already consumed
    setRoutes([
      [/UPDATE event_partner_authorization_tokens\s+SET used_at = now\(\), used_ip_hash/, () => []],
      [/SELECT used_at, expires_at FROM event_partner_authorization_tokens/, () => [{
        used_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
      }]],
    ]);
    await expect(authorization.authorizeWithToken(raw, { agreed: true }))
      .rejects.toMatchObject({ code: 'ALREADY_USED', status: 409 });
    expect(store.used).toBe(true);
  });

  test('an expired link is refused with its own code, never silently treated as invalid', async () => {
    setRoutes([
      [/UPDATE event_partner_authorization_tokens\s+SET used_at = now\(\), used_ip_hash/, () => []],
      [/SELECT used_at, expires_at FROM event_partner_authorization_tokens/, () => [{
        used_at: null, expires_at: new Date(Date.now() - 1000).toISOString(),
      }]],
    ]);
    await expect(authorization.authorizeWithToken(raw, { agreed: true }))
      .rejects.toMatchObject({ code: 'EXPIRED', status: 410 });
  });

  test('an unknown link is refused and reveals nothing about which links exist', async () => {
    setRoutes([
      [/UPDATE event_partner_authorization_tokens\s+SET used_at = now\(\), used_ip_hash/, () => []],
      [/SELECT used_at, expires_at FROM event_partner_authorization_tokens/, () => []],
    ]);
    await expect(authorization.authorizeWithToken(raw, { agreed: true }))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN', status: 404 });
  });

  test('offline authorization always demands stated evidence and a named administrator', async () => {
    await expect(authorization.recordOfflineAuthorization('auth-1', { method: 'bogus', evidence: 'x'.repeat(20), actorId: USER_ID }))
      .rejects.toMatchObject({ code: 'INVALID_METHOD' });
    await expect(authorization.recordOfflineAuthorization('auth-1', { method: 'written_agreement', evidence: 'short', actorId: USER_ID }))
      .rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });
    await expect(authorization.recordOfflineAuthorization('auth-1', { method: 'written_agreement', evidence: 'Countersigned agreement on file, ref 2026-114.' }))
      .rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('revocation', () => {
  test('revoking disables the attached source in the same transaction and is terminal', async () => {
    const seen = [];
    setRoutes([
      [/SELECT \* FROM authorized_event_sources WHERE id = \$1 FOR UPDATE/, () => [{
        id: 'auth-1', organization_id: UUID_A, status: 'collecting', import_source_id: 'src-1',
      }]],
      [/UPDATE import_sources SET status = 'disabled'/, (sql, params) => { seen.push(params); return []; }],
      [/UPDATE authorized_event_sources\s+SET status = 'revoked'/, () => [{ id: 'auth-1', status: 'revoked' }]],
      [/INSERT INTO audit_log/, () => []],
    ]);
    const row = await authorization.revoke('auth-1', { reason: 'Company asked us to stop', via: 'company_request', actorId: USER_ID });
    expect(row.status).toBe('revoked');
    expect(seen).toEqual([['src-1']]);   // the source was disabled, not merely paused
  });

  test('revoking twice is idempotent rather than an error', async () => {
    setRoutes([
      [/SELECT \* FROM authorized_event_sources WHERE id = \$1 FOR UPDATE/, () => [{ id: 'auth-1', status: 'revoked' }]],
    ]);
    const row = await authorization.revoke('auth-1', { actorId: USER_ID });
    expect(row.status).toBe('revoked');
    expect(calls().some((c) => /UPDATE authorized_event_sources/.test(c.sql))).toBe(false);
  });

  test('revocation is a different record from an email unsubscribe — it touches no email table', async () => {
    setRoutes([
      [/SELECT \* FROM authorized_event_sources WHERE id = \$1 FOR UPDATE/, () => [{ id: 'auth-1', status: 'collecting', import_source_id: null, organization_id: UUID_A }]],
      [/UPDATE authorized_event_sources\s+SET status = 'revoked'/, () => [{ id: 'auth-1', status: 'revoked' }]],
      [/INSERT INTO audit_log/, () => []],
    ]);
    await authorization.revoke('auth-1', { actorId: USER_ID });
    const sql = calls().map((c) => c.sql).join(' ');
    expect(sql).not.toMatch(/email_suppressions|marketing_contacts|notification_preferences/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('per-company import source safety checklist', () => {
  const good = {
    authorizedDomain: 'abcestates.com',
    feedUrl: 'https://abcestates.com/sales/feed.xml',
    connector: 'feed', kind: 'rss',
    termsAttestedBy: 'ops@advantage.bid', termsAttestedUrl: 'https://abcestates.com/terms',
    robotsChecked: true, robotsCheckedBy: USER_ID,
    attributionName: 'ABC Estate Sales', attributionUrl: 'https://abcestates.com',
    mediaPolicy: 'link_only', autoPublish: false,
  };

  test('a complete, compliant configuration passes', () => {
    const r = partnerSource.validateSourceConfig(good);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  test('a feed pointed off the authorized domain is refused — this is the repointing guard', () => {
    const r = partnerSource.validateSourceConfig(Object.assign({}, good, { feedUrl: 'https://someoneelse.com/feed.xml' }));
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('feed_on_authorized_domain');
  });

  test('a subdomain of the authorized domain is accepted', () => {
    const r = partnerSource.validateSourceConfig(Object.assign({}, good, { feedUrl: 'https://sales.abcestates.com/feed.xml' }));
    expect(r.failures).not.toContain('feed_on_authorized_domain');
  });

  test('a lookalike domain is NOT accepted', () => {
    const r = partnerSource.validateSourceConfig(Object.assign({}, good, { feedUrl: 'https://notabcestates.com/feed.xml' }));
    expect(r.failures).toContain('feed_on_authorized_domain');
  });

  test('unattested terms or robots block the source', () => {
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { termsAttestedBy: null })).failures).toContain('terms_attested');
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { termsAttestedUrl: null })).failures).toContain('terms_attested');
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { robotsChecked: false })).failures).toContain('robots_attested');
  });

  test('attribution is mandatory — an imported event must credit the company', () => {
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { attributionName: null })).failures).toContain('attribution_present');
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { attributionUrl: null })).failures).toContain('attribution_present');
  });

  test('image mirroring and auto-publish are refused, so the real-image publication gate stays in charge', () => {
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { mediaPolicy: 'mirror' })).failures).toContain('media_policy_safe');
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { autoPublish: true })).failures).toContain('auto_publish_off');
  });

  test('plaintext feeds and unapproved connectors are refused', () => {
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { feedUrl: 'http://abcestates.com/feed.xml' })).failures).toContain('feed_url_https');
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { connector: 'gsa' })).failures).toContain('connector_allowed');
    expect(partnerSource.validateSourceConfig(Object.assign({}, good, { kind: 'csv' })).failures).toContain('kind_allowed');
  });

  test('a partner may only ever use the consented-feed connector', () => {
    expect(partnerSource.ALLOWED_CONNECTORS).toEqual(['feed']);
    expect(partnerSource.DEFAULTS.auto_publish).toBe(false);
    expect(partnerSource.DEFAULTS.media_policy).toBe('link_only');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('collection cannot start by accident', () => {
  test('activate() refuses while the Owner gate is off, however valid the source is', async () => {
    cfgValues['event_partners.collection_enabled'] = false;
    await expect(partnerSource.activate('auth-1', { actorId: USER_ID }))
      .rejects.toMatchObject({ code: 'COLLECTION_DISABLED' });
    // It refused before touching anything.
    expect(calls().some((c) => /UPDATE import_sources/.test(c.sql))).toBe(false);
  });

  test('activate() refuses an unvalidated source even with the gate on', async () => {
    cfgValues['event_partners.collection_enabled'] = true;
    setRoutes([
      [/SELECT \* FROM authorized_event_sources WHERE id = \$1 FOR UPDATE/, () => [{
        id: 'auth-1', status: 'authorized', import_source_id: 'src-1', source_validated_at: null,
      }]],
    ]);
    await expect(partnerSource.activate('auth-1', { actorId: USER_ID }))
      .rejects.toMatchObject({ code: 'NOT_VALIDATED' });
    expect(calls().some((c) => /UPDATE import_sources SET status = 'active'/.test(c.sql))).toBe(false);
  });

  test('a source cannot be created for a company that has not authorized', async () => {
    setRoutes([
      [/SELECT \* FROM authorized_event_sources WHERE id = \$1 FOR UPDATE/, () => [{
        id: 'auth-1', status: 'invited', organization_id: UUID_A,
      }]],
    ]);
    await expect(partnerSource.createForAuthorization('auth-1', { actorId: USER_ID }))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  test('resuming re-checks the gate: with it off the partner returns to configured, not collecting', async () => {
    cfgValues['event_partners.collection_enabled'] = false;
    let target = null;
    setRoutes([
      [/SELECT \* FROM authorized_event_sources WHERE id = \$1 FOR UPDATE/, () => [{
        id: 'auth-1', status: 'paused', import_source_id: 'src-1',
        source_validated_at: new Date().toISOString(),
      }]],
      [/UPDATE authorized_event_sources SET status = \$2/, (sql, params) => { target = params[1]; return [{ id: 'auth-1', status: params[1] }]; }],
      [/INSERT INTO audit_log/, () => []],
    ]);
    const row = await partnerSource.resume('auth-1', { actorId: USER_ID });
    expect(target).toBe('source_configured');
    expect(row.status).toBe('source_configured');
    expect(calls().some((c) => /UPDATE import_sources SET status = 'active'/.test(c.sql))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('claim security — first-authenticated-user-wins is closed', () => {
  const verifiedCompanyUser = { id: USER_ID, email: 'owner@abcestates.com', email_verified: true };
  const org = { id: UUID_A, name: 'ABC Estate Sales', website_url: 'https://abcestates.com', contact_email: 'info@abcestates.com' };
  const client = { query: db.query };

  function baseRoutes(extra) {
    return [
      [/FROM authorized_event_sources\s+WHERE organization_id = \$1 AND status NOT IN/, () => []],
      [/SELECT id, name, website_url, contact_email FROM organizations/, () => [org]],
      [/INSERT INTO organization_claim_attempts/, () => []],
    ].concat(extra || []);
  }

  test('a random signed-in stranger is refused', async () => {
    cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
    setRoutes(baseRoutes());
    await expect(claimSecurity.verifyClaimProof(client,
      { id: USER_ID, email: 'stranger@gmail.com', email_verified: true }, UUID_A, {}))
      .rejects.toMatchObject({ code: 'CLAIM_VERIFICATION_REQUIRED', status: 403 });
  });

  test('a free-mailbox address never satisfies the domain rung, even if the listing also uses one', async () => {
    cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
    setRoutes(baseRoutes([
      [/SELECT id, name, website_url, contact_email FROM organizations/, () => [
        { id: UUID_A, name: 'X', website_url: null, contact_email: 'abcestates@gmail.com' }],
      ],
    ]));
    await expect(claimSecurity.verifyClaimProof(client,
      { id: USER_ID, email: 'anyone@gmail.com', email_verified: true }, UUID_A, {}))
      .rejects.toMatchObject({ code: 'CLAIM_VERIFICATION_REQUIRED' });
  });

  test('an unverified email is refused even when the domain matches', async () => {
    cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
    setRoutes(baseRoutes());
    await expect(claimSecurity.verifyClaimProof(client,
      { id: USER_ID, email: 'owner@abcestates.com', email_verified: false }, UUID_A, {}))
      .rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  test('a verified company-domain address is accepted and recorded as such', async () => {
    cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
    setRoutes(baseRoutes());
    const out = await claimSecurity.verifyClaimProof(client, verifiedCompanyUser, UUID_A, {});
    expect(out.ok).toBe(true);
    expect(out.proofMethod).toBe('verified_email_domain');
  });

  test('every denial is written to the evidence table with its reason', async () => {
    cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
    const attempts = [];
    setRoutes([
      [/INSERT INTO organization_claim_attempts/, (sql, params) => { attempts.push(params); return []; }],
    ].concat(baseRoutes()));
    await expect(claimSecurity.verifyClaimProof(client,
      { id: USER_ID, email: 'stranger@example.org', email_verified: true }, UUID_A, {})).rejects.toThrow();
    expect(attempts).toHaveLength(1);
    expect(attempts[0][2]).toBe('denied');
    expect(attempts[0][4]).toBe('CLAIM_VERIFICATION_REQUIRED');
  });

  test('an Event Partner listing always requires a token — the domain rung does not apply', async () => {
    cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
    setRoutes([
      // This organization IS an event partner.
      [/FROM authorized_event_sources\s+WHERE organization_id = \$1 AND status NOT IN/, () => [{ '?column?': 1 }]],
      [/SELECT id, name, website_url, contact_email FROM organizations/, () => [org]],
      [/INSERT INTO organization_claim_attempts/, () => []],
    ]);
    await expect(claimSecurity.verifyClaimProof(client, verifiedCompanyUser, UUID_A, {}))
      .rejects.toMatchObject({ code: 'CLAIM_TOKEN_REQUIRED' });
  });

  test("the token_only policy requires a token for every listing", async () => {
    cfgValues['organizations.claim_proof_policy'] = 'token_only';
    setRoutes(baseRoutes());
    await expect(claimSecurity.verifyClaimProof(client, verifiedCompanyUser, UUID_A, {}))
      .rejects.toMatchObject({ code: 'CLAIM_TOKEN_REQUIRED' });
  });

  describe('claim tokens', () => {
    const raw = tokens.mintToken();
    const tokenRow = (o) => Object.assign({
      id: 'ct-1', organization_id: UUID_A, token_hash: tokens.hashToken(raw),
      invited_email_normalized: 'owner@abcestates.com',
      expires_at: new Date(Date.now() + 86400000).toISOString(), used_at: null, attempts: 0,
    }, o || {});

    const withToken = (o, extra) => setRoutes(baseRoutes([
      [/SELECT \* FROM organization_claim_tokens WHERE token_hash = \$1 FOR UPDATE/, () => [tokenRow(o)]],
      [/UPDATE organization_claim_tokens SET attempts/, () => []],
    ].concat(extra || [])));

    test('a token for a DIFFERENT company cannot claim this one', async () => {
      cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
      withToken({ organization_id: UUID_B });
      await expect(claimSecurity.verifyClaimProof(client, verifiedCompanyUser, UUID_A, { claimToken: raw }))
        .rejects.toMatchObject({ code: 'CLAIM_TOKEN_WRONG_ORG' });
    });

    test('a token forwarded to the wrong person cannot be redeemed', async () => {
      cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
      withToken();
      await expect(claimSecurity.verifyClaimProof(client,
        { id: USER_ID, email: 'someoneelse@abcestates.com', email_verified: true }, UUID_A, { claimToken: raw }))
        .rejects.toMatchObject({ code: 'CLAIM_TOKEN_WRONG_RECIPIENT' });
    });

    test('an expired or already-used token is refused', async () => {
      cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
      withToken({ expires_at: new Date(Date.now() - 1000).toISOString() });
      await expect(claimSecurity.verifyClaimProof(client, verifiedCompanyUser, UUID_A, { claimToken: raw }))
        .rejects.toMatchObject({ code: 'CLAIM_TOKEN_EXPIRED' });
      withToken({ used_at: new Date().toISOString() });
      await expect(claimSecurity.verifyClaimProof(client, verifiedCompanyUser, UUID_A, { claimToken: raw }))
        .rejects.toMatchObject({ code: 'CLAIM_TOKEN_USED' });
    });

    test('a malformed token is refused without a lookup', async () => {
      cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
      setRoutes(baseRoutes());
      await expect(claimSecurity.verifyClaimProof(client, verifiedCompanyUser, UUID_A, { claimToken: 'garbage' }))
        .rejects.toMatchObject({ code: 'CLAIM_TOKEN_INVALID' });
      expect(calls().some((c) => /organization_claim_tokens WHERE token_hash/.test(c.sql))).toBe(false);
    });

    test('a valid token is consumed atomically and grants the claim', async () => {
      cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
      let consumed = false;
      withToken({}, [
        [/UPDATE organization_claim_tokens\s+SET used_at = now\(\), used_by_user_id/, () => {
          if (consumed) return [];
          consumed = true;
          return [{ id: 'ct-1' }];
        }],
      ]);
      const out = await claimSecurity.verifyClaimProof(client, verifiedCompanyUser, UUID_A, { claimToken: raw, ip: '198.51.100.7' });
      expect(out.ok).toBe(true);
      expect(out.proofMethod).toBe('claim_token');
      expect(out.claimTokenId).toBe('ct-1');
      expect(consumed).toBe(true);
      expect(JSON.stringify(calls())).not.toContain(raw);   // the raw token never reaches the database
    });

    test('losing the atomic consume race is refused rather than granted', async () => {
      cfgValues['organizations.claim_proof_policy'] = 'token_or_verified_domain';
      withToken({}, [
        [/UPDATE organization_claim_tokens\s+SET used_at = now\(\), used_by_user_id/, () => []],
      ]);
      await expect(claimSecurity.verifyClaimProof(client, verifiedCompanyUser, UUID_A, { claimToken: raw }))
        .rejects.toMatchObject({ code: 'CLAIM_TOKEN_USED' });
    });

    test('issuing a claim link requires an administrator and a valid recipient', async () => {
      await expect(claimSecurity.issueClaimToken(UUID_A, { invitedEmail: 'a@b.com' }))
        .rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
      await expect(claimSecurity.issueClaimToken(UUID_A, { invitedEmail: 'not-an-email', actorId: USER_ID }))
        .rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    });

    test('a claim link is never issued for an already-owned listing', async () => {
      setRoutes([
        [/SELECT id, name, lifecycle_state FROM organizations/, () => [{ id: UUID_A, name: 'X', lifecycle_state: 'claimed' }]],
        [/SELECT 1 FROM organization_members WHERE organization_id = \$1 AND role = 'owner'/, () => [{ '?column?': 1 }]],
      ]);
      await expect(claimSecurity.issueClaimToken(UUID_A, { invitedEmail: 'owner@abcestates.com', actorId: USER_ID }))
        .rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('analytics attribution', () => {
  test('event_view and event_outbound_click are registered first-party types', () => {
    expect(analytics.KNOWN_EVENT_TYPES.has('event_view')).toBe(true);
    expect(analytics.KNOWN_EVENT_TYPES.has('event_outbound_click')).toBe(true);
    expect(analytics.KNOWN_EVENT_TYPES.has('storefront_view')).toBe(true);
  });

  test('the host company is resolved from the event id, never taken from the browser', async () => {
    let inserted = null;
    setRoutes([
      [/SELECT host_organization_id FROM events WHERE id = \$1/, () => [{ host_organization_id: UUID_A }]],
      [/INSERT INTO analytics_events/, (sql, params) => { inserted = params; return []; }],
    ]);
    analytics._HOST_CACHE.clear();
    await analytics.insertEvent({
      event_type: 'event_view', event_id: EVENT_ID,
      // A hostile client naming a different company must be ignored entirely.
      organization_id: UUID_B,
    }, '198.51.100.7');
    expect(inserted[17]).toBe(EVENT_ID);
    expect(inserted[18]).toBe(UUID_A);       // resolved server-side
    expect(inserted[18]).not.toBe(UUID_B);   // the client's claim was discarded
  });

  test('an unattributed event stores a null company rather than guessing one', async () => {
    let inserted = null;
    setRoutes([
      [/SELECT host_organization_id FROM events WHERE id = \$1/, () => [{ host_organization_id: null }]],
      [/INSERT INTO analytics_events/, (sql, params) => { inserted = params; return []; }],
    ]);
    analytics._HOST_CACHE.clear();
    await analytics.insertEvent({ event_type: 'event_view', event_id: EVENT_ID }, '');
    expect(inserted[17]).toBe(EVENT_ID);
    expect(inserted[18]).toBeNull();
  });

  test('a malformed event id is dropped, and no company is looked up for it', async () => {
    let inserted = null;
    setRoutes([
      [/SELECT host_organization_id FROM events/, () => { throw new Error('should not resolve'); }],
      [/INSERT INTO analytics_events/, (sql, params) => { inserted = params; return []; }],
    ]);
    analytics._HOST_CACHE.clear();
    await analytics.insertEvent({ event_type: 'event_view', event_id: 'not-a-uuid' }, '');
    expect(inserted[17]).toBeNull();
    expect(inserted[18]).toBeNull();
  });

  test('the IP is still hashed, never stored raw', async () => {
    let inserted = null;
    setRoutes([[/INSERT INTO analytics_events/, (sql, params) => { inserted = params; return []; }]]);
    await analytics.insertEvent({ event_type: 'event_outbound_click' }, '198.51.100.7');
    expect(inserted[12]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(inserted)).not.toContain('198.51.100.7');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the >=100 performance rule never flatters a weak number', () => {
  const counts = (views, clicks) => setRoutes([
    [/FROM analytics_events\s+WHERE organization_id = \$1/, () => [
      { event_type: 'event_view', total: views, unique_visitors: Math.floor(views / 2) },
      { event_type: 'event_outbound_click', total: clicks, unique_visitors: Math.floor(clicks / 2) },
    ]],
  ]);

  test('99 is not enough — one short of the bar is still benefits_only', async () => {
    cfgValues['event_partners.performance_min_metric'] = 100;
    counts(99, 12);
    const r = await performance.evaluate(UUID_A, {});
    expect(r.mode).toBe('benefits_only');
    expect(r.eligible_metrics).toEqual([]);
    expect(r.shortfall).toBe(1);
    expect(r.claims).toBeUndefined();     // there is nothing quotable to hand a caller
    expect(r.stats.event_views).toBe(99); // the true number is still visible internally
  });

  test('exactly 100 qualifies, and the figure quoted is the exact count', async () => {
    cfgValues['event_partners.performance_min_metric'] = 100;
    counts(100, 3);
    const r = await performance.evaluate(UUID_A, {});
    expect(r.mode).toBe('performance_stats_eligible');
    expect(r.eligible_metrics).toEqual(['event_views']);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].value).toBe(100);
  });

  test('eligibility is per metric: 247 views with 12 clicks offers the views claim only', async () => {
    cfgValues['event_partners.performance_min_metric'] = 100;
    counts(247, 12);
    const r = await performance.evaluate(UUID_A, {});
    expect(r.eligible_metrics).toEqual(['event_views']);
    expect(r.claims.map((c) => c.value)).toEqual([247]);
    expect(JSON.stringify(r.claims)).not.toContain('12');
  });

  test('both metrics can qualify independently, each with its own true value', async () => {
    cfgValues['event_partners.performance_min_metric'] = 100;
    counts(247, 132);
    const r = await performance.evaluate(UUID_A, {});
    expect(r.eligible_metrics.slice().sort()).toEqual(['event_views', 'outbound_clicks']);
    expect(r.claims.find((c) => c.metric === 'event_views').value).toBe(247);
    expect(r.claims.find((c) => c.metric === 'outbound_clicks').value).toBe(132);
  });

  test('zero activity is benefits_only, never an empty boast', async () => {
    cfgValues['event_partners.performance_min_metric'] = 100;
    setRoutes([[/FROM analytics_events\s+WHERE organization_id = \$1/, () => []]]);
    const r = await performance.evaluate(UUID_A, {});
    expect(r.mode).toBe('benefits_only');
    expect(r.stats).toEqual({ event_views: 0, event_view_visitors: 0, outbound_clicks: 0, outbound_click_visitors: 0 });
  });

  test('the threshold can be raised but never lowered below 100 by configuration', async () => {
    cfgValues['event_partners.performance_min_metric'] = 5;
    counts(50, 0);
    expect((await performance.evaluate(UUID_A, {})).mode).toBe('benefits_only');
    expect(await performance.threshold()).toBe(100);

    cfgValues['event_partners.performance_min_metric'] = 500;
    counts(300, 0);
    const r = await performance.evaluate(UUID_A, {});
    expect(r.threshold).toBe(500);
    expect(r.mode).toBe('benefits_only');
  });

  test('a caller cannot lower the bar by passing its own threshold', async () => {
    cfgValues['event_partners.performance_min_metric'] = 100;
    counts(40, 0);
    const r = await performance.evaluate(UUID_A, { threshold: 10 });
    expect(r.threshold).toBe(100);
    expect(r.mode).toBe('benefits_only');
  });

  test('nothing is sent — the service only ever returns data', () => {
    const src = read('src', 'services', 'eventPartners', 'performanceStatsService.js');
    expect(src).not.toMatch(/emailService|sendEmail|nodemailer|marketingSend/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('A15 exists and can do nothing that reaches a company', () => {
  const a15 = agents.get('A15');

  test('it is registered under the Marketing Director roster', () => {
    expect(a15).toBeTruthy();
    expect(a15.key).toBe('a15_event_partner');
    expect(a15.name).toBe('Event Partner Outreach');
    expect(a15.tier).toBe('growth');
  });

  test('it cannot publish, spend or review', () => {
    expect(a15.canPublish).toBe(false);
    expect(a15.canSpend).toBe(false);
    expect(a15.canReview).toBe(false);
    expect(agents.canPublish('A15')).toBe(false);
    expect(agents.canSpend('A15')).toBe(false);
  });

  test('it may draft, propose and read — and nothing else', () => {
    expect(a15.capabilities.slice().sort())
      .toEqual(['draft_partner_outreach', 'propose_partner_outreach', 'read_partner_metrics']);
    ['send_email', 'send_partner_outreach', 'authorize_source', 'grant_claim', 'publish_partner']
      .forEach((cap) => expect(agents.agentCan('A15', cap)).toBe(false));
  });

  test('no agent anywhere in the roster holds a Phase 1 forbidden capability', () => {
    Object.values(agents.AGENTS).forEach((a) => {
      agents.FORBIDDEN_PHASE1_CAPABILITIES.forEach((cap) => {
        expect(a.capabilities).not.toContain(cap);
      });
    });
  });

  test('only the Director and Paid Media may spend — A15 did not change that', () => {
    const spenders = Object.values(agents.AGENTS).filter((a) => a.canSpend).map((a) => a.code).sort();
    expect(spenders).toEqual(['A1', 'A8']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('permissions', () => {
  test('the two Event Partner permissions exist', () => {
    expect(rbac.PERMISSIONS).toContain('event_partners.view');
    expect(rbac.PERMISSIONS).toContain('event_partners.manage');
  });

  test('Marketing/Sales staff can look but not act', () => {
    const marketing = rbac.ROLES.marketing.permissions;
    expect(marketing).toContain('event_partners.view');
    expect(marketing).not.toContain('event_partners.manage');
  });

  test('the Super Admin retains everything', () => {
    expect(rbac.ROLES.super_admin.permissions).toBe('*');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('source-level guarantees the runtime cannot express', () => {
  test('migration 153 is additive and reassigns no historical event', () => {
    const m = read('db', 'migrations', '153_event_partner_authorization_foundation.sql');
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS authorized_event_sources/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS event_partner_authorization_tokens/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS organization_claim_tokens/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS host_organization_id/);
    // No destructive or rewriting statement anywhere.
    expect(m).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(m).not.toMatch(/UPDATE\s+events\s+SET/i);
    expect(m).not.toMatch(/DELETE\s+FROM/i);
    // It creates no import source, so deploying it collects nothing.
    expect(m).not.toMatch(/INSERT INTO import_sources/i);
  });

  test('every new Owner gate ships off', () => {
    const m = read('db', 'migrations', '153_event_partner_authorization_foundation.sql');
    ["('event_partners.enabled',                'false'",
     "('event_partners.collection_enabled',     'false'",
     "('event_partners.outreach_enabled',       'false'"].forEach((line) => {
      expect(m).toContain(line);
    });
    expect(m).toMatch(/\('event_partners\.performance_min_metric', '100'/);
  });

  test('host identity is a separate column from importer ownership', () => {
    const m = read('db', 'migrations', '153_event_partner_authorization_foundation.sql');
    expect(m).toMatch(/host_organization_id\s+uuid REFERENCES organizations\(id\)/);
    // A host can never be recorded without saying how it was proven.
    expect(m).toMatch(/chk_events_host_requires_method/);
    const writer = read('src', 'services', 'eventImport', 'writer.js');
    // The importer's own ownership column stays immutable.
    expect(writer).toMatch(/!\['slug', 'organization_id', 'source', 'status'\]\.includes\(k\)/);
  });

  test('the import writer attributes a host only through the authorized-source path', () => {
    const svc = read('src', 'services', 'eventPartners', 'hostAttributionService.js');
    expect(svc).toMatch(/status IN \('authorized','source_configured','collecting','paused'\)/);
    // Historical matching reports; it never applies.
    expect(svc).toMatch(/requires_admin_confirmation: true/);
    expect(svc).toMatch(/organizer_website_url_host/);
    // Name similarity is deliberately not evidence.
    expect(svc).not.toMatch(/organizer_name\s+ILIKE/i);
  });

  test('the storefront beacon now sends event_type, so storefront_view is no longer discarded', () => {
    const html = read('public', 'storefront.html');
    expect(html).toContain('event_type:type');
    expect(html).not.toMatch(/Object\.assign\(\{type:type/);
  });

  test('the outbound CTA keeps its nofollow/noopener/noreferrer and new-tab behaviour', () => {
    const html = read('public', 'event.html');
    expect(html).toContain('rel="nofollow noopener noreferrer"');
    expect(html).toMatch(/var EXT = ' target="_blank" rel="nofollow noopener noreferrer"'/);
  });

  test('event view and click are each fired at most once per event per session', () => {
    const html = read('public', 'event.html');
    expect(html).toMatch(/sessionStorage\.getItem\(k\)/);
    expect(html).toMatch(/once\('view'/);
    expect(html).toMatch(/once\('outclick'/);
    expect(html).toMatch(/event_outbound_click/);
  });

  test('the browser never names the company its activity is credited to', () => {
    expect(read('public', 'widgets', 'shared', 'analytics.js')).not.toMatch(/payload\.organization_id/);
    expect(read('public', 'widgets', 'shared', 'behavior-tracker.js')).not.toMatch(/ctx\.organization_id/);
    expect(read('public', 'event.html')).not.toMatch(/organization_id:/);
  });

  test('the authorization page is a POST-confirmed grant and is kept out of search results', () => {
    const html = read('public', 'authorize-event-promotion.html');
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    expect(html).toMatch(/method: 'POST'/);
    expect(html).toMatch(/confirm: true/);
    // No account, password or payment anywhere in the flow.
    expect(html).not.toMatch(/type="password"/);
  });

  test('nothing in the Phase 1 Event Partner code can send an email', () => {
    ['authorizationService.js', 'partnerSourceService.js', 'hostAttributionService.js',
     'performanceStatsService.js', 'tokens.js', 'authorizationStatement.js'].forEach((f) => {
      const src = read('src', 'services', 'eventPartners', f);
      expect(src).not.toMatch(/emailService|sendEmail|nodemailer|smtp|marketingSendService/i);
    });
    ['adminEventPartners.js', 'publicEventPartner.js'].forEach((f) => {
      const src = read('src', 'routes', f);
      expect(src).not.toMatch(/emailService|sendEmail|nodemailer/i);
    });
  });

  test('nothing in the Phase 1 code touches the Brilliant Directories mailbox', () => {
    ['src/services/eventPartners/authorizationService.js', 'src/services/eventPartners/partnerSourceService.js',
     'src/routes/adminEventPartners.js', 'src/routes/publicEventPartner.js',
     'public/authorize-event-promotion.html'].forEach((rel) => {
      const src = read.apply(null, rel.split('/'));
      expect(src).not.toMatch(/events@advantage\.bid/i);
      expect(src).not.toMatch(/imap|pop3|directorysecure/i);
    });
  });

  test('the admin surface has no send-campaign control', () => {
    const route = read('src', 'routes', 'adminEventPartners.js');
    expect(route).not.toMatch(/router\.(post|put)\('\/[^']*\/(send|campaign|outreach)/);
    const page = read('public', 'admin', 'event-partners.html');
    expect(page).not.toMatch(/Send campaign|Send outreach|Send email/i);
  });

  test('no visible surface introduces AI or vendor terminology', () => {
    ['public/authorize-event-promotion.html', 'public/claim-listing.html', 'public/admin/event-partners.html']
      .forEach((rel) => {
        const src = read.apply(null, rel.split('/'));
        expect(src).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|machine learning|GPT|OpenAI|LLM/i);
        expect(src).not.toMatch(/Cloudinary|Railway|Neon|Postmark|nodemailer|Amazon SES/i);
      });
  });
});
