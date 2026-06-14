const db = require('../db/index');
const auditService = require('./auditService');
const realtime = require('../lib/realtime'); // #1 real-time push (pg NOTIFY)
const { writeAuditLog } = require('../lib/auditLog');
const { getSellerPayoutPreference } = require('./payoutPreferenceService');
const { validateAuctionSchedule, ScheduleRuleError, isProfessional } = require('./sellerTypeRules');

// #18: default gap between consecutive lot closings (AAC timed model). Lot N
// closes at start_time + N * this interval. Editable config is a post-launch
// follow-up; 60s is the AAC default.
const LOT_CLOSE_INTERVAL_SECONDS = 60;

// Phase C: server-authoritative seller-type schedule enforcement, shared by
// createAuction + updateAuction. Pure decision over a resolved sellerType.
// - No violation        → { overridden: false }.
// - Admin + override reason → { overridden: true }  (caller audits the override).
// - Otherwise (seller, or admin without a reason) → throws ScheduleRuleError.
function enforceScheduleRule({ sellerType, endTime, pickupWindowStart, actorRole, overrideReason }) {
  const { ok, violations } = validateAuctionSchedule({ sellerType, endTime, pickupWindowStart });
  if (ok) return { overridden: false, violations: [] };
  const isAdmin   = actorRole === 'admin';
  const hasReason = overrideReason != null && String(overrideReason).trim().length > 0;
  if (isAdmin && hasReason) return { overridden: true, violations };
  throw new ScheduleRuleError(violations, { adminOverrideAvailable: isAdmin });
}

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

  // Phase C / C.2: resolve seller_type once when needed for the schedule rule or
  // preview gating. sellerId IS the seller_profile id.
  let sellerType = null;
  if ((endTime && pickupWindowStart) || previewStart || previewEnd) {
    const spRes = await db.query('SELECT seller_type FROM seller_profiles WHERE id = $1', [sellerId]);
    sellerType = spRes.rows[0] ? spRes.rows[0].seller_type : null;
  }

  // Phase C: server-authoritative 48h pickup rule (admin may override w/ reason).
  let scheduleOverride = null;
  if (endTime && pickupWindowStart) {
    const res = enforceScheduleRule({
      sellerType, endTime, pickupWindowStart,
      actorRole: data.actorRole, overrideReason: data.overrideReason,
    });
    if (res.overridden) scheduleOverride = res.violations;
  }

  // Phase C.2: Preview Start/End are professional-only. Non-professional (and
  // untyped) sellers cannot set them; force null on create. Admin bypasses.
  let effPreviewStart = previewStart || null;
  let effPreviewEnd   = previewEnd   || null;
  if (data.actorRole !== 'admin' && !isProfessional(sellerType)) {
    effPreviewStart = null;
    effPreviewEnd   = null;
  }

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
      effPreviewStart,
      effPreviewEnd,
      pickupWindowStart || null,
      pickupWindowEnd   || null,
      shippingAvailable === true,
      bannerImageUrl  || null,
      coverImageUrl   || null,
    ]
  );
  const created = result.rows[0];

  // Phase C: record an admin override of the schedule rule (non-blocking audit;
  // visible in History). Only reached when an admin supplied an override reason.
  if (created && scheduleOverride) {
    writeAuditLog({
      event_type:  'schedule_rule_overridden',
      entity_type: 'auction',
      entity_id:   created.id,
      auction_id:  created.id,
      actor_id:    data.actorUserId || null,
      metadata: {
        violations:      scheduleOverride,
        override_reason: data.overrideReason || null,
        schedule:        { end_time: endTime, pickup_window_start: pickupWindowStart },
        phase:           'create',
      },
    }).catch(() => {});
  }
  return created;
}


