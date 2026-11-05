const db = require('../db');
const { maskPayoutPrefForMode } = require('../lib/stripeMode');

const VALID_METHODS = ['ach', 'check'];

const ACH_FIELDS   = ['ach_account_last4', 'ach_routing_last4', 'ach_account_name'];
const CHECK_FIELDS = ['check_payee_name', 'check_address_line1', 'check_address_line2',
                      'check_city', 'check_state', 'check_postal_code'];
const ALL_PREF_FIELDS = [...ACH_FIELDS, ...CHECK_FIELDS];

// Every change is audited (field names + masked values only) and the seller is emailed (payoutSafeguards). Replacing an
// existing payout destination needs the account's current password (options.currentPassword).
async function upsertSellerPayoutPreference(sellerUserId, payload, options = {}) {
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

  const safeguards = require('./payoutSafeguards');
  const { withTransaction } = require('../utils/withTransaction');
  const out = await withTransaction(async (client) => {
    const before = (await client.query('SELECT * FROM seller_payout_preferences WHERE seller_user_id = $1 FOR UPDATE', [sellerUserId])).rows[0] || null;
    const proposed = { ...(before || {}), payout_method };
    for (const field of ALL_PREF_FIELDS) if (payload[field] !== undefined) proposed[field] = payload[field];
    await safeguards.assertPasswordForDestinationChange(sellerUserId, { before, after: proposed, currentPassword: options.currentPassword });
    const result = await client.query(
      `INSERT INTO seller_payout_preferences (seller_user_id, ${colList})
       VALUES ($${sellerIdx}, ${valList})
       ON CONFLICT (seller_user_id) DO UPDATE
         SET ${setList}
       RETURNING *`,
      vals
    );
    const row = result.rows[0];
    const diff = await safeguards.recordPayoutDetailsChange(client, { sellerUserId, actorId: options.actorId || sellerUserId,
      source: 'payout_preferences', before, after: row });
    return { row, diff };
  });
  safeguards.notifySellerPayoutDetailsChanged(sellerUserId, out.diff).catch(() => {});
  return out.row;
}

// Readers (settlement, Direct Deposit release, seller views) only ever see provider references from the
// CURRENT payment mode: a TEST connected account / bank reference is hidden under LIVE keys, so no TEST id
// can be used for a LIVE transfer and the seller is asked to set up direct deposit again.
async function getSellerPayoutPreference(sellerUserId, runner = db) {   // runner: a transaction client, or the pool
  const result = await runner.query(
    'SELECT * FROM seller_payout_preferences WHERE seller_user_id = $1',
    [sellerUserId]
  );
  return maskPayoutPrefForMode(result.rows[0] || null);
}

module.exports = { upsertSellerPayoutPreference, getSellerPayoutPreference };
