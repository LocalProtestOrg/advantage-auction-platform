const db = require('../db');

const VALID_METHODS = ['ach', 'check'];

const ACH_FIELDS   = ['ach_account_last4', 'ach_routing_last4', 'ach_account_name'];
const CHECK_FIELDS = ['check_payee_name', 'check_address_line1', 'check_address_line2',
                      'check_city', 'check_state', 'check_postal_code'];
const ALL_PREF_FIELDS = [...ACH_FIELDS, ...CHECK_FIELDS];

async function upsertSellerPayoutPreference(sellerUserId, payload) {
  const { payout_method } = payload;

  if (!VALID_METHODS.includes(payout_method)) {
    throw new Error(`Invalid payout_method: must be 'ach' or 'check'`);
  }

  // Start with required + timestamp columns; optional fields appended after
  const cols = ['payout_method', 'updated_at'];
  const vals = [payout_method, new Date()];

  for (const field of ALL_PREF_FIELDS) {
    if (payload[field] !== undefined) {
      cols.push(field);
      vals.push(payload[field]);
    }
  }

  // sellerUserId is the final parameter — its $N is cols.length + 1
  const sellerIdx = vals.length + 1;
  vals.push(sellerUserId);

  const colList = cols.join(', ');
  const valList = cols.map((_, i) => `$${i + 1}`).join(', ');
  const setList = cols.map((col, i) => `${col} = $${i + 1}`).join(', ');

  const result = await db.query(
    `INSERT INTO seller_payout_preferences (seller_user_id, ${colList})
     VALUES ($${sellerIdx}, ${valList})
     ON CONFLICT (seller_user_id) DO UPDATE
       SET ${setList}
     RETURNING *`,
    vals
  );

  return result.rows[0];
}

async function getSellerPayoutPreference(sellerUserId) {
  const result = await db.query(
    'SELECT * FROM seller_payout_preferences WHERE seller_user_id = $1',
    [sellerUserId]
  );
  return result.rows[0] || null;
}

module.exports = { upsertSellerPayoutPreference, getSellerPayoutPreference };
