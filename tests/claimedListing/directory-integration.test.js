'use strict';

/**
 * Directory (www.advantage.bid) integration: the Claim Listing button and the analytics beacon.
 *
 * Root causes this suite guards against (verified 2026-09-25 on the live directory):
 *   1. The BD HEAD editor strips backslashes, so the v2 button script's `/^\d+$/` became `/^d+$/`, never
 *      matched a member id, and returned before touching the link: every click went to /join?claim=.
 *   2. The directory's first-party analytics POST was preflighted and answered with the app origin.
 */

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const cors = require('../../src/lib/corsPolicy');

describe('analytics CORS for the directory', () => {
  test('only the directory hosts, only the analytics events path', () => {
    expect(cors.directoryOriginFor('https://www.advantage.bid', '/api/analytics/events')).toBe('https://www.advantage.bid');
    expect(cors.directoryOriginFor('https://advantage.bid', '/api/analytics/events')).toBe('https://advantage.bid');
    expect(cors.directoryOriginFor('https://www.advantage.bid', '/api/auth/me')).toBeNull();
    expect(cors.directoryOriginFor('https://www.advantage.bid', '/api/admin/claimed-listings/overview')).toBeNull();
    expect(cors.directoryOriginFor('https://www.advantage.bid', '/api/analytics/identify')).toBeNull();
    expect(cors.directoryOriginFor('https://evil.example', '/api/analytics/events')).toBeNull();
    expect(cors.directoryOriginFor('https://www.advantage.bid.evil.example', '/api/analytics/events')).toBeNull();
    expect(cors.directoryOriginFor(null, '/api/analytics/events')).toBeNull();
  });
  test('no wildcard and no credentials are introduced; the origin is echoed with Vary', () => {
    const s = read('server.js');
    const block = s.slice(s.indexOf('const directoryOrigin'), s.indexOf("res.header('Access-Control-Allow-Methods'"));
    expect(block).toMatch(/res\.header\('Access-Control-Allow-Origin', directoryOrigin\);\s*res\.header\('Vary', 'Origin'\);/);
    expect(s).not.toMatch(/Access-Control-Allow-Credentials/);
    expect(read('src/lib/corsPolicy.js')).not.toContain("'*'");
  });
});

describe('the Claim Listing button (BD HEAD script v3)', () => {
  const v3 = read('docs/marketing/claimed-listing/bd-head-claim-listing-v3.html');
  test('contains no backslash at all (the BD editor strips them)', () => {
    expect(v3.split(String.fromCharCode(92)).length - 1).toBe(0);
  });
  test('never targets the generic BD Join page; it always goes to the Railway claim page', () => {
    expect(v3).toMatch(/var CLAIM = 'https:\/\/bid\.advantage\.bid\/claim-listing\.html';/);
    expect(v3).not.toMatch(/location\.[a-z]+\([^)]*join/i);
    expect(v3).toMatch(/document\.addEventListener\('click', function \(e\) \{[\s\S]*?e\.preventDefault\(\);[\s\S]*?\}, true\);/);   // capture phase
    expect(v3).not.toMatch(/fetch\(/);   // no cross-origin lookup that could fail back to Join
  });
  test('stays under the BD prompt budget', () => {
    expect(v3.length).toBeLessThan(4000);
  });
});

describe('the Railway landing resolves ?bd= itself', () => {
  const page = read('public/claim-listing.html');
  test('same-origin lookup; a failed or unclaimable lookup shows a message, never a join page', () => {
    expect(page).toMatch(/fetch\('\/api\/public\/listings\/by-bd\/' \+ encodeURIComponent\(bdId\)\)/);
    expect(page).toMatch(/This listing can.{0,2}'t be claimed online/);
    expect(page).toMatch(/We couldn.{0,2}'t load this listing/);
    expect(page).not.toMatch(/\/join\?/);
  });
});
