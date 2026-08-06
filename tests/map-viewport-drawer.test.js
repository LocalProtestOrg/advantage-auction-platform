'use strict';

/**
 * "Events Near You" must follow the visible map area: the drawer lists only eligible events whose
 * coordinates fall inside map.getBounds(), sorted nearest-to-center, refreshed on map movement.
 * Source-level assertions (the codebase's pattern for map wiring + copy).
 */
const fs = require('fs');
const path = require('path');
const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

describe('viewport filtering', () => {
  test('inViewport uses the map bounds (getBounds().contains), not text or a stale center', () => {
    expect(index).toMatch(/function inViewport\(d\)\{/);
    expect(index).toMatch(/map\.getBounds&&map\.getBounds\(\)/);
    expect(index).toMatch(/return b\.contains\(\[\+d\.lng,\+d\.lat\]\);/);
    // records without coordinates cannot be placed on the map → excluded
    expect(index).toMatch(/if\(d\.lng==null\|\|d\.lat==null\) return false;/);
  });
  test('buildList applies viewport filtering to the non-archive tabs only', () => {
    expect(index).toMatch(/var viewport=\(f!=='archive'\);/);
    expect(index).toMatch(/if\(viewport\)\{ rows=sortForViewport\(rows\.filter\(inViewport\)\); \}/);
  });
  test('the drawer dataset is the event/auction dataset (clustered events remain eligible)', () => {
    // built from EVENTS_MAP / DATA, never from rendered/expanded markers
    expect(index).toMatch(/function activeEvents\(\)\{ return EVENTS_MAP\.filter/);
    expect(index).not.toMatch(/buildList[\s\S]{0,400}queryRenderedFeatures/);
  });
});

describe('sorting', () => {
  test('sorts by distance from visible center, then start, then title', () => {
    expect(index).toMatch(/function distFromCenter\(d\)\{[\s\S]{0,200}map\.getCenter\(\)/);
    const s = index.slice(index.indexOf('function sortForViewport'), index.indexOf('function sortForViewport') + 420);
    expect(s).toMatch(/da!==db\) return da-db/);
    expect(s).toMatch(/sa!==sb\) return sa-sb/);
    expect(s).toMatch(/localeCompare/);
  });
});

describe('update timing', () => {
  test('the drawer refreshes on map moveend', () => {
    expect(index).toMatch(/map\.on\('moveend', scheduleDrawerRefresh\);/);
  });
  test('refresh is debounced and guarded (ready + not during a preview pan)', () => {
    const s = index.slice(index.indexOf('function scheduleDrawerRefresh'), index.indexOf('function scheduleDrawerRefresh') + 400);
    expect(s).toMatch(/if\(!drawerReady \|\| \(MP && MP\._previewPan\)\) return;/);
    expect(s).toMatch(/setTimeout\([\s\S]{0,120},\s*140\)/);
  });
  test('drawerReady is set only once the drawer is first built', () => {
    expect((index.match(/drawerReady=true;/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('hover / focus after filtering', () => {
  test('a preview-driven pan is flagged so it does not rebuild the drawer', () => {
    expect(index).toMatch(/MP\._previewPan=true; map\.easeTo\(\{center:coords,duration:420\}\);/);
    expect(index).toMatch(/open\(\); MP\._previewPan=false;/);
  });
  test('keyboard focus is preserved across a rebuild (same card, else the active tab)', () => {
    expect(index).toMatch(/focusedId=ae\.dataset\.id;/);
    expect(index).toMatch(/var again=list\.querySelector\('\.card\[data-id="'\+focusedId\+'"\]'\);/);
    expect(index).toMatch(/if\(again\) again\.focus\(\); else \{ var tab=document\.querySelector\('\.dtab\.on'\); if\(tab\) tab\.focus\(\); \}/);
  });
});

describe('drawer title, count, and empty-state copy', () => {
  test('title stays "Events Near You"', () => {
    expect(index).toMatch(/near:'Events Near You'/);
  });
  test('the count reflects what is on the map, plus any online auctions listed below', () => {
    expect(index).toMatch(/\+' on the map'/);
    expect(index).toMatch(/'No events on the map here'/);
    expect(index).toMatch(/online auction/);   // subtitle also surfaces the coordless online-auction count
  });
  test('empty-state copy is the approved wording with a List View escape hatch (no em dash)', () => {
    expect(index).toMatch(/No events are visible in this area\.<br>Move or zoom the map to explore other events\.<br><a href="'\+listViewHref\(\)\+'"/);
    const empty = 'No events are visible in this area.<br>Move or zoom the map to explore other events.';
    expect(index).toContain(empty);
    expect(empty).not.toMatch(/—/); // em dash
  });
  test('List View escape hatch preserves current search state', () => {
    const s = index.slice(index.indexOf('function listViewHref'), index.indexOf('function listViewHref') + 400);
    expect(s).toMatch(/\['q','city','state','zip','type','radius','sort','preset','lat','lng','near'\]/);
    expect(s).toMatch(/all-events/);
  });
});

describe('accessibility', () => {
  test('a polite live region announces the visible count', () => {
    expect(index).toMatch(/id="drawerLive" role="status" aria-live="polite"/);
    expect(index).toMatch(/function announceVisible\(count\)\{/);
    // only announce on real change (not every minor movement)
    expect(index).toMatch(/count===_lastAnnounced\) return;/);
  });
});

describe('regression — drawer never draws company/professional records', () => {
  test('source only draws from native auctions + events', () => {
    expect(index).toMatch(/function source\(f\)\{ return f==='archive'\?ARCH:activeAuctions\(\)\.concat\(activeEvents\(\)\.map\(evToDrawer\)\); \}/);
    expect(index).not.toMatch(/companyRecs\.map\(evToDrawer\)/);
  });
});

describe('regression — sibling surfaces + payments unaffected (cross-checks)', () => {
  test('Dashboard Home, photo enlargement, Stripe test posture, company/event layers intact', () => {
    const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'widgets', 'shared', 'member-chrome.js'), 'utf8');
    const event = fs.readFileSync(path.join(__dirname, '..', 'public', 'event.html'), 'utf8');
    expect(shell).toContain('<h1 id="adv-title">');
    expect(shell).toMatch(/Dashboard Home/);
    expect(event).toMatch(/#lb \.lbimg\{[^}]*width:94vw;height:90vh/);
    expect(index).toMatch(/MP_EVENT_CATS = \[/);
    expect(index).toMatch(/cluster:true, clusterRadius:46, clusterMaxZoom:12/);
  });
});
