const db = require('../db/index');
// Canonical increment ladder — shared verbatim with the client (bid-increment.js)
// so validation and the displayed "next minimum" can never diverge.
const { incrementForCents, effectiveIncrement, nextMinCents } = require('../../public/widgets/shared/bid-increment');
const realtime = require('../lib/realtime'); // #1 real-time push (pg NOTIFY)

// ── Increment resolution ───────────────────────────────────────────────────────
// The platform ladder (incrementForCents) is the default. A configured FLAT
// override (professional seller / admin) takes precedence when present, walked
// lot → auction → auction_house. resolveIncrementOverride returns that flat
// override in cents, or null when none is set (⇒ use the ladder).

// Auction/house override only (no lot row needed) — used by the list endpoint to
// resolve once, then band each lot by its own price.
async function resolveAuctionIncrementOverride(client, auctionId) {
  if (!auctionId) return null;
  const auctionRes = await client.query(
    `SELECT bid_increment_cents, auction_house_id FROM auctions WHERE id = $1`,
    [auctionId]
  );
  const auction = auctionRes.rows[0];
  if (!auction) return null;
  if (auction.bid_increment_cents != null) return auction.bid_increment_cents;
  if (!auction.auction_house_id) return null;
  const houseRes = await client.query(
    `SELECT default_bid_increment_cents FROM auction_houses WHERE id = $1`,
    [auction.auction_house_id]
  );
  const house = houseRes.rows[0];
  return (house && house.default_bid_increment_cents != null) ? house.default_bid_increment_cents : null;
}

// Full override for a specific lot: lot-level wins, else auction/house.
// NOTE: reads lot.bid_increment_cents (the canonical column). A prior bug read
// lot.bid_increment, leaving every lot-level override silently inert.
async function resolveIncrementOverride(client, lot) {
  if (lot.bid_increment_cents != null) return lot.bid_increment_cents;
  return resolveAuctionIncrementOverride(client, lot.auction_id);
}

// Minimum acceptable next bid (cents) for a lot given its flat override (or null).
function nextMinBidCents(startingCents, currentCents, override) {
  return nextMinCents(startingCents, currentCents, override);
}

