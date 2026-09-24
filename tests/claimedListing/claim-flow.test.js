'use strict';

/**
 * Claimed Listing — the token-first claim experience.
 * Scanner traffic never consumes a token or counts as engagement; replayed and foreign tokens are
 * refused; the email always comes from the token binding; an existing account must sign in; mailbox
 * control alone never transfers an already-claimed listing; exits stop outreach and suppress.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-claimed-listing';
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

jest.mock('../../src/db', () => {
  const state = { routes: [], calls: [] };
  const query = async (sql, params) => {
    const text = String(sql);
    state.calls.push({ sql: text, params });
    for (const [re, handler] of state.routes) if (re.test(text)) {
      const out = typeof handler === 'function' ? await handler(text, params) : handler;
      return Array.isArray(out) ? { rows: out, rowCount: out.length } : out;
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), pool: { end: async () => {} }, __state: state };
});
jest.mock('../../src/services/organizationLifecycleService', () => ({ claim: jest.fn() }));
jest.mock('../../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: '<m1@x>' })), isConfigured: () => true,
  claimedListingConfigurationSet: () => null, EMAIL_FROM: 'notifications@advantage.bid' }));

const db = require('../../src/db');
const lifecycle = require('../../src/services/organizationLifecycleService');
const tokens = require('../../src/services/eventPartners/tokens');
const claims = require('../../src/services/claimedListings/claimLinkService');
const events = require('../../src/services/claimedListings/claimEvents');

const ORG = '11111111-2222-4333-8444-555555555555';
const RAW = tokens.mintToken();
let TOKEN; let ORGROW; let USERS; let written;

function setup({ token = {}, org = {}, users = [] } = {}) {
  TOKEN = Object.assign({ id: 'tok-1', organization_id: ORG, token_hash: tokens.hashToken(RAW), invited_email_normalized: 'owner@smith-estates.com',
    expires_at: new Date(Date.now() + 86400000).toISOString(), used_at: null }, token);
  ORGROW = Object.assign({ id: ORG, name: 'Smith Estates', city: 'Houston', state: 'TX', contact_email: 'owner@smith-estates.com',
    contact_phone: '713-555-0100', has_owner: false, lifecycle_state: 'inactive', profile_data: {}, bd_sync_status: 'active' }, org);
  USERS = users;
  written = [];
  db.__state.calls = [];
  db.__state.routes = [
    [/^\s*(INSERT|UPDATE|DELETE)/i, (sql, p) => { written.push(sql.replace(/\s+/g, ' ').trim()); return /RETURNING id/.test(sql) ? [{ id: 'new-user-1' }] : []; }],
    [/FROM organization_claim_tokens WHERE token_hash/, () => (TOKEN ? [TOKEN] : [])],
    [/FROM organizations o WHERE o\.id = \$1/, () => [ORGROW]],
    [/SELECT contact_phone FROM organizations WHERE id = \$1/, () => [ORGROW]],
    [/FROM users WHERE lower\(email\)/, () => USERS],
    [/claimed_listings\.self_request_enabled/, () => [{ value: false }]],
    [/FROM listing_claim_events/, () => [{ n: 0 }]],
  ];
}
const tokenWrites = () => written.filter((s) => /organization_claim_tokens/.test(s));

describe('opening a claim link never consumes it', () => {
  beforeEach(() => setup());
  test('lookup and the server GET record are read-only for the token', async () => {
    const look = await claims.lookup(RAW);
    expect(look.state).toBe('valid');
    await claims.recordLinkFetch(look, { userAgent: 'Mozilla/5.0 (compatible; Proofpoint URL Defense)', ip: '10.0.0.1' });
    expect(tokenWrites()).toEqual([]);
    const fetchRow = written.find((s) => /INSERT INTO listing_claim_events/.test(s));
    expect(fetchRow).toBeTruthy();
  });
  test('a link scanner is classified automated; a browser GET is still only a link_fetch, never a click', async () => {
    expect(events.uaClass('Mozilla/5.0 (compatible; Proofpoint URL Defense)')).toBe('automated');
    expect(events.uaClass('Microsoft Office SafeLinks')).toBe('automated');
    expect(events.uaClass('python-requests/2.31')).toBe('automated');
    expect(events.uaClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('browser');
    const route = read('src/routes/claimListing.js');
    const get = route.slice(route.indexOf("router.get('/claim/:token'"), route.indexOf("router.post('/claim/:token/beacon'"));
    expect(get).toMatch(/recordLinkFetch/);
    expect(get).not.toMatch(/recordPageView|startClaim|complete\(|exit\(/);
  });
  test('a page view needs a real interaction; "continue" still consumes nothing', async () => {
    const r = await claims.recordPageView(RAW, { visitorId: 'v1', interacted: false });
    expect(r.recorded).toBe(false);
    await claims.recordPageView(RAW, { visitorId: 'v1', interacted: true });
    const cs = await claims.startClaim(RAW, { visitorId: 'v1' });
    expect(cs.ok).toBe(true);
    expect(cs.masked_email).toBe('o•••••@smith-estates.com');
    expect(tokenWrites()).toEqual([]);
  });
});

describe('redemption', () => {
  beforeEach(() => { lifecycle.claim.mockReset(); lifecycle.claim.mockResolvedValue({ id: ORG, name: 'Smith Estates', lifecycle_state: 'claimed' }); });

  test('no account: one is created for the BOUND address (verified by the link) and the unchanged ladder claims with the token', async () => {
    setup();
    const out = await claims.complete(RAW, { fullName: 'Jane Smith', password: 'correct horse battery', signedInUser: null });
    expect(out.created).toBe(true);
    const ins = written.find((s) => /INSERT INTO users/.test(s));
    expect(ins).toMatch(/email_verified, email_verified_at, auth_source\) VALUES \(\$1,\$2,'buyer',\$3,true,now\(\),'claim_link'\)/);
    const call = db.__state.calls.find((c) => /INSERT INTO users/.test(c.sql));
    expect(call.params[0]).toBe('owner@smith-estates.com');            // from the token, never from input
    expect(lifecycle.claim).toHaveBeenCalledWith('new-user-1', ORG, expect.objectContaining({ claimToken: RAW }));
    expect(written.some((s) => /INSERT INTO audit_log/.test(s))).toBe(true);   // verification reason recorded
  });

  test('complete() takes no email parameter at all', () => {
    const src = read('src/services/claimedListings/claimLinkService.js');
    expect(src).toMatch(/async function complete\(rawToken, \{ fullName = '', password = '', signedInUser = null, ip = '', visitorId = null \} = \{\}\)/);
  });

  test('an existing account must sign in first; a different signed-in user is refused', async () => {
    setup({ users: [{ id: 'u-owner', email: 'owner@smith-estates.com', email_verified: false }] });
    await expect(claims.complete(RAW, { signedInUser: null })).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED', status: 409 });
    await expect(claims.complete(RAW, { signedInUser: { id: 'u-stranger' } })).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' });
    expect(lifecycle.claim).not.toHaveBeenCalled();
    await claims.complete(RAW, { signedInUser: { id: 'u-owner' } });
    expect(lifecycle.claim).toHaveBeenCalledWith('u-owner', ORG, expect.objectContaining({ claimToken: RAW }));
  });

  test('a used, expired, foreign or already-claimed link is refused before anything is written', async () => {
    for (const [tok, org, code] of [[{ used_at: new Date().toISOString() }, {}, 'CLAIM_LINK_USED'],
      [{ expires_at: new Date(Date.now() - 1000).toISOString() }, {}, 'CLAIM_LINK_EXPIRED'],
      [{}, { has_owner: true }, 'CLAIM_LINK_CLAIMED']]) {
      setup({ token: tok, org });
      await expect(claims.complete(RAW, { fullName: 'X Y', password: 'long enough pw' })).rejects.toMatchObject({ code });
      expect(written.filter((s) => /INSERT INTO users/.test(s))).toEqual([]);
    }
    setup(); TOKEN = null;
    await expect(claims.complete(RAW, {})).rejects.toMatchObject({ code: 'CLAIM_LINK_INVALID' });
    await expect(claims.complete('not-a-token', {})).rejects.toMatchObject({ code: 'CLAIM_LINK_INVALID' });
  });

  test('the proof ladder that consumes the token is the existing one, unchanged', () => {
    const sec = read('src/services/organizationClaimSecurityService.js');
    expect(sec).toMatch(/WHERE id = \$1 AND used_at IS NULL AND expires_at > now\(\)/);        // atomic single-use consume
    expect(sec).toMatch(/CLAIM_TOKEN_WRONG_RECIPIENT/);                                       // recipient binding
    expect(sec).toMatch(/user\.email_verified !== true/);                                     // verified email still required
  });
});

describe('claim links only ever go to the address on the listing', () => {
  test('issuing to any other address is refused (except an administrator)', async () => {
    setup();
    db.__state.routes.unshift([/SELECT id, name, contact_email FROM organizations/, () => [ORGROW]]);
    await expect(claims.issueToken(ORG, { channel: 'self_request', invitedEmail: 'attacker@evil.test' })).rejects.toMatchObject({ code: 'ADDRESS_MISMATCH' });
    const ok = await claims.issueToken(ORG, { channel: 'outreach' });
    expect(ok.invitedEmail).toBe('owner@smith-estates.com');
    expect(written.some((s) => /SET used_at = now\(\) WHERE organization_id = \$1 AND used_at IS NULL/.test(s))).toBe(true);   // one live link
  });
  test('an already claimed listing gets no new link', async () => {
    setup();
    db.__state.routes.unshift([/SELECT id, name, contact_email FROM organizations/, () => [ORGROW]], [/FROM organization_members WHERE organization_id = \$1 AND role = 'owner'/, () => [{ 1: 1 }]]);
    await expect(claims.issueToken(ORG, { channel: 'outreach' })).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
  });
});

describe('exits, help and disputes', () => {
  test('each exit option suppresses the address, stops outreach and creates the right staff task', async () => {
    for (const [action, task] of [['not_my_company', 'wrong_contact_research'], ['business_closed', 'remove_listing'], ['wrong_contact', 'wrong_contact_research'], ['remove_listing', 'remove_listing']]) {
      setup();
      const r = await claims.exit(RAW, action);
      expect(r.ok).toBe(true);
      expect(written.some((s) => /INSERT INTO listing_outreach_suppressions/.test(s))).toBe(true);
      expect(written.some((s) => /UPDATE listing_outreach_sequences s SET state = 'stopped'/.test(s))).toBe(true);
      const t = db.__state.calls.find((c) => /INSERT INTO listing_tasks/.test(c.sql));
      expect(t.params[2]).toBe(task);
      expect(tokenWrites()).toEqual([]);   // an exit never consumes the claim link either
    }
    await expect(claims.exit(RAW, 'delete_everything')).rejects.toMatchObject({ code: 'UNKNOWN_OPTION' });
  });

  test('no confirmation email is sent for an exit', async () => {
    const email = require('../../src/services/emailService');
    email.sendEmail.mockClear();
    setup();
    await claims.exit(RAW, 'remove_listing');
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  test('help on an unclaimed listing: staff verify by calling the phone ON the listing', async () => {
    setup();
    await claims.helpRequest(ORG, { name: 'Jane Smith', phone: '555-000-9999' });
    const t = db.__state.calls.find((c) => /INSERT INTO listing_tasks/.test(c.sql));
    expect(t.params[2]).toBe('claim_help_request');
    const payload = JSON.parse(t.params[7]);
    expect(payload.verify_by_calling_listing_phone).toBe('713-555-0100');
    expect(payload.requester_phone_supplied).toBe('555-000-9999');
    expect(payload.rule).toMatch(/never the number supplied/i);
  });

  test('a claimed listing is a DISPUTE for a Super Admin, never an automatic transfer', async () => {
    setup({ org: { has_owner: true } });
    await claims.helpRequest(ORG, { name: 'Other Person' });
    const t = db.__state.calls.find((c) => /INSERT INTO listing_tasks/.test(c.sql));
    expect(t.params[2]).toBe('dispute');
    expect(t.params[3]).toBe('high');
    expect(lifecycle.claim).not.toHaveBeenCalledWith(expect.anything(), ORG, expect.objectContaining({ adminOverride: true }));
  });
});

describe('self-service claim link request', () => {
  test('off by default: nothing is sent and the visitor is pointed to help', async () => {
    setup();
    const ctx = await claims.claimContext(ORG);
    expect(ctx.self_request_available).toBe(false);
    expect(ctx.masked_email).toBe('o•••••@smith-estates.com');
    expect(JSON.stringify(ctx)).not.toMatch(/owner@smith-estates\.com/);   // never the full address
    await expect(claims.selfRequest(ORG, { ip: '1.2.3.4' })).rejects.toMatchObject({ code: 'SELF_REQUEST_UNAVAILABLE' });
  });
  test('rate limits: 1 per listing per day, 3 per week, 10 per IP per day', () => {
    const src = read('src/services/claimedListings/claimLinkService.js');
    expect(src).toMatch(/countSince\('self_request', \{ organizationId, hours: 24 \}\) >= 1/);
    expect(src).toMatch(/countSince\('self_request', \{ organizationId, hours: 24 \* 7 \}\) >= 3/);
    expect(src).toMatch(/countSince\('self_request', \{ ipHash, hours: 24 \}\) >= 10/);
  });
  test('the directory lookup returns only an id, and nothing for claimed or hidden listings', () => {
    const r = read('src/routes/publicListings.js');
    expect(r).toMatch(/return res\.json\(\{ orgId: r\.orgId \}\)/);
    const s = read('src/services/claimedListings/claimLinkService.js');
    expect(s).toMatch(/if \(!o \|\| o\.has_owner \|\| o\.bd_sync_status === 'removed' \|\| \(o\.profile_data && o\.profile_data\.removal_requested_at\)\) return null;/);
  });
});

describe('the landing page', () => {
  const route = read('src/routes/claimListing.js');
  test('noindex, no third-party scripts, fonts or pixels', () => {
    expect(route).toMatch(/noindex,nofollow/);
    expect(route).not.toMatch(/<script[^>]+src=/i);
    expect(route).not.toMatch(/googleapis|gstatic|googletagmanager|connect\.facebook\.net|fbevents|<img/i);
    const tag = read('src/middleware/analyticsTag.js');
    expect(tag).toMatch(/'\/claim\/'/);
    expect(tag).toMatch(/'\/claim-listing\.html'/);
  });
  test('the blueprint copy is on the page, without em dashes', () => {
    expect(route).toMatch(/This is my company, continue/);
    expect(route).toMatch(/we never ask for payment details to claim a listing/);
    expect(route).toMatch(/written by Advantage\.Bid from public business information/);
    for (const x of ["This isn't my company", 'This business has closed', "I'm not the right contact", 'Please remove this listing']) expect(route).toContain(x);
    expect(route).not.toMatch(/—/);
    expect(read('public/claim-listing.html')).not.toMatch(/—/);
  });
  test('a legacy ?org=&token= link opens the token-first page instead of consuming anything', () => {
    expect(read('public/claim-listing.html')).toMatch(/location\.replace\('\/claim\/' \+ encodeURIComponent\(claimToken\)\)/);
  });
});
