# Widget Deployment Workflow

Step-by-step process for safely deploying Advantage widgets into BD pages,
landing pages, partner embeds, and growth frontend systems.

---

## Before You Start

**Check the package is published.**
Only deploy widgets with a corresponding version document in
`/ops/frontend/packages/[widget-name]/v[X.Y.Z].md`.

**Identify the target page.**
Know exactly which BD page or section you are modifying before touching anything.

**Save the current state.**
Copy the existing HTML of the section you are replacing into the deployment log
before making any changes. This is your rollback snapshot.

---

## Deployment Checklist

### Step 1 — Read the full package document
Open `ops/frontend/packages/[widget-name]/v[X.Y.Z].md` and read it entirely.
Do not skip the "Mobile Considerations," "Accessibility," or "Cache Considerations" sections.

### Step 2 — Choose your embed variant
Each package offers two embed variants:

**Standalone embed (recommended for single-widget pages or quick deploys):**
One `<div>` container + one `<script>` tag. Self-contained. Works without the shared platform layer.

**Full platform layer embed (recommended for multi-widget pages):**
Load shared utils, config, and components once. All widgets on the page share a single
copy of each dependency. Fewer HTTP requests. Required if deploying two or more widgets
on the same page.

### Step 3 — Configure `data-api-base`
Always set `data-api-base="https://auctions.advantage.bid"` when deploying on external
BD pages. This tells the widget where to fetch data from.

On pages hosted on `auctions.advantage.bid` itself, omit `data-api-base` or set it to
an empty string — the widget will use the same origin.

### Step 4 — Test before publishing
Paste the embed code into a staging or preview page first. Open the browser console.
Confirm:
- No JavaScript errors in console
- Widget renders within 2-3 seconds
- Cards display correctly on desktop (1100px+)
- Cards display correctly on mobile (375px)
- Fallback/empty state renders if no live data is available

### Step 5 — Deploy to BD page
Replace the target section in the BD page with the widget embed code.
If the widget replaces an existing static section, remove that section's HTML entirely —
do not leave the old markup alongside the widget.

### Step 6 — Verify post-deployment
After deploying:
- Hard refresh the page (`Ctrl+Shift+R` / `Cmd+Shift+R`)
- Confirm widget renders correctly in both desktop and mobile views
- Confirm no layout shift or style collisions with existing BD page styles
- Confirm analytics events are firing (use browser console event listener if needed)

### Step 7 — Log the deployment
Add an entry to `ops/frontend/docs/deployment-log.md`:

```markdown
## [Date] — [Widget Name] v[X.Y.Z] deployed to [BD Page Name]

- Page: [URL or BD page identifier]
- Widget version: [X.Y.Z]
- Embed variant: standalone / full platform layer
- Previous section saved: [yes — see below] / [no — new section]
- Deployed by: [name]
- Notes: [anything notable]

Previous HTML (for rollback):
[paste the old HTML here]
```

---

## Multi-Widget Pages

When deploying two or more widgets on the same page:

1. Load the shared platform layer once at the top (see `shared-platform-layer` package)
2. Configure `AAPConfig.set()` once after the shared scripts load
3. Add each widget's container `<div>` in the desired page position
4. Load each widget's script after its container
5. Widget scripts are idempotent — loading the same script twice is safe (no-op)

**Load order matters:**
```
shared/utils.js
shared/config.js
AAPConfig.set({ ... })   ← configure before widget scripts run
shared/components/*.js   ← all six component scripts
widget-A.js
widget-B.js
```

---

## Config Priority (Important for BD Deployments)

Each widget resolves config in this order (highest priority first):

1. `data-*` attribute on the container element
2. `AAPConfig.set()` called on the page
3. Remote config from `AAPConfig.loadRemote()` (if called)
4. Platform defaults (built into widget)

**For BD:** Use `data-*` attributes for per-page overrides. Use `AAPConfig.set()`
for site-wide defaults shared across all widgets on the page.

---

## CORS Considerations

Widgets fetch data from `https://auctions.advantage.bid`. The platform's CORS policy
allows cross-origin requests from authorized BD domains.

If a BD domain is not yet authorized, widgets will show an error state.
**Submit the BD domain to engineering for CORS allowlisting before deploying.**

---

## What Frontend Ops Cannot Do

- Modify the widget JavaScript source files
- Change the API endpoints the widgets call
- Add or remove authentication headers
- Modify the platform's CORS policy
- Bypass the data-* / AAPConfig configuration system
- Access admin API endpoints from BD embed code

Any of these requirements means a formal engineering request is needed.

*Last updated: 2026-05-11*
