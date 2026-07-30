'use strict';

// Commit 11 — Admin Review Queue UI (public/admin/imported-events.html). The repo has no
// DOM test runner, so (matching settlement-review-ui.test.js) these are static-source +
// inline-JS-syntax checks that the page: is admin-gated, consumes ONLY the Commit 10 API,
// implements the required filters/detail/bulk/approve-all flows, escapes imported content,
// keeps external links safe, degrades through loading/empty/error states, and neither writes
// to Brilliant Directories nor auto-publishes.

const fs = require('fs');
const vm = require('vm');
const HTML = fs.readFileSync('public/admin/imported-events.html', 'utf8');
const NAV = fs.readFileSync('public/widgets/shared/admin-nav.js', 'utf8');

describe('page availability + admin shell placement', () => {
  test('lives in the admin backend and loads the shared admin nav', () => {
    expect(HTML).toContain('<script src="/widgets/shared/admin-nav.js"></script>');
    expect(HTML).toMatch(/<meta name="robots" content="noindex, nofollow"/);
  });
  test('registered in the shared admin navigation', () => {
    expect(NAV).toMatch(/\/admin\/imported-events\.html/);
    expect(NAV).toMatch(/label: 'Imported Events'/);
  });
  test('inline JS has no syntax errors', () => {
    const scripts = [...HTML.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts.length).toBe(1);
    expect(() => new vm.Script(scripts[0])).not.toThrow();
  });
});

describe('authorization (client guard; API stays authoritative)', () => {
  test('requires a token and an admin role, else redirects/denies', () => {
    expect(HTML).toContain("localStorage.getItem('token')");
    expect(HTML).toContain("window.location.href = '/login.html'");
    expect(HTML).toMatch(/role !== 'admin'/);
    expect(HTML).toContain('Access Denied');
  });
  test('all API calls send the Bearer token and a 401 logs out', () => {
    expect(HTML).toMatch(/'Authorization':'Bearer '\+token/);
    expect(HTML).toMatch(/status===401.*adminLogout\(\)/s);
  });
});

describe('consumes ONLY the Commit 10 API', () => {
  test('uses the /api/admin/event-imports base + every endpoint', () => {
    expect(HTML).toMatch(/const API = '\/api\/admin\/event-imports'/);
    expect(HTML).toMatch(/API\+'\/queue\?'/);
    expect(HTML).toMatch(/API\+'\/queue\/'\+encodeURIComponent\(id\)\)/);           // detail
    expect(HTML).toMatch(/API\+'\/queue\/'\+encodeURIComponent\(id\)\+'\/approve'/); // approve one
    expect(HTML).toMatch(/API\+'\/queue\/'\+encodeURIComponent\(id\)\+'\/reject'/);  // reject one
    expect(HTML).toMatch(/API\+'\/bulk-approve'/);
    expect(HTML).toMatch(/API\+'\/bulk-reject'/);
    expect(HTML).toMatch(/API\+'\/approve-all'/);
    expect(HTML).toMatch(/API\+'\/sources'/);
  });
  test('markets come from the existing public endpoint (no new API invented)', () => {
    expect(HTML).toContain('/api/public/event-markets');
  });
  test('does not fabricate company matches beyond the API response', () => {
    // company-match status/candidates come straight from the API payload
    expect(HTML).toMatch(/it\.company_match_status/);
    expect(HTML).toMatch(/d\.company_match/);
    expect(HTML).toMatch(/d\.company_match\.candidates/);
  });
});

