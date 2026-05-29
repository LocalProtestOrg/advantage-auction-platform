const db = require('../db/index');
const auditService = require('./auditService');
const { writeAuditLog } = require('../lib/auditLog');
const { getSellerPayoutPreference } = require('./payoutPreferenceService');

async function createAuction(data) {
  const {
    sellerId,
    title,
    subtitle,
    description,
    state,
    startTime,
    endTime,
    streetAddress,
    city,
    addressState,
    zip,
    previewStart,
    previewEnd,
    pickupWindowStart,
    pickupWindowEnd,
    shippingAvailable,
    bannerImageUrl,
    coverImageUrl,
  } = data;

  const result = await db.query(
    `INSERT INTO auctions (
       seller_id, title, subtitle, description, state,
       start_time, end_time,
       street_address, city, address_state, zip,
       preview_start, preview_end,
       pickup_window_start, pickup_window_end,
       shipping_available, banner_image_url, cover_image_url
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      sellerId,
      title,
      subtitle        || null,
      description     || null,
      state           || 'draft',
      startTime       || null,
      endTime         || null,
      streetAddress   || null,
      city            || null,
      addressState    || null,
      zip             || null,
      previewStart    || null,
      previewEnd      || null,
      pickupWindowStart || null,
      pickupWindowEnd   || null,
      shippingAvailable === true,
      bannerImageUrl  || null,
      coverImageUrl   || null,
    ]
  );
  return result.rows[0];
}


// Update auction (only allowed fields, enforce ownership via seller_profiles)
//
// actorRole governs state-transition permission:
//   admin     → any state value accepted
//   non-admin → only 'submitted' accepted, and only when current state is
//               'draft' (one-shot seller self-submission for AAC Review).
//               All other non-admin state requests are silently dropped.
// Other field whitelisting is unchanged.
async function updateAuction(auctionId, userId, updates, actorRole) {
  const allowed = [
    'title', 'subtitle', 'description',
    'start_time', 'end_time',
    'street_address', 'city', 'address_state', 'zip',
    'preview_start', 'preview_end',
    'pickup_window_start', 'pickup_window_end',
    'shipping_available', 'banner_image_url', 'cover_image_url',
  ];

  // Gate state transitions separately from the generic whitelist. Defense-in-
  // depth on top of GOV-1's route-layer canMutateAuction gate — also protects
  // business sellers (who bypass GOV-1 for non-draft auctions) from setting
  // arbitrary states like 'published' / 'active' / 'closed' from the seller
  // PATCH endpoint.
  let stateToWrite = null;
  if (updates.state !== undefined) {
    if (actorRole === 'admin') {
      stateToWrite = updates.state;
    } else if (updates.state === 'submitted') {
      const cur = await db.query('SELECT state FROM auctions WHERE id = $1', [auctionId]);
      if (cur.rows[0] && cur.rows[0].state === 'draft') {
        stateToWrite = 'submitted';
      }
    }
    // All other non-admin state requests silently dropped.
  }

  const fields = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(updates[key]);
    }
  }

  if (stateToWrite !== null) {
    fields.push(`state = $${idx++}`);
    values.push(stateToWrite);
  }

  if (fields.length === 0) return null;

  values.push(new Date()); // updated_at
  fields.push(`updated_at = $${idx++}`);

  values.push(auctionId, userId);

  // OP-A: admin bypasses ownership check. Sellers still require their
  // user_id to match the auction's seller_profile owner. This is the same
  // bypass pattern used by GOV-1's canMutateAuction and other admin paths.
  const isAdmin = actorRole === 'admin';
  const query = isAdmin
    ? `
        UPDATE auctions
        SET ${fields.join(', ')}
        WHERE id = $${idx++}
        RETURNING *
      `
    : `
        UPDATE auctions
        SET ${fields.join(', ')}
        WHERE id = $${idx++}
          AND seller_id = (SELECT id FROM seller_profiles WHERE user_id = $${idx})
        RETURNING *
      `;
  // Admin path doesn't reference userId in the WHERE — drop it from the
  // parameter list to keep $${idx} substitutions aligned.
  if (isAdmin) values.pop();

  // INT-2: snapshot pre-update values so we can write a diff to audit_log
  // after the UPDATE succeeds. Run this just-in-time and tolerate failure —
  // an audit gap must never block the mutation.
  let beforeRow = null;
  try {
    const beforeRes = await db.query(
      `SELECT ${[...allowed, 'state'].join(', ')} FROM auctions WHERE id = $1`,
      [auctionId]
    );
    beforeRow = beforeRes.rows[0] || null;
  } catch (_) { /* audit snapshot is best-effort */ }

  const result = await db.query(query, values);
  if (!result.rows[0]) return null;

  // INT-2: write audit_log entry. Pick a more specific event type when the
  // change is an entry into 'submitted' state (the moderation queue trigger);
  // every other field/state change is 'auction_updated' with a diff blob.
  try {
    const after = result.rows[0];
    const changed = {};
    for (const k of [...allowed, 'state']) {
      if (updates[k] === undefined) continue;
      const fromVal = beforeRow ? beforeRow[k] : null;
      const toVal   = after[k];
      if (String(fromVal) !== String(toVal)) {
        changed[k] = { from: fromVal, to: toVal };
      }
    }
    const enteredSubmitted = changed.state && changed.state.to === 'submitted';
    writeAuditLog({
      event_type:  enteredSubmitted ? 'auction_submitted' : 'auction_updated',
      entity_type: 'auction',
      entity_id:   auctionId,
      auction_id:  auctionId,
      actor_id:    userId,
      metadata:    { changed_fields: changed, actor_role: actorRole || 'unknown' },
    }).catch(() => {});
  } catch (_) { /* audit failures are non-blocking by design */ }

  return result.rows[0];
}

// Delete auction (enforce ownership)
async function deleteAuction(auctionId, userId) {
  const result = await db.query(
    `DELETE FROM auctions
     WHERE id = $1
       AND seller_id = (SELECT id FROM seller_profiles WHERE user_id = $2)
     RETURNING *`,
    [auctionId, userId]
  );
  return result.rows[0] || null;
}


// Get all auctions for a seller (by user_id via seller_profiles)
async function getSellerAuctions(userId) {
  const result = await db.query(
    `SELECT a.*
     FROM auctions a
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE sp.user_id = $1
     ORDER BY a.created_at DESC`,
    [userId]
  );
  return result.rows;
}


// Get a single auction by id, verifying ownership via seller_profiles
async function getAuctionById(auctionId, userId) {
  const result = await db.query(
    `SELECT a.*
     FROM auctions a
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE a.id = $1 AND sp.user_id = $2
     LIMIT 1`,
    [auctionId, userId]
  );
  return result.rows[0] || null;
}

async function publishAuction(auctionId, actorId = null) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      'SELECT id, state FROM auctions WHERE id = $1 FOR UPDATE',
      [auctionId]
    );
    if (!current.rows[0]) {
      throw new Error('Auction not found');
    }
    const { state } = current.rows[0];
    if (state === 'published') {
      throw new Error('Auction is already published');
    }
    if (state === 'closed') {
      throw new Error('Cannot publish a closed auction');
    }

    // PUB-5: publish no longer overwrites seller-provided start_time/end_time.
    // The seller chose these in seller-create.html and they are authoritative
    // through the publish transition. published → active and active → closed
    // are now driven by the state transition scheduler (PUB-7) which compares
    // start_time / end_time to NOW(). Auctions submitted without times stay
    // in 'published' until an admin edits them.
    const result = await client.query(
      `UPDATE auctions
       SET state = 'published',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [auctionId]
    );

    await client.query(
      `UPDATE lots SET state = 'open' WHERE auction_id = $1 AND state = 'withdrawn'`,
      [auctionId]
    );

    await auditService.logEvent(client, {
      eventType:  'auction.published',
      entityType: 'auction',
      entityId:   auctionId,
      auctionId,
      actorId
    });

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function closeAuction(auctionId, actorId = null) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock auction row and verify it exists and is not already closed
    const auctionRes = await client.query(
      `SELECT a.id, a.state, sp.user_id AS seller_user_id
       FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
       WHERE a.id = $1 FOR UPDATE OF a`,
      [auctionId]
    );
    if (!auctionRes.rows[0]) {
      throw new Error('Auction not found');
    }
    const { state } = auctionRes.rows[0];
    if (state === 'closed') {
      throw new Error('Auction is already closed');
    }
    // PUB-6: accept 'active' as a valid pre-close state in addition to
    // 'published'. Both paths reach closeAuction:
    //   • admin emergency takedown of a 'published' (not yet live) auction
    //   • scheduler auto-close of an 'active' (live) auction whose end_time
    //     has arrived (PUB-7)
    if (state !== 'published' && state !== 'active') {
      throw new Error('Only published or active auctions can be closed');
    }

    // Mark auction closed
    await client.query(
      `UPDATE auctions SET state = 'closed', updated_at = now() WHERE id = $1`,
      [auctionId]
    );

    // Lock all non-withdrawn lots for this auction before reading bids.
    // This blocks any concurrent createBid calls (which also SELECT lots FOR UPDATE)
    // from slipping a new bid in between the top-bid read and the lot state write.
    // Withdrawn lots are excluded — they are already settled and must not be re-opened.
    const lotsRes = await client.query(
      `SELECT id FROM lots WHERE auction_id = $1 AND state != 'withdrawn' FOR UPDATE`,
      [auctionId]
    );

    const results = [];

    for (const lot of lotsRes.rows) {
      // Highest bid: max amount_cents, earliest created_at as tiebreaker
      const bidRes = await client.query(
        `SELECT bidder_user_id, amount_cents FROM bids
         WHERE lot_id = $1
         ORDER BY amount_cents DESC, created_at ASC
         LIMIT 1`,
        [lot.id]
      );

      const topBid = bidRes.rows[0];

      if (topBid) {
        const winningCents = topBid.amount_cents;
        await client.query(
          `UPDATE lots
           SET state = 'closed',
               winning_buyer_user_id = $1,
               winning_amount_cents = $2
           WHERE id = $3 AND state != 'closed'`,
          [topBid.bidder_user_id, winningCents, lot.id]
        );
        results.push({
          lot_id: lot.id,
          winner_user_id: topBid.bidder_user_id,
          winning_amount_cents: winningCents
        });
      } else {
        await client.query(
          `UPDATE lots SET state = 'closed' WHERE id = $1 AND state != 'closed'`,
          [lot.id]
        );
        results.push({
          lot_id: lot.id,
          winner_user_id: null,
          winning_amount_cents: null
        });
      }
    }

    await auditService.logEvent(client, {
      eventType:  'auction.closed',
      entityType: 'auction',
      entityId:   auctionId,
      auctionId,
      actorId,
      metadata: { lots_closed: results.length, results }
    });

    // Create seller payout record inside the transaction so it is guaranteed to exist
    // after close, even if the process crashes immediately after COMMIT.
    // Figures are computed from the in-transaction results array; using pool connections
    // here would read stale lot data (winning amounts not yet committed).
    // Fee rate mirrors the constant in reportingService — update both if the rate changes.
    const PLATFORM_FEE_RATE = 0.10;
    const sellerUserId = auctionRes.rows[0].seller_user_id;
    const grossRevenueCents = results.reduce((sum, r) => sum + (r.winning_amount_cents ?? 0), 0);
    const platformFeeCents  = Math.round(grossRevenueCents * PLATFORM_FEE_RATE);
    const sellerPayoutCents = grossRevenueCents - platformFeeCents;
    const pref = await getSellerPayoutPreference(sellerUserId);
    await client.query(
      `INSERT INTO seller_payouts
         (auction_id, seller_user_id, gross_revenue_cents, platform_fee_cents, seller_payout_cents, payout_method)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (auction_id) DO NOTHING`,
      [auctionId, sellerUserId, grossRevenueCents, platformFeeCents, sellerPayoutCents, pref ? pref.payout_method : null]
    );

    await client.query('COMMIT');

    // Fire-and-forget: cache report data after close is committed.
    // DATA GENERATION ONLY — does not send email, does not send PDF.
    // Final seller report (stats + payout + PDF) is human-gated and sent separately
    // via POST /api/admin/auctions/:auctionId/send-final-report.
    require('./reportingService').generateAuctionReport(auctionId)
      .then(() => console.log(`[reporting] generated auction report for auction_id=${auctionId}`))
      .catch(err => console.error(`[reporting] failed for auction_id=${auctionId}:`, err.message));

    // Fire-and-forget: operational close email to seller (NOT the final payout/stat report).
    // Sends auction total, buyer list, and unpaid item warnings.
    // Email failures must never surface to the caller — auction close is already committed.
    require('./operationalCloseEmailService').sendOperationalCloseEmail(auctionId)
      .catch(err => console.error(`[email] operational close email failed for auction_id=${auctionId}:`, err.message));

    return {
      auction_id: auctionId,
      lots_closed: results.length,
      results
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createAuction,
  getSellerAuctions,
  getAuctionById,
  updateAuction,
  deleteAuction,
  publishAuction,
  closeAuction
};
