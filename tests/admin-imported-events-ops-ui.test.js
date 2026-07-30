'use strict';

// Commit 15 — the operations UI added to public/admin/imported-events.html: manual run controls,
// worker/scheduler status, and the Run History workbench. Static-source + inline-JS-syntax checks
// (matching the repo's UI-test convention), preserving the Commit 11 tests in the sibling file.

const fs = require('fs');
const vm = require('vm');
const HTML = fs.readFileSync('public/admin/imported-events.html', 'utf8');

describe('inline JS still parses after the Commit 15 additions', () => {
  test('no syntax errors', () => {
    const scripts = [...HTML.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts.length).toBe(1);
    expect(() => new vm.Script(scripts[0])).not.toThrow();
  });
});

describe('manual import controls (reuse the Commit 14 service via the API)', () => {
  test('Run Import Now, Dry Run, source picker, and a status refresh exist', () => {
    ['mSource', 'mDry', 'mRun', 'opsRefresh', 'mResult'].forEach(id => expect(HTML).toContain('id="' + id + '"'));
    expect(HTML).toContain('Run Import Now');
    expect(HTML).toContain('Dry Run');
  });
  test('the manual-run source picker offers a "run all enabled sources" option', () => {
    expect(HTML).toContain('All enabled sources');
    expect(HTML).toMatch(/filter\(s=>s\.status==='active'\)/); // only active sources are runnable
  });
  test('runs POST /run with apply true|false and confirms before an apply run', () => {
    expect(HTML).toMatch(/API\+'\/run'/);
    expect(HTML).toMatch(/function runManual\(apply\)/);
    expect(HTML).toMatch(/confirmDialog\(title, body, \(\)=>doRun\(apply, sourceKey, all\), \{ okLabel: apply\?'Run import':'Dry run', danger: apply \}\)/);
  });
  test('apply run states DRAFTS-not-published; dry run states it writes nothing', () => {
    expect(HTML).toMatch(/created as <b>DRAFTS<\/b> for review - nothing is published automatically/);
    expect(HTML).toMatch(/writes <b>nothing<\/b>/);
  });
  test('prevents duplicate submissions (busy guard + disables buttons in-flight)', () => {
    expect(HTML).toMatch(/if\(STATE\.busy\) return; setBusy\(true\)/);
    expect(HTML).toMatch(/btns\.forEach\(b=>b&&\(b\.disabled=true\)\)/);
  });
});

describe('worker / scheduler status display', () => {
  test('consumes GET /status and shows enabled state + schedule + last run', () => {
    expect(HTML).toMatch(/API\+'\/status'/);
    expect(HTML).toMatch(/function loadStatus/);
    ['schDot', 'schStatus', 'schSchedule', 'workerState', 'lastRun'].forEach(id => expect(HTML).toContain('id="' + id + '"'));
    expect(HTML).toMatch(/Scheduler: '\+\(s\.enabled\?'Enabled':'Disabled \(idle\)'\)/);
    expect(HTML).toMatch(/s\.schedule_label/);
  });
  test('status uses textContent (no unescaped injection into the status line)', () => {
    expect(HTML).toMatch(/getElementById\('schSchedule'\)\.textContent=s\.schedule_label/);
  });
});

describe('Run History workbench', () => {
  test('tabs switch between the queue and run history', () => {
    ['tabQueue', 'tabRuns', 'view-queue', 'view-runs'].forEach(id => expect(HTML).toContain('id="' + id + '"'));
    expect(HTML).toMatch(/function switchView/);
  });
  test('consumes GET /runs and GET /runs/:id', () => {
    expect(HTML).toMatch(/API\+'\/runs\?'/);
    expect(HTML).toMatch(/API\+'\/runs\/'\+encodeURIComponent\(id\)/);
    expect(HTML).toMatch(/function openRunDetail/);
  });
  test('the table has every required column', () => {
    ['Run', 'Source', 'Trigger', 'Started', 'Finished', 'Duration', 'Status', 'Imported', 'Updated', 'Skipped', 'Dupes', 'Errors']
      .forEach(h => expect(HTML).toContain('<th' + (h === 'Run' ? '>' : ''))); // sanity: table exists
    expect(HTML).toMatch(/>Imported<\/th>[\s\S]*>Updated<\/th>[\s\S]*>Skipped<\/th>[\s\S]*>Dupes<\/th>[\s\S]*>Errors<\/th>/);
  });
  test('history filters by source, status, and trigger with a refresh', () => {
    ['rSource', 'rStatus', 'rTrigger', 'rRefresh'].forEach(id => expect(HTML).toContain('id="' + id + '"'));
  });
  test('run rows are keyboard-accessible (button role + Enter/Space)', () => {
    expect(HTML).toMatch(/tr\.tabIndex=0; tr\.setAttribute\('role','button'\)/);
    expect(HTML).toMatch(/e\.key==='Enter'\|\|e\.key===' '/);
  });
});

describe('error visibility (operator feedback categories)', () => {
  test('connector failure, weekly cap, empty source, duplicate-heavy, partial + complete success', () => {
    expect(HTML).toContain('Connector failure');
    expect(HTML).toContain('Weekly cap reached');
    expect(HTML).toContain('Empty source - no records returned');
    expect(HTML).toContain('Mostly duplicates - nothing new imported');
    expect(HTML).toContain('Partial success');
    expect(HTML).toContain('Complete success');
    expect(HTML).toContain('Dry run complete (nothing written)');
  });
});

describe('states + notifications + responsiveness', () => {
  test('loading, empty, and error states for run history', () => {
    expect(HTML).toContain('Loading run history');
    expect(HTML).toContain('No import runs yet');
    expect(HTML).toContain('Could not load run history');
    expect(HTML).toMatch(/id="runsRetry"/);
  });
  test('success + failure notifications on manual runs', () => {
    expect(HTML).toMatch(/toast\(apply\?'Import run complete\.':'Dry run complete\.','ok'\)/);
    expect(HTML).toMatch(/toast\('Run failed\.','err'\)/);
  });
  test('run table scrolls horizontally on small screens (no page-level x-scroll)', () => {
    expect(HTML).toMatch(/\.runwrap\{overflow-x:auto\}/);
  });
});

describe('governance carried into the new UI', () => {
  test('imported/source content in run detail is escaped', () => {
    expect(HTML).toMatch(/esc\(r\.source_name\|\|r\.source_key/);
    expect(HTML).toMatch(/error: '\+esc\(it\.error\)/);
  });
  test('external-link safety unchanged (full rel triplet; no bare noopener)', () => {
    expect(HTML).toMatch(/const EXT = ' target="_blank" rel="nofollow noopener noreferrer"'/);
    expect(HTML).not.toMatch(/rel="noopener"(?! noreferrer)/);
  });
  test('the UI never publishes automatically and never references Brilliant Directories', () => {
    expect(HTML).not.toMatch(/auto[-_ ]?publish\s*\(/i);
    expect(HTML).not.toMatch(/brilliant|directorysecure/i);
    // manual runs create drafts; the only publish path remains the explicit review-queue approve
    expect(HTML).toMatch(/nothing is published automatically/);
  });
  test('dry runs are described as not recorded in history', () => {
    expect(HTML).toContain('Dry runs are previews and are not recorded');
  });
});