describe('filters, search, pagination + summary', () => {
  test('source, market, and search inputs plus clear filters', () => {
    ['fSource', 'fMarket', 'fQ', 'fClear'].forEach(id => expect(HTML).toContain('id="' + id + '"'));
    expect(HTML).toMatch(/qs\.set\('sourceId'/);
    expect(HTML).toMatch(/qs\.set\('market'/);
    expect(HTML).toMatch(/qs\.set\('q'/);
    expect(HTML).toMatch(/function clearFilters/);
  });
  test('pagination controls drive page + limit params', () => {
    expect(HTML).toMatch(/qs\.set\('page'/);
    expect(HTML).toMatch(/qs\.set\('limit'/);
    expect(HTML).toMatch(/id="pgPrev"/);
    expect(HTML).toMatch(/id="pgNext"/);
  });
  test('summary shows total pending, filtered, and selected counts + source breakdown', () => {
    ['sTotal', 'sFiltered', 'sSelected', 'sBreakdown'].forEach(id => expect(HTML).toContain('id="' + id + '"'));
    expect(HTML).toContain('Source breakdown');
  });
});

describe('queue rows expose the required review metadata', () => {
  test('title, date, city/state, organizer, source, import time, method, media, auto-publish', () => {
    expect(HTML).toMatch(/it\.title/);
    expect(HTML).toMatch(/fdatetime\(it\.start_at\)/);
    expect(HTML).toMatch(/it\.city.*it\.state/s);
    expect(HTML).toMatch(/Organizer: '\+esc\(it\.organizer/);
    expect(HTML).toMatch(/Source: '\+esc\(it\.source_platform/);
    expect(HTML).toMatch(/Imported '\+fdatetime\(it\.imported_at\)/);
    expect(HTML).toMatch(/methodLabel\(it\.import\)/);
    expect(HTML).toMatch(/Media: '\+esc\(it\.media_policy/);
    expect(HTML).toMatch(/Auto-publish: '\+\(it\.auto_publish_eligible/);
  });
  test('company match is shown with a symbol + words (not color alone)', () => {
    expect(HTML).toMatch(/Exact company match/);
    expect(HTML).toMatch(/Possible company match/);
    expect(HTML).toMatch(/No company match/);
    expect(HTML).toMatch(/sym[^]*?[●◐○]/); // symbol accompanies the color
  });
  test('duplicate reason / import note is surfaced when present', () => {
    expect(HTML).toMatch(/it\.import\.duplicate_reason/);
    expect(HTML).toContain('Import note');
  });
  test('each row has review/approve/reject buttons + a selection checkbox', () => {
    expect(HTML).toMatch(/data-review="/);
    expect(HTML).toMatch(/data-approve="/);
    expect(HTML).toMatch(/data-reject="/);
    expect(HTML).toMatch(/type="checkbox" data-sel="/);
  });
});

describe('detail review view', () => {
  test('renders full imported content, provenance, run + match metadata', () => {
    expect(HTML).toMatch(/function openDetail/);
    ['Description', 'Event details', 'Timezone', 'Import metadata', 'Import run ID',
     'Source attribution / provenance', 'Company-match candidates'].forEach(s => expect(HTML).toContain(s));
    expect(HTML).toMatch(/d\.import\.run_id/);
    expect(HTML).toMatch(/d\.attribution/);
  });
  test('thumbnails render ONLY under a mirror media policy; otherwise external links', () => {
    expect(HTML).toMatch(/media_policy==='mirror'/);
    expect(HTML).toMatch(/not mirrored/);
  });
});

describe('imported/source content is escaped + external links are safe', () => {
  test('an esc() escaper exists and covers the dangerous characters', () => {
    expect(HTML).toMatch(/function esc\(s\)\{ return String[\s\S]*?&lt;[\s\S]*?&gt;[\s\S]*?&quot;/);
  });
  test('every external link opens in a new tab with rel="nofollow noopener noreferrer"', () => {
    expect(HTML).toMatch(/const EXT = ' target="_blank" rel="nofollow noopener noreferrer"'/);
    // no bare rel="noopener" anywhere (must be the full triplet)
    expect(HTML).not.toMatch(/rel="noopener"(?! noreferrer)/);
  });
  test('imported URLs are never rendered as trusted inline media outside the mirror policy', () => {
    // the <img src=imported url> path is guarded by the mirror check
    expect(HTML).toMatch(/mirror\s*\n?\s*\?\s*'<div class="imgs">/);
  });
});

describe('single approve/reject flows', () => {
  test('approve one calls the API, removes the row, and disables buttons in-flight (no dup submit)', () => {
    expect(HTML).toMatch(/function approveOne/);
    expect(HTML).toMatch(/if\(STATE\.busy\) return; setBusy\(true\)/);
    expect(HTML).toMatch(/card\.querySelectorAll\('button'\)\.forEach\(b=>b\.disabled=true\)/);
    expect(HTML).toMatch(/function dropCard/);
  });
  test('reject prompts for an OPTIONAL reason (per the API contract)', () => {
    expect(HTML).toMatch(/function openReasonDialog/);
    expect(HTML).toMatch(/Reason \(optional\)/);
    expect(HTML).toMatch(/reason: reason\|\|undefined/);
  });
  test('success + failure feedback via toasts', () => {
    expect(HTML).toMatch(/function toast/);
    expect(HTML).toMatch(/toast\('Event approved and published\.','ok'\)/);
    expect(HTML).toMatch(/toast\('Approve failed[^']*','err'\)/);
  });
});

describe('bulk actions', () => {
  test('select all visible + clear selection', () => {
    ['bSelectAll', 'bClearSel', 'bApprove', 'bReject'].forEach(id => expect(HTML).toContain('id="' + id + '"'));
  });
  test('bulk approve/reject confirm and show the affected count', () => {
    expect(HTML).toMatch(/function bulkApprove/);
    expect(HTML).toMatch(/function bulkReject/);
    expect(HTML).toMatch(/Approve '\+ids\.length\+' selected/);
  });
  test('respects the 500-id cap client-side', () => {
    expect(HTML).toMatch(/const MAX_BULK = 500/);
    expect(HTML).toMatch(/ids=ids\.slice\(0,MAX_BULK\)/);
  });
});

describe('approve-all safety', () => {
  test('exists, is visually distinct, and is not the dominant default action', () => {
    expect(HTML).toContain('id="bApproveAll"');
    expect(HTML).toContain('class="aa-box"');       // dashed warning container
    expect(HTML).toMatch(/btn-aa/);                 // distinct styling
  });
  test('uses the exact filtered count as expectedCount and lists active filters', () => {
    expect(HTML).toMatch(/const expectedCount = STATE\.list\.total/);
    expect(HTML).toMatch(/expectedCount,/);
    expect(HTML).toMatch(/function activeFilterText/);
    expect(HTML).toContain('Active filters');
  });
  test('requires explicit confirmation before firing', () => {
    expect(HTML).toMatch(/confirmDialog\('Approve All in the current filter\?'/);
    expect(HTML).toMatch(/okLabel:'Yes, Approve All'/);
  });
  test('on 409 mismatch it NEVER silently retries and forces a refresh/review', () => {
    expect(HTML).toMatch(/APPROVE_ALL_COUNT_MISMATCH/);
    expect(HTML).toMatch(/The queue changed - nothing was published/);
    expect(HTML).toMatch(/okLabel:'Refresh queue'/);
    // no automatic re-POST of approve-all inside the mismatch branch
    const mismatch = HTML.slice(HTML.indexOf('APPROVE_ALL_COUNT_MISMATCH'), HTML.indexOf('APPROVE_ALL_COUNT_MISMATCH') + 700);
    expect(mismatch).not.toMatch(/approve-all/);
  });
});

describe('states: loading / empty / no-results / error', () => {
  test('loading state', () => { expect(HTML).toMatch(/Loading review queue/); });
  test('empty vs filtered-no-results states', () => {
    expect(HTML).toContain('The review queue is empty');
    expect(HTML).toContain('No imports match these filters');
  });
  test('error state with retry', () => {
    expect(HTML).toContain('Could not load the queue');
    expect(HTML).toMatch(/id="rt"/);
  });
});

describe('accessibility', () => {
  test('accessible modal (role=dialog, aria-modal, focus restore, Esc, focus trap)', () => {
    expect(HTML).toMatch(/setAttribute\('role','dialog'\)/);
    expect(HTML).toMatch(/setAttribute\('aria-modal','true'\)/);
    expect(HTML).toMatch(/e\.key==='Escape'/);
    expect(HTML).toMatch(/function trap/);
    expect(HTML).toMatch(/lastFocused[\s\S]*\.focus\(\)/);
  });
  test('labels, live regions, and visible focus', () => {
    expect(HTML).toMatch(/aria-live="polite"/);
    expect(HTML).toMatch(/aria-label="Select '/);
    expect(HTML).toMatch(/:focus-visible\{outline/);
  });
});

describe('analytics preparation (no GA4/GTM, fixed vocabulary)', () => {
  test('emits the fixed action names only, through a no-op hook', () => {
    expect(HTML).toMatch(/function emit\(action, data\)/);
    ['queue_viewed', 'import_detail_reviewed', 'import_approved', 'import_rejected',
     'bulk_approval', 'bulk_rejection', 'approve_all_attempt', 'approve_all_result']
      .forEach(n => expect(HTML).toContain("'" + n + "'"));
  });
  test('no GA4/GTM/analytics vendor code is introduced', () => {
    expect(HTML).not.toMatch(/gtag|googletagmanager|G-[A-Z0-9]{6,}|dataLayer|analytics\.js/i);
  });
});

describe('governance: no BD writes, no auto-publish', () => {
  test('never references Brilliant Directories / BD write surfaces', () => {
    expect(HTML).not.toMatch(/brilliant|directorysecure|\/api\/bd\b/i);
  });
  test('publishing only happens via an explicit approve/approve-all action (no silent auto-publish)', () => {
    // The only publish paths are approve, bulk-approve, approve-all — all user-initiated.
    expect(HTML).not.toMatch(/auto[-_ ]?publish\s*\(/i);
    expect(HTML).toMatch(/Auto-publish: '/); // shown as read-only metadata only
  });
});
