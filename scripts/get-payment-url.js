require('dotenv').config();
const { Pool } = require('pg');
const http = require('http');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function post(path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: 'localhost', port: 3000, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  // 1. Find a closed lot with a winner and no blocking payment
  const { rows } = await pool.query(`
    SELECT l.id AS lot_id, l.auction_id, l.winning_buyer_user_id, l.winning_amount_cents,
           u.email
    FROM lots l
    JOIN users u ON u.id = l.winning_buyer_user_id
    WHERE l.state = 'closed'
      AND l.winning_buyer_user_id IS NOT NULL
      AND l.winning_amount_cents IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM payments p
        WHERE p.lot_id = l.id
          AND p.buyer_user_id = l.winning_buyer_user_id
          AND p.status IN ('pending', 'paid', 'refunded', 'partially_refunded')
      )
    LIMIT 1
  `);

  if (!rows[0]) {
    console.error('No eligible lot found (all closed lots may already have payments).');
    process.exit(1);
  }

  const { lot_id, auction_id, winning_buyer_user_id, winning_amount_cents, email } = rows[0];
  console.log(`Lot:     ${lot_id}`);
  console.log(`Auction: ${auction_id}`);
  console.log(`Winner:  ${email} (${winning_buyer_user_id})`);
  console.log(`Amount:  $${(winning_amount_cents / 100).toFixed(2)}`);

  // 2. Login as the winner (assumes password123)
  const login = await post('/api/auth/login', { email, password: 'password123' });
  if (!login.token) { console.error('Login failed:', login); process.exit(1); }

  // 3. Call charge-lot
  const charge = await post(
    '/api/payments/charge-lot',
    { lot_id, auction_id },
    { 'Authorization': `Bearer ${login.token}`, 'Idempotency-Key': `payment-live-${Date.now()}` }
  );

  if (!charge.success) { console.error('charge-lot failed:', charge); process.exit(1); }

  const { client_secret, amount_cents } = charge.data;
  const url = `http://localhost:3000/payment.html?client_secret=${client_secret}&amount=${amount_cents}&lot_id=${lot_id}`;
  console.log('\nPayment URL:');
  console.log(url);

  await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