// Update auction (only allowed fields, enforce ownership via seller_profiles)
//
// actorRole governs state-transition permission:
//   admin     → any state value accepted
//   non-admin → only 'submitted' accepted, and only when current state is
//               'draft' (one-shot seller self-submission for AAC Review).
//               All other non-admin state requests are silently dropped.
// Other field whitelisting is unchanged.
async function updateAuction(auctionId, userId, updates, actorRole, options = {}) {
  const allowed = [
    'title', 'subtitle', 'description',
    'start_time', 'end_time',
    'street_address', 'city', 'address_state', 'zip',
    'preview_start', 'preview_end',
    'pickup_window_start', 'pickup_window_end',
    'shipping_available', 'banner_image_url', 'cover_image_url',
  ];
  // Phase 4: admin-only auction settings (sellers can never set these). Closes
  // the "orphaned editable fields" gaps from the admin-controls audit.
  //   auction_terms        — per-auction terms/disclosure text
  //   public_auction_type  — drives public filtering
  //   admin_notes          — internal JSONB notes (also the only field editable
  //                          once an auction is closed — see the guard below)
  //   bid_increment_cents  — flat per-auction increment override (honored by
  //                          bidService.resolveAuctionIncrementOverride)
  //   buyer_premium_bps    — stored only; NOT charged yet (migration 067)
  //   ADMIN-CTRL Phase 1A — advanced admin-editable fields (per approved matrix):
  //   timezone, default_starting_bid_cents, increment_ladder (validated),
  //   marketing_selection (admin marketing panel). Bidding/price fields are
  //   additionally locked once the auction is ACTIVE (see ACTIVE_LOCKED below).
  const adminOnly = ['auction_terms', 'public_auction_type', 'admin_notes', 'bid_increment_cents', 'buyer_premium_bps',
    'timezone', 'default_starting_bid_cents', 'increment_ladder', 'marketing_selection'];
  const effectiveAllowed = actorRole === 'admin' ? [...allowed, ...adminOnly] : allowed;

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

  // Phase C: server-authoritative schedule validation. Validate ONLY when the
  // patch touches a schedule field, or on a submit/publish transition — so
  // unrelated edits to existing auctions are never re-validated (grandfathering
  // of legacy auctions). Computes the EFFECTIVE schedule (patch value ?? stored)
  // and classifies by the auction's seller_type. Throws ScheduleRuleError unless
  // valid or an admin supplied an override reason (then captured for audit).
  let scheduleOverride = null;
  const scheduleTouched = updates.end_time !== undefined || updates.pickup_window_start !== undefined;
  const submitOrPublish = stateToWrite === 'submitted' || stateToWrite === 'published';
  if (scheduleTouched || submitOrPublish) {
    const sched = await db.query(
      `SELECT a.end_time, a.pickup_window_start, sp.seller_type
         FROM auctions a
         JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE a.id = $1`,
      [auctionId]
    );
    if (sched.rows[0]) {
      const effEnd    = updates.end_time !== undefined            ? updates.end_time            : sched.rows[0].end_time;
      const effPickup = updates.pickup_window_start !== undefined ? updates.pickup_window_start : sched.rows[0].pickup_window_start;
      const res = enforceScheduleRule({
        sellerType:       sched.rows[0].seller_type,
        endTime:          effEnd,
        pickupWindowStart: effPickup,
        actorRole,
        overrideReason:   options.overrideReason,
      });
      if (res.overridden) {
        scheduleOverride = { violations: res.violations, end_time: effEnd, pickup_window_start: effPickup };
      }
    }
  }

  // Phase C.2: Preview Start/End are professional-only. For non-professional
  // (non-admin) sellers, strip preview fields from the update so they are never
  // written — existing values are preserved (grandfathering of existing auctions).
  if (actorRole !== 'admin' && (updates.preview_start !== undefined || updates.preview_end !== undefined)) {
    const ptRes = await db.query(
      `SELECT sp.seller_type FROM auctions a
         JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE a.id = $1`,
      [auctionId]
    );
    if (!ptRes.rows[0] || !isProfessional(ptRes.rows[0].seller_type)) {
      delete updates.preview_start;
      delete updates.preview_end;
    }
  }

  // Phase 4: validate + normalize admin-only settings.
  if (actorRole === 'admin') {
    if (updates.buyer_premium_bps !== undefined && updates.buyer_premium_bps !== null) {
      const bp = Number(updates.buyer_premium_bps);
      if (!Number.isInteger(bp) || bp < 0 || bp > 2500) throw new Error('buyer_premium_bps must be an integer 0–2500 (basis points; 0–25%)');
    }
    if (updates.bid_increment_cents !== undefined && updates.bid_increment_cents !== null) {
      const inc = Number(updates.bid_increment_cents);
      if (!Number.isInteger(inc) || inc < 1 || inc > 1000000) throw new Error('bid_increment_cents must be a positive integer (cents)');
    }
    // admin_notes is JSONB — accept a plain string as { text } for convenience.
    if (typeof updates.admin_notes === 'string') updates.admin_notes = { text: updates.admin_notes };
    // ADMIN-CTRL Phase 1A: validate advanced fields.
    if (updates.default_starting_bid_cents !== undefined && updates.default_starting_bid_cents !== null) {
      const d = Number(updates.default_starting_bid_cents);
      if (!Number.isInteger(d) || d < 1 || d > 100000000) throw new Error('default_starting_bid_cents must be a positive integer (cents)');
    }
    if (updates.increment_ladder !== undefined && updates.increment_ladder !== null) {
      if (!Array.isArray(updates.increment_ladder)) throw new Error('increment_ladder must be a JSON array of { threshold_cents, increment_cents }');
      for (const tier of updates.increment_ladder) {
        if (!tier || typeof tier !== 'object' || !Number.isInteger(Number(tier.increment_cents)) || Number(tier.increment_cents) < 1) {
          throw new Error('Each increment_ladder tier needs a positive integer increment_cents');
        }
      }
      // node-pg serializes a JS array as a Postgres array literal, not JSON —
      // stringify so it binds correctly to the jsonb column (pg casts text→jsonb).
      updates.increment_ladder = JSON.stringify(updates.increment_ladder);
    }
    if (updates.marketing_selection !== undefined && updates.marketing_selection !== null && typeof updates.marketing_selection !== 'object') {
      throw new Error('marketing_selection must be a JSON object');
    }
  }

  // Phase 4: closed-auction protection. Once closed, fields are locked except
  // internal admin_notes (annotations). State changes still flow via the
  // dedicated lifecycle endpoints / admin stateToWrite below.
  const curStateRow = await db.query('SELECT state FROM auctions WHERE id = $1', [auctionId]);
  const curState = curStateRow.rows[0] && curStateRow.rows[0].state;
  if (curState === 'closed') {
    for (const k of effectiveAllowed) {
      if (k !== 'admin_notes' && updates[k] !== undefined) {
        throw new Error('Closed auctions are locked. Only admin notes may be edited.');
      }
    }
  }
  // ADMIN-CTRL Phase 1A: bidding/price structure is locked once the auction is
  // live (active) — changing it mid-auction would move the goalposts for bidders.
  // (Title/description/location/schedule remain editable-with-care on active.)
  const ACTIVE_LOCKED = ['increment_ladder', 'bid_increment_cents', 'buyer_premium_bps', 'default_starting_bid_cents'];
  if (curState === 'active') {
    for (const k of ACTIVE_LOCKED) {
      if (updates[k] !== undefined) throw new Error('Bidding and price fields are locked once the auction is active.');
    }
  }

  const fields = [];
  const values = [];
  let idx = 1;

  for (const key of effectiveAllowed) {
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
      `SELECT ${[...effectiveAllowed, 'state'].join(', ')} FROM auctions WHERE id = $1`,
      [auctionId]
    );
    beforeRow = beforeRes.rows[0] || null;
  } catch (_) { /* audit snapshot is best-effort */ }

  const result = await db.query(query, values);
  if (!result.rows[0]) return null;

  // Phase C: record an admin override of the schedule rule (non-blocking;
  // visible in the auction History timeline). Only set when an admin proceeded
  // past a violation with an override reason.
  if (scheduleOverride) {
    writeAuditLog({
      event_type:  'schedule_rule_overridden',
      entity_type: 'auction',
      entity_id:   auctionId,
      auction_id:  auctionId,
      actor_id:    userId,
      metadata: {
        violations:      scheduleOverride.violations,
        override_reason: options.overrideReason || null,
        schedule:        { end_time: scheduleOverride.end_time, pickup_window_start: scheduleOverride.pickup_window_start },
        phase:           'update',
      },
    }).catch(() => {});
  }

  // INT-2: write audit_log entry. Pick a more specific event type when the
  // change is an entry into 'submitted' state (the moderation queue trigger);
  // every other field/state change is 'auction_updated' with a diff blob.
  try {
    const after = result.rows[0];
    const changed = {};
    for (const k of [...effectiveAllowed, 'state']) {
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

// ── Deletion safety + cascade (ADMIN-CTRL Phase 1A) ──────────────────────────
// Money/obligation guard for hard deletion. An auction is UNSAFE to hard-delete
// if it has any settled/in-flight payment, any seller payout record, or any
// invoice (issued or paid). Returns { safe, blockers[], counts }. Pure read;
// callers should re-check inside the delete transaction.
async function assessAuctionDeletable(auctionId, client = db) {
  const { rows } = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM payments       WHERE auction_id=$1)                                 AS payments_total,
      (SELECT COUNT(*)::int FROM payments       WHERE auction_id=$1 AND status IN ('paid','pending')) AS payments_settled,
      (SELECT COUNT(*)::int FROM seller_payouts WHERE auction_id=$1)                                 AS payouts,
      (SELECT COUNT(*)::int FROM invoices       WHERE auction_id=$1)                                 AS invoices_total,
      (SELECT COUNT(*)::int FROM invoices       WHERE auction_id=$1 AND status IN ('issued','paid'))  AS invoices_open,
      (SELECT COUNT(*)::int FROM lots           WHERE auction_id=$1)                                 AS lots,
      (SELECT COUNT(*)::int FROM bids           WHERE auction_id=$1)                                 AS bids,
      (SELECT state FROM auctions WHERE id=$1)                                                        AS state
  `, [auctionId]);
  const c = rows[0] || {};
  const blockers = [];
  if ((c.payments_settled || 0) > 0) blockers.push(`${c.payments_settled} settled/pending payment(s)`);
  if ((c.payouts || 0)          > 0) blockers.push(`${c.payouts} seller payout record(s)`);
  if ((c.invoices_open || 0)    > 0) blockers.push(`${c.invoices_open} invoice(s)`);
  return { safe: blockers.length === 0, blockers, counts: c };
}

// Physically remove an auction and all dependent rows. Almost every child FK is
// ON DELETE CASCADE; the two exceptions are handled explicitly first:
//   • pickup_schedules.auction_id is NO ACTION (would block) → cleared first,
//     after pickup_assignments (by lot) in case they reference a schedule.
//   • audit_log has NO FK to auctions, so the trail survives the delete.
// Runs inside the caller's transaction client.
async function purgeAuctionCascade(client, auctionId) {
  await client.query(`DELETE FROM pickup_assignments WHERE lot_id IN (SELECT id FROM lots WHERE auction_id=$1)`, [auctionId]);
  await client.query(`DELETE FROM pickup_schedules   WHERE auction_id=$1`, [auctionId]);
  await client.query(`DELETE FROM auctions           WHERE id=$1`, [auctionId]); // cascades lots, bids, payments, payouts, etc.
}

// Admin hard-delete with money-guard + audit snapshot. Returns one of:
//   { deleted:true, snapshot } | { notFound:true } | { blocked:true, blockers, counts }
async function hardDeleteAuction(auctionId, actorId = null) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT id, title, state FROM auctions WHERE id=$1 FOR UPDATE`, [auctionId]);
    if (!cur.rows[0]) { await client.query('ROLLBACK'); return { notFound: true }; }
    const assess = await assessAuctionDeletable(auctionId, client);
    if (!assess.safe) { await client.query('ROLLBACK'); return { blocked: true, blockers: assess.blockers, counts: assess.counts }; }
    const snapshot = { title: cur.rows[0].title, state: cur.rows[0].state, counts: assess.counts };
    // Audit BEFORE the row vanishes (audit_log has no FK to auctions, but log the
    // intent atomically inside the same transaction so it commits with the delete).
    await auditService.logEvent(client, {
      eventType: 'auction.hard_deleted', entityType: 'auction', entityId: auctionId,
      auctionId, actorId, metadata: snapshot,
    });
    await purgeAuctionCascade(client, auctionId);
    await client.query('COMMIT');
    return { deleted: true, snapshot };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Delete auction (seller path — enforce ownership; now money-guarded + cascade).
async function deleteAuction(auctionId, userId) {
  const owns = await db.query(
    `SELECT a.id FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
      WHERE a.id = $1 AND sp.user_id = $2`,
    [auctionId, userId]
  );
  if (!owns.rows[0]) return null;
  const assess = await assessAuctionDeletable(auctionId);
  if (!assess.safe) { const e = new Error('Cannot delete: ' + assess.blockers.join('; ') + '. Archive instead.'); e.code = 'DELETE_BLOCKED'; e.blockers = assess.blockers; throw e; }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await purgeAuctionCascade(client, auctionId);
    await client.query('COMMIT');
    return { id: auctionId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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

    // #18: generate the staggered close schedule from the seller's start_time so
    // lots close sequentially (Lot 1 closes one interval after start, each later
    // lot one interval after the previous). end_time is set to the LAST lot's
    // close so the auction-level scheduler (runAuctionStateTransitions) only
    // closes the auction after every lot has finished. This reuses the existing
    // lot-auto-close + anti-snipe machinery — no scheduler change. Only runs when
    // a start_time is set; auctions without one stay unscheduled until an admin
    // sets times (then re-publish regenerates).
    const startTime = result.rows[0].start_time;
    if (startTime) {
      await client.query(
        `WITH ordered AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY lot_number ASC NULLS LAST, created_at ASC) AS pos
             FROM lots
            WHERE auction_id = $1 AND state = 'open'
         )
         UPDATE lots l
            SET closes_at = $2::timestamptz + make_interval(secs => (ordered.pos * $3))
           FROM ordered
          WHERE l.id = ordered.id`,
        [auctionId, startTime, LOT_CLOSE_INTERVAL_SECONDS]
      );
      await client.query(
        `UPDATE auctions a
            SET end_time = sub.max_close, updated_at = NOW()
           FROM (SELECT MAX(closes_at) AS max_close
                   FROM lots WHERE auction_id = $1 AND state != 'withdrawn') sub
          WHERE a.id = $1 AND sub.max_close IS NOT NULL`,
        [auctionId]
      );
    }

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
        // ADMIN-CTRL Phase 3: enqueue the winner's "you won" email into
        // notifications_queue (the real SES path). Previously closeAuction sent
        // nothing — winners were never emailed. The worker renders WINNING via
        // notificationContent.buildLotEmail (link base = publicBaseUrl()). Atomic
        // with the close; relevance() keeps WINNING deliverable post-close.
        await client.query(
          `INSERT INTO notifications_queue (user_id, type, payload) VALUES ($1, 'WINNING', $2)`,
          [topBid.bidder_user_id, JSON.stringify({ lot_id: lot.id, visible_cents: winningCents })]
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

    // #1 real-time: results-mode transition — tell everyone viewing the auction
    // to reload into the sale-results view. Best-effort (close already committed).
    realtime.publish('auction', { auction_id: auctionId, state: 'closed' });

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
  assessAuctionDeletable,
  hardDeleteAuction,
  publishAuction,
  closeAuction,
  // Exported for unit-testing the Phase C override decision without a DB.
  enforceScheduleRule,
};
