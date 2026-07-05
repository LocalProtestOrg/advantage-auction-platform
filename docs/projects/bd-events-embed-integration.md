# BD ↔ Railway Events — Embed Integration Reference (production)

**Status:** production widgets live on `bid.advantage.bid`. BD city pages **not yet edited** (requires BD page-edit access — see "BD access" below). Railway = source of truth; BD = presentation only.

## Verified production URLs
| URL | Status |
|---|---|
| `https://bid.advantage.bid/widgets/events.js` | ✅ 200 |
| `https://bid.advantage.bid/widgets/events.html` | ✅ 200 |
| `https://bid.advantage.bid/events.html` | ✅ 200 |
| `https://bid.advantage.bid/org/events/new` | ✅ 302 → `/org/event-new.html` (query preserved) |

> **Create-Event deep-link:** `/org/events/new` is a simple server-side redirect that preserves the query string (e.g. `?market=houston`) and lands on the static create page `/org/event-new.html`. Use the pretty `/org/events/new?market=…` in BD links.

## City page → market mapping
| BD page | `data-market` | Create-Event link |
|---|---|---|
| `/houston` | `houston` | `…/org/events/new?market=houston` |
| `/new-york` | `nyc_tristate` | `…/org/events/new?market=nyc_tristate` |
| `/new-jersey` | `nyc_tristate` | `…/org/events/new?market=nyc_tristate` |
| `/connecticut` | `nyc_tristate` | `…/org/events/new?market=nyc_tristate` |

## Placement rule
Add the widget **below** the existing city-page intro content. **Do not remove** any existing content. Keep BD native events untouched.

## Snippet A — JavaScript widget (preferred)
Houston (`/houston`):
```html
<div data-advantage-events data-market="houston" data-limit="12"></div>
<script async src="https://bid.advantage.bid/widgets/events.js"></script>
```
NYC / Tri-State (`/new-york`, `/new-jersey`, `/connecticut`):
```html
<div data-advantage-events data-market="nyc_tristate" data-limit="12"></div>
<script async src="https://bid.advantage.bid/widgets/events.js"></script>
```

## Snippet B — iframe fallback (only if a `<script>` can't be added)
Houston:
```html
<iframe src="https://bid.advantage.bid/widgets/events.html?market=houston"
        style="width:100%;border:0;min-height:900px" loading="lazy" title="Local events"></iframe>
```
NYC / Tri-State:
```html
<iframe src="https://bid.advantage.bid/widgets/events.html?market=nyc_tristate"
        style="width:100%;border:0;min-height:900px" loading="lazy" title="Local events"></iframe>
```

## Snippet C — Create-Event button
Houston:
```html
<a href="https://bid.advantage.bid/org/events/new?market=houston">Create Event</a>
```
NYC / Tri-State:
```html
<a href="https://bid.advantage.bid/org/events/new?market=nyc_tristate">Create Event</a>
```

## BD access
Automated access to BD is **read-only REST API only** (`X-Api-Key`, base `https://www.advantage.bid/api/v2/`) — **no BD MCP, no page-edit capability**. BD city-page edits are therefore **manual** (paste the snippets above) until BD page-edit access is intentionally enabled. BD CSP is permissive (`script-src https:`, `connect-src *`, `frame-src *`) so both the JS widget and iframe are allowed. Canonical origin `https://www.advantage.bid` (and `https://advantage.bid`) are already in the events API CORS allow-list.

## Manual BD tasks (for whoever has BD page-edit access)
1. `/houston` → paste Snippet A (houston) below intro.
2. `/new-york`, `/new-jersey`, `/connecticut` → paste Snippet A (nyc_tristate) below intro.
3. Optionally add Snippet C (Create-Event) near the widget on each page.
4. Use Snippet B (iframe) only on any page where a `<script>` tag isn't permitted.
5. Leave BD native events in place for now.
