// End-to-end settlement integration (Increment 6). Exercises the REAL transactional
// paths against a live DB: calculate -> adjust -> recalc (versioned snapshots) -> Mark Paid
// -> locked/immutable -> historical independence from later banking changes.
//
// Runs ONLY when a DB is present and RUN_SETTLEMENT_INTEGRATION=1 (so the normal unit suite
// is unaffected). Run on staging:
//   RUN_SETTLEMENT_INTEGRATION=1 railway run --service advantage-staging npx jest tests/settlement-integration.test.js
const crypto = require('crypto');
const RUN = !!process.env.DATABASE_URL && process.env.RUN_SETTLEMENT_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

const db = require('../src/db');
const engine = require('../src/services/settlementEngine');
const adjustments = require('../src/services/settlementAdjustmentService');

d('settlement end-to-end (live DB)', () => {
  const ids = {};
  const uniq = crypto.randomUUID().slice(0, 8);

  beforeAll(async () => {
    const seller = (await db.query(`INSERT INTO users (email, password_hash, role) VALUES ($1,'x','seller') RETURNING id`, [`it-seller-${uniq}@example.test`])).rows[0];
    const buyer = (await db.query(`INSERT INTO users (email, password_hash, role) VALUES ($1,'x','buyer') RETURNING id`, [`it-buyer-${uniq}@example.test`])).rows[0];
    ids.seller = seller.id; ids.buyer = buyer.id;
    ids.profile = (await db.query(`INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1,'private',$2) RETURNING id`, [seller.id, `ITest ${uniq}`])).rows[0].id;
    ids.auction = (await db.query(`INSERT INTO auctions (seller_id, title, end_time) VALUES ($1,$2, now()) RETURNING id`, [ids.profile, `ITest Auction ${uniq}`])).rows[0].id;
    await db.query(`INSERT INTO seller_payouts (auction_id, seller_user_id, gross_revenue_cents, platform_fee_cents, seller_payout_cents) VALUES ($1,$2,100000,0,100000)`, [ids.auction, seller.id]);
    await db.query(`INSERT INTO buyer_auction_invoices (auction_id, buyer_user_id, total_cents, status) VALUES ($1,$2,100000,'paid')`, [ids.auction, buyer.id]);
    await db.query(`INSERT INTO seller_payout_preferences (seller_user_id, payout_method, check_payee_name, check_address_line1, check_city, check_state, check_postal_code)
                    VALUES ($1,'check','ITest Payee','1 Main','Detroit','MI','48226')`, [seller.id]);
  });

  afterAll(async () => {
    if (!ids.auction) return;
    await db.query('DELETE FROM settlement_adjustments WHERE auction_id=$1', [ids.auction]);
    await db.query('DELETE FROM settlement_snapshots WHERE auction_id=$1', [ids.auction]);
    await db.query('DELETE FROM seller_payouts WHERE auction_id=$1', [ids.auction]);
    await db.query('DELETE FROM buyer_auction_invoices WHERE auction_id=$1', [ids.auction]);
    await db.query('DELETE FROM audit_log WHERE auction_id=$1', [ids.auction]);
    await db.query('DELETE FROM auctions WHERE id=$1', [ids.auction]);
    await db.query('DELETE FROM seller_profiles WHERE id=$1', [ids.profile]);
    await db.query('DELETE FROM seller_payout_preferences WHERE seller_user_id=$1', [ids.seller]);
    await db.query('DELETE FROM users WHERE id = ANY($1)', [[ids.seller, ids.buyer]]);
  });

  test('calculate -> adjust -> recalc bumps versions; net reflects collected + adjustments', async () => {
    const base = await engine.computeSettlement(ids.auction);
    expect(base.buyer_payments_collected_cents).toBe(100000);
    expect(base.net_seller_proceeds_cents).toBe(100000);

    await engine.recalculateSettlement(ids.auction, ids.seller);                    // v1
    const debit = await adjustments.addAdjustment({ auctionId: ids.auction, type: 'debit', amountCents: 5000, reason: 'Disposal fee', category: 'Fee', actorId: ids.seller });
    ids.debitAdj = debit.id;
    const r2 = await engine.recalculateSettlement(ids.auction, ids.seller);          // v2
    await adjustments.addAdjustment({ auctionId: ids.auction, type: 'credit', amountCents: 2000, reason: 'Reimbursement', category: 'Reimbursement', actorId: ids.seller });
    const r3 = await engine.recalculateSettlement(ids.auction, ids.seller);          // v3

    expect(r2.version).toBe(2);
    expect(r3.version).toBe(3);
    expect(r3.totals.net_seller_proceeds_cents).toBe(97000);                         // 100000 - 5000 + 2000
    const snaps = await db.query('SELECT count(*)::int n FROM settlement_snapshots WHERE auction_id=$1', [ids.auction]);
    expect(snaps.rows[0].n).toBe(3);
    const sp = await db.query('SELECT settlement_version FROM seller_payouts WHERE auction_id=$1', [ids.auction]);
    expect(sp.rows[0].settlement_version).toBe(3);
  });

  test('Mark Paid freezes the final immutable snapshot and locks the settlement', async () => {
    const paid = await engine.markSettlementPaid(ids.auction, {
      paymentMethod: 'check', paymentReference: 'CHK-ITEST-1', paidAt: '2026-07-15',
      paymentNote: 'mailed', finalAmountCents: 97000, confirmedCompleted: true, actorId: ids.seller,
    });
    expect(paid.paid).toBe(true);
    expect(paid.final_amount_cents).toBe(97000);

    const sp = (await db.query('SELECT * FROM seller_payouts WHERE auction_id=$1', [ids.auction])).rows[0];
    expect(sp.settlement_status).toBe('paid');
    expect(sp.final_amount_paid_cents).toBe(97000);
    expect(sp.payout_reference).toBe('CHK-ITEST-1');
    expect(sp.payment_method_used).toBe('check');
    const fin = (await db.query('SELECT * FROM settlement_snapshots WHERE auction_id=$1 AND is_final=true', [ids.auction])).rows;
    expect(fin.length).toBe(1);
    ids.finalSnapshot = JSON.stringify(fin[0].snapshot);
  });

  test('locked settlement rejects recalculation, adjustment add, and void', async () => {
    const rec = await engine.recalculateSettlement(ids.auction, ids.seller);
    expect(rec.frozen).toBe(true);                                                   // no new snapshot
    await expect(adjustments.addAdjustment({ auctionId: ids.auction, type: 'debit', amountCents: 100, reason: 'late', actorId: ids.seller }))
      .rejects.toThrow(/immutable/i);
    await expect(adjustments.voidAdjustment({ adjustmentId: ids.debitAdj, actorId: ids.seller, voidReason: 'x' }))
      .rejects.toThrow(/immutable/i);
    const snaps = await db.query('SELECT count(*)::int n FROM settlement_snapshots WHERE auction_id=$1', [ids.auction]);
    expect(snaps.rows[0].n).toBe(4);                                                 // 3 review + 1 final; no more
  });

  test('changing banking after payment leaves the historical settlement unchanged', async () => {
    await db.query(`UPDATE seller_payout_preferences SET payout_method='check', check_payee_name='CHANGED NAME' WHERE seller_user_id=$1`, [ids.seller]);
    const sp = (await db.query('SELECT * FROM seller_payouts WHERE auction_id=$1', [ids.auction])).rows[0];
    expect(sp.settlement_status).toBe('paid');
    expect(sp.payment_method_used).toBe('check');
    expect(sp.payout_reference).toBe('CHK-ITEST-1');
    expect(sp.final_amount_paid_cents).toBe(97000);
    expect(sp.settlement_version).toBe(4);
    const fin = (await db.query('SELECT snapshot FROM settlement_snapshots WHERE auction_id=$1 AND is_final=true', [ids.auction])).rows[0];
    expect(JSON.stringify(fin.snapshot)).toBe(ids.finalSnapshot);                    // byte-identical historical record
  });
});
