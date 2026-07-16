'use strict';

/**
 * SEV-1 regression — Lot Detail live bid synchronization.
 *
 * The bug: #bid-empty is a CHILD of #bid-list. renderBids wiped the list with
 * innerHTML='' AFTER the first bid rendered, destroying #bid-empty. Every later
 * render then dereferenced `empty.style` on null and threw — and refreshLotNow's
 * silent catch swallowed it — so the current-bid headline, bid count and history
 * froze for the rest of the session while the auction gallery kept updating.
 *
 * Reproduced live with two browsers: DB and gallery moved to $310 while Lot Detail
 * sat at $250 indefinitely, on the very page that placed the bid.
 *
 * These tests pin the source contract that made it possible. No new dependency:
 * the page source is asserted directly, and the real clearBidRows helper is run
 * against a minimal element stub.
 */

const fs = require('fs');
const path = require('path');

const LOT_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'lot.html'), 'utf8');

function renderBidsSource() {
  const start = LOT_HTML.indexOf('function renderBids(');
  expect(start).toBeGreaterThan(-1);
  return LOT_HTML.slice(start, start + 2600);
}

describe('SEV-1 — the DOM contract that froze Lot Detail', () => {
  test('#bid-empty is nested inside #bid-list (the precondition for the bug)', () => {
    // Markup order: <div id="bid-list"> ... <div id="bid-empty"> ... </div>
    const list = LOT_HTML.indexOf('id="bid-list"');
    const empty = LOT_HTML.indexOf('id="bid-empty"');
    const listClose = LOT_HTML.indexOf('</div>', LOT_HTML.indexOf('id="bid-empty"'));
    expect(list).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(list);      // #bid-empty comes after #bid-list opens
    expect(listClose).toBeGreaterThan(empty); // and before it closes → it is a child
  });

  test('renderBids never clears the list with innerHTML (that destroyed #bid-empty)', () => {
    const body = renderBidsSource();
    expect(body).not.toMatch(/list\.innerHTML\s*=\s*['"]{2}/);
    expect(body).toMatch(/clearBidRows\(list\)/);
  });

  test('every #bid-empty dereference in renderBids is null-guarded', () => {
    // An unguarded `empty.style` threw BEFORE setCurrentBid(), which is precisely
    // why the price froze rather than merely losing the history list.
    renderBidsSource().split('\n').forEach((line) => {
      if (/\bempty\.style/.test(line)) expect(line).toMatch(/if \(empty\)/);
    });
  });

  test('clearBidRows removes bid rows but preserves #bid-empty', () => {
    const src = LOT_HTML.match(/function clearBidRows\(list\)\s*\{[\s\S]*?\n  \}/);
    expect(src).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const clearBidRows = new Function(src[0] + '; return clearBidRows;')();

    const mk = (id) => {
      const el = { id, remove() { list.children = list.children.filter((c) => c !== el); } };
      return el;
    };
    const list = { children: [] };
    const empty = mk('bid-empty');
    list.children.push(empty, mk(''), mk(''), mk(''));

    clearBidRows(list);

    expect(list.children).toHaveLength(1);
    expect(list.children[0]).toBe(empty);        // survives → next render cannot throw

    // The real page polls every 3s; repeated clears must stay stable.
    for (let i = 0; i < 10; i++) clearBidRows(list);
    expect(list.children[0]).toBe(empty);
  });

  test('refreshLotNow no longer swallows render errors silently', () => {
    const start = LOT_HTML.indexOf('async function refreshLotNow(');
    expect(start).toBeGreaterThan(-1);
    const body = LOT_HTML.slice(start, start + 1800);
    // The silent catch is what let a render error freeze the live price unnoticed.
    expect(body).not.toMatch(/catch\s*\{\s*\/\* network blip \*\/\s*\}/);
    expect(body).toMatch(/console\.error\('\[lot\] refresh failed:/);
  });

  test('renderBids still sets the current bid from the authoritative value', () => {
    // PR #61 made the headline read the lot's current_bid_cents (what the gallery
    // shows). Keep that wiring intact — it is the other half of gallery parity.
    const body = renderBidsSource();
    expect(body).toMatch(/authCents\s*>\s*0/);
    expect(body).toMatch(/setCurrentBid\(topCents\)/);
  });
});
