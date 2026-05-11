# Frontend Widget Export Pipeline — CHANGELOG

Operational changelog for the `/exports/frontend-widgets/` deployment pipeline.
Tracks engineering-published widget updates and export package changes.

**Audience:** Frontend operations — read this before deploying a new version.  
**Maintained by:** Engineering — updated with every export package release.  
**Format:** One entry per release, most recent at top.

---

## How to Read This Changelog

Each entry covers one or more package changes published together.
For every entry, check:

1. **Affected packages** — which widget packages changed
2. **Change type** — MAJOR / MINOR / PATCH (see below)
3. **Frontend action required** — what frontend ops must do, if anything
4. **Migration guide** — only present for MAJOR changes

### Change Type Guide

| Type | Semver | What it means for frontend ops |
|---|---|---|
| **MAJOR** | x+1.0.0 | Breaking change — action required before deploying updated package |
| **MINOR** | x.y+1.0 | New capability added — backward compatible, no action required |
| **PATCH** | x.y.z+1 | Bug fix — deploy at next opportunity, no config changes needed |

### When to Act

- **PATCH** — Deploy at next opportunity. No changes to embed code needed.
- **MINOR** — No action required unless you want the new feature. Read release notes.
- **MAJOR** — Read the migration guide before deploying. Coordinate with engineering.

---

## Releases

---

### [2026-05-11] — Initial Export Pipeline v1.0.0

**Type:** Initial release  
**Frontend action required:** None — this is the first publication  
**Affected packages:** All

#### Packages Published

| Package | Version | Status |
|---|---|---|
| `featured-lots` | 1.0.0 | Stable |
| `featured-near-you` | 1.0.0 | Stable |
| `seller-cta` | 1.0.0 | Stable |
| `city-enhancements` | 1.0.0 | Stable |
| `onboarding-flow` | 0.0.0 | Planned |
| `shared-platform-layer` (docs) | 1.0.0 | Stable |

#### What's In This Release

**`featured-lots` v1.0.0**
- Standalone embed: one `<div>` + one `<script>` tag, no other dependencies
- Full platform layer embed: shares utils/config/components with other widgets on the same page
- Config: `data-limit`, `data-auction-state`, `data-theme`, `data-seller-cta-*`
- Analytics: `aap:widget:loaded`, `aap:lot:click`, `aap:cta:click`
- Calls: `GET /api/public/featured-lots`
- Inline fallbacks for all shared components — works without the shared platform layer

**`featured-near-you` v1.0.0**
- Three-source fetch strategy: geo-featured → geo-near → national fallback
- Optional browser geolocation (`data-use-geolocation="true"`) or hardcoded coordinates
- Config: `data-lat`, `data-lng`, `data-radius-km`, `data-limit`, `data-theme`
- Analytics: `aap:widget:loaded`, `aap:widget:fallback`, `aap:auction:click`, `aap:cta:click`
- Calls: `GET /api/public/featured-auctions`, `GET /api/public/auctions/near`
- Self-contained CSS with full dark theme support

**`seller-cta` v1.0.0**
- Standalone seller call-to-action card without a widget grid
- Config: `data-url` (required), `data-headline`, `data-subtext`, `data-label`
- Analytics: `aap:cta:click`
- No API calls — pure client-side render

**`city-enhancements` v1.0.0**
- Wraps `featured-near-you` with a built-in coordinate lookup table
- 10 metro area configurations: dallas-tx, houston-tx, san-antonio-tx, atlanta-ga,
  chicago-il, phoenix-az, denver-co, nashville-tn, kansas-city-mo, minneapolis-mn
- Config: `data-city="[slug]"` (required) + all `featured-near-you` data-* attrs
- No browser geolocation prompt — always uses hardcoded coordinates
- Calls same endpoints as `featured-near-you`

**`onboarding-flow` v0.0.0 (planned)**
- Package directory created with engineering requirements documented
- No `widget.js` or `widget.css` — not deployable yet
- Status will change to `stable` when engineering completes the widget

#### Pipeline Infrastructure Added
- `deployment-log.md` — operational deployment ledger
- `CHANGELOG.md` — this file
- `README.md` — pipeline overview with machine boundary diagram, governance rules
- Per-package `README.md` — full deployment guides
- Per-package `version.json` — semver, compatibility, changelog
- Per-package `widget.js` — thin CDN loader (not widget source)
- Per-package `widget.css` — CSS override layer for BD branding

---

## Per-Widget Changelog Quick Reference

For widget-level changelogs, the authoritative record is in each package's `version.json`
under the `changelog[]` array. This file tracks pipeline-level changes; per-widget changes
are tracked at the package level.

| Package | version.json location |
|---|---|
| featured-lots | `featured-lots/version.json` |
| featured-near-you | `featured-near-you/version.json` |
| seller-cta | `seller-cta/version.json` |
| city-enhancements | `city-enhancements/version.json` |
| onboarding-flow | `onboarding-flow/version.json` |

---

## Upcoming / Planned

| Package | Planned version | Expected type | Notes |
|---|---|---|---|
| `onboarding-flow` | 1.0.0 | Initial release | Multi-step seller/buyer registration flow. Engineering in backlog. |
| `city-enhancements` | 1.1.0 | MINOR | Additional city configurations as regional BD pages expand. |
| `featured-lots` | future | MINOR | `data-columns` attribute for forced column count — if engineering prioritizes. |

---

## Migration Guide Template (for MAJOR releases)

When engineering publishes a MAJOR version, this section will contain a migration guide:

```
### Migration: [package] v[N-1].x → v[N].0.0

**Breaking changes:**
- [List each breaking change: removed attribute, changed container ID, changed API endpoint, etc.]

**Required frontend actions:**
1. [Specific step — update embed code, change container ID, etc.]
2. [Next step]

**Before deploying the new version:**
- [ ] Read all breaking changes above
- [ ] Update embed code per instructions
- [ ] Test on staging — confirm widget renders correctly with new embed code
- [ ] Confirm rollback plan (prior version embed code saved)

**If you need more time before migrating:**
The prior version will remain available at the CDN until [date].
No action is required until you choose to deploy the updated package.
```

---

*Changelog initialized: 2026-05-11*  
*This file is operational governance infrastructure — not runtime code.*
