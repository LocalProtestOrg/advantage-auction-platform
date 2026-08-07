'use strict';

/**
 * Launch fix H-2 — Publishing must NEVER resurrect withdrawn lots (seller intent is authoritative).
 *
 * Hermetic guard (runs in the default suite, no DB): mocks the pg client and drives publishAuction,
 * asserting the removed "UPDATE lots SET state='open' WHERE state='withdrawn'" resurrection query is
 * never issued, while every publish validation + the open-lot close scheduling still run.
 */

jest.mock('../../src/db/index', () => ({ connect: jest.fn() }));
jest.mock('../../src/services/auditService', () => ({ logEvent: jest.fn(async () => {}) }));
jest.mock('../../src/services/verificationService', () => ({ publicationGate: jest.fn(async () => ({ blocked: false })) }));
jest.mock('../../src/services/auctionGeocodingService', () => ({ geocodeAuctionSafe: jest.fn(async () => {}) }));
jest.mock('../../src/lib/realtime', () => ({ publish: jest.fn(), notify: jest.fn() }));

const db = require('../../src/db/index');
const auctionService = require('../../src/services/auctionService');

const FUTURE = new Date(Date.now() + 3600e3).toISOString();

// Fake client that records every SQL string and returns sensible rows for the publish flow.
function fakeClient() {
  const queries = [];
  const client = {
    queries,
    query: jest.fn(async (sql) => {
      const s = String(sql);
      queries.push(s);
      if (/FROM auctions WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ id: 'A', state: 'draft', seller_id: 'S', start_time: FUTURE }] };
      if (/count\(\*\)::int AS c FROM lots/.test(s)) return { rows: [{ c: 2 }] };
      if (/UPDATE\s+auctions[\s\S]*state = 'published'[\s\S]*RETURNING/.test(s)) return { rows: [{ id: 'A', state: 'published', start_time: FUTURE }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return client;
}

describe('publishAuction — H-2: withdrawn lots are never resurrected', () => {
  let client;
  beforeEach(() => { client = fakeClient(); db.connect.mockResolvedValue(client); });

  test('publish issues NO query that flips withdrawn lots back to open', async () => {
    await auctionService.publishAuction('A');
    const resurrection = client.queries.filter((q) =>
      /UPDATE\s+lots\s+SET\s+state\s*=\s*'open'/i.test(q) && /'withdrawn'/i.test(q));
    expect(resurrection).toHaveLength(0);
    // Belt-and-suspenders: no publish query writes state='open' onto a withdrawn row at all.
    expect(client.queries.some((q) => /state\s*=\s*'open'[\s\S]*state\s*=\s*'withdrawn'/i.test(q))).toBe(false);
  });

  test('publish still succeeds and returns the published auction', async () => {
    const res = await auctionService.publishAuction('A');
    expect(res).toMatchObject({ id: 'A', state: 'published' });
  });

  test('all publish validations are preserved (FOR UPDATE lock + non-withdrawn lot count guard)', async () => {
    await auctionService.publishAuction('A');
    expect(client.queries.some((q) => /FROM auctions WHERE id = \$1 FOR UPDATE/.test(q))).toBe(true);
    expect(client.queries.some((q) => /count\(\*\)::int AS c FROM lots WHERE auction_id = \$1 AND state != 'withdrawn'/.test(q))).toBe(true);
    const verificationService = require('../../src/services/verificationService');
    expect(verificationService.publicationGate).toHaveBeenCalledWith('S');
  });

  test('open lots are still scheduled (close schedule targets state=\'open\' only)', async () => {
    await auctionService.publishAuction('A');
    const schedule = client.queries.find((q) => /UPDATE lots l[\s\S]*closes_at/.test(q));
    expect(schedule).toBeTruthy();
    expect(schedule).toMatch(/state = 'open'/);       // withdrawn lots (state<>'open') get no closes_at
    expect(schedule).not.toMatch(/'withdrawn'/);
  });
});
