import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REAL-TIME BID SYNCHRONIZATION — two-client regression (Owner Acceptance 1.5)
 * ─────────────────────────────────────────────────────────────────────────────
 * Purpose: permanently guarantee that the "desktop shows CLOSED / no extension
 * while mobile is still live" class of desync can never silently return. It is
 * NOT trying to reproduce the old bug — it locks in the SERVER-AUTHORITATIVE
 * reconciliation contract of the real production lot.html.
 *
 * Why hermetic (no live DB): the unit under test is the CLIENT's reconciliation
 * behavior when it misses realtime events. The "server" is simply an authoritative
 * state the test controls, so the scenario is deterministic (no timing luck, no
 * browser-throttling races) and touches ZERO production data, Stripe, or workers.
 *
 *   • The REAL public/lot.html runs in two browser contexts (Client A + Client B),
 *     with its REAL shared scripts (bid-utils, bid-status, countdown, the actual
 *     socket handlers and the tick/visibility/focus/connect reconcilers).
 *   • A single in-memory `server.lot` is the source of truth. GET /api/lots/:id
 *     returns it; POST /api/lots/:id/bids applies the SAME anti-snipe rule as the
 *     server (bid within 120s → closes_at += 120s, extension_count++). This mirrors
 *     bidService + lots.js so the client reconciles against real server semantics.
 *   • /socket.io/socket.io.js is replaced by a controllable shim exposing
 *     window.__lotSocket (disconnect/connect) and window.__rtDeliver(ev,payload).
 *     "Client B misses an event" == the test simply does not deliver it to B while
 *     B is frozen; recovery is driven ONLY by the production reconcilers.
 *
 * Server authority itself (lots.js close check, bidService +2min) is additionally
 * covered by tests/owner-acceptance-phase1.test.js and e2e/bidding.spec.js.
 */

// Playwright runs with cwd at the project root; public/ holds the real page + assets.
const PUBLIC = path.resolve(process.cwd(), 'public');

const LOT_ID = '11111111-1111-1111-1111-111111111111';
const AUCTION_ID = '22222222-2222-2222-2222-222222222222';
const EXT_MS = 120_000; // anti-snipe extension window/amount (2 minutes) — MUST match server rule

