require('dotenv').config();
const { Pool } = require('pg');

const AUCTION_ID = 'a1000000-0000-4000-8000-000000000001';
const LOT_ID     = 'b2000000-0000-4000-8000-000000000001';
const WINNER_ID  = '1e42bebb-8325-4f8c-ad82-86837bba7a9b'; // buyer@test.com

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  await pool.query(
    `INSERT INTO auctions (id, title, state)
     VALUES ($1, 'Payment Test Auction', 'closed')
     ON CONFLICT (id) DO NOTHING`,
    [AUCTION_ID]
  );

  await pool.query(
    `INSERT INTO lots (id, auction_id, title, state, winning_buyer_user_id, winning_amount_cents)
     VALUES ($1, $2, 'Payment Test Lot', 'closed', $3, 5000)
     ON CONFLICT (id) DO NOTHING`,
    [LOT_ID, AUCTION_ID, WINNER_ID]
  );

  const { rows } = await pool.query(
    `SELECT l.id AS lot_id, l.auction_id, l.state, l.winning_buyer_user_id, l.winning_amount_cents
     FROM lots l WHERE l.id = $1`,
    [LOT_ID]
  );

  console.log(JSON.stringify(rows[0], null, 2));
  await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
