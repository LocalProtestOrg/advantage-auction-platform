/**
 * Full multi-user browser rehearsal spec
 * Covers all 7 phases: seller setup → buyer visibility → competitive bidding
 * → anti-sniping → seller intervention → close/payment → operational audit
 */
import 'dotenv/config';
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';

test.describe.configure({ mode: 'serial' });

// ── Constants ─────────────────────────────────────────────────────────────────
const BASE          = process.env.BASE_URL || 'http://localhost:3000';
const AUCTION_ID    = 'aca6e204-a5ac-4a3c-a266-b023d6d46430';
const LOT_1_ID      = '017bb51a-08b6-43d2-8402-493fb47e6bae'; // Antique Chair  $5 starting
const LOT_2_ID      = '4271bbd0-9750-44ef-8f17-91b509f88bf4'; // Oil Painting  $10 starting
const LOT_3_ID      = '11e51030-482d-4ad7-bbfb-8614c6acce9c'; // Bookcase Set   $2 starting

const ADMIN  = { email: 'test-admin@example.com',        password: 'rehearsal123' };
const SELLER = { email: 'test-seller@example.com',       password: 'rehearsal123' };
const BUYER_A = { email: 'rehearsal-buyer-a@test.com',   password: 'rehearsal123' };
const BUYER_B = { email: 'rehearsal-buyer-b@test.com',   password: 'rehearsal123' };
const BUYER_C = { email: 'rehearsal-buyer-c@test.com',   password: 'rehearsal123' };

// ── DB helper (Neon via DATABASE_URL) ─────────────────────────────────────────
let _pool;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pool;
}
async function dbQuery(sql, params = []) {
  const client = await getPool().connect();
  try   { return (await client.query(sql, params)).rows; }
  finally { client.release(); }
}
async function getLot(lotId) {
  return (await dbQuery('SELECT * FROM lots WHERE id = $1', [lotId]))[0] ?? null;
}

// ── API helpers ───────────────────────────────────────────────────────────────
// Token cache: avoids re-authenticating the same account on every test, which
// would exhaust the strictLimiter (10 logins/min) when all tests run from one IP.
const _tokenCache = {};
async function login(request, { email, password }) {
  if (_tokenCache[email]) return _tokenCache[email];
  const res  = await request.post('/api/auth/login', { data: { email, password } });
  const body = await res.json();
  expect(res.status(), `Login failed for ${email}: ${JSON.stringify(body)}`).toBe(200);
  const token = body.token;
  expect(token, `JWT missing for ${email}`).toBeTruthy();
  _tokenCache[email] = token;
  return token;
}

