'use strict';

/**
 * BD embed packages (Increment 9) — production-ready embed guards.
 *
 * The BD layer must be thin: it embeds + configures the shared Advantage widgets. These guards
 * cover the org-scoped events filter (no cross-org leak), duplicate-init protection, graceful
 * states, cache-versioning, credential-free snippets, and the local fixture + guide.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

const feed = read('src', 'routes', 'publicEvents.js');
const eventsW = read('public', 'widgets', 'events.js');
const feedW = read('public', 'widgets', 'marketplace-feed.js');
const fixture = read('public', 'widgets', 'bd-embed-preview.html');
const guide = read('docs', 'projects', 'bd-marketplace-embed-guide.md');

describe('organization-scoped events filter is tenant-safe', () => {
  test('filters by a stable UUID and yields zero rows on an invalid id (no cross-org leak)', () => {
    const h = feed.slice(feed.indexOf("const orgId ="), feed.indexOf('const limit ='));
    expect(h).toMatch(/organization_id/);
    expect(h).toMatch(/e\.organization_id = \$/);
    expect(h).toMatch(/where\.push\('false'\)/); // invalid id → empty, never all
  });
});

describe('widgets are production-hardened', () => {
  test('events.js supports data-organization-id + exposes a version', () => {
    expect(eventsW).toContain("getAttribute('data-organization-id')");
    expect(eventsW).toContain('organization_id=');
    expect(eventsW).toMatch(/WIDGET_VERSION/);
  });
  test('events.js keeps loading / empty / error states + per-container init guard', () => {
    expect(eventsW).toContain('Loading events…');
    expect(eventsW).toContain('No upcoming events right now.');
    expect(eventsW).toContain('Events are unavailable right now.');
    expect(eventsW).toContain('__abEventsInit');
  });
  test('marketplace-feed.js guards double init + shows an explicit error state + version', () => {
    expect(feedW).toMatch(/__abMktInit/);
    expect(feedW).toContain('The marketplace is unavailable right now');
    expect(feedW).toMatch(/WIDGET_VERSION/);
  });
  test('widgets touch no credentials/tokens (public feeds only)', () => {
    [eventsW, feedW].forEach(function (w) {
      expect(w).not.toMatch(/api[_-]?key|secret|token|authorization|bearer/i);
    });
  });
});

describe('local fixture demonstrates all three embed configurations', () => {
  test('fixture wires unified + market-scoped + org-scoped embeds', () => {
    expect(fixture).toContain('id="marketplace-feed"');
    expect(fixture).toContain('data-market="houston"');
    expect(fixture).toContain('data-organization-id');
    expect(fixture).toContain('/widgets/marketplace-feed.js');
    expect(fixture).toContain('/widgets/events.js');
  });
});

describe('embed guide documents the required production config', () => {
  test('covers CORS, cache-versioning, no-credentials, and replace-these values', () => {
    expect(guide).toMatch(/EVENTS_ALLOWED_ORIGINS/);
    expect(guide).toMatch(/\?v=/);
    expect(guide).toMatch(/No credentials/i);
    expect(guide).toMatch(/ORGANIZATION_UUID/);
  });
});