// A JWT-shaped dummy token so the page takes the authenticated path (poll + reconcile).
// The hermetic API ignores auth; only the page's own token-presence checks matter.
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const DUMMY_TOKEN = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ id: 'buyer-a', exp: 4102444800 })}.sig`;

// Controllable socket.io replacement. io() returns a shim exposing connect/disconnect
// and a __rtDeliver hook so the test decides exactly which client receives which event.
const SOCKET_SHIM = `(function(){
  function Shim(opts){ this._h={}; this.connected=false; this.auth=opts&&opts.auth; this._joined=[]; var s=this;
    setTimeout(function(){ if(!s.connected){ s.connected=true; s._emit('connect'); } },0); }
  Shim.prototype.on=function(ev,cb){ (this._h[ev]=this._h[ev]||[]).push(cb); return this; };
  Shim.prototype.emit=function(ev){ if(ev==='joinAuction'){ this._joined.push(arguments[1]); } return this; };
  Shim.prototype._emit=function(ev,p){ (this._h[ev]||[]).forEach(function(cb){ try{cb(p);}catch(e){} }); };
  Shim.prototype.disconnect=function(){ this.connected=false; this._emit('disconnect','io client disconnect'); return this; };
  Shim.prototype.connect=function(){ if(!this.connected){ this.connected=true; this._emit('connect'); } return this; };
  window.io=function(opts){ var s=new Shim(opts); window.__shimSocket=s; return s; };
  window.__rtDeliver=function(ev,p){ if(window.__shimSocket) window.__shimSocket._emit(ev,p); };
})();`;

// Audio has no place in a headless sync test and can throw; a safe no-op keeps the
// reconciliation logic (the actual subject) deterministic. Sound wiring is covered by
// the jest source assertions (handlers call BuyerChime.play on bid/outbid/extended).
const CHIME_STUB = `window.BuyerChime={play:function(){},isMuted:function(){return true},toggle:function(){return true},mute:function(){},unmute:function(){}};`;

function freshServerLot(closesAtMs) {
  return {
    id: LOT_ID, auction_id: AUCTION_ID, auction_title: 'RT Sync Test Auction',
    auction_public_type: 'standard', title: 'RT Sync Test Lot', lot_number: 1,
    category: 'Test', description: 'Realtime reconciliation fixture lot.', size_category: 'A',
    state: 'open', closes_at: new Date(closesAtMs).toISOString(),
    current_bid_cents: 1000, starting_bid_cents: 100,
    effective_bid_increment_cents: 500, buyer_premium_bps: 1800,
    extension_count: 0, winning_amount_cents: null,
  };
}

const CTYPE = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

// One route handler per client, closed over the SHARED `server` object so both
// clients read/write the same authoritative state.
function makeRouter(server) {
  return async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });

    // External fonts — resolve fast, never block page 'load'.
    if (url.host.includes('googleapis') || url.host.includes('gstatic')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });

    // Controllable realtime + safe audio.
    if (p === '/socket.io/socket.io.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: SOCKET_SHIM });
    if (p === '/widgets/shared/buyer-chime.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: CHIME_STUB });

    // ---- Hermetic API mirroring the real server contract ----
    if (p === `/api/lots/${LOT_ID}` && req.method() === 'GET') return json({ success: true, data: server.lot });
    if (p === `/api/lots/${LOT_ID}/images`) return json({ success: true, data: [] });
    if (p === `/api/lots/${LOT_ID}/bids` && req.method() === 'GET') return json({ success: true, data: [] });
    if (p === `/api/lots/${LOT_ID}/bids` && req.method() === 'POST') {
      const now = Date.now();
      const closes = new Date(server.lot.closes_at).getTime();
      // Server-authoritative close: a bid after closes_at is rejected on the DB value.
      if (now > closes) return json({ success: false, message: 'Lot has closed and is no longer accepting bids' }, 422);
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
      const maxBid = Number(body.max_bid_cents) || (server.lot.current_bid_cents + server.lot.effective_bid_increment_cents);
      server.lot.current_bid_cents = maxBid;
      // Anti-snipe: bid inside the final 120s extends closes_at by 120s (bidService rule).
      if (closes - now <= EXT_MS) {
        server.lot.closes_at = new Date(closes + EXT_MS).toISOString();
        server.lot.extension_count += 1;
      }
      return json({ success: true, data: server.lot });
    }
    if (p === `/api/lots/${LOT_ID}/winner-status`) return json({ success: true, data: { is_winner: true } });
    // Default: a fully-registered bidder (the bug scenario: two competitors with the
    // real bid form). getBidGate reads {success,data}; can_bid:true keeps #bid-input.
    // A test may set server.gate to model a non-registered viewer (gate replaces the form).
    if (p === `/api/auctions/${AUCTION_ID}/registration-status`) {
      return json(server.gate || { success: true, data: { logged_in: true, terms_accepted_current: true, registered: true, card_on_file: true, can_bid: true } });
    }
    if (p === '/api/auth/me') return json({ success: true, data: { id: 'buyer-a' } });
    // Benign catch-all for any other page-support call (watchlist, nav, auth-refresh…).
    if (p.startsWith('/api/')) return json({ success: true, data: [] });

    // ---- Static assets: serve the REAL files so production code runs verbatim ----
    if (p === '/' || p === '/lot.html') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(PUBLIC, 'lot.html'), 'utf8') });
    }
    const rel = p.replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return route.fulfill({ status: 200, contentType: CTYPE[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  };
}

async function openClient(context, server) {
  const page = await context.newPage();
  await page.addInitScript((t) => { try { localStorage.setItem('token', t); } catch (e) {} }, DUMMY_TOKEN);
  await page.route('**/*', makeRouter(server));
  await page.goto(`http://localhost/lot.html?lotId=${LOT_ID}`, { waitUntil: 'domcontentloaded' });
  // Wait until the page has loaded the lot and started its countdown (client is live).
  await page.waitForFunction(() => typeof currentClosesAt !== 'undefined' && !!currentClosesAt, null, { timeout: 15_000 });
  return page;
}