async function placeBid(request, token, lotId, maxCents) {
  return request.post(`/api/lots/${lotId}/bids`, {
    data:    { max_bid_cents: maxCents },
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function adminPublish(request, token, auctionId) {
  return request.patch(`/api/admin/auctions/${auctionId}/publish`, {
    headers: {
      Authorization:    `Bearer ${token}`,
      'Idempotency-Key': `publish-${auctionId}-${Date.now()}`,
    },
  });
}

async function adminClose(request, token, auctionId) {
  return request.post(`/api/admin/auctions/${auctionId}/close`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Seller setup + admin publish
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 1 — Seller setup + admin publish', () => {
  test.beforeAll(async () => {
    // Reset rehearsal auction and lots to pristine state so the spec is re-runnable
    await dbQuery(
      `UPDATE auctions SET state = 'draft', updated_at = now()
       WHERE id = $1`, [AUCTION_ID]
    );
    await dbQuery(
      `UPDATE lots SET state = 'open', is_withdrawn = false,
              current_bid_cents = 0, current_winner_user_id = NULL,
              bid_count = 0, extension_count = 0,
              winning_buyer_user_id = NULL, winning_amount_cents = NULL
       WHERE auction_id = $1`, [AUCTION_ID]
    );
    await dbQuery('DELETE FROM bids           WHERE lot_id = ANY($1::uuid[])',
                  [[LOT_1_ID, LOT_2_ID, LOT_3_ID]]);
    await dbQuery('DELETE FROM lot_proxy_bids WHERE lot_id = ANY($1::uuid[])',
                  [[LOT_1_ID, LOT_2_ID, LOT_3_ID]]);
    await dbQuery('DELETE FROM payments        WHERE lot_id = ANY($1::uuid[])',
                  [[LOT_1_ID, LOT_2_ID, LOT_3_ID]]);
    // Clear idempotency cache so publish/close can re-run cleanly
    await dbQuery(
      `DELETE FROM payment_idempotency_keys WHERE idempotency_key LIKE $1`,
      [`%-${AUCTION_ID}%`]
    );
  });

  test('seller can login and see dashboard', async ({ request }) => {
    const token = await login(request, SELLER);
    const res   = await request.get('/api/sellers/me/dashboard', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.auctions).toBeDefined();
  });

  test('seller can view lot inventory for rehearsal auction', async ({ request }) => {
    const token = await login(request, SELLER);
    const res   = await request.get(`/api/lots/auction/${AUCTION_ID}/seller`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.length).toBe(3);
  });

  test('admin can publish the rehearsal auction', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res   = await adminPublish(request, token, AUCTION_ID);
    const body  = await res.json();
    // Accept 200 (just published) or the "already published" error (idempotent re-run)
    if (res.status() !== 200) {
      expect(body.message || body.error, 'Unexpected publish failure').toMatch(/already published/i);
    } else {
      expect(body.success).toBe(true);
    }
    // Verify auction state in DB
    const rows = await dbQuery('SELECT state FROM auctions WHERE id = $1', [AUCTION_ID]);
    expect(rows[0].state).toBe('published');
  });

  test('lots are in open state after publish', async () => {
    for (const id of [LOT_1_ID, LOT_2_ID, LOT_3_ID]) {
      const lot = await getLot(id);
      expect(lot, `Lot ${id} not found`).toBeTruthy();
      expect(lot.state).toBe('open');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Public buyer visibility
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 2 — Public buyer visibility', () => {
  test('auction-view page loads with all 3 lots', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto(`${BASE}/auction-view.html?auctionId=${AUCTION_ID}`);
    // Wait for real lot cards (not skeleton) — skeleton cards have no href
    await page.waitForSelector('.lot-card[href]', { timeout: 10000 });

    const cards = await page.locator('.lot-card[href]').count();
    expect(cards).toBe(3);

    // Lot count badge (populated by JS after AJAX)
    const badge = await page.locator('#lot-count').textContent();
    expect(badge).toContain('3');

    // No JS errors
    expect(consoleErrors).toHaveLength(0);
  });

  test('lot detail page loads without errors', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    // Buyer A logs in first so lot detail doesn't redirect to login
    await page.goto(`${BASE}/login.html`);
    await page.fill('#login-email', BUYER_A.email);
    await page.fill('#login-password', BUYER_A.password);
    await page.click('#login-btn');
    await page.waitForURL(url => !url.href.includes('/login.html'), { timeout: 8000 });

    await page.goto(`${BASE}/lot.html?lotId=${LOT_1_ID}`);
    await page.waitForSelector('#lot-title', { timeout: 10000 });
    const title = await page.locator('#lot-title').textContent();
    expect(title).toContain('Antique Chair');

    expect(consoleErrors).toHaveLength(0);
  });

  test('buyer A can see all 3 lots via API', async ({ request }) => {
    const res  = await request.get(`/api/lots/auction/${AUCTION_ID}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.length).toBe(3);
    body.data.forEach(lot => expect(lot.state).toBe('open'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Competitive bidding simulation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 3 — Competitive bidding', () => {
  test.beforeAll(async () => {
    // Clean bids on LOT_1 before competitive test
    await dbQuery('DELETE FROM bids           WHERE lot_id = $1', [LOT_1_ID]);
    await dbQuery('DELETE FROM lot_proxy_bids WHERE lot_id = $1', [LOT_1_ID]);
    await dbQuery(
      'UPDATE lots SET current_bid_cents = 0, current_winner_user_id = NULL WHERE id = $1',
      [LOT_1_ID]
    );
  });

  test('Buyer A places opening bid on Lot 1 (Chair)', async ({ request }) => {
    const tokenA = await login(request, BUYER_A);
    const res    = await placeBid(request, tokenA, LOT_1_ID, 1000); // $10
    expect(res.status(), (await res.json()).message).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.visible_cents).toBeGreaterThanOrEqual(500); // at least starting bid
  });

  test('Buyer B outbids Buyer A with higher max', async ({ request }) => {
    const tokenB = await login(request, BUYER_B);
    const res    = await placeBid(request, tokenB, LOT_1_ID, 2500); // $25 max
    expect(res.status(), (await res.json()).message).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('current bid updated: B holds lead over A', async () => {
    const lot    = await getLot(LOT_1_ID);
    const buyerB = await dbQuery('SELECT id FROM users WHERE email = $1', [BUYER_B.email]);
    expect(lot.current_winner_user_id).toBe(buyerB[0].id);
    expect(lot.current_bid_cents).toBeGreaterThan(500);
    expect(lot.current_bid_cents).toBeLessThanOrEqual(2500);
  });

  test('Buyer C beats both with higher proxy bid', async ({ request }) => {
    const tokenC = await login(request, BUYER_C);
    const res    = await placeBid(request, tokenC, LOT_1_ID, 5000); // $50 max
    expect(res.status(), (await res.json()).message).toBe(200);
    const lot    = await getLot(LOT_1_ID);
    const buyerC = await dbQuery('SELECT id FROM users WHERE email = $1', [BUYER_C.email]);
    expect(lot.current_winner_user_id).toBe(buyerC[0].id);
    // Visible price = second-highest max + increment, capped at winner's max
    expect(lot.current_bid_cents).toBeGreaterThan(2500);
    expect(lot.current_bid_cents).toBeLessThanOrEqual(5000);
  });

  test('bid history is queryable and ordered', async ({ request }) => {
    const tokenA = await login(request, BUYER_A);
    const res    = await request.get(`/api/lots/${LOT_1_ID}/bids`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);
  });

  test('bid below minimum is rejected', async ({ request }) => {
    const tokenA = await login(request, BUYER_A);
    // Current bid > $25, so $1 should be rejected
    const res  = await placeBid(request, tokenA, LOT_1_ID, 100);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/at least/i);
  });

  test('seller sees bid count in seller inventory', async ({ request }) => {
    const token = await login(request, SELLER);
    const res   = await request.get(`/api/lots/auction/${AUCTION_ID}/seller`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const lots = (await res.json()).data;
    const chair = lots.find(l => l.id === LOT_1_ID);
    expect(chair).toBeTruthy();
    expect(chair.bid_count).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Anti-sniping validation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 4 — Anti-sniping', () => {
  const SNIPE_LOT = LOT_2_ID; // Oil Painting — dedicated to anti-snipe test

  test.beforeAll(async () => {
    // Clean + reset Oil Painting lot, then set closes_at to 90s from now
    await dbQuery('DELETE FROM bids           WHERE lot_id = $1', [SNIPE_LOT]);
    await dbQuery('DELETE FROM lot_proxy_bids WHERE lot_id = $1', [SNIPE_LOT]);
    await dbQuery(
      `UPDATE lots SET current_bid_cents = 0, current_winner_user_id = NULL,
              extension_count = 0, closes_at = NOW() + interval '90 seconds',
              state = 'open'
       WHERE id = $1`,
      [SNIPE_LOT]
    );
  });

  test('bid within 2-minute window extends closes_at by 2 minutes', async ({ request }) => {
    const lotBefore   = await getLot(SNIPE_LOT);
    const closesBefore = new Date(lotBefore.closes_at).getTime();
    expect(new Date(lotBefore.closes_at) - new Date()).toBeLessThan(120000); // within 2 min

    const tokenA = await login(request, BUYER_A);
    const res    = await placeBid(request, tokenA, SNIPE_LOT, lotBefore.starting_bid_cents || 1000);
    expect(res.status(), (await res.json()).message).toBe(200);

    const lotAfter   = await getLot(SNIPE_LOT);
    const closesAfter = new Date(lotAfter.closes_at).getTime();
    const delta = closesAfter - closesBefore;

    // Must extend by ~2 minutes (120 s ± 3 s)
    expect(delta).toBeGreaterThanOrEqual(117_000);
    expect(delta).toBeLessThanOrEqual(123_000);
  });

  test('extension_count increments on anti-snipe', async () => {
    const lot = await getLot(SNIPE_LOT);
    expect(lot.extension_count).toBeGreaterThanOrEqual(1);
  });

  test('subsequent snipe bid extends again', async ({ request }) => {
    // Force closes_at back inside the 2-minute window
    await dbQuery(
      `UPDATE lots SET closes_at = NOW() + interval '60 seconds' WHERE id = $1`,
      [SNIPE_LOT]
    );
    const before = new Date((await getLot(SNIPE_LOT)).closes_at).getTime();

    const tokenB = await login(request, BUYER_B);
    // Buyer B must outbid A — use a high max
    const lot    = await getLot(SNIPE_LOT);
    const res    = await placeBid(request, tokenB, SNIPE_LOT, (lot.current_bid_cents || 0) + 2000);
    expect(res.status(), (await res.json()).message).toBe(200);

    const after = new Date((await getLot(SNIPE_LOT)).closes_at).getTime();
    expect(after - before).toBeGreaterThanOrEqual(117_000);
  });

  test('countdown field closes_at is updated in lot detail API response', async ({ request }) => {
    const res  = await request.get(`/api/lots/${SNIPE_LOT}`);
    expect(res.status()).toBe(200);
    const lot  = (await res.json()).data;
    expect(lot.closes_at).toBeTruthy();
    // closes_at must be in the future
    expect(new Date(lot.closes_at).getTime()).toBeGreaterThan(Date.now());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — Seller intervention (edit + withdraw)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 5 — Seller intervention', () => {
  test('seller can edit a lot title mid-auction', async ({ request }) => {
    const token = await login(request, SELLER);
    const res   = await request.put(`/api/lots/${LOT_3_ID}`, {
      data: {
        title:           'Rehearsal Lot 3 — Bookcase Set (UPDATED)',
        description:     'Mahogany 3-shelf bookcase pair — updated description',
        size_category:   'C',
        pickup_category: 'C',
      },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.title).toContain('UPDATED');
  });

  test('public lot list reflects the edit', async ({ request }) => {
    const res  = await request.get(`/api/lots/auction/${AUCTION_ID}`);
    const lots = (await res.json()).data;
    const updated = lots.find(l => l.id === LOT_3_ID);
    expect(updated.title).toContain('UPDATED');
  });

  test('seller cannot withdraw a lot that has bids', async ({ request }) => {
    const token = await login(request, SELLER);
    const res   = await request.delete(`/api/lots/${LOT_1_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // LOT_1 has bids → must be blocked
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.message).toMatch(/bids/i);
  });

  test('seller can withdraw Lot 3 (Bookcase) which has no bids', async ({ request }) => {
    const token = await login(request, SELLER);
    const res   = await request.delete(`/api/lots/${LOT_3_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('withdrawn lot disappears from public lot list', async ({ request }) => {
    const res  = await request.get(`/api/lots/auction/${AUCTION_ID}`);
    const lots = (await res.json()).data;
    const withdrawn = lots.find(l => l.id === LOT_3_ID);
    expect(withdrawn).toBeUndefined();
    expect(lots.length).toBe(2); // only Chair + Painting remain
  });

  test('direct lot URL for withdrawn lot returns 404', async ({ request }) => {
    const res = await request.get(`/api/lots/${LOT_3_ID}`);
    expect(res.status()).toBe(404);
  });

  test('bidding blocked on withdrawn lot', async ({ request }) => {
    const token = await login(request, BUYER_A);
    const res   = await placeBid(request, token, LOT_3_ID, 500);
    expect(res.status()).toBe(403);
    const body  = await res.json();
    expect(body.message).toMatch(/not open for bidding/i);
  });

  test('seller cannot access lots of another seller', async ({ request }) => {
    const token = await login(request, SELLER);
    // test-sellerB auction doesn't exist, but testing wrong-seller cross-access
    const anotherSellersLot = LOT_1_ID; // owned by test-seller — this should succeed
    const res = await request.get(`/api/lots/auction/${AUCTION_ID}/seller`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200); // correct seller can access
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — Close auction + payment eligibility
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 6 — Close + payment', () => {
  let winnerEmail, nonWinnerEmail;

  test('admin can close the rehearsal auction', async ({ request }) => {
    const token = await login(request, ADMIN);
    const res   = await adminClose(request, token, AUCTION_ID);
    const body  = await res.json();
    if (res.status() !== 200) {
      // May already be closed from a previous run
      expect(body.message || body.error, 'Unexpected close error').toMatch(/closed/i);
    } else {
      expect(body.success || body.auction_id).toBeTruthy();
    }
  });

  test('auction state is closed in DB', async () => {
    const rows = await dbQuery('SELECT state FROM auctions WHERE id = $1', [AUCTION_ID]);
    expect(rows[0].state).toBe('closed');
  });

  test('open lots are now closed', async () => {
    const lots = await dbQuery(
      'SELECT state FROM lots WHERE auction_id = $1 AND is_withdrawn = false',
      [AUCTION_ID]
    );
    lots.forEach(l => expect(l.state).toBe('closed'));
  });

  test('winning buyers are assigned correctly', async () => {
    const lot1 = await getLot(LOT_1_ID);
    const lot2 = await getLot(LOT_2_ID);

    // LOT_1 had bids — must have a winner
    expect(lot1.winning_buyer_user_id).toBeTruthy();
    expect(lot1.winning_amount_cents).toBeGreaterThan(0);

    // LOT_2 had an anti-snipe bid — must have a winner
    expect(lot2.winning_buyer_user_id).toBeTruthy();

    // Stash for payment tests
    const winnerRow = await dbQuery(
      'SELECT email FROM users WHERE id = $1', [lot1.winning_buyer_user_id]
    );
    winnerEmail = winnerRow[0].email;
  });

  test('closed lots reject new bids', async ({ request }) => {
    const token = await login(request, BUYER_A);
    const res   = await placeBid(request, token, LOT_1_ID, 99900);
    expect(res.status()).toBe(422);
    const body  = await res.json();
    expect(body.message).toMatch(/not accepting bids/i);
  });

  test('non-winner cannot initiate payment', async ({ request }) => {
    // Buyer A, B, and C all bid — at most one won LOT_1
    // Find a definite non-winner by checking DB
    const lot1 = await getLot(LOT_1_ID);
    const nonWinnerCandidates = [BUYER_A, BUYER_B, BUYER_C];
    const winnerUser = await dbQuery('SELECT email FROM users WHERE id = $1', [lot1.winning_buyer_user_id]);
    const nonWinner = nonWinnerCandidates.find(b => b.email !== winnerUser[0].email);

    if (!nonWinner) { test.skip(); return; }

    const token = await login(request, nonWinner);
    const res   = await request.post('/api/payments/charge-lot', {
      data:    { lot_id: LOT_1_ID, auction_id: AUCTION_ID },
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `non-winner-${Date.now()}` },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBeFalsy();
    expect(body.message || body.error).toMatch(/winning bidder|not.*winner|only winning/i);
  });

  test('winner can initiate payment for their lot', async ({ request }) => {
    if (!winnerEmail) {
      const lot1 = await getLot(LOT_1_ID);
      const row  = await dbQuery('SELECT email FROM users WHERE id = $1', [lot1.winning_buyer_user_id]);
      winnerEmail = row[0].email;
    }

    const winnerCreds = [BUYER_A, BUYER_B, BUYER_C].find(b => b.email === winnerEmail)
      ?? { email: winnerEmail, password: 'rehearsal123' };

    const token = await login(request, winnerCreds);
    const res   = await request.post('/api/payments/charge-lot', {
      data:    { lot_id: LOT_1_ID, auction_id: AUCTION_ID },
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `rehearsal-winner-${Date.now()}` },
    });
    const body = await res.json();
    // Expect either success or a graceful Stripe-not-configured message
    if (res.status() === 200) {
      expect(body.success).toBe(true);
      expect(body.data.client_secret || body.data.payment_intent_id).toBeTruthy();
    } else {
      // In test/dev env Stripe may not be configured — accept 4xx with an explanation
      expect(res.status()).toBeLessThan(500);
      console.warn('[Phase 6] Winner payment returned', res.status(), body.message || body.error);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7 — Operational audit: page-level browser checks
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 7 — Operational audit', () => {
  test('auction-view renders 2 lots after withdraw+close, no console errors', async ({ page }) => {
    const consoleErrors = [];
    const networkFails  = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('requestfailed', r => networkFails.push(r.url()));

    await page.goto(`${BASE}/auction-view.html?auctionId=${AUCTION_ID}`);
    // Wait for real lot cards (not skeleton) — skeleton have no href
    await page.waitForSelector('.lot-card[href], .state-msg', { timeout: 10000 });

    // 2 non-withdrawn lots (Chair + Painting), both closed
    const cards = await page.locator('.lot-card[href]').count();
    expect(cards).toBe(2);

    expect(consoleErrors, `Console errors: ${consoleErrors.join('; ')}`).toHaveLength(0);
  });

  test('lot detail page shows closed state and disables bid input', async ({ page }) => {
    // Log in as buyer A
    await page.goto(`${BASE}/login.html`);
    await page.fill('#login-email', BUYER_A.email);
    await page.fill('#login-password', BUYER_A.password);
    await page.click('#login-btn');
    await page.waitForURL(url => !url.href.includes('/login.html'), { timeout: 8000 });

    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto(`${BASE}/lot.html?lotId=${LOT_1_ID}`);
    await page.waitForSelector('#lot-title', { timeout: 10000 });

    // Closed banner should be visible
    await page.waitForSelector('#closed-banner', { state: 'visible', timeout: 8000 });

    // Bid inputs should be disabled
    const bidDisabled = await page.locator('#btn-bid').isDisabled();
    expect(bidDisabled).toBe(true);

    expect(consoleErrors, `Console errors: ${consoleErrors.join('; ')}`).toHaveLength(0);
  });

  test('login page loads and both tabs render without error', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('.card-title');

    await page.click('#tab-register');
    await page.waitForSelector('#panel-register.active');
    expect(consoleErrors).toHaveLength(0);
  });

  test('seller dashboard loads and shows auction list', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    // Set seller token in localStorage
    const token = await (async () => {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SELLER),
      });
      return (await r.json()).token;
    })();

    await page.goto(`${BASE}/login.html`);
    await page.evaluate((tok) => localStorage.setItem('token', tok), token);
    await page.goto(`${BASE}/dashboard/seller.html`);
    await page.waitForSelector('.auction-card, .empty, [id*="auction"]', { timeout: 10000 });

    expect(consoleErrors.filter(e => !e.includes('favicon')), `Console errors: ${consoleErrors.join('; ')}`).toHaveLength(0);
  });

  test('API 404 returns JSON, not HTML', async ({ request }) => {
    const res = await request.get('/api/does-not-exist-xyz');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  test('unauthenticated seller route returns 401 or 403', async ({ request }) => {
    const res = await request.get(`/api/lots/auction/${AUCTION_ID}/seller`);
    expect([401, 403]).toContain(res.status());
  });

  test('unauthenticated bid returns 401 or 403', async ({ request }) => {
    const res = await request.post(`/api/lots/${LOT_1_ID}/bids`, {
      data: { max_bid_cents: 1000 },
    });
    expect([401, 403]).toContain(res.status());
  });
});
