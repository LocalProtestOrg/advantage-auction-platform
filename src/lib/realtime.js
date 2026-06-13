// #1 Real-time bridge — Postgres LISTEN/NOTIFY → socket.io.
//
// The web process owns the socket.io `io` instance, but lot/auction CLOSE events
// originate in a SEPARATE forked worker process (notificationWorker). To bridge
// processes without new infrastructure, every producer (bidService in the web
// process, the workers in their process) calls publish() → pg_notify(). A single
// listener in the WEB process (startListener) receives every notification and
// emits to socket.io rooms.
//
// Privacy: the NOTIFY payload may carry winner_user_id, but that identity is
// ONLY used to emit targeted per-user events (lot:winning / lot:outbid) to that
// user's private room. The room broadcast (lot:update) never includes any
// bidder identity, and realized prices are withheld for closed lots (gated by
// REST when the client re-fetches).
const db = require('../db');
const { Client } = require('pg');

const CH_LOT     = 'rt_lot';
const CH_AUCTION = 'rt_auction';

// Publish a real-time event from ANY process. Best-effort: never throws into the
// caller's critical path (a failed push must never fail a bid or a close).
async function publish(kind, payload) {
  try {
    const channel = kind === 'auction' ? CH_AUCTION : CH_LOT;
    await db.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)]);
  } catch (e) {
    console.error('[realtime] publish failed:', e.message);
  }
}

// Build the PUBLIC lot payload broadcast to the auction room. Carries no bidder
// identity. Price fields are public only while the lot is live; for a closed (or
// withdrawn) lot the realized price is gated (#20.1), so they are nulled and the
// client re-fetches the gated value via REST.
function publicLotPayload(p) {
  const closed = p.state === 'closed' || p.state === 'withdrawn';
  return {
    lot_id:                        p.lot_id,
    lot_number:                    p.lot_number,
    title:                         p.title,
    state:                         p.state,
    closes_at:                     p.closes_at,
    extension_count:               p.extension_count,
    bid_count:                     closed ? null : p.bid_count,
    current_bid_cents:             closed ? null : p.current_bid_cents,
    next_min_bid_cents:            closed ? null : p.next_min_bid_cents,
    effective_bid_increment_cents: closed ? null : p.effective_bid_increment_cents,
  };
}

// Emit a parsed notification to socket.io rooms. Pure given (io, kind, payload);
// exported for unit testing with a mock io.
function dispatch(io, kind, p) {
  if (!io || !p) return;
  if (kind === 'auction') {
    io.to(`auction:${p.auction_id}`).emit('auction:update', { auction_id: p.auction_id, state: p.state });
    return;
  }
  // Public, identity-free broadcast to everyone viewing the auction.
  io.to(`auction:${p.auction_id}`).emit('lot:update', publicLotPayload(p));
  // Targeted, privacy-safe winning/outbid signals to the specific users only.
  if (p.winner_user_id) {
    io.to(`user:${p.winner_user_id}`).emit('lot:winning', { lot_id: p.lot_id, auction_id: p.auction_id, state: p.state });
  }
  if (p.prev_winner_user_id && p.prev_winner_user_id !== p.winner_user_id) {
    io.to(`user:${p.prev_winner_user_id}`).emit('lot:outbid', { lot_id: p.lot_id, auction_id: p.auction_id });
  }
}

// Start the single web-process listener. LISTEN requires a session-level
// connection, so we open a DEDICATED direct client — NOT a pooled one. On Neon
// the pooled (-pooler / pgBouncer transaction-mode) endpoint does not support
// LISTEN, so when DATABASE_URL is set we connect to the direct endpoint
// (strip -pooler). publish() still uses the pool for NOTIFY (a single committed
// statement, delivered server-wide). Self-heals on connection error so a
// transient DB blip never permanently kills real-time push (polling covers it).
async function startListener(io) {
  let client;
  let stopped = false;
  async function connect() {
    if (stopped) return;
    try {
      if (process.env.DATABASE_URL) {
        client = new Client({
          connectionString: process.env.DATABASE_URL.replace('-pooler', ''),
          ssl: { rejectUnauthorized: false },
        });
        await client.connect();
      } else {
        // Local dev (individual PG* vars, no pooler) — a pooled session is fine.
        client = await db.pool.connect();
      }
      client.on('notification', (msg) => {
        try {
          const payload = JSON.parse(msg.payload);
          dispatch(io, msg.channel === CH_AUCTION ? 'auction' : 'lot', payload);
        } catch (e) {
          console.error('[realtime] dispatch failed:', e.message);
        }
      });
      client.on('error', (e) => {
        console.error('[realtime] listener connection error:', e.message);
        try { client.end ? client.end() : client.release(true); } catch (_) {}
        if (!stopped) setTimeout(connect, 3000);
      });
      await client.query(`LISTEN ${CH_LOT}`);
      await client.query(`LISTEN ${CH_AUCTION}`);
      console.log(`[realtime] listener attached (LISTEN ${CH_LOT}, ${CH_AUCTION})`);
    } catch (e) {
      console.error('[realtime] listener connect failed, retrying in 3s:', e.message);
      if (!stopped) setTimeout(connect, 3000);
    }
  }
  await connect();
  return () => { stopped = true; try { client && (client.end ? client.end() : client.release(true)); } catch (_) {} };
}

module.exports = { publish, dispatch, publicLotPayload, startListener, CH_LOT, CH_AUCTION };