// Read exactly the state a human sees + the client's believed authoritative close.
async function readState(page) {
  return page.evaluate(() => ({
    closesAt: (typeof currentClosesAt !== 'undefined') ? currentClosesAt : null,
    closed: (typeof lotClosed !== 'undefined') ? lotClosed : null,
    connected: (window.__lotSocket && typeof window.__lotSocket.connected === 'boolean') ? window.__lotSocket.connected : null,
    joined: (window.__shimSocket && window.__shimSocket._joined) ? window.__shimSocket._joined.slice() : [],
    cdText: ((document.getElementById('countdown-val') || {}).textContent || '').trim(),
    bidText: ((document.getElementById('current-bid') || {}).textContent || '').trim(),
    banner: (() => { const b = document.getElementById('closed-banner'); return b ? getComputedStyle(b).display : 'none'; })(),
  }));
}

const deliver = (page, ev, payload) => page.evaluate(([e, p]) => window.__rtDeliver(e, p), [ev, payload]);
// Model a fully-throttled background tab: no socket delivery AND frozen timers.
const freezeTab = (page) => page.evaluate(() => { try { window.__lotSocket.disconnect(); } catch (e) {} try { stopRefresh(); } catch (e) {} });
const reconnectSocket = (page) => page.evaluate(() => { window.__lotSocket.connect(); });
const refocusTab = (page) => page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
const clientPlacesBid = (page, cents) => page.evaluate(([lotId, c]) => fetch('/api/lots/' + lotId + '/bids', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') }, body: JSON.stringify({ max_bid_cents: c }),
}).then((r) => r.status), [LOT_ID, cents]);

// ─────────────────────────────────────────────────────────────────────────────

