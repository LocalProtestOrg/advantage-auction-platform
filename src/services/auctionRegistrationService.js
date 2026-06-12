// #20 Auction (bidder) registration. Reuses auction_buyers (migration 062).
// Registration requires: active user + accepted current buyer terms + pickup
// acknowledgement + an eligible auction. The bid gate additionally requires an
// ACTIVE registration row. Card-on-file is STEP 4 (not enforced here yet).
const db = require('../db');
const termsService = require('./termsService');
const { writeAuditLog } = require('../lib/auditLog');

const REGISTRABLE_STATES = ['published', 'active'];

class RegistrationError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

async function _currentTermsAcceptanceId(userId) {
  const { rows } = await db.query(
    `SELECT ta.id
       FROM terms_acceptances ta
       JOIN terms_versions tv ON tv.id = ta.terms_version_id
      WHERE ta.user_id = $1 AND tv.kind = 'buyer_terms' AND tv.is_current = true
      LIMIT 1`,
    [userId]
  );
  return rows[0] ? rows[0].id : null;
}

// Register (or re-activate) the user for an auction. Idempotent via
// UNIQUE(auction_id, user_id). Throws RegistrationError on a failed precondition.
async function registerForAuction(userId, auctionId, { pickupAcknowledged } = {}) {
  if (pickupAcknowledged !== true) {
    throw new RegistrationError('PICKUP_NOT_ACK', 'You must acknowledge the pickup obligations to register.', 422);
  }
  const u = (await db.query('SELECT is_active FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) throw new RegistrationError('NO_USER', 'Account not found.', 401);
  if (u.is_active === false) throw new RegistrationError('INACTIVE', 'Account suspended. Contact Advantage Auction support.', 403);

  const a = (await db.query('SELECT state FROM auctions WHERE id = $1', [auctionId])).rows[0];
  if (!a) throw new RegistrationError('NO_AUCTION', 'Auction not found.', 404);
  if (!REGISTRABLE_STATES.includes(a.state)) {
    throw new RegistrationError('NOT_ELIGIBLE', 'This auction is not open for registration.', 422);
  }

  if (!(await termsService.hasAcceptedCurrentTerms(userId))) {
    throw new RegistrationError('TERMS_NOT_ACCEPTED', 'Please accept the current Buyer Terms & Conditions before registering.', 403);
  }
  const termsAcceptanceId = await _currentTermsAcceptanceId(userId);

  // Assign the next paddle number for this auction on first insert; preserve it
  // on re-registration. (Rare concurrent collisions on the auction-scoped paddle
  // unique index surface as an error the client can retry — acceptable at launch.)
  const res = await db.query(
    `INSERT INTO auction_buyers
       (auction_id, user_id, paddle_number, terms_acceptance_id, pickup_acknowledged, status, registered_at)
     VALUES (
       $1, $2,
       (SELECT COALESCE(MAX(paddle_number), 99) + 1 FROM auction_buyers WHERE auction_id = $1),
       $3, true, 'active', now())
     ON CONFLICT (auction_id, user_id) DO UPDATE
       SET terms_acceptance_id = EXCLUDED.terms_acceptance_id,
           pickup_acknowledged = true,
           status = 'active'
     RETURNING id, paddle_number, status, (xmax = 0) AS inserted`,
    [auctionId, userId, termsAcceptanceId]
  );
  const row = res.rows[0];
  writeAuditLog({
    event_type:  'auction.bidder_registered',
    entity_type: 'auction_buyer',
    entity_id:   row.id,
    auction_id:  auctionId,
    actor_id:    userId,
    metadata:    { paddle_number: row.paddle_number, new: row.inserted },
  }).catch(() => {});

  return { registration_id: row.id, paddle_number: row.paddle_number, status: row.status, newly_registered: row.inserted };
}

async function getRegistrationStatus(userId, auctionId) {
  const reg = (await db.query(
    `SELECT status, pickup_acknowledged, registered_at, paddle_number
       FROM auction_buyers WHERE auction_id = $1 AND user_id = $2`,
    [auctionId, userId]
  )).rows[0] || null;
  const termsAccepted = await termsService.hasAcceptedCurrentTerms(userId);
  const registeredActive = !!reg && reg.status === 'active';
  return {
    registered: registeredActive,
    status: reg ? reg.status : null,
    pickup_acknowledged: reg ? reg.pickup_acknowledged : false,
    terms_accepted_current: termsAccepted,
    paddle_number: reg ? reg.paddle_number : null,
    can_bid: registeredActive && termsAccepted,
  };
}

// Server bid gate. Returns { ok } or { ok:false, status, code, message }.
async function assertCanBid(userId, auctionId) {
  const u = (await db.query('SELECT is_active FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) return { ok: false, status: 401, code: 'NOT_LOGGED_IN', message: 'Please log in to bid.' };
  if (u.is_active === false) return { ok: false, status: 403, code: 'INACTIVE', message: 'Account suspended. Contact Advantage Auction support.' };
  if (!(await termsService.hasAcceptedCurrentTerms(userId))) {
    return { ok: false, status: 403, code: 'TERMS_NOT_ACCEPTED', message: 'Please accept the current Buyer Terms & Conditions to bid.' };
  }
  const reg = (await db.query('SELECT status FROM auction_buyers WHERE auction_id = $1 AND user_id = $2', [auctionId, userId])).rows[0];
  if (!reg) return { ok: false, status: 403, code: 'NOT_REGISTERED', message: 'Please register to bid in this auction.' };
  if (reg.status !== 'active') return { ok: false, status: 403, code: 'REGISTRATION_REVOKED', message: 'Your registration for this auction is not active.' };
  return { ok: true };
}

module.exports = { registerForAuction, getRegistrationStatus, assertCanBid, RegistrationError };