// ── resolveProxyBid ───────────────────────────────────────────────────────────
// Called inside an open transaction on a FOR-UPDATE locked lot row.
// Upserts the caller's max, re-ranks all proxies, computes visible price,
// writes bid history + lot fields, then returns resolution detail.
async function resolveProxyBid(client, lot, bidderUserId, maxAmountCents, override) {
  const currentBidCents  = lot.current_bid_cents || 0;
  const startingBidCents = lot.starting_bid_cents || 100;

  // Minimum acceptable max = must beat current price by at least one increment
  // (ladder band at the current price, or the flat override when configured).
  const minMaxCents = nextMinCents(startingBidCents, currentBidCents, override);
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
      runnerUp.max_amount_cents + effectiveIncrement(runnerUp.max_amount_cents, override),
      winner.max_amount_cents
    );
  }

  // Bid history row for the winner at the visible price (is_proxy = true).
  // auction_id is denormalized for query convenience — schema defines it on
  // the bids table (db/migrations/001:156) but createBid was historically
  // inserting NULL, breaking any analytics or filter that joined via
  // bids.auction_id. lot.auction_id is available because resolveProxyBid
  // receives the full lot row loaded via SELECT * FOR UPDATE.
  const insertResult = await client.query(
    `INSERT INTO bids (lot_id, auction_id, bidder_user_id, amount_cents, is_proxy)
     VALUES ($1, $2, $3, $4, true)
     RETURNING *`,
    [lot.id, lot.auction_id, winner.bidder_user_id, visibleCents]
  );

  // Update lot: visible price + live winner + bid counter.
  await client.query(
    `UPDATE lots
     SET current_bid_cents      = $1,
         current_winner_user_id = $2,
         bid_count              = bid_count + 1
     WHERE id = $3`,
    [visibleCents, winner.bidder_user_id, lot.id]
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
  if (remaining > 0 && remaining <= 120000) {
    const extRes = await client.query(
      `UPDATE lots
       SET closes_at       = closes_at + interval '2 minutes',
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
              SELECT bidder_user_id AS user_id FROM bids       WHERE lot_id = $1
              UNION
              SELECT user_id                   FROM watchlists WHERE lot_id = $1
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

    // INT-1: an extended lot must not be auto-closed by the auction-level
    // state-transition scheduler while it still has time on its clock. We
    // recompute MAX(closes_at) over the auction's non-withdrawn lots and
    // bump auctions.end_time to track it. This UPDATE only fires when the
    // new max would push the auction's end forward — never shortens.
    // Lot extensions are intentionally uncapped per operator direction.
    await client.query(
      `UPDATE auctions
         SET end_time   = latest.max_closes,
             updated_at = NOW()
        FROM (
          SELECT MAX(closes_at) AS max_closes
            FROM lots
           WHERE auction_id = $1
             AND state != 'withdrawn'
        ) latest
        WHERE auctions.id = $1
          AND latest.max_closes IS NOT NULL
          AND (auctions.end_time IS NULL OR latest.max_closes > auctions.end_time)`,
      [lot.auction_id]
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

    // Self-bidding guard (server-authoritative): a seller must never bid on a lot
    // in an auction they own. Walks lot → auction → seller_profile → user_id and
    // rejects when the bidder is the owning seller. Runs inside the locked
    // transaction so it cannot be raced, and covers every caller of createBid.
    const ownerRes = await client.query(
      `SELECT sp.user_id
         FROM auctions a
         JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE a.id = $1`,
      [lot.auction_id]
    );
    const ownerUserId = ownerRes.rows[0] && ownerRes.rows[0].user_id;
    if (ownerUserId && String(ownerUserId) === String(userId)) {
      const e = new Error('You cannot bid on your own auction.');
      e.code = 'SELF_BID_FORBIDDEN';
      throw e;
    }

    // Status guard (route pre-flight already checked; this is the DB-level guard).
    if (!['draft', 'open', 'active'].includes(lot.status || lot.state)) {
      throw new Error('Bidding not allowed on this lot');
    }

    // Resolve the increment override once for this transaction (null ⇒ ladder).
    const override = await resolveIncrementOverride(client, lot);

    console.log('BID SUBMITTED (UNIFIED)', {
      userId,
      submittedMaxCents,
      override,
      currentBidCents: lot.current_bid_cents,
    });

    // Step 4 — Validate minimum before touching any state.
    const currentBidCents  = lot.current_bid_cents || 0;
    const startingBidCents = lot.starting_bid_cents || 100;
    const minAllowed = nextMinCents(startingBidCents, currentBidCents, override);
    if (submittedMaxCents < minAllowed) {
      throw new Error(`Bid must be at least $${(minAllowed / 100).toFixed(2)}`);
    }

    // Step 3 — Single resolution path for all bid types.
    const resolution = await resolveProxyBid(client, lot, userId, submittedMaxCents, override);

    // Step 6 — Anti-snipe (unchanged, position unchanged).
    const finalClosesAt = await applyAntiSnipe(client, lot);

    // ACCOUNT/BUYER OPS: auto-add the bid-on lot to the bidder's watchlist so it
    // surfaces on their Watchlist/Favorites page. Idempotent; best-effort inside
    // the txn (a watchlist hiccup must never fail a committed bid path).
    try {
      await client.query(
        `INSERT INTO watchlists (user_id, lot_id) VALUES ($1, $2) ON CONFLICT (user_id, lot_id) DO NOTHING`,
        [userId, lot.id]
      );
    } catch (e) { console.error('[bid] watchlist auto-add failed (non-fatal):', e.message); }

    await client.query('COMMIT');

    // #1 real-time: push the new lot state to everyone viewing the auction, plus
    // privacy-safe winning/outbid to the affected users. Best-effort — the bid is
    // already committed; a failed push must never surface. This same lot:update
    // also conveys an anti-snipe extension (closes_at + extension_count change).
    const extended = finalClosesAt && lot.closes_at
      && new Date(finalClosesAt).getTime() > new Date(lot.closes_at).getTime();
    realtime.publish('lot', {
      auction_id:                    lot.auction_id,
      lot_id:                        lot.id,
      lot_number:                    lot.lot_number,
      title:                         lot.title,
      current_bid_cents:             resolution.visible_cents,
      next_min_bid_cents:            nextMinCents(lot.starting_bid_cents || 100, resolution.visible_cents, override),
      effective_bid_increment_cents: effectiveIncrement(resolution.visible_cents, override),
      bid_count:                     (lot.bid_count || 0) + 1,
      state:                         'open',
      closes_at:                     finalClosesAt,
      extension_count:               (lot.extension_count || 0) + (extended ? 1 : 0),
      winner_user_id:                resolution.winner_user_id,
      prev_winner_user_id:           lot.current_winner_user_id || null,
    });

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

module.exports = {
  createBid,
  getBidsByLot,
  resolveIncrementOverride,
  resolveAuctionIncrementOverride,
  nextMinBidCents,
  effectiveIncrement,
  incrementForCents,
};
