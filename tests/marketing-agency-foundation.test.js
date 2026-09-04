'use strict';

/**
 * Autonomous Marketing Agency — Phase 3A foundation. The ten required invariants, plus concurrency,
 * idempotency, cents-property, seller-isolation, and accounting-separation coverage. Nothing here
 * activates marketing; it proves the control layer.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

const policy = require('../src/lib/marketingPolicy');

// ── PURE policy: allocation invariant, cents property, radius, claims ───────────────
describe('marketingPolicy — allocation (Concept B) is cents-exact and separate', () => {
  test('INVARIANT 2: direct_max + growth_base === package_price across a broad price range', () => {
    for (let price = 0; price <= 500000; price += 137) { // covers $0 … $5,000 incl. odd cents
      const a = policy.allocate(price, 6000);
      expect(a.direct_max_cents + a.growth_base_cents).toBe(price); // never loses a cent
      expect(a.direct_max_cents).toBeLessThanOrEqual(price);
      policy.assertAllocationInvariant(a);
    }
  });
  test('example: $9.99 → direct max $5.99, growth base $4.00', () => {
    const a = policy.allocate(999, 6000);
    expect(a.direct_max_cents).toBe(599);
    expect(a.growth_base_cents).toBe(400);
  });
  test('growth base is the REMAINDER (never an independent 40%)', () => {
    const a = policy.allocate(1000, 6000); // 60% of 1000 = 600; remainder 400
    expect(a.growth_base_cents).toBe(1000 - a.direct_max_cents);
  });
  test('unused direct capacity = direct_max − spent', () => {
    expect(policy.unusedDirectCapacityCents(600, 250)).toBe(350);
    expect(policy.unusedDirectCapacityCents(600, 600)).toBe(0);
  });
  test('INVARIANT 7: paid event_local radius = policy default unless an APPROVED exception', () => {
    expect(policy.resolveEventLocalRadiusMiles({ defaultMiles: 30 })).toBe(30);
    expect(policy.resolveEventLocalRadiusMiles({ defaultMiles: 30, exceptionMiles: 75 })).toBe(30); // no approver → ignored
    expect(policy.resolveEventLocalRadiusMiles({ defaultMiles: 30, exceptionMiles: 75, exceptionApprovedBy: 'u1' })).toBe(75);
    expect(policy.hasValidEventCoordinates(29.76, -95.36)).toBe(true);
    expect(policy.hasValidEventCoordinates(null, null)).toBe(false);
    expect(policy.hasValidEventCoordinates(0, 0)).toBe(false); // null-island rejected
  });
  test('INVARIANT 9: factual claim needs a non-null source; implied needs judgment QA', () => {
    expect(policy.evaluateClaim({ claim_kind: 'factual', authoritative_source: 'lot#12.material' }).acceptable).toBe(true);
    expect(policy.evaluateClaim({ claim_kind: 'factual', authoritative_source: '' }).acceptable).toBe(false);
    expect(policy.evaluateClaim({ claim_kind: 'factual' }).acceptable).toBe(false);
    expect(policy.evaluateClaim({ claim_kind: 'subjective' }).acceptable).toBe(true);
    expect(policy.evaluateClaim({ claim_kind: 'implied' }).acceptable).toBe(false); // deterministic alone insufficient
  });
});

// ── Functional in-memory DB harness for the ledger service ─────────────────────────
// Simulates marketing_allocations (conditional atomic UPDATEs), the ledgers (unique idempotency keys),
// the growth pool, and monthly authority — enough to prove the money invariants behaviorally.
function makeHarness() {
  const st = { alloc: {}, ledgerKeys: new Map(), growthKeys: new Set(), growth: 3? 0 : 0, month: {} };
  st.growth = 0;
  let uuid = 0;
  const client = {
    async query(sql, params = []) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT gen_random_uuid\(\) AS id/.test(sql)) return { rows: [{ id: 'res-' + (++uuid) }], rowCount: 1 };
      // allocations lookup
      if (/SELECT \* FROM marketing_allocations WHERE marketing_job_id = \$1 FOR UPDATE/.test(sql)) {
        const a = st.alloc[params[0]]; return { rows: a ? [a] : [], rowCount: a ? 1 : 0 };
      }
      if (/INSERT INTO marketing_allocations/.test(sql)) {
        const [jobId, auctionId, price, directMax, growthBase] = params;
        st.alloc[jobId] = { marketing_job_id: jobId, auction_id: auctionId, package_price_cents: price, direct_max_cents: directMax, growth_base_cents: growthBase, direct_reserved_cents: 0, direct_spent_cents: 0, unused_swept: false };
        return { rows: [st.alloc[jobId]], rowCount: 1 };
      }
      if (/UPDATE marketing_jobs/.test(sql)) return { rows: [], rowCount: 1 };
      // ledger idempotency lookups
      if (/SELECT reservation_id FROM marketing_ledger WHERE idempotency_key = \$1/.test(sql)) {
        const r = st.ledgerKeys.get(params[0]); return { rows: r ? [{ reservation_id: r }] : [], rowCount: r ? 1 : 0 };
      }
      if (/SELECT id FROM marketing_ledger WHERE idempotency_key = \$1/.test(sql)) {
        const has = st.ledgerKeys.has(params[0]); return { rows: has ? [{ id: 'x' }] : [], rowCount: has ? 1 : 0 };
      }
      // reserve (conditional atomic)
      if (/UPDATE marketing_allocations\s+SET direct_reserved_cents = direct_reserved_cents \+ \$2\s+WHERE marketing_job_id = \$1 AND direct_reserved_cents \+ direct_spent_cents \+ \$2 <= direct_max_cents/.test(sql)) {
        const a = st.alloc[params[0]]; const amt = params[1];
        if (a && a.direct_reserved_cents + a.direct_spent_cents + amt <= a.direct_max_cents) { a.direct_reserved_cents += amt; return { rows: [{ direct_reserved_cents: a.direct_reserved_cents }], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      // spend (needs reservation)
      if (/SET direct_reserved_cents = direct_reserved_cents - \$2, direct_spent_cents = direct_spent_cents \+ \$2\s+WHERE marketing_job_id = \$1 AND direct_reserved_cents >= \$2/.test(sql)) {
        const a = st.alloc[params[0]]; const amt = params[1];
        if (a && a.direct_reserved_cents >= amt) { a.direct_reserved_cents -= amt; a.direct_spent_cents += amt; return { rows: [{ direct_spent_cents: a.direct_spent_cents }], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      // release
      if (/SET direct_reserved_cents = direct_reserved_cents - \$2\s+WHERE marketing_job_id = \$1 AND direct_reserved_cents >= \$2/.test(sql)) {
        const a = st.alloc[params[0]]; const amt = params[1];
        if (a && a.direct_reserved_cents >= amt) { a.direct_reserved_cents -= amt; return { rows: [{ direct_reserved_cents: a.direct_reserved_cents }], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      // marketing_ledger insert (unique idempotency)
      if (/INSERT INTO marketing_ledger/.test(sql)) {
        const key = params[4], reservationId = params[3];
        if (st.ledgerKeys.has(key)) return { rows: [], rowCount: 0 };
        st.ledgerKeys.set(key, reservationId || null); return { rows: [{ id: 'l' + (++uuid) }], rowCount: 1 };
      }
      // growth ledger insert
      if (/INSERT INTO growth_pool_ledger/.test(sql)) {
        const key = params[6]; if (st.growthKeys.has(key)) return { rows: [], rowCount: 0 };
        st.growthKeys.add(key); return { rows: [{ id: 'g' + (++uuid) }], rowCount: 1 };
      }
      if (/UPDATE growth_pool SET balance_cents = balance_cents \+ \$1/.test(sql)) { st.growth += params[0]; return { rows: [], rowCount: 1 }; }
      if (/UPDATE growth_pool SET balance_cents = balance_cents - \$1/.test(sql)) { st.growth -= params[0]; return { rows: [], rowCount: 1 }; }
      if (/SELECT balance_cents.* FROM growth_pool WHERE id = 1 FOR UPDATE/.test(sql)) return { rows: [{ balance_cents: st.growth, reserved_cents: 0 }], rowCount: 1 };
      if (/SELECT id FROM growth_pool_ledger WHERE idempotency_key = \$1/.test(sql)) { const has = st.growthKeys.has(params[0]); return { rows: has ? [{ id: 'x' }] : [], rowCount: has ? 1 : 0 }; }
      if (/INSERT INTO growth_monthly_authority/.test(sql)) { const m = params[0]; if (!st.month[m]) st.month[m] = { month: m, additional_authority_cents: params[1], owner_granted_cents: 0, spent_beyond_pool_cents: 0 }; return { rows: [], rowCount: 1 }; }
      if (/SELECT \* FROM growth_monthly_authority WHERE month = \$1 FOR UPDATE/.test(sql)) { const a = st.month[params[0]]; return { rows: a ? [a] : [], rowCount: a ? 1 : 0 }; }
      if (/SELECT \* FROM growth_monthly_authority WHERE month = \$1/.test(sql)) { const a = st.month[params[0]]; return { rows: a ? [a] : [], rowCount: a ? 1 : 0 }; }
      if (/UPDATE growth_monthly_authority SET spent_beyond_pool_cents = spent_beyond_pool_cents \+ \$2/.test(sql)) { st.month[params[0]].spent_beyond_pool_cents += params[1]; return { rows: [], rowCount: 1 }; }
      if (/UPDATE growth_monthly_authority SET owner_granted_cents = owner_granted_cents \+ \$2/.test(sql)) { st.month[params[0]].owner_granted_cents += params[1]; return { rows: [], rowCount: 1 }; }
      // sweep uses the FOR UPDATE alloc lookup + this update:
      if (/UPDATE marketing_allocations SET unused_swept = true/.test(sql)) { st.alloc[params[0]].unused_swept = true; return { rows: [], rowCount: 1 }; }
      throw new Error('Unhandled SQL in harness: ' + sql.slice(0, 90));
    },
    release() {},
  };
  return { st, db: { connect: async () => client, query: (s, p) => client.query(s, p) } };
}

describe('marketingLedgerService — money invariants (functional harness)', () => {
  let ledger, h;
  beforeEach(() => {
    jest.resetModules();
    h = makeHarness();
    jest.doMock('../src/db', () => h.db);
    jest.doMock('../src/services/configService', () => ({ get: async () => null, setPlatformConfig: async () => {} }));
    ledger = require('../src/services/marketingLedgerService');
  });
  afterEach(() => { jest.dontMock('../src/db'); jest.dontMock('../src/services/configService'); });

  test('freeze contributes the growth BASE once (INVARIANT 2 + idempotent freeze / INVARIANT 3)', async () => {
    await ledger.freezeAllocation({ marketingJobId: 'j1', auctionId: 'a1', packagePriceCents: 999 });
    expect(h.st.alloc.j1.direct_max_cents).toBe(599);
    expect(h.st.alloc.j1.growth_base_cents).toBe(400);
    expect(h.st.growth).toBe(400); // base contributed
    await ledger.freezeAllocation({ marketingJobId: 'j1', packagePriceCents: 999 }); // re-freeze = no-op
    expect(h.st.growth).toBe(400); // not double-counted
  });

  test('INVARIANT 1 + 8: reservations never exceed direct_max; spend requires a reservation', async () => {
    await ledger.freezeAllocation({ marketingJobId: 'j1', packagePriceCents: 1000 }); // direct_max 600
    expect((await ledger.reserve({ marketingJobId: 'j1', amountCents: 400, idempotencyKey: 'r1' })).ok).toBe(true);
    expect((await ledger.reserve({ marketingJobId: 'j1', amountCents: 250, idempotencyKey: 'r2' })).ok).toBe(false); // 400+250 > 600
    expect((await ledger.reserve({ marketingJobId: 'j1', amountCents: 200, idempotencyKey: 'r3' })).ok).toBe(true); // 400+200 = 600 OK
    expect(h.st.alloc.j1.direct_reserved_cents).toBe(600);
    // spend without reservation capacity fails; with reservation succeeds
    const spendOk = await ledger.spend({ marketingJobId: 'j1', amountCents: 600, idempotencyKey: 's1' });
    expect(spendOk.ok).toBe(true);
    expect(h.st.alloc.j1.direct_spent_cents).toBe(600);
    const overSpend = await ledger.spend({ marketingJobId: 'j1', amountCents: 1, idempotencyKey: 's2' });
    expect(overSpend.ok).toBe(false); // no reservation left
  });

  test('idempotency: repeated reserve/spend keys do not double-apply', async () => {
    await ledger.freezeAllocation({ marketingJobId: 'j1', packagePriceCents: 1000 });
    await ledger.reserve({ marketingJobId: 'j1', amountCents: 300, idempotencyKey: 'r1' });
    const again = await ledger.reserve({ marketingJobId: 'j1', amountCents: 300, idempotencyKey: 'r1' }); // same key
    expect(again.idempotent).toBe(true);
    expect(h.st.alloc.j1.direct_reserved_cents).toBe(300); // not 600
  });

  test('INVARIANT 10: unused capacity sweeps to Growth exactly once', async () => {
    await ledger.freezeAllocation({ marketingJobId: 'j1', packagePriceCents: 1000 }); // direct_max 600, growth base 400
    await ledger.reserve({ marketingJobId: 'j1', amountCents: 500, idempotencyKey: 'r1' });
    await ledger.spend({ marketingJobId: 'j1', reservationId: 'res', amountCents: 500, idempotencyKey: 's1' });
    const sweep1 = await ledger.sweepUnusedToGrowth({ marketingJobId: 'j1' }); // unused = 600 - 500 = 100
    expect(sweep1.contributed_cents).toBe(100);
    expect(h.st.growth).toBe(400 + 100);
    const sweep2 = await ledger.sweepUnusedToGrowth({ marketingJobId: 'j1' }); // second call = no-op
    expect(sweep2.alreadySwept).toBe(true);
    expect(h.st.growth).toBe(500); // unchanged
  });

  test('INVARIANT 5 + 6: growth spend limited to pool + monthly authority; new month resets', async () => {
    await ledger.freezeAllocation({ marketingJobId: 'j1', packagePriceCents: 100000 }); // growth base 40000
    expect(h.st.growth).toBe(40000);
    // spend within pool
    expect((await ledger.growthSpend({ amountCents: 30000, idempotencyKey: 'g1', month: '2026-09-01' })).ok).toBe(true);
    expect(h.st.growth).toBe(10000);
    // spend beyond pool but within $1,000 monthly authority (pool 10000 + up to 100000 beyond)
    const beyond = await ledger.growthSpend({ amountCents: 60000, idempotencyKey: 'g2', month: '2026-09-01' });
    expect(beyond.ok).toBe(true);
    expect(beyond.beyond_pool_cents).toBe(50000);
    // now exceed remaining monthly authority → refuse + escalate
    const refuse = await ledger.growthSpend({ amountCents: 60000, idempotencyKey: 'g3', month: '2026-09-01' });
    expect(refuse.ok).toBe(false);
    expect(refuse.escalate).toBe(true);
    // NEXT month → fresh authority
    const nextMonth = await ledger.growthSpend({ amountCents: 90000, idempotencyKey: 'g4', month: '2026-10-01' });
    expect(nextMonth.ok).toBe(true); // pool 0, beyond 90000 <= 100000 fresh authority
  });
});

// ── Deterministic QA golden fixtures (in the project gate via tests/) ───────────────
describe('deterministic QA golden fixtures', () => {
  // A creative claim is derived from a source lot field; if the field is absent, the claim is unsupported.
  function claimFromLot(lot, field, text) {
    const value = lot[field];
    const supported = value != null && String(value).trim() !== '';
    return { claim_kind: 'factual', claim_text: text, authoritative_source: supported ? `lot:${lot.id}.${field}` : null };
  }
  const SPARSE_LOT = { id: 'sparse-1', title: 'Antique side table', maker: null, material: null, era: null };
  const RICH_LOT   = { id: 'rich-1', title: 'Stickley oak table', maker: 'Stickley', material: 'quarter-sawn oak', era: 'c.1910' };

  test('SPARSE lot: an unsupported maker/material assertion FAILS the deterministic gate', () => {
    const makerClaim = claimFromLot(SPARSE_LOT, 'maker', 'Made by a renowned maker');
    const materialClaim = claimFromLot(SPARSE_LOT, 'material', 'Solid mahogany construction');
    expect(policy.evaluateClaim(makerClaim).acceptable).toBe(false);
    expect(policy.evaluateClaim(materialClaim).acceptable).toBe(false);
  });
  test('RICH lot: supported factual assertions are PERMITTED (not over-restrictive)', () => {
    const makerClaim = claimFromLot(RICH_LOT, 'maker', 'Made by Stickley');
    const materialClaim = claimFromLot(RICH_LOT, 'material', 'Quarter-sawn oak');
    expect(policy.evaluateClaim(makerClaim).acceptable).toBe(true);
    expect(policy.evaluateClaim(materialClaim).acceptable).toBe(true);
  });
  test('implied (layout/composition) claims are never auto-passed by deterministic QA alone', () => {
    expect(policy.evaluateClaim({ claim_kind: 'implied', claim_text: 'looks like a museum piece' }).reason).toBe('needs_judgment_qa');
  });
});

// ── Migration 126: DB-level guarantees ──────────────────────────────────────────────
describe('migration 126 — schema-level invariants', () => {
  const mig = read('db', 'migrations', '126_marketing_agency_foundation.sql');
  test('INVARIANT 1 backstop: ceiling CHECK reserved+spent <= direct_max', () => {
    expect(mig).toMatch(/CHECK \(direct_reserved_cents \+ direct_spent_cents <= direct_max_cents\)/);
  });
  test('INVARIANT 2 backstop: sum CHECK direct_max + growth_base = price', () => {
    expect(mig).toMatch(/CHECK \(direct_max_cents \+ growth_base_cents = package_price_cents\)/);
  });
  test('INVARIANT 4: internal ledgers carry NO seller_user_id', () => {
    const ledgerBlock = mig.slice(mig.indexOf('CREATE TABLE IF NOT EXISTS marketing_ledger'), mig.indexOf('CREATE TABLE IF NOT EXISTS growth_pool'));
    expect(ledgerBlock).not.toMatch(/seller_user_id/);
    const growthBlock = mig.slice(mig.indexOf('CREATE TABLE IF NOT EXISTS growth_pool_ledger'), mig.indexOf('CREATE TABLE IF NOT EXISTS growth_monthly_authority'));
    expect(growthBlock).not.toMatch(/seller_user_id/);
  });
  test('INVARIANT 5 backstop: monthly authority CHECK spent_beyond <= authority + grant', () => {
    expect(mig).toMatch(/CHECK \(spent_beyond_pool_cents <= additional_authority_cents \+ owner_granted_cents\)/);
  });
  test('idempotency keys are UNIQUE on both ledgers and the queue', () => {
    expect(mig).toMatch(/idempotency_key\s+TEXT NOT NULL UNIQUE/);
    expect(mig).toMatch(/idempotency_key TEXT UNIQUE/); // queue
  });
  test('config seeded SEPARATE bps/cents, no combined-total key', () => {
    expect(mig).toMatch(/marketing\.direct_spend_max_bps',\s*'6000'/);
    expect(mig).toMatch(/marketing\.event_local_radius_miles',\s*'30'/);
    expect(mig).toMatch(/marketing\.growth_monthly_additional_authority_cents','100000'/);
    expect(mig).not.toMatch(/growth_base_bps|direct_and_growth_total/);
  });
  test('growth markets seeded (Houston + NYC) as data, not hard-coded logic', () => {
    expect(mig).toMatch(/Houston Metropolitan Area/);
    expect(mig).toMatch(/New York City Metropolitan Area/);
  });
  test('paid event_local needs coordinates + resolved radius columns', () => {
    expect(mig).toMatch(/resolved_radius_miles/);
    expect(mig).toMatch(/event_lat/); expect(mig).toMatch(/event_lng/);
    expect(mig).toMatch(/marketing_radius_exceptions/);
  });
});

// ── Accounting separation (Concept A vs Concept B) ─────────────────────────────────
describe('accounting separation — internal spend never seller-facing', () => {
  test('marketing_ledger / growth_pool_ledger service never writes a seller_user_id', () => {
    const svc = read('src', 'services', 'marketingLedgerService.js');
    expect(svc).not.toMatch(/seller_user_id/);
  });
  test('INVARIANT 8: spend SQL requires an existing reservation (no external spend without reservation)', () => {
    const svc = read('src', 'services', 'marketingLedgerService.js');
    expect(svc).toMatch(/direct_reserved_cents >= \$2/); // spend/release gate on reserved balance
    expect(svc).toMatch(/direct_reserved_cents \+ direct_spent_cents \+ \$2 <= direct_max_cents/); // reserve ceiling
  });
});

// ── Durable queue (transactional) + agent doc + config service ─────────────────────
describe('durable queue + governance', () => {
  test('queue enqueue accepts a caller client (atomic with the tx); no fire-and-forget', () => {
    const q = read('src', 'services', 'marketingQueueService.js');
    expect(q).toMatch(/function enqueue\(runner,/);
    expect(q).toMatch(/marketing_job_queue/);
    expect(q).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
  });
  test('triggerMarketingWorkflow durably enqueues (no terminal console.log of the job)', () => {
    const w = read('src', 'services', 'marketingWorkflow.js');
    expect(w).toMatch(/marketingQueue\.enqueue/);
    expect(w).not.toMatch(/console\.log\(`\[marketingWorkflow\] job triggered/);
  });
  test('stale admin-approval instruction removed; autonomous flow documented', () => {
    const md = read('.claude', 'agents', 'marketing.md');
    expect(md).not.toMatch(/Do not bypass admin approval for campaign publication/);
    expect(md).toMatch(/Independent QA/);
    expect(md).toMatch(/Owner is not a routine publication bottleneck/);
  });
  test('marketingConfigService reads marketing.* with policy fallbacks', () => {
    const c = read('src', 'services', 'marketingConfigService.js');
    expect(c).toMatch(/marketing\.direct_spend_max_bps/);
    expect(c).toMatch(/marketing\.growth_monthly_additional_authority_cents/);
  });
});
