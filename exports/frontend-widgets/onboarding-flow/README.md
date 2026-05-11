# Onboarding Flow Widget — Export Package (Planned)

**Status: NOT YET BUILT**

This package directory is a planned placeholder. The onboarding flow widget
has not been engineered yet. This README documents the requirements so engineering
can scope and build it correctly.

Do not deploy this package — there is no `widget.js` or `widget.css` yet.

---

## Purpose

A multi-step onboarding entry sequence for seller and buyer registration.
Designed to embed on BD landing pages, scenario pages, and partner sites
as a self-contained registration flow without requiring buyers/sellers to
navigate away from the BD page.

---

## Planned Embed Shape

```html
<!-- Onboarding Flow Widget — PLANNED, NOT YET AVAILABLE -->
<div
  id="aap-onboarding-flow"
  data-api-base="https://auctions.advantage.bid"
  data-flow="seller"
  data-headline="Start Selling with Advantage"
  data-return-url="https://auctions.advantage.bid/seller-dashboard"
></div>
<script src="https://auctions.advantage.bid/widgets/onboarding-flow.js" defer></script>
```

---

## Engineering Requirements

For this widget to be built and published to this export:

1. **Multi-step form component** — seller registration flow (business info → lot types → schedule call) and buyer registration flow (basic info → card verification)
2. **AAPConfig-driven copy** — all labels, CTAs, step headings configurable via `AAPConfig`
3. **Analytics events** — `aap:onboarding:step` (fires at each step change), `aap:onboarding:complete` (fires on successful registration)
4. **Standalone embed** — must work without shared platform layer (self-contained)
5. **No auth token in embed code** — registration credentials must never appear in client-side embed
6. **CORS** — `/api/auth/register` endpoint must be allowlisted for BD domains
7. **Redirect handling** — `data-return-url` determines where the user goes after completing registration

---

## When This Package Will Be Published

When engineering completes the widget and it passes full Playwright validation,
this directory will receive:
- `widget.js` — embed loader
- `widget.css` — brand override layer
- Updated `README.md` — full deployment guide
- Updated `version.json` — version `1.0.0`, status `stable`

Frontend operations should watch for the `version.json` status to change from
`planned` to `stable` before deploying.

---

## Related Engineering Tasks

- Engineering request: see `ops/growth/campaigns/` for the seller onboarding campaign context
- API dependency: `POST /api/auth/register` must support BD domain CORS allowlist

*Placeholder created: 2026-05-11*
