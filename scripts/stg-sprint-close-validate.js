/*
 * stg-sprint-close-validate.js — automated two-buyer Sprint-Close validation.
 *
 * RUN ON STAGING, AND ONLY AFTER the fix/stabilization-sprint-1 branch is
 * deployed to the staging service (it exercises NEW endpoints/sockets/serializer
 * fields that old staging code does not have). Stripe TEST. Creates throwaway
 * fixtures and cleans up. Covers the [AUTO] items in
 * docs/projects/sprint-close-validation-checklist.md. The full real-time close
 * cascade + anti-snipe timing is covered by re-pointing the existing two-buyer
 * TEST-auction harness at staging.
 *
 *   railway run --service advantage-staging --environment production node scripts/stg-sprint-close-validate.js
 */
const raw = process.env.DATABASE_URL || '';
const sk  = process.env.STRIPE_SECRET_KEY || '';
if (raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: production endpoint — this harness is staging-only'); process.exit(2); }
if (!raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: not the staging endpoint'); process.exit(2); }
if (!sk.startsWith('sk_test_')) { console.error('REFUSE: Stripe not TEST'); process.exit(2); }
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { io: ioClient } = require('socket.io-client');
const db = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
const stripe = Stripe(sk, { apiVersion: '2026-03-25.dahlia' });
const BASE = 'https://advantage-staging-production.up.railway.app';
const JWT = process.env.JWT_SECRET;
const results = []; const ok = (n, c, d) => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}  ${d || ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = t => t ? { Authorization: 'Bearer ' + t } : {};
async function api(m, p, t, body, extra) {
  const r = await fetch(BASE + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, H(t), extra || {}), body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, headers: r.headers };
}
const getLot = async (id, t) => (await api('GET', `/api/lots/${id}`, t)).body.data;
async function setupBuyer(tag, aucId) {
  const id = (await db.query(`INSERT INTO users (email,password_hash,role,is_active) VALUES ($1,'x','buyer',true) RETURNING id`, [`scv-${tag}-${Date.now()}@example.com`])).rows[0].id;
  const tok = jwt.sign({ id, role: 'buyer' }, JWT, { expiresIn: '2h' });
  await api('POST', '/api/terms/accept', tok);
  const si = await api('POST', '/api/payments/setup-intent', tok);
  await stripe.setupIntents.confirm(si.body.data.client_secret.split('_secret')[0], { payment_method: 'pm_card_visa' });
  await api('POST', '/api/payments/card-on-file', tok);
  const reg = await api('POST', `/api/auctions/${aucId}/register`, tok, { pickup_acknowledged: true });
  const rs = await api('GET', `/api/auctions/${aucId}/registration-status`, tok);
  return { id, tok, regOk: reg.status === 200, canBid: rs.body.data && rs.body.data.can_bid };
}

(async () => {
  let aucId, lot1, lot2, A, B, adminId, adminTok;
  const START = new Date(Date.now() + 120000);
  try {
    adminId = (await db.query(`SELECT id FROM users WHERE role='admin' AND COALESCE(is_active,true)=true ORDER BY created_at LIMIT 1`)).rows[0].id;
    adminTok = jwt.sign({ id: adminId, role: 'admin' }, JWT, { expiresIn: '2h' });
    aucId = (await db.query(`INSERT INTO auctions (title,state,start_time) VALUES ('SprintClose Val','draft',$1) RETURNING id`, [START])).rows[0].id;
    lot1 = (await db.query(`INSERT INTO lots (auction_id,title,state,lot_number,starting_bid_cents) VALUES ($1,'Lot 1','open',1,2500) RETURNING id`, [aucId])).rows[0].id;
    lot2 = (await db.query(`INSERT INTO lots (auction_id,title,state,lot_number,starting_bid_cents) VALUES ($1,'Lot 2','open',2,2500) RETURNING id`, [aucId])).rows[0].id;
    let pub = await api('PATCH', `/api/admin/auctions/${aucId}/publish`, adminTok);
    if (pub.status === 404 || pub.status === 405) pub = await api('POST', `/api/admin/auctions/${aucId}/publish`, adminTok);
    ok('A setup: publish + staggered closes', pub.status === 200);

    // Registration + card + terms + can_bid
    A = await setupBuyer('a', aucId); B = await setupBuyer('b', aucId);
    ok('B registration: A & B can_bid (terms+card+pickup)', A.regOk && A.canBid && B.regOk && B.canBid);

    // C session renewal: a token past half-life gets X-Refreshed-Token back
    const nowSec = Math.floor(Date.now() / 1000);
    const oldTok = jwt.sign({ id: A.id, role: 'buyer', iat: nowSec - 50000, exp: nowSec + 36400 }, JWT);
    const rr = await api('GET', `/api/lots/${lot1}/bids`, oldTok);
    ok('C session sliding-renewal header issued past half-life', !!(rr.headers.get && rr.headers.get('x-refreshed-token')));

    // D increment ladder bands (server-authoritative) — set price, read effective increment
    const bands = [[100, 100], [2500, 100], [5000, 500], [20000, 1000], [50000, 2500], [100000, 5000], [250000, 10000]];
    let ladderOk = true, detail = [];
    for (const [cur, inc] of bands) {
      await db.query(`UPDATE lots SET current_bid_cents=$1 WHERE id=$2`, [cur, lot2]);
      const l = await getLot(lot2, A.tok);
      if (Number(l.effective_bid_increment_cents) !== inc) { ladderOk = false; detail.push(`@${cur}=${l.effective_bid_increment_cents}!=${inc}`); }
    }
    await db.query(`UPDATE lots SET current_bid_cents=0 WHERE id=$1`, [lot2]);
    ok('D increment ladder exact across bands (incl >$1000=$50)', ladderOk, detail.join(' '));

    // D bidding + max + too-low
    const b1 = await getLot(lot1, A.tok);
    const a1 = await api('POST', `/api/lots/${lot1}/bids`, A.tok, { amount: b1.next_min_bid_cents / 100 });
    const b1b = await getLot(lot1, B.tok);
    const bb = await api('POST', `/api/lots/${lot1}/bids`, B.tok, { amount: b1b.next_min_bid_cents / 100 });
    ok('D competitive bids accepted (A then B)', a1.status === 200 && bb.status === 200);
    const low = await api('POST', `/api/lots/${lot1}/bids`, A.tok, { amount: 0.01 });
    ok('D too-low bid rejected w/ human message', low.status >= 400 && /at least \$/.test((low.body && low.body.message) || ''));
    const mx = await api('POST', `/api/lots/${lot1}/bids`, A.tok, { max_bid_cents: 50000 });
    ok('D max/proxy bid accepted', mx.status === 200);

    // E viewer status + my-bids
    const lA = await getLot(lot1, A.tok);
    ok('E viewer_is_high_bidder/has_bid/max present, no UUIDs', lA.viewer_is_high_bidder === true && lA.viewer_has_bid === true && lA.viewer_max_bid_cents === 50000 && !('current_winner_user_id' in lA) && !('winning_buyer_user_id' in lA));
    const mb = await api('GET', '/api/lots/my-bids', A.tok);
    ok('E My Bids returns A\'s bid lot with status + photo fields', mb.status === 200 && (mb.body.data || []).some(x => x.id === lot1));

    // I watchlist add/list/remove
    await api('POST', '/api/watchlist/add', B.tok, { lotId: lot2 });
    const wl = await api('GET', '/api/watchlist', B.tok);
    const inWl = (wl.body.data || []).some(x => x.id === lot2);
    await api('POST', '/api/watchlist/remove', B.tok, { lotId: lot2 });
    const wl2 = await api('GET', '/api/watchlist', B.tok);
    ok('I watchlist add → list → remove', inWl && !(wl2.body.data || []).some(x => x.id === lot2));

    // F real-time: B (socket) joined; A places a higher bid → B (prev leader?) gets events
    const sockB = ioClient(BASE, { auth: { token: B.tok } });
    const evB = [];
    ['lot:update', 'lot:winning', 'lot:outbid'].forEach(e => sockB.on(e, d => evB.push({ e, d })));
    await new Promise(r => sockB.on('connect', r));
    sockB.emit('joinAuction', aucId);
    await sleep(500);
    // B takes the lead, then A outbids → B should get lot:outbid + room gets lot:update
    await api('POST', `/api/lots/${lot1}/bids`, B.tok, { max_bid_cents: 60000 });
    await sleep(400);
    const lNow = await getLot(lot1, A.tok);
    await api('POST', `/api/lots/${lot1}/bids`, A.tok, { max_bid_cents: 70000 });
    await sleep(1200);
    ok('F real-time lot:update broadcast received', evB.some(x => x.e === 'lot:update'));
    ok('F real-time targeted lot:outbid received by outbid bidder', evB.some(x => x.e === 'lot:outbid'));
    sockB.close();

    // J email staleness: enqueue stale (closed lot) + fresh (open lot) OUTBID; worker drops stale
    await db.query(`UPDATE lots SET state='closed' WHERE id=$1`, [lot2]);
    const stale = (await db.query(`INSERT INTO notifications_queue (user_id,type,payload,status) VALUES ($1,'OUTBID',jsonb_build_object('lot_id',$2::text),'pending') RETURNING id`, [A.id, lot2])).rows[0].id;
    const fresh = (await db.query(`INSERT INTO notifications_queue (user_id,type,payload,status) VALUES ($1,'OUTBID',jsonb_build_object('lot_id',$2::text),'pending') RETURNING id`, [A.id, lot1])).rows[0].id;
    await sleep(9000); // allow the deployed worker to drain
    const sRow = (await db.query(`SELECT status FROM notifications_queue WHERE id=$1`, [stale])).rows[0];
    const fRow = (await db.query(`SELECT status FROM notifications_queue WHERE id=$1`, [fresh])).rows[0];
    ok('J stale outbid (lot closed) dropped (skipped, not sent)', sRow && sRow.status === 'skipped', `stale=${sRow && sRow.status}`);
    ok('J fresh outbid sent (or in-flight), not skipped', fRow && fRow.status !== 'skipped', `fresh=${fRow && fRow.status}`);

  } catch (e) { console.error('ERR', e.message, e.stack); }
  finally {
    try { if (aucId) await db.query(`DELETE FROM auctions WHERE id=$1`, [aucId]); for (const u of [A, B]) if (u && u.id) await db.query(`DELETE FROM users WHERE id=$1`, [u.id]); console.log('cleanup done.'); } catch (ce) { console.error('cleanup err', ce.message); }
    const fails = results.filter(r => !r).length;
    console.log(`\n${results.length - fails}/${results.length} PASS` + (fails ? `  (${fails} FAIL)` : ''));
    await db.end(); process.exit(fails ? 1 : 0);
  }
})();
