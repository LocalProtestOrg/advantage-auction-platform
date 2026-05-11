# Shared CSS Strategy

How Advantage widgets manage styling without conflicting with BD host page CSS.

---

## Core Principle: CSS Namespace Isolation

Every platform CSS class uses a short, unique namespace prefix. This means widgets
can be embedded on any BD page without their styles leaking into or being
overridden by the host page's CSS.

| Prefix | Owned by | Applies to |
|---|---|---|
| `aapc-` | Shared component library | Cards, badges, skeletons, CTA, empty/error states |
| `aapfl-` | Featured Lots widget | Grid layout, grid wrapper |
| `aapny-` | Featured Near You widget | Grid layout, grid wrapper |

**BD pages must not use `aapc-`, `aapfl-`, or `aapny-` class names.**
These are reserved. Any class starting with these prefixes in the BD host page
will collide with widget styles.

---

## CSS Custom Property Theming

Widgets use CSS custom properties (variables) for theming instead of hardcoded colors.
This allows BD pages to override widget colors without touching the widget source.

Custom properties are scoped to the `.aapc-root` class applied to the widget's
outer grid element. They do not bleed into the rest of the BD page.

### Default (light theme) variables

```css
.aapc-root {
  --aapc-bg:   #ffffff;   /* card background */
  --aapc-bg2:  #f8fafc;   /* secondary background, no-image placeholder */
  --aapc-fg:   #1e293b;   /* primary text */
  --aapc-sub:  #64748b;   /* secondary / muted text */
  --aapc-bdr:  #e2e8f0;   /* border color */
  --aapc-live: #ef4444;   /* LIVE NOW badge background */
  --aapc-up:   #3b82f6;   /* UPCOMING badge background */
  --aapc-ship: #0284c7;   /* Ships badge background */
  --aapc-end:  #f97316;   /* Ending Soon badge background */
  --aapc-dist: #0284c7;   /* distance text color */
  --aapc-cta-bdr: #3b82f6; /* CTA card dashed border */
}
```

### Dark theme overrides

Add `data-theme="dark"` to the widget container, or add `aapc-dark` class to the grid element.

The dark theme overrides all `--aapc-*` variables for inverted colors. No additional
CSS is needed on the BD page.

---

## Overriding Widget Colors from BD Page CSS

To match widget colors to a BD page's brand:

```css
/* Scope overrides to the widget container only */
#aap-featured-lots .aapc-root {
  --aapc-bg:  #1a1a2e;   /* dark card background */
  --aapc-fg:  #e0e0e0;   /* light text */
  --aapc-bdr: #333355;   /* dark border */
  --aapc-up:  #6c5ce7;   /* brand purple for UPCOMING badge */
}
```

**This is the correct and safe way to customize widget appearance from a BD page.**
Do not attempt to override `.aapc-*` class properties directly — those may change
between widget versions. Custom property overrides are part of the stable public interface.

---

## Style Injection Mechanism

Each widget and component injects its required CSS into `document.head` when it
first runs. Injection is idempotent — each CSS block has a unique `id` attribute
and will not be injected twice even if the script is loaded multiple times.

| Script | CSS injected | Style block ID |
|---|---|---|
| `badge.js` | Root variables + badge styles | `aapc-root-styles`, `aapc-badge-styles` |
| `skeleton-card.js` | Pulse animation + skeleton styles | `aapc-skel-styles` |
| `auction-card.js` | Card shell + body + typography | `aapc-card-styles` |
| `seller-cta.js` | CTA card styles | `aapc-cta-styles` |
| `empty-state.js` | Empty + error state | `aapc-state-styles` |
| `featured-lots.js` | Grid layout | `aapfl-styles` |
| `featured-near-you.js` | Grid layout | `aapny-styles` |

All style blocks are injected once and never re-injected. Safe for multi-widget pages.

---

## BD Page CSS Compatibility

### Safe to have on BD page

- Any custom class names that don't start with `aapc-`, `aapfl-`, `aapny-`
- CSS resets (will not override widget styles — widgets are self-contained)
- Google Fonts (widgets use system fonts by default; host page fonts do not cascade in)
- Bootstrap, Tailwind, Foundation (widgets use specific class names, no conflicts)

### Can cause issues

- `* { box-sizing: content-box !important; }` — widget layout uses `border-box`
- Very aggressive CSS resets that reset `display: flex` or `display: grid`
- `max-width: 100%` rules applied to `img` — can affect card image heights

### Fix for aggressive resets

If a BD page's global CSS reset is interfering with widget layout, scope the embed
inside a container with `all: initial` protection:

```html
<div style="all: unset; display: block;">
  <div id="aap-featured-lots" data-api-base="https://auctions.advantage.bid"></div>
</div>
```

Use sparingly — `all: unset` has broad implications for inherited styles.

---

## Grid Layout

Both widgets use CSS Grid with `auto-fill` and `minmax`:

```css
/* Featured Lots grid */
.aapfl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
}

/* Below 480px: single column */
@media (max-width: 480px) {
  .aapfl-grid { grid-template-columns: 1fr; }
}
```

**To control how many columns appear:**
The grid auto-fills based on available width. To force 2 columns on desktop:
wrap the widget container in a `max-width: 620px` parent. To force 3 columns:
use `max-width: 900px`. The widget itself does not support a `data-columns` attribute
(feature request, not yet built — submit to engineering if needed).

*Last updated: 2026-05-11*