test.describe('Realtime bid synchronization — two clients, server-authoritative', () => {
  test.describe.configure({ mode: 'serial' });

  test('[1] both clients join the room; a missed extension reconciles on socket reconnect (Req 1–7)', async ({ browser }) => {
    const server = { lot: freshServerLot(Date.now() + 40_000) }; // closes in 40s → next bid is inside the 120s anti-snipe window
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const A = await openClient(ctxA, server);
    const B = await openClient(ctxB, server);

    // Req 1: both clients connected and joined the auction room.
    await expect.poll(async () => (await readState(A)).connected).toBe(true);
    await expect.poll(async () => (await readState(B)).connected).toBe(true);
    await expect.poll(async () => (await readState(A)).joined).toContain(AUCTION_ID);
    await expect.poll(async () => (await readState(B)).joined).toContain(AUCTION_ID);

    const closesBefore = server.lot.closes_at;
    const a0 = await readState(A); const b0 = await readState(B);
    expect(a0.closesAt).toBe(closesBefore);
    expect(b0.closesAt).toBe(closesBefore); // both agree at the start

    // Req 6 setup: Client B becomes a throttled background tab — no socket, no poll.
    await freezeTab(B);
    await expect.poll(async () => (await readState(B)).connected).toBe(false);

    // Req 2+3: Client A places a bid inside the anti-snipe window → the authoritative
    // server extends closes_at by 120s. (Real bidService semantics, in the mock.)
    const status = await clientPlacesBid(A, 5000);
    expect(status).toBe(200);
    const extMs = new Date(server.lot.closes_at).getTime() - new Date(closesBefore).getTime();
    expect(extMs).toBe(EXT_MS);          // server extended by exactly 2 minutes
    expect(server.lot.extension_count).toBe(1);

    // The realtime bridge broadcasts lot:update to the room. B is offline and MISSES it.
    await deliver(A, 'lot:update', { lot_id: LOT_ID, closes_at: server.lot.closes_at, current_bid_cents: server.lot.current_bid_cents, extension_count: 1, state: 'open' });

    // Client A converged to the extended close.
    await expect.poll(async () => (await readState(A)).closesAt).toBe(server.lot.closes_at);

    // Req 5: while B is stale it must show the (old) live time — NEVER CLOSED — because
    // the server still considers bidding open. It missed the event but did not lie.
    const bStale = await readState(B);
    expect(bStale.closed).toBe(false);
    expect(bStale.banner).toBe('none');
    expect(bStale.closesAt).toBe(closesBefore);                 // provably stale (missed the extension)
    expect(bStale.closesAt).not.toBe((await readState(A)).closesAt);

    // Req 6: the tab comes back → the production socket 'connect' reconciler fires
    // (joinIfReady + refreshLotNow) and B reconciles against the authoritative server.
    await reconnectSocket(B);

    // Req 4 + 7: both clients now observe the IDENTICAL authoritative closing time,
    // current bid, and (open) status. Countdown is derived from closesAt, so equal
    // closesAt ⇒ equal countdown modulo sub-second read jitter.
    await expect.poll(async () => (await readState(B)).closesAt).toBe(server.lot.closes_at);
    const a1 = await readState(A); const b1 = await readState(B);
    expect(b1.closesAt).toBe(a1.closesAt);                      // closing time matches
    expect(b1.closed).toBe(a1.closed);                          // lot status matches (both open)
    expect(b1.closed).toBe(false);
    expect(b1.banner).toBe('none');
    expect(b1.bidText).toBe(a1.bidText);                        // current bid matches
    expect(b1.bidText).toMatch(/\$/);
    expect(a1.cdText).toMatch(/\d/); expect(b1.cdText).toMatch(/\d/); // both showing a live countdown

    await ctxA.close(); await ctxB.close();
  });

  test('[2] a hidden tab reconciles on refocus (visibility/focus) — the non-socket recovery path (Req 6)', async ({ browser }) => {
    const server = { lot: freshServerLot(Date.now() + 40_000) };
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const A = await openClient(ctxA, server);
    const B = await openClient(ctxB, server);

    const closesBefore = server.lot.closes_at;
    await freezeTab(B); // background tab: frozen timers + dropped socket

    // A bids inside the window → server extends; broadcast reaches A only.
    expect(await clientPlacesBid(A, 6000)).toBe(200);
    expect(new Date(server.lot.closes_at).getTime() - new Date(closesBefore).getTime()).toBe(EXT_MS);
    await deliver(A, 'lot:update', { lot_id: LOT_ID, closes_at: server.lot.closes_at, current_bid_cents: server.lot.current_bid_cents, extension_count: 1, state: 'open' });
    await expect.poll(async () => (await readState(A)).closesAt).toBe(server.lot.closes_at);

    // B still stale, still NOT closed.
    const bStale = await readState(B);
    expect(bStale.closesAt).toBe(closesBefore);
    expect(bStale.closed).toBe(false);

    // Refocus WITHOUT reconnecting the socket — only the visibility/focus reconcilers
    // (Fix 1b) can save B here. It must converge to the authoritative close.
    await refocusTab(B);
    await expect.poll(async () => (await readState(B)).closesAt).toBe(server.lot.closes_at);
    const b1 = await readState(B);
    expect(b1.closed).toBe(false);
    expect(b1.banner).toBe('none');

    await ctxA.close(); await ctxB.close();
  });

  test('[3] the local countdown NEVER displays CLOSED while the server is open; it reconciles at zero (Fix 1a, Req 5)', async ({ browser }) => {
    // Lot closes very soon so the LOCAL clock crosses zero during the test.
    const server = { lot: freshServerLot(Date.now() + 2_500) };
    const ctx = await browser.newContext();
    const B = await openClient(ctx, server);

    // Drop the socket and the 3s poll but LEAVE the countdown ticking — so the ONLY
    // possible recovery is the tick-at-zero self-reconcile (Fix 1a: refreshLotNow()).
    await B.evaluate(() => { try { window.__lotSocket.disconnect(); } catch (e) {} try { clearInterval(refreshTimer); refreshTimer = null; } catch (e) {} });

    // While the client counts down, the server extends the close (as a late bid would).
    server.lot.closes_at = new Date(new Date(server.lot.closes_at).getTime() + EXT_MS).toISOString();
    server.lot.extension_count += 1;
    server.lot.current_bid_cents = 4000;

    // Sample the visible countdown across the zero-crossing: it must NEVER read the
    // terminal "Ended", and lotClosed must never latch true — because the SERVER is open.
    const deadline = Date.now() + 6_000;
    let sawClosingOrLive = false;
    while (Date.now() < deadline) {
      const s = await readState(B);
      expect(s.closed).toBe(false);                 // never falsely latch closed from the local clock
      expect(s.cdText).not.toBe('Ended');           // the old bug's verdict must be gone
      expect(s.banner).toBe('none');
      if (s.cdText === 'Closing…' || /\d/.test(s.cdText)) sawClosingOrLive = true;
      if (s.closesAt === server.lot.closes_at) break; // reconciled via tick-zero self-refresh
      await B.waitForTimeout(150);
    }
    expect(sawClosingOrLive).toBe(true);

    // Reconciled to the authoritative extended close, still open — no false CLOSED ever shown.
    await expect.poll(async () => (await readState(B)).closesAt).toBe(server.lot.closes_at);
    const done = await readState(B);
    expect(done.closed).toBe(false);
    expect(done.banner).toBe('none');

    await ctx.close();
  });

  test('[4] an authoritative close propagates to BOTH clients — identical final CLOSED state (Req 8–9)', async ({ browser }) => {
    const server = { lot: freshServerLot(Date.now() + 40_000) };
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const A = await openClient(ctxA, server);
    const B = await openClient(ctxB, server);

    // Precondition: neither client is closed while the server is open.
    expect((await readState(A)).closed).toBe(false);
    expect((await readState(B)).closed).toBe(false);

    // The server authoritatively closes the lot (worker/close path) and names a winner.
    server.lot.state = 'closed';
    server.lot.closes_at = new Date(Date.now() - 1_000).toISOString();
    server.lot.winning_amount_cents = server.lot.current_bid_cents;

    // Both clients learn of it — A via the realtime broadcast, B via its own reconcile
    // (either a realtime nudge or the poll/visibility path). Both must converge to CLOSED.
    await deliver(A, 'lot:update', { lot_id: LOT_ID, closes_at: server.lot.closes_at, current_bid_cents: server.lot.current_bid_cents, state: 'closed' });
    await deliver(B, 'lot:update', { lot_id: LOT_ID, closes_at: server.lot.closes_at, current_bid_cents: server.lot.current_bid_cents, state: 'closed' });

    await expect.poll(async () => (await readState(A)).closed).toBe(true);
    await expect.poll(async () => (await readState(B)).closed).toBe(true);
    const a = await readState(A); const b = await readState(B);
    expect(a.banner).toBe('block');          // Req 8: closed banner shown
    expect(b.banner).toBe('block');
    expect(a.cdText).toBe('Ended');          // once the SERVER confirms closed, "Ended" is correct
    expect(b.cdText).toBe('Ended');
    expect(b.closed).toBe(a.closed);         // Req 9: identical final state
    expect(b.bidText).toBe(a.bidText);       // identical final price

    await ctxA.close(); await ctxB.close();
  });

  test('[5] a NON-registered viewer (gate replaced the bid form) transitions cleanly to CLOSED — no JS exception (Phase 1.6 hardening)', async ({ browser }) => {
    // Model a viewer who has NOT accepted terms/registered: getBidGate → gate replaces
    // the bid form, so #bid-input/#max-bid-input/#btn-bid are absent. Pre-hardening,
    // applyClosedState() threw on the missing #bid-input before rendering the closed
    // state; the null guards must now let it complete cleanly.
    const server = { lot: freshServerLot(Date.now() + 40_000), gate: { success: true, data: { logged_in: true, terms_accepted_current: false, registered: false, card_on_file: false, can_bid: false } } };
    const ctx = await browser.newContext();
    const V = await openClient(ctx, server);

    // The gate replaced the bid form → the inputs applyClosedState touches are gone.
    const domGone = await V.evaluate(() => ({
      bidInput: !!document.getElementById('bid-input'),
      maxInput: !!document.getElementById('max-bid-input'),
      bidBtn: !!document.getElementById('btn-bid'),
      banner: !!document.getElementById('closed-banner'),
    }));
    expect(domGone.bidInput).toBe(false);
    expect(domGone.maxInput).toBe(false);
    expect(domGone.bidBtn).toBe(false);
    expect(domGone.banner).toBe(true);       // the closed banner element itself still exists

    // Capture any uncaught page error / console error from here on.
    const errors = [];
    V.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    V.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    // The server authoritatively closes the lot.
    server.lot.state = 'closed';
    server.lot.closes_at = new Date(Date.now() - 1_000).toISOString();
    server.lot.winning_amount_cents = server.lot.current_bid_cents;
    await deliver(V, 'lot:update', { lot_id: LOT_ID, closes_at: server.lot.closes_at, current_bid_cents: server.lot.current_bid_cents, state: 'closed' });

    // The closed state renders cleanly for the non-registered viewer.
    await expect.poll(async () => (await readState(V)).closed).toBe(true);
    const s = await readState(V);
    expect(s.banner).toBe('block');          // closed banner shown despite the missing bid form
    expect(s.cdText).toBe('Ended');          // countdown flipped to the terminal state
    expect(errors).toEqual([]);              // and NO exception was thrown (the old failure mode)

    await ctx.close();
  });
});
