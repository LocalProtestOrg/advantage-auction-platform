# Widget Naming and Version Discipline

Rules for naming, versioning, and identifying widget packages across the
engineering → frontend deployment pipeline.

---

## Package Naming Convention

```
[type]-[name]
```

| Type prefix | Used for |
|---|---|
| `widget-` | Self-contained interactive widgets (grids, carousels, feeds) |
| `section-` | Static or near-static page sections (hero, FAQ, CTA block) |
| `shared-` | Shared infrastructure (utilities, config, component library) |
| `block-` | Reusable inline content blocks (testimonial, stat bar, icon row) |

**Examples:**
- `widget-featured-lots`
- `widget-featured-near-you`
- `section-seller-hero`
- `section-how-it-works`
- `shared-platform-layer`
- `block-seller-testimonial`

**No spaces, no underscores, no camelCase.** Lowercase hyphenated only.

---

## Version Numbering

Follows semantic versioning: **MAJOR.MINOR.PATCH**

| Increment | When to use |
|---|---|
| **MAJOR** (1.x.x → 2.x.x) | Breaking change — embed code structure changes, container ID changes, API endpoint changes, removed config keys |
| **MINOR** (x.1.x → x.2.x) | Additive change — new optional `data-*` attribute, new analytics event, new config key, new capability that is backward-compatible |
| **PATCH** (x.x.1 → x.x.2) | Bug fix — visual fix, CSS adjustment, fallback improvement, no API or interface change |

**Never modify a published version document.** When a change is needed:
1. Create a new version document alongside the old one
2. Update the deployment log with the new version
3. Keep the old version document for rollback reference

---

## Package Document Filename Convention

```
ops/frontend/packages/[package-name]/v[MAJOR].[MINOR].[PATCH].md
```

Examples:
```
ops/frontend/packages/widget-featured-lots/v1.0.0.md
ops/frontend/packages/widget-featured-lots/v1.1.0.md  ← new minor version
ops/frontend/packages/widget-featured-near-you/v1.0.0.md
ops/frontend/packages/shared-platform-layer/v1.0.0.md
```

---

## Version Status Labels

Each package document carries a status in its metadata header:

| Status | Meaning |
|---|---|
| `Stable` | Tested, deployed or cleared for deployment |
| `Beta` | Functional but not yet validated in production BD context |
| `Deprecated` | Superseded by a newer version — do not deploy fresh |
| `Archived` | No longer maintained — kept for rollback reference only |

---

## Widget Container ID Convention

Each widget uses a stable, namespaced HTML container ID:

| Widget | Container ID |
|---|---|
| Featured Lots | `aap-featured-lots` |
| Featured Near You | `aap-featured-near-you` |

Container IDs never change across versions — they are part of the stable embed interface.
If a breaking change requires a new container ID, that is a MAJOR version increment.

---

## CSS Class Namespace Convention

All platform CSS uses namespaced class prefixes to prevent collisions with BD host page styles:

| Prefix | Used by |
|---|---|
| `aapc-` | Shared component library (cards, badges, skeletons) |
| `aapfl-` | Featured Lots widget grid and layout |
| `aapny-` | Featured Near You widget grid and layout |

Future widgets must adopt a unique 4-5 character prefix. Never use generic
class names like `.grid`, `.card`, `.badge`, `.title` — these will collide
with BD host page CSS.

---

## Analytics Event Naming Convention

All analytics events follow the pattern: `aap:[scope]:[action]`

| Event | Scope | Action |
|---|---|---|
| `aap:widget:loaded` | widget | loaded |
| `aap:widget:fallback` | widget | fallback |
| `aap:lot:click` | lot | click |
| `aap:auction:click` | auction | click |
| `aap:cta:click` | cta | click |

Event names never change across MINOR versions. Removing an event is a MAJOR change.
Adding a new event is a MINOR change.

*Last updated: 2026-05-11*
