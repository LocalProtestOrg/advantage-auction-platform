const db = require('../db/index');

// ── resolveBidIncrement ────────────────────────────────────────────────────────
// Walks the hierarchy: lot → auction → auction_house → 500 (cents).
// Uses the already-open transaction client; never opens its own connection.
async function resolveBidIncrement(client, lot) {
  // 1. Lot-level override — highest precedence.
  if (lot.bid_increment != null) {
    return Math.round(lot.bid_increment * 100);
  }

  // 2. Fetch auction (only when needed).
  if (!lot.auction_id) return 500;
  const auctionRes = await client.query(
    `SELECT bid_increment_cents, auction_house_id FROM auctions WHERE id = $1`,
    [lot.auction_id]
  );
  const auction = auctionRes.rows[0];
  if (!auction) return 500;

  // 3. Auction-level override.
  if (auction.bid_increment_cents != null) {
    return auction.bid_increment_cents;
  }

  // 4. Fetch auction house (only when needed).
  if (!auction.auction_house_id) return 500;
  const houseRes = await client.query(
    `SELECT default_bid_increment_cents FROM auction_houses WHERE id = $1`,
    [auction.auction_house_id]
  );
  const house = houseRes.rows[0];

  // 5. House default, or hardcoded fallback.
  return (house && house.default_bid_increment_cents != null)
    ? house.default_bid_increment_cents
    : 500;
}

// ── resolveProxyBid ───────────────────────────────────────────────────────────
// Called inside an open transaction on a FOR-UPDATE locked lot row.
// Upserts the caller's max, re-ranks all proxies, computes visible price,
// writes bid history + lot fields, then returns resolution detail.
async function resolveProxyBid(client, lot, bidderUserId, maxAmountCents, increment) {
  const currentBidCents  = lot.current_bid_cents || 0;
  const startingBidCents = lot.starting_bid_cents || 100;

  // Minimum acceptable max = must beat current price by at least one increment.
  const minMaxCents = Math.max(startingBidCents, currentBidCents + increment);
  if (maxAmountCents < minMaxCents) {
    throw new Error(
      `Max bid must be at least $${(minMaxCents / 100).toFixed(2)}`
    );
  }

  // Upsert — only ever raises the max, never lowers it.
  await client.query(
    `INSERT INTO lot_proxy_bids (lot_id, bidder_user_id, max_amount_cents)
     VALUES ($1, $2, $3)
     ON CONFLICT (lot_id, bidder_user_id) DO UPDATE
       SET max_amount_cents = GREATEST(lot_proxy_bids.max_amount_cents, EXCLUDED.max_amount_cents),
           updated_at = now()`,
    [lot.id, bidderUserId, maxAmountCents]
  );

  // Re-read all proxy bids for this lot (still inside the transaction / row lock).
  const proxyRes = await client.query(
    `SELECT * FROM lot_proxy_bids
     WHERE lot_id = $1
     ORDER BY max_amount_cents DESC, created_at ASC`,
    [lot.id]
  );
  const proxies  = proxyRes.rows;
  const winner   = proxies[0];
  const runnerUp = proxies[1] || null;

  // Visible price rule:
  //   1 bidder  → starting bid (or current bid if higher) — winner's max stays hidden.
  //   2+ bidders → second-highest max + one increment, capped at winner's max.
  let visibleCents;
  if (!runnerUp) {
    visibleCents = Math.max(startingBidCents, currentBidCents);
  } else {
    visibleCents = Math.min(
      runnerUp.max_amount_cents + increment,
      winner.max_amount_cents
    );
  }

  // Bid history row for the winner at the visible price (is_proxy = true).
  const insertResult = await client.query(
    `INSERT INTO bids (lot_id, user_id, amount, is_proxy)
     VALUES ($1, $2, $3, true)
     RETURNING *`,
    [lot.id, winner.bidder_user_id, visibleCents / 100]
  );

  // Update lot: visible price + live winner.
  await client.query(
    `UPDATE lots
     SET current_bid_cents      = $1,
         current_price          = $2,
         current_winner_user_id = $3
     WHERE id = $4`,
    [visibleCents, visibleCents / 100, winner.bidder_user_id, lot.id]
  );

  // Queue notifications inside the same transaction so they commit atomically
  // with the bid. No external API calls here — a worker drains the queue later.
  const previousWinnerId = lot.current_winner_user_id || null;
  const newWinnerId      = winner.bidder_user_id;
  const notifPayload     = JSON.stringify({ lot_id: lot.id, visible_cents: visibleCents });

  // Helper: resolves true if the user has email enabled (defaults true when no prefs row).
  async function emailEnabled(userId) {
    const res = await client.query(
      `SELECT COALESCE(email_enabled, true) AS email_enabled
       FROM notification_preferences
       WHERE user_id = $1`,
      [userId]
    );
    return res.rows.length === 0 ? true : res.rows[0].email_enabled;
  }

  if (previousWinnerId && previousWinnerId !== newWinnerId) {
    if (await emailEnabled(previousWinnerId)) {
      await client.query(
        `INSERT INTO notifications_queue (user_id, type, payload) VALUES ($1, 'OUTBID', $2)`,
        [previousWinnerId, notifPayload]
      );
    }
  }

  if (await emailEnabled(newWinnerId)) {
    await client.query(
      `INSERT INTO notifications_queue (user_id, type, payload) VALUES ($1, 'LEADING', $2)`,
      [newWinnerId, notifPayload]
    );
  }

  return {
    bid:            insertResult.rows[0],
    winner_user_id: newWinnerId,
    visible_cents:  visibleCents,
    proxy_count:    proxies.length,
  };
}

