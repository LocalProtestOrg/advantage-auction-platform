'use strict';

/**
 * Phase-1 event/navigation polish: view-mode labels, brand-home destination, Dashboard Home label,
 * event-type (not timing status) card badge, and the enlarged photo viewer.
 * Source-level assertions (the codebase's pattern for HTML/widget copy + wiring).
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('Item 1 — Map View / List View labels (display-mode switch, not "Browse All Events")', () => {
  const index = read('public', 'index.html');
  const widget = read('public', 'widgets', 'marketplace-feed.js');
  test('map page uses the shared "List View | Map View" selector, not "Browse All Events"', () => {
    expect(index).toMatch(/class="viewseg"[\s\S]{0,260}>List View<\/a>[\s\S]{0,160}>Map View<\/a>/);
    expect(index).not.toContain('>Browse All Events</a>');
    // the standalone lower-left List View button was removed from the map key
    expect(index).not.toMatch(/class="legend-browse"/);
  });
  test('the feed widget toggle uses the paired "List View" / "Map View" labels', () => {
    expect(widget).toMatch(/aria-current="true">List View<\/a>/);
    expect(widget).toMatch(/id="amf-map"[\s\S]{0,80}>Map View<\/a>/);
  });
});

describe('Item 3 — the Advantage.Bid brand/logo links to https://advantage.bid', () => {
  const event = read('public', 'event.html');
  const shell = read('public', 'widgets', 'shared', 'member-chrome.js'); // shared chrome renders the brand
  test('event-detail brand goes to advantage.bid (not the marketplace root)', () => {
    expect(event).toMatch(/<a class="brand" href="https:\/\/advantage\.bid">Advantage<span>\.Bid<\/span><\/a>/);
  });
  test('a labeled marketplace link (Map) may still point to the Railway root', () => {
    expect(event).toMatch(/class="hlink" href="\/">🗺 Map<\/a>/);
  });
  test('the dashboard shell brand already links to advantage.bid (desktop + mobile)', () => {
    expect((shell.match(/href="https:\/\/advantage\.bid"/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('Item 4 — dashboard "Home" reads "Dashboard Home" (never an ambiguous "Home")', () => {
  const nav = read('public', 'widgets', 'shared', 'member-nav-config.js');
  const shell = read('public', 'widgets', 'shared', 'member-chrome.js'); // shared chrome renders the header
  test('every nav config home item is labeled "Dashboard Home"', () => {
    expect((nav.match(/label: 'Dashboard Home'/g) || []).length).toBe(3);
    expect(nav).not.toMatch(/label: 'Home'/);
  });
  test('the shell title default is "Dashboard Home"', () => {
    expect(shell).toContain('<h1 id="adv-title">');
    expect(shell).toMatch(/\|\| 'Dashboard Home'/); // default title when no section is set
  });
});

describe('Item 6 — card badge shows event TYPE, not a timing status', () => {
  const widget = read('public', 'widgets', 'marketplace-feed.js');
  test('badge() returns the type (Auction / Estate Sale), never "Coming soon"/"Live auction"', () => {
    const b = widget.slice(widget.indexOf('function badge'), widget.indexOf('function cta'));
    expect(b).toMatch(/>Estate Sale</);
    expect(b).toMatch(/>Auction</);
    expect(b).not.toMatch(/Coming soon/);
    expect(b).not.toMatch(/Live auction/);
    expect(b).not.toMatch(/Ending soon/);
  });
  test('timing status lives separately in whenLabel (not a type word)', () => {
    const w = widget.slice(widget.indexOf('function whenLabel'), widget.indexOf('function badge'));
    expect(w).not.toMatch(/Live auction/);
    expect(w).toMatch(/Live now|Ends |Starts /);
  });
});

describe('Item 7 — enlarged photo viewer fills the viewport (aspect preserved)', () => {
  const event = read('public', 'event.html');
  test('lightbox image box is sized to ~94vw x 90vh with object-fit: contain (no crop)', () => {
    expect(event).toMatch(/#lb \.lbimg\{[^}]*width:94vw;height:90vh/);
    expect(event).toMatch(/#lb \.lbimg\{[^}]*object-fit:contain/);
  });
  test('lightbox keyboard/close/counter controls remain', () => {
    expect(event).toMatch(/id="lbprev"/);
    expect(event).toMatch(/id="lbnext"/);
    expect(event).toMatch(/id="lbx"/);
    expect(event).toMatch(/id="lbcount"/);
  });
});
