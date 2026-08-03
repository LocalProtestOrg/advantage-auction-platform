'use strict';

/**
 * Phase-1 final map-experience polish:
 *   1. Right-panel event card hover/focus → map marker preview (reusing the event popup renderer).
 *   2. Approved title capitalization across the map/drawer/legend/selector/preview scope.
 *   3. Mobile map-key collapse control sits below the floating header (header-safe offset + 44px target).
 *   4. Shared "List View | Map View" segmented selector on the map; standalone legend button removed.
 *   5. Event drawer ⇄ marker synchronization via the legend filters.
 *   6. Consistent status vocabulary (Live Now / Ending Soon / Upcoming / Ended).
 * Source-level assertions (the codebase's pattern for HTML/CSS/JS wiring + copy).
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const index = read('public', 'index.html');

describe('Part 1 — drawer event card hover/focus previews the matching marker', () => {
  test('event cards get hover AND keyboard-focus preview handlers (hover-capable pointers only)', () => {
    expect(index).toMatch(/if\(d\.isEvent && HOVERABLE\)\{/);
    expect(index).toMatch(/c\.addEventListener\('mouseenter',function\(\)\{ mpPreviewEvent\(d\.id\); \}\);/);
    expect(index).toMatch(/c\.addEventListener\('focus',function\(\)\{ mpPreviewEvent\(d\.id\); \}\);/);
  });
  test('HOVERABLE gates hover to fine, hover-capable pointers (not touch)', () => {
    expect(index).toMatch(/HOVERABLE=window\.matchMedia\('\(hover:hover\) and \(pointer:fine\)'\)\.matches/);
  });
  test('preview connects by STABLE map id (data-id), never by title text', () => {
    expect(index).toMatch(/function mpPreviewEvent\(mapId\)\{/);
    expect(index).toMatch(/var rec=MP\.byId&&MP\.byId\[mapId\];/);
    // drawer card carries the stable id
    expect(index).toMatch(/c\.dataset\.id=d\.id;/);
  });
  test('reuses the single event popup renderer (mpOpenCard → mpEventCardHTML), no second impl', () => {
    const body = index.slice(index.indexOf('function mpPreviewEvent'), index.indexOf('function mpPreviewEvent') + 700);
    expect(body).toMatch(/mpOpenCard\(\{ properties:\{ id:rec\.id/);
    expect((index.match(/function mpEventCardHTML/g) || []).length).toBe(1);
  });
  test('hover never navigates; the card anchor still owns navigation', () => {
    // the preview opens a popup; the card remains an <a href> for click/Enter/Space activation
    expect(index).toMatch(/var c=document\.createElement\('a'\); c\.className='card'; c\.dataset\.id=d\.id; c\.href=d\.href;/);
  });
  test('the preview may pan (not zoom) to bring an off-screen marker into view', () => {
    expect(index).toMatch(/MP\._previewPan=true; map\.easeTo\(\{center:coords,duration:420\}\);/);
    expect(index).toMatch(/open\(\); MP\._previewPan=false;/);
  });
});

describe('Part 2/6 — approved title capitalization + consistent status vocabulary', () => {
  test('drawer heading + tabs use title case', () => {
    expect(index).toMatch(/<div class="dtitle" id="dTitle">Events Near You<\/div>/);
    expect(index).toMatch(/data-f="near">Near You</);
    expect(index).toMatch(/data-f="ending">Ending Soon</);
    expect(index).toMatch(/data-f="coming">Upcoming</);
  });
  test('drawer titles map uses title case', () => {
    expect(index).toMatch(/var TT=\{near:'Events Near You',ending:'Ending Soon',coming:'Upcoming',archive:'Past Auctions'\};/);
  });
  test('drawer status tags use the approved vocabulary (Live Now / Ending Soon / Upcoming)', () => {
    expect(index).toMatch(/live:'● Live Now',ending:'⏱ Ending Soon',coming:'◷ Upcoming',historical:'Past'/);
  });
  test('an in-progress event reads "Live Now", never the ad-hoc "In progress"', () => {
    expect(index).toMatch(/if\(s&&s>now\) return 'Upcoming';\s*\n\s*return 'Live Now';/);
    expect(index).not.toMatch(/return 'In progress';/);
  });
  test('native-auction preview chips read UPCOMING, not COMING SOON', () => {
    expect(index).not.toMatch(/coming:'COMING SOON'/);
    expect(index).toMatch(/coming:'UPCOMING'/);
  });
});

describe('Part 3 — mobile map-key collapse control is header-safe', () => {
  test('a shared header offset variable exists (calculated, not a single hardcoded value)', () => {
    expect(index).toMatch(/--hdr-top:max\(14px,env\(safe-area-inset-top\)\);/);
    expect(index).toMatch(/--hdr-offset:calc\(var\(--hdr-top\) \+ var\(--hdr-h\) \+ 10px\);/);
  });
  test('the expanded mobile key begins below the header (top offset), not anchored under it', () => {
    expect(index).toMatch(/\.legend\{display:none;left:12px;right:auto;top:calc\(var\(--hdr-offset\) \+ 46px\);bottom:auto;/);
  });
  test('the collapse control is a >=44px touch target and stays visible on mobile', () => {
    expect(index).toMatch(/\.legend-close\{display:flex;[^}]*width:44px;height:44px/);
  });
  test('the key caps its height and scrolls, respecting safe-area insets', () => {
    expect(index).toMatch(/max-height:calc\(100dvh - var\(--hdr-offset\) - 46px - 168px - env\(safe-area-inset-bottom\)\)/);
    expect(index).toMatch(/overflow-y:auto/);
    // vh fallback for engines without dvh
    expect(index).toMatch(/@supports not \(height:100dvh\)/);
  });
  test('the fix is positional — the key stays BELOW the header z-index (no z-index war)', () => {
    // legend mobile z-index is 39; the header (.top) is 40
    expect(index).toMatch(/\.legend\{display:none;left:12px;[^}]*z-index:39;/);
    expect(index).toMatch(/\.top\{position:fixed;z-index:40;/);
  });
  test('the header height is synced from the real element at runtime', () => {
    expect(index).toMatch(/function syncHeaderH\(\)\{[^]*setProperty\('--hdr-h', h\+'px'\)/);
    expect(index).toMatch(/window\.addEventListener\('resize', syncHeaderH\);/);
  });
});

describe('Part 4 — shared List View | Map View selector on the map', () => {
  test('a segmented selector exists with the same label order as List View', () => {
    expect(index).toMatch(/class="viewseg"[\s\S]{0,260}>List View<\/a>[\s\S]{0,160}>Map View<\/a>/);
  });
  test('Map View is marked active via aria-current', () => {
    expect(index).toMatch(/<a class="viewseg-opt on" href="\/" aria-current="page">Map View<\/a>/);
  });
  test('the standalone lower-left List View button was removed from the map key', () => {
    expect(index).not.toMatch(/class="legend-browse"/);
    expect(index).not.toMatch(/legend-browse/);
  });
  test('the selector reveals with the header chrome', () => {
    expect(index).toMatch(/function revealChrome\(\)\{[^]*viewSeg[^]*classList\.add\('in'\)/);
  });
  test('List View destination preserves search/location/type/radius/sort/preset state', () => {
    expect(index).toMatch(/\['q','city','state','zip','type','radius','sort','preset','lat','lng','near'\]/);
    expect(index).toMatch(/\['view-list-link','segListLink'\]\.forEach/);
  });
});

describe('Part 5 — event drawer ⇄ marker synchronization', () => {
  test('the drawer honours the event-type and status filters', () => {
    expect(index).toMatch(/function activeEvents\(\)\{ return EVENTS_MAP\.filter\(function\(r\)\{ return MP\.active\[r\.category_key\]!==false; \}\); \}/);
    expect(index).toMatch(/function activeAuctions\(\)\{ return DATA\.filter\(function\(d\)\{ return !MP\.statusHidden\[d\.state\]; \}\); \}/);
    expect(index).toMatch(/function source\(f\)\{ return f==='archive'\?ARCH:activeAuctions\(\)\.concat\(activeEvents\(\)\.map\(evToDrawer\)\); \}/);
  });
  test('status rows record their hidden state for the drawer', () => {
    expect(index).toMatch(/MP\.statusHidden\[key\]=!on;/);
    expect(index).toMatch(/statusHidden:\{\}/);
  });
  test('legend toggles refresh the drawer (both individual and bulk)', () => {
    expect((index.match(/if\(typeof mpRefreshDrawer==='function'\) mpRefreshDrawer\(\);/g) || []).length)
      .toBeGreaterThanOrEqual(2);
  });
  test('company-directory records are never merged into the event drawer', () => {
    // the drawer only draws from DATA (native auctions) + EVENTS_MAP (events)
    expect(index).toMatch(/EVENTS_MAP=eventRecs;/);
    expect(index).not.toMatch(/companyRecs\.map\(evToDrawer\)/);
  });
});

describe('regression — existing map behavior is preserved', () => {
  test('event marker layer + company pins + clustering remain', () => {
    expect(index).toMatch(/MP_EVENT_CATS = \[/);
    expect(index).toMatch(/var MP_CATS = \[/);
    expect(index).toMatch(/cluster:true, clusterRadius:46, clusterMaxZoom:12/);
  });
  test('company card branch is untouched (events never hijack company markers)', () => {
    expect(index).toMatch(/if\(rec && rec\.isEvent\)\{/);
    expect(index).toMatch(/MP\.card=new maplibregl\.Popup\(\{className:'mp-card2'/);
  });
  test('event previews still point at the canonical event page, never a discovery source', () => {
    expect(index).toMatch(/>View Event</);
    expect(index).toMatch(/href="'\+mpEsc\(r\.url\)/);
    expect(index).not.toMatch(/discovery_url|attribution_url|external_url/);
  });
});

describe('regression — sibling surfaces unaffected (cross-checks)', () => {
  test('Dashboard Home label + event photo enlargement remain', () => {
    const shell = read('public', 'widgets', 'shared', 'member-shell.js');
    const event = read('public', 'event.html');
    expect(shell).toMatch(/<h1 id="adv-title">Dashboard Home<\/h1>/);
    expect(event).toMatch(/#lb \.lbimg\{[^}]*width:94vw;height:90vh/);
  });
  test('auction/event cards in the feed still badge by TYPE, never "Coming soon"', () => {
    const widget = read('public', 'widgets', 'marketplace-feed.js');
    const b = widget.slice(widget.indexOf('function badge'), widget.indexOf('function cta'));
    expect(b).not.toMatch(/Coming soon/);
  });
});