// ── applyAntiSnipe ────────────────────────────────────────────────────────────
// Must be called inside an open transaction, after bid + lot updates, before COMMIT.
// Returns the final closes_at value (extended or original). Untouched by this change.
async function applyAntiSnipe(client, lot) {
  if (!lot.closes_at) return null;
  const remaining = new Date(lot.closes_at).getTime() - Date.now();
  if (remaining > 0 && remaining <= 60000) {
    const extRes = await client.query(
      `UPDATE lots
       SET closes_at       = closes_at + interval '60 seconds',
           extension_count = extension_count + 1
       WHERE id = $1
       RETURNING closes_at`,
      [lot.id]
    );
    const extended = extRes.rows[0].closes_at;
    console.log('[bid] anti-snipe extension applied, new closes_at:', extended);

    // Notify all bidders + watchers of the extension.
    // Dedup key = (user, lot, closes_at) — each unique extension fires once per user.
    await client.query(
      `INSERT INTO notifications_queue (user_id, type, payload)
       SELECT DISTINCT candidates.user_id,
              'EXTENDED_BIDDING',
              jsonb_build_object(
                'lot_id',        $1::text,
                'closes_at',     $2::text,
                'visible_cents', $3::int
              )
       FROM (
              SELECT user_id FROM bids       WHERE lot_id = $1
              UNION
              SELECT user_id FROM watchlists WHERE lot_id = $1
            ) candidates
       WHERE NOT EXISTS (
               SELECT 1 FROM notifications_queue nq
               WHERE  nq.user_id              = candidates.user_id
                 AND  nq.type                 = 'EXTENDED_BIDDING'
                 AND  nq.payload->>'lot_id'   = $1::text
                 AND  nq.payload->>'closes_at' = $2::text
             )`,
      [lot.id, extended.toISOString(), lot.current_bid_cents || 0]
    );

    return extended;
  }
  return lot.closes_at;
}

// ── createBid ─────────────────────────────────────────────────────────────────
// All bids — manual or proxy — flow through resolveProxyBid.
// A manual bid (amount) is treated as a max bid equal to the submitted amount.
async function createBid(lotId, userId, { amount, maxBid, max_bid_cents }) {
  // Step 1 — Normalize to a single ceiling value in cents.
  let submittedMaxCents;
  if (max_bid_cents != null && Number(max_bid_cents) > 0) {
    submittedMaxCents = Math.round(Number(max_bid_cents));
  } else if (amount != null && Number(amount) > 0) {
    submittedMaxCents = Math.round(Number(amount) * 100);
  } else {
    throw new Error('Enter a bid amount or max bid');
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Lock the lot row for the duration of this transaction.
    const lotRes = await client.query(
      'SELECT * FROM lots WHERE id = $1 FOR UPDATE',
      [lotId]
    );
    const lot = lotRes.rows[0];
    if (!lot) throw new Error('Lot not found');

    // Status guard (route pre-flight already checked; this is the DB-level guard).
    if (!['draft', 'open', 'active'].includes(lot.status || lot.state)) {
      throw new Error('Bidding not allowed on this lot');
    }

    // Resolve increment once for this transaction.
    const increment = await resolveBidIncrement(client, lot);

    console.log('BID SUBMITTED (UNIFIED)', {
      userId,
      submittedMaxCents,
      increment,
      currentBidCents: lot.current_bid_cents,
    });

    // Step 4 — Validate minimum before touching any state.
    const currentBidCents  = lot.current_bid_cents || 0;
    const startingBidCents = lot.starting_bid_cents || 100;
    const minAllowed = Math.max(startingBidCents, currentBidCents + increment);
    if (submittedMaxCents < minAllowed) {
      throw new Error(`Bid must be at least $${(minAllowed / 100).toFixed(2)}`);
    }

    // Step 3 — Single resolution path for all bid types.
    const resolution = await resolveProxyBid(client, lot, userId, submittedMaxCents, increment);

    // Step 6 — Anti-snipe (unchanged, position unchanged).
    const finalClosesAt = await applyAntiSnipe(client, lot);

    await client.query('COMMIT');

    const result = {
      ...resolution.bid,
      closes_at:      finalClosesAt,
      is_proxy:       true,
      winner_user_id: resolution.winner_user_id,
      visible_cents:  resolution.visible_cents,
    };

    console.log('CREATE BID SUCCESS', result);
    return result;

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('CREATE BID ERROR:', error);
    throw error;
  } finally {
    client.release();
  }
}

// ── getBidsByLot ──────────────────────────────────────────────────────────────
async function getBidsByLot(lotId) {
  const res = await db.query(
    `SELECT * FROM bids WHERE lot_id = $1 ORDER BY created_at DESC`,
    [lotId]
  );
  return res.rows;
}

module.exports = { createBid, getBidsByLot, resolveBidIncrement };
